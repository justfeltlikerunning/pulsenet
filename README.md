<p align="center">
  <img src="assets/banner.png" alt="PulseNet banner" width="100%">
</p>

# ⚡ PulseNet

**Multi-agent chat interface built on the [agent-pulse](https://github.com/justfeltlikerunning/agent-pulse) decentralized mesh.**

PulseNet gives you a ChatGPT-style UI for orchestrating conversations with multiple AI agents simultaneously. Messages flow through an encrypted peer-to-peer mesh — no central broker, real-time WebSocket delivery, with automatic HTTP fallback.

![License](https://img.shields.io/badge/license-MIT-green?style=flat-square) ![Node](https://img.shields.io/badge/node-%3E%3D18-blue?style=flat-square) ![Protocol](https://img.shields.io/badge/mesh-pulse%2F2.0-cyan?style=flat-square)

## Features

- **1-on-1 conversations** — Talk to any agent directly
- **Multi-agent pipelines** — `@Agent-2 @Agent-5 analyze this data` runs Agent-2 first, then Agent-5 with Agent-2's response as context
- **Agent-to-agent relay** — Agents can @mention each other to chain conversations
- **Context-aware dispatch** — Intelligent tier routing (T0/T1/T2) sends only the context each agent needs, reducing token waste by 30-40%
- **E2E encrypted mesh** — All inter-agent messages encrypted via X25519 + AES-256-GCM
- **File uploads & sharing** — Images, documents, CSVs — agents can both receive and send files
- **@all broadcasts** — Message every agent in a conversation at once
- **Undo send** — Cancel a message before agents see it
- **Conversation management** — Organized sidebar with categories, search, unread indicators
- **Push notifications** — iOS app support via APN
- **Multi-hub federation** — Leader election and client failover across PulseNet instances

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    PulseNet Web UI                            │
│   Conversations │ Messages │ @mentions │ File Upload          │
└────────┬─────────────────────────────────────────────────────┘
         │ WebSocket + REST API
         ▼
┌──────────────────────────────────────────────────────────────┐
│                    PulseNet Server                            │
│   SQLite DB │ Context Router │ Smart Dispatch │ Federation    │
└────────┬─────────────────────────────────────────────────────┘
         │ agent-pulse mesh (E2E encrypted)
         ▼
┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
│  Agent-1  │  │  Agent-2  │  │ Agent-5  │  │Agent-4 │  ...
│  (Opus) │  │  (Opus) │  │(Sonnet) │  │(Sonnet) │
└─────────┘  └─────────┘  └─────────┘  └─────────┘
```

## Context Router

PulseNet classifies every outbound message to determine how much conversation context to include:

| Tier | What's Sent | Example | Token Savings |
|------|------------|---------|---------------|
| **T0** | Task only | "query assets_view WHERE isactive=1" | ~95% fewer tokens |
| **T1** | Task + metadata + fetch URL | "now break that down by operator" | ~60% fewer tokens |
| **T2** | Full 20-message history | "let's brainstorm together" | Baseline (current) |

A hybrid rules engine (~70% of cases, instant) + local LLM (Qwen3-0.6B on CPU, ~200ms) handles classification. Safe fallback: always T2 when uncertain.

### On-Demand Context API

T1 messages include a fetch URL so agents can pull only what they need:

```
GET /api/messages/:conversationId?last=10
GET /api/messages/:conversationId?agent=agent-2&last=5
GET /api/messages/:conversationId?since=2026-03-07T10:00:00Z
```

## Quick Start

```bash
npm install

# Copy and configure
cp config/pulsenet-config.example.json config/pulsenet-config.json

# Start the server
node src/server.js
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/conversations | List all conversations |
| GET | /api/messages/:convId | Get messages (supports `?last=N`, `?agent=X`, `?since=T`) |
| POST | /api/messages | Send a message |
| POST | /api/upload | Upload a file |
| GET | /api/agents | List connected agents |
| GET | /api/agents/status | Health check all agents |
| GET | /events | SSE stream for real-time updates |

## Message Dispatch

```
@Agent-2 query active wells          → T0: task sent directly, no history
@Agent-5 what did agent-2 find         → T1: task + metadata, agent fetches context on demand
@Agent-2 @Agent-5 brainstorm together  → T2: full conversation history included
[T0] force minimal context          → Override: human can force any tier
```

## Pipeline Dispatch

When multiple agents are @mentioned, PulseNet runs them in sequence:

```
@Agent-2 @Agent-5 analyze treatment data
```

1. Agent-2 receives the message, processes it
2. Agent-5 receives the message + Agent-2's response as additional context
3. Both responses appear in the conversation in order

## Related Projects

- **[agent-pulse](https://github.com/justfeltlikerunning/agent-pulse)** — The decentralized messaging hub that powers PulseNet
- **[OpenClaw](https://github.com/openclaw/openclaw)** — AI agent framework

## License

MIT
