#!/bin/bash
# pulsenet-send.sh — Agent-to-agent messaging via PulseNet
# Replaces mesh-send.sh. All reliability (retry, dedup, circuit breaking) is server-side.
#
# Usage:
#   pulsenet-send.sh <target> <message>                    # simple message to one agent
#   pulsenet-send.sh <target> <message> --conv <conv>      # post to specific conversation
#   pulsenet-send.sh <target> <message> --conv-id <uuid>   # post to exact conversation by ID
#   pulsenet-send.sh <target> <message> --type request     # request (expect response)
#   pulsenet-send.sh --targets "a,b,c" <message>           # rally multiple agents
#   pulsenet-send.sh --broadcast <message>                 # all agents
#   pulsenet-send.sh <target> --file /path/to/report.csv "Here's the report"  # with file
#
# Environment:
#   AGENT_NAME / MY_AGENT   — sender identity (default: agent-1)
#   PULSENET_URL            — server URL (default: http://localhost:3000)
#   PULSENET_TOKEN          — auth token (default: changeme)

set -euo pipefail

# --- Config ---
# Auto-detect sender: env var > agent-pulse registry > hostname
if [ -n "${AGENT_NAME:-}" ]; then
  : # explicit env var takes priority
elif [ -n "${MY_AGENT:-}" ]; then
  AGENT_NAME="$MY_AGENT"
elif [ -f "$HOME/agent-pulse/config/agent-registry.json" ]; then
  AGENT_NAME=$(python3 -c "import json; print(json.load(open('$HOME/agent-pulse/config/agent-registry.json')).get('agent',''))" 2>/dev/null)
  AGENT_NAME="${AGENT_NAME:-$(hostname)}"
else
  AGENT_NAME="$(hostname)"
fi
PULSENET_URL="${PULSENET_URL:-${WEBHOST_URL:-http://localhost:3000}}"
PULSENET_TOKEN="${PULSENET_TOKEN:-${WEBHOST_TOKEN:-changeme}}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# --- Parse args ---
TARGET=""
TARGETS=""
MESSAGE=""
CONV=""
CONV_ID_OVERRIDE=""
NO_META=false
MSG_TYPE="notification"
BROADCAST=false
SUBJECT=""
FILE_PATH=""

usage() {
    cat >&2 << 'EOF'
Usage: web-host-send.sh [options] <target> <message>
       web-host-send.sh [options] --targets "a,b,c" <message>
       web-host-send.sh [options] --broadcast <message>

Options:
  --conv <name>           Conversation/channel (e.g., alerts, sre, discovery)
  --conv-id <id>          Exact conversation ID (e.g., UUID from PulseNet UI) — stays inline
  --type <type>           Message type: notification|request|response (default: notification)
  --subject <text>        Subject line
  --targets "a,b,c"       Send to multiple agents (comma-separated)
  --broadcast             Send to all agents
  -h, --help              Show this help

Examples:
  web-host-send.sh agent-2 "Query active tank count"
  web-host-send.sh --targets "agent-2,agent-5" "Cross-check query" --type request
  web-host-send.sh --broadcast "Schema v3 deployed" --conv alerts
EOF
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --conv)       CONV="$2"; shift 2 ;;
        --conv-id)    CONV_ID_OVERRIDE="$2"; NO_META=true; shift 2 ;;
        --no-meta)    NO_META=true; shift ;;
        --type)       MSG_TYPE="$2"; shift 2 ;;
        --subject)    SUBJECT="$2"; shift 2 ;;
        --targets)    TARGETS="$2"; shift 2 ;;
        --file)       FILE_PATH="$2"; shift 2 ;;
        --broadcast)  BROADCAST=true; shift ;;
        -h|--help)    usage ;;
        -*)           echo "Unknown option: $1" >&2; usage ;;
        *)
            if [[ -z "$TARGET" && -z "$TARGETS" && "$BROADCAST" == "false" ]]; then
                TARGET="$1"
            elif [[ -z "$MESSAGE" ]]; then
                MESSAGE="$1"
            else
                MESSAGE="$MESSAGE $1"
            fi
            shift ;;
    esac
done

# If targets mode, remaining arg is the message
if [[ -n "$TARGETS" || "$BROADCAST" == "true" ]] && [[ -z "$MESSAGE" ]]; then
    # The first positional arg was actually the message
    MESSAGE="$TARGET"
    TARGET=""
fi

if [[ -z "$MESSAGE" ]]; then
    echo -e "${RED}Error: No message provided${NC}" >&2
    usage
fi

# --- Build target list ---
declare -a AGENT_LIST=()

if [[ "$BROADCAST" == "true" ]]; then
    AGENT_LIST=(agent-1 agent-4 agent-2 agent-3 agent-5 agent-7 agent-6 agent-8 agent-9)
    # Remove self
    AGENT_LIST=("${AGENT_LIST[@]/$AGENT_NAME/}")
elif [[ -n "$TARGETS" ]]; then
    IFS=',' read -ra AGENT_LIST <<< "$TARGETS"
elif [[ -n "$TARGET" ]]; then
    AGENT_LIST=("$TARGET")
else
    echo -e "${RED}Error: No target specified${NC}" >&2
    usage
fi

# --- Build conversation ID ---
if [[ -n "$CONV_ID_OVERRIDE" ]]; then
    # Exact conversation ID passed — use it directly (stays inline in existing conversation)
    CONV_ID="$CONV_ID_OVERRIDE"
elif [[ -n "$CONV" ]]; then
    # Map short names to channel IDs (same as web-host-report.sh)
    declare -A CONV_MAP=(
        ["alerts"]="channel-alerts"
        ["sre"]="channel-sre"
        ["discovery"]="channel-discovery"
        ["watchdog"]="channel-fleet-watchdog"
        ["fleet-watchdog"]="channel-fleet-watchdog"
        ["vm-tasks"]="channel-vm-tasks"
        ["windows"]="channel-vm-tasks"
        ["crosschecks"]="channel-crosschecks"
        ["cross-checks"]="channel-crosschecks"
        ["security"]="channel-security"
        ["ops"]="channel-ops"
        ["daily"]="channel-daily-report"
        ["daily-report"]="channel-daily-report"
        ["brain"]="channel-brain"
        ["fleet-ops"]="channel-fleet-ops"
    )
    CONV_ID="${CONV_MAP[$CONV]:-channel-${CONV}}"
else
    # Auto-generate conversation ID for agent-to-agent
    if [[ ${#AGENT_LIST[@]} -gt 1 || "$BROADCAST" == "true" ]]; then
        CONV_ID="agent-broadcast-$(date +%Y%m%d)"
    else
        PAIR=$(echo -e "${AGENT_NAME}\n${AGENT_LIST[0]}" | sort | tr '\n' '-' | sed 's/-$//')
        CONV_ID="agent-${PAIR}"
    fi
fi

# --- Build message body with metadata ---
BODY="$MESSAGE"
if [[ -n "$SUBJECT" ]]; then
    BODY="**${SUBJECT}**\n\n${MESSAGE}"
fi

# Add metadata footer for agent processing (skip for chat replies)
if [[ "$NO_META" != "true" ]]; then
    META="\n\n---\n_From: ${AGENT_NAME} | Type: ${MSG_TYPE} | $(date -u +%Y-%m-%dT%H:%M:%SZ)_"
    BODY="${BODY}${META}"
fi

# --- Send to each target ---
SENT=0
FAILED=0

for agent in "${AGENT_LIST[@]}"; do
    [[ -z "$agent" ]] && continue  # skip empty entries from broadcast self-removal
    
    # Build targets array for this agent
    TARGETS_JSON="[\"${agent}\"]"
    
    if [[ -n "$FILE_PATH" && -f "$FILE_PATH" ]]; then
        # File upload via multipart form
        RESPONSE=$(curl -sf --max-time 30 -X POST "${PULSENET_URL}/api/upload" \
            -F "file=@${FILE_PATH}" \
            -F "sender=${AGENT_NAME}" \
            -F "senderType=agent" \
            -F "conversationId=${CONV_ID}" \
            -F "message=${MESSAGE}" \
            -F "targets=${TARGETS_JSON}" \
            2>/dev/null) || true
    else
        # Text message via JSON ingest
        RESPONSE=$(curl -sf --max-time 10 -X POST "${PULSENET_URL}/api/ingest" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer ${PULSENET_TOKEN}" \
            -d "$(jq -n -c \
                --arg sender "$AGENT_NAME" \
                --arg body "$BODY" \
                --arg convId "$CONV_ID" \
                --arg convTitle "${CONV:-${CONV_ID_OVERRIDE:-agent-comms}}" \
                --argjson targets "$TARGETS_JSON" \
                '{conversationId: $convId, from: $sender, sender_type: "agent", body: $body, title: $convTitle, targets: $targets}'
            )" 2>/dev/null) || true
    fi
    
    # Check for dedup
    if echo "$RESPONSE" | jq -e '.deduplicated' >/dev/null 2>&1; then
        echo -e "${YELLOW}⚡ Deduped for ${agent} (already sent within 4hr window)${NC}" >&2
        SENT=$((SENT + 1))
        continue
    fi
    
    if [[ -n "$RESPONSE" ]] && (echo "$RESPONSE" | jq -e '.ok // .id' >/dev/null 2>&1); then
        echo -e "${GREEN}✓ Sent to ${agent} via WebHost${NC}" >&2
        SENT=$((SENT + 1))
    else
        echo -e "${RED}✗ Failed to send to ${agent}${NC}" >&2
        FAILED=$((FAILED + 1))
    fi
done

# --- Summary ---
TOTAL=$((SENT + FAILED))
if [[ $FAILED -eq 0 ]]; then
    echo -e "${GREEN}✅ All ${SENT} message(s) delivered to WebHost${NC}" >&2
else
    echo -e "${YELLOW}⚠️ ${SENT}/${TOTAL} sent, ${FAILED} failed${NC}" >&2
    exit 1
fi
