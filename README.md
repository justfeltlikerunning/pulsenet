# ⚡ PulseNet

A production-grade real-time chat interface for orchestrating fleets of AI agents. Built on the [agent-pulse](https://github.com/justfeltlikerunning/agent-pulse) WebSocket protocol with an iMessage-style UI, sequential pipeline dispatch, and native iOS push notifications.

![PulseNet](https://img.shields.io/badge/PulseNet-Multi--Agent%20Chat-blue?style=flat-square) ![License](https://img.shields.io/badge/license-MIT-green?style=flat-square) ![Node](https://img.shields.io/badge/node-18+-green?style=flat-square)

## What It Does

PulseNet is the communication hub for a distributed AI agent fleet. It connects to any number of [OpenClaw](https://github.com/openclaw/openclaw)-powered agents via WebSocket and gives you a unified interface to coordinate them:

- **1-on-1 conversations** — Talk to any agent directly, each with isolated session context
- **Sequential pipelines** — `@Bayou @Wesley analyze this data` runs agents in order, each seeing prior responses
- **Broadcast** — `@all check status` hits every agent in a conversation simultaneously
- **File uploads** — Attach images, documents, CSVs — agents can receive and send files back
- **Push notifications** — Native iOS push via APNs so you never miss a response
- **Undo send** — Cancel a dispatch before agents start processing
- **Smart routing** — Messages auto-route to the last agent who spoke when no @mention is used

## Architecture

```
┌─────────────┐     WebSocket      ┌──────────────┐
│   PulseNet  │◄──────────────────►│  Agent Pulse │
│  (Frontend) │     (per agent)    │   Hub (N×)   │
└──────┬──────┘                    └──────┬───────┘
       │                                  │
       │  HTTP API                        │ OpenClaw
       │                                  │ Gateway
┌──────┴──────┐                    ┌──────┴───────┐
│  PulseNet   │                    │  AI Agents   │
│  (Backend)  │                    │  (Claude,    │
│  Express +  │                    │   GPT, etc.) │
│  SQLite     │                    └──────────────┘
└─────────────┘
```

PulseNet connects as a **peer** to each agent's pulse hub. Messages flow bidirectionally over persistent WebSocket connections. Each conversation gets its own isolated session per agent — preventing context overflow when conversations run for days or weeks.

## Features

### Sequential Pipeline Dispatch
When you @mention multiple agents, they execute in order:

```
@AgentA @AgentB analyze this and verify the findings
```

1. **AgentA** runs first with your message
2. **AgentB** runs second — receives your original message *plus* AgentA's full response as context
3. Each agent in the chain sees all previous responses before starting

### Per-Conversation Session Isolation
Each agent maintains a **separate session per conversation**. A busy analysis conversation doesn't bleed context into a quick status check. Session IDs include the conversation ID as a suffix, so agents can participate in dozens of simultaneous conversations without confusion.

### Smart Routing
| Message | Behavior |
|---------|----------|
| `@Agent do X` | Direct dispatch to one agent |
| `@AgentA @AgentB do X` | Pipeline: AgentA → AgentB |
| `@all check status` | Broadcast to all conversation participants |
| Follow-up with no @mention | Routes to last agent who spoke |
| `/stop` | Cancel all pending dispatches + clear typing indicators |

### iMessage-Style UI
- Blue bubbles for your messages, grey/dark bubbles for agents
- Agent avatar + color coding for quick identification
- Long-press context menu — react, reply, copy, delete
- Multi-select mode for batch operations
- Optimistic message rendering with delivery confirmation
- Typing indicators during agent processing
- Unread badges per conversation

### Push Notifications (iOS)
Native APNs push so your phone gets notified when agents respond — even when the app is backgrounded. Device tokens are persisted to SQLite and survive server restarts.

### File Handling
- Upload images, documents, spreadsheets via drag-and-drop or file picker
- Agents can send files back (reports, exports, generated content)
- Multi-file uploads supported
- Stale media guard — only files from the last 60 seconds attach to new dispatches
- 50MB max file size (configurable)

### Reliability
- **Delivery tracking** — Every agent dispatch tracked with status (pending/delivered/failed/dead)
- **Retry queue** — Failed deliveries retry automatically on agent reconnect
- **Dead letter handling** — Exhausted retries surfaced in UI with manual retry option
- **Dedup** — 4-hour SHA-256 window prevents duplicate alerts from flooding agents
- **Rogue post guard** — `/api/ingest` rejects messages targeting unknown conversation IDs

### Model Failover
PulseNet agents support automatic model failover. If the primary provider becomes unavailable, agents transparently fall back to a secondary provider via the `copilot-proxy` plugin. PulseNet dispatch and response handling are model-agnostic — the same `@mention` syntax works regardless of which model is answering.

## Quick Start

### Prerequisites
- Node.js 18+
- Agents running [agent-pulse](https://github.com/justfeltlikerunning/agent-pulse) hubs
- [OpenClaw](https://github.com/openclaw/openclaw) gateway (or any compatible agent runtime)

### Install

```bash
git clone https://github.com/justfeltlikerunning/pulsenet.git
cd pulsenet
npm install
```

### Configure

```bash
cp config.example.json config/config.json
```

Edit `config/config.json`:

```json
{
  "port": 3000,
  "peerId": "pulsenet",
  "pulseToken": "your-pulse-auth-token",
  "ingestToken": "your-ingest-token",
  "publicUrl": "https://your-domain.com",
  "agents": [
    { "name": "agent1", "label": "Agent 1", "color": "#4CAF50" }
  ],
  "agentWsUrls": {
    "agent1": "ws://10.0.0.10:18800"
  },
  "agentHooks": {
    "agent1": {
      "url": "http://10.0.0.10:18789/hooks/pulsenet",
      "token": "your-hook-token"
    }
  }
}
```

### Run

```bash
node src/server.js
```

Open `http://localhost:3000`.

### Production (systemd)

```ini
[Unit]
Description=PulseNet Chat Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/pulsenet
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

## iOS App

A native Swift iOS app provides full mobile feature parity:

- Real-time SSE updates with auto-reconnect (handles phone sleep/background)
- Native APNs push notifications
- File uploads via iOS share sheet
- Custom certificate support for local network deployments
- USB deploy pipeline for sideloading

The app connects to the same PulseNet server — no separate backend needed.

## Agent-Side Script

Deploy `pulsenet-send.sh` to your agents for outbound messaging:

```bash
# Send a message to a conversation
./pulsenet-send.sh <agent-name> "message text" --conv <conversation-id>

# Send with a file attachment
./pulsenet-send.sh <agent-name> "here's the report" --file /path/to/report.csv --conv <conversation-id>

# Post to a report channel
./pulsenet-report.sh <channel-name> "report content"
```

The script handles authentication, retry on failure, and duplicate suppression automatically.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/stop` | Cancel pending dispatches, clear typing indicators |
| `/broadcast <msg>` | Send message to all agents in conversation |
| `/agents` | Show agent list and connection status |

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/conversations` | List all conversations |
| `POST` | `/api/conversations` | Create a conversation |
| `GET` | `/api/messages` | Get messages for a conversation |
| `POST` | `/api/messages` | Send a message |
| `DELETE` | `/api/messages/:id` | Delete/cancel a message |
| `POST` | `/api/upload` | Upload a file |
| `POST` | `/api/ingest` | Webhook for agent-initiated messages |
| `GET` | `/api/search` | Full-text search across messages |
| `POST` | `/api/apn/register` | Register iOS device for push notifications |
| `GET` | `/api/dead-letters` | List undelivered messages |
| `POST` | `/api/dead-letters/:id/retry` | Retry a dead letter manually |
| `GET` | `/events` | SSE stream for real-time UI updates |

## Related Projects

- **[agent-pulse](https://github.com/justfeltlikerunning/agent-pulse)** — WebSocket protocol for real-time agent communication
- **[agent-mesh](https://github.com/justfeltlikerunning/agent-mesh)** — Structured messaging protocol (PulseNet's built-in reliability layer handles most use cases)
- **[OpenClaw](https://github.com/openclaw/openclaw)** — AI agent runtime powering the fleet

## License

MIT
