# ShrimpNet 🦐

A real-time web chat interface for AI agent fleets. Connect multiple AI agents, route messages with @mentions, manage conversations, and get responses in real-time.

## Features

- **Multi-agent chat** — Talk to multiple AI agents in the same conversation
- **Smart routing** — @mention routes messages only to mentioned agents
- **Real-time responses** — SSE-based live message delivery
- **Conversation management** — Create, rename, pin, delete conversations
- **Agent presence** — See which agents are online via WebSocket pulse hub
- **Sidebar filters** — Filter conversations by agent or group (Work/Personal/Security/Brain)
- **@mention autocomplete** — Type @ to see agent suggestions with presence status
- **Context carry-forward** — Agents see conversation history + relevant memories from previous chats
- **Typing indicators** — See when agents are processing your message
- **File uploads** — Share files with thumbnail previews
- **Mobile-first** — Responsive design with PWA support (Add to Home Screen)
- **HTTPS ready** — Works with Caddy reverse proxy for push notifications
- **Dark theme** — Easy on the eyes, built for extended use

## Architecture

ShrimpNet connects to AI agents through two mechanisms:

1. **WebSocket Hub (agent-pulse)** — Real-time bidirectional messaging between ShrimpNet and agents
2. **Webhook API** — HTTP POST to agent endpoints (compatible with OpenClaw, LangChain, CrewAI, or any webhook-enabled agent framework)

```
User → ShrimpNet → Webhook → Agent Framework → Agent processes → curl/webhook back → ShrimpNet → SSE → User
```

## Quick Start

```bash
# Clone
git clone https://github.com/justfeltlikerunning/shrimpnet.git
cd shrimpnet

# Install
npm install

# Configure
cp config/config.example.json config/config.json
# Edit config/config.json with your agent endpoints and tokens

# Run
node src/server.js

# Open http://localhost:3000
```

## Configuration

Edit `config/config.json`:

| Field | Description |
|-------|-------------|
| `port` | Server port (default: 3000) |
| `userName` | Your display name in the chat |
| `publicUrl` | Public URL for agent callbacks |
| `pulseHubWs` | WebSocket URL for agent-pulse hub |
| `pulseToken` | Auth token for pulse hub |
| `ingestToken` | Auth token for the /api/ingest endpoint |
| `agentHooks` | Map of agent webhook endpoints + tokens |
| `agents` | Agent display info (name, label, color) |
| `brainSearchUrl` | Optional: semantic search API for cross-agent memory |
| `memoryApiToken` | Optional: token for agent memory API (session polling) |

## Agent Integration

ShrimpNet works with any agent that can:
1. **Receive webhooks** — Accept HTTP POST with a message payload
2. **Send responses** — POST back to ShrimpNet's `/api/ingest` endpoint

### OpenClaw Integration
Add a webhook mapping to your agent's `openclaw.json`:
```json
{
  "hooks": {
    "mappings": [{
      "match": { "path": "shrimpnet" },
      "action": "agent",
      "name": "ShrimpNet-Chat",
      "sessionKey": "hook:shrimpnet",
      "messageTemplate": "{{message}}",
      "allowUnsafeExternalContent": true
    }]
  }
}
```

### Generic Agent Integration
Your agent receives:
```json
POST /your-webhook-endpoint
{
  "message": "[ShrimpNet:conv-id] User says: Hello!\n\nConversation so far:\n...",
  "sessionKey": "hook:shrimpnet:conversation-id"
}
```

Your agent responds:
```json
POST http://your-shrimpnet:3000/api/ingest
Authorization: Bearer your-ingest-token
{
  "protocol": "pulse/1.0",
  "conversationId": "conversation-id",
  "from": "agent-name",
  "type": "response",
  "payload": { "body": "Agent's response text" }
}
```

## HTTPS Setup (for PWA + Push Notifications)

```bash
# Install Caddy
sudo apt install caddy

# Configure /etc/caddy/Caddyfile
:443 {
    tls /path/to/cert.crt /path/to/cert.key
    reverse_proxy localhost:3000
}

sudo systemctl restart caddy
```

## License

MIT
