'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const multer = require('multer');
const sharp = require('sharp');
const WebSocket = require('ws');
const webpush   = require('web-push');

// ─── Config ──────────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/config.json'), 'utf8'));
const PORT = parseInt(process.env.PORT || config.port || 3000);
const UPLOADS_DIR = path.join(ROOT, config.uploadsDir);
const THUMBS_DIR  = path.join(ROOT, config.thumbnailsDir);
const DB_PATH     = path.join(ROOT, config.dbPath);
const PUBLIC_DIR  = path.join(ROOT, 'public');

const PULSE_HUB_WS   = process.env.PULSE_HUB_WS   || config.pulseHubWs   || 'ws://localhost:18800';
const PULSE_HUB_HTTP = process.env.PULSE_HUB_HTTP  || config.pulseHubHttp || 'http://localhost:18801';
const PULSE_TOKEN    = process.env.PULSE_TOKEN      || config.pulseToken   || 'change-me';
const MEMORY_API_TOKEN = process.env.MEMORY_API_TOKEN || config.memoryApiToken || '';

// ─── VAPID / Push ─────────────────────────────────────────────────────────────
let VAPID_PUBLIC_KEY  = '';
let VAPID_PRIVATE_KEY = '';
try {
  const vapidPath = path.join(ROOT, 'config/vapid-keys.json');
  const vapidKeys = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
  VAPID_PUBLIC_KEY  = vapidKeys.publicKey;
  VAPID_PRIVATE_KEY = vapidKeys.privateKey;
  webpush.setVapidDetails('mailto:admin@shrimpnet.local', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('[Push] VAPID keys loaded');
} catch(e) {
  console.warn('[Push] No VAPID keys found — push disabled:', e.message);
}

// Ensure dirs exist
[UPLOADS_DIR, THUMBS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── Agent registry ───────────────────────────────────────────────────────────
const AGENTS = config.agents || [];

// ─── Agent webhook endpoints ──────────────────────────────────────────────────
// Load from config or environment
const AGENT_HOOKS = config.agentHooks || {};

// Agent IP map for session polling
const AGENT_IPS = config.agentIps || {};

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    sender TEXT NOT NULL,
    sender_type TEXT DEFAULT 'agent',
    type TEXT DEFAULT 'message',
    subject TEXT,
    body TEXT,
    file_path TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_type TEXT,
    thumbnail_path TEXT,
    timestamp TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    last_message_at TEXT,
    participant_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (conversation_id, agent_name)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_presence (
    agent_name TEXT PRIMARY KEY,
    status TEXT DEFAULT 'unknown',
    last_seen TEXT,
    latency_ms INTEGER
  );
`);

// Migrations: add pinned and deleted columns if not present
try { db.exec(`ALTER TABLE conversations ADD COLUMN pinned INTEGER DEFAULT 0`); } catch(_) {}
try { db.exec(`ALTER TABLE conversations ADD COLUMN deleted INTEGER DEFAULT 0`); } catch(_) {}

// Seed agent_presence if empty
const presenceCount = db.prepare('SELECT COUNT(*) as c FROM agent_presence').get();
if (presenceCount.c === 0) {
  const ins = db.prepare('INSERT OR IGNORE INTO agent_presence (agent_name, status) VALUES (?, ?)');
  for (const a of AGENTS) ins.run(a.name, 'unknown');
}

// Prepared statements
const stmts = {
  insertMsg: db.prepare(`
    INSERT OR REPLACE INTO messages
      (id,conversation_id,sender,sender_type,type,subject,body,file_path,file_name,file_size,file_type,thumbnail_path,timestamp)
    VALUES
      (@id,@conversation_id,@sender,@sender_type,@type,@subject,@body,@file_path,@file_name,@file_size,@file_type,@thumbnail_path,@timestamp)
  `),
  upsertConv: db.prepare(`
    INSERT INTO conversations (id,title,last_message_at,participant_count)
    VALUES (@id,@title,@last_message_at,1)
    ON CONFLICT(id) DO UPDATE SET
      last_message_at=excluded.last_message_at,
      participant_count=participant_count+1
  `),
  getMessages: db.prepare(`
    SELECT * FROM messages
    WHERE (@before IS NULL OR timestamp < @before)
    ORDER BY timestamp DESC LIMIT 100
  `),
  getMsgsByConv: db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id=@conv
    ORDER BY timestamp ASC LIMIT 200
  `),
  getConversations: db.prepare(`
    SELECT c.*, m.sender AS last_sender, m.body AS last_body
    FROM conversations c
    LEFT JOIN messages m ON m.id = (
      SELECT id FROM messages WHERE conversation_id=c.id ORDER BY timestamp DESC LIMIT 1
    )
    WHERE (c.deleted IS NULL OR c.deleted = 0)
    ORDER BY c.pinned DESC, c.last_message_at DESC
  `),
  getParticipants: db.prepare(`
    SELECT agent_name FROM conversation_participants WHERE conversation_id=?
  `),
  addParticipant: db.prepare(`
    INSERT OR IGNORE INTO conversation_participants (conversation_id, agent_name) VALUES (?, ?)
  `),
  upsertPresence: db.prepare(`
    INSERT INTO agent_presence (agent_name, status, last_seen, latency_ms)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(agent_name) DO UPDATE SET
      status=excluded.status, last_seen=excluded.last_seen, latency_ms=excluded.latency_ms
  `),
  getPresence: db.prepare('SELECT * FROM agent_presence'),
};

// ─── SSE clients ─────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

// ─── Pulse WebSocket client ───────────────────────────────────────────────────
let pulseWs = null;
let pulseConnected = false;
let pulseReconnectTimer = null;
let pulseReconnectDelay = 2000;
const PULSE_MAX_DELAY = 60000;

const USER_NAME = config.userName || 'User';
const PUBLIC_URL = config.publicUrl || 'http://localhost:3000';
const BRAIN_SEARCH_URL = config.brainSearchUrl || process.env.BRAIN_SEARCH_URL || null;

function connectPulse() {
  if (pulseWs) {
    try { pulseWs.terminate(); } catch(_) {}
    pulseWs = null;
  }

  console.log(`[Pulse] Connecting to ${PULSE_HUB_WS}...`);
  pulseWs = new WebSocket(PULSE_HUB_WS);

  pulseWs.on('open', () => {
    console.log('[Pulse] Connected to hub');
    pulseConnected = true;
    pulseReconnectDelay = 2000;
    clearTimeout(pulseReconnectTimer);

    pulseWs.send(JSON.stringify({
      type: 'identify',
      agent: 'shrimpnet',
      token: PULSE_TOKEN,
    }));

    broadcast('pulse_status', { connected: true });
  });

  pulseWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(_) { return; }

    if (msg.protocol === 'pulse/1.0' && msg.from) {
      if (msg.from === 'shrimpnet') return;
      const userNameLower = USER_NAME.toLowerCase();
      if (msg.from === userNameLower || msg.from === USER_NAME) return;
      if (msg.payload && (msg.payload.sender === USER_NAME || msg.payload.sender === userNameLower)) return;
      if (sentMsgIds.has(msg.id)) return;
      const convId = msg.conversationId || msg.conv_id || `pulse-${msg.from}`;
      const msgBody = (msg.payload && (msg.payload.body || msg.payload.text || msg.payload.subject))
        || msg.body || '';
      const subject = (msg.payload && msg.payload.subject) || msg.subject || null;

      const stored = {
        id: msg.id || uuidv4(),
        conversation_id: convId,
        sender: msg.from,
        sender_type: 'agent',
        type: msg.type || 'message',
        subject,
        body: msgBody,
        file_path: null, file_name: null, file_size: null, file_type: null, thumbnail_path: null,
        timestamp: msg.timestamp || new Date().toISOString(),
      };
      storeMessage(stored);

      stmts.upsertPresence.run(msg.from, 'online', null);
      markConversationResponded(convId, msg.from);
      broadcast('agent_presence', { agent: msg.from, status: 'online' });
    }

    if (msg.type === 'peers' || msg.type === 'presence') {
      const peers = msg.peers || msg.agents || [];
      for (const peer of peers) {
        const name = typeof peer === 'string' ? peer : peer.agent || peer.name;
        if (name && name !== 'shrimpnet') {
          stmts.upsertPresence.run(name, 'online', null);
        }
      }
      broadcast('agent_presence', { peers });
    }
  });

  pulseWs.on('error', (err) => {
    console.error('[Pulse] Error:', err.message);
    pulseConnected = false;
    broadcast('pulse_status', { connected: false });
  });

  pulseWs.on('close', () => {
    console.log('[Pulse] Disconnected from hub, reconnecting...');
    pulseConnected = false;
    broadcast('pulse_status', { connected: false });
    pulseWs = null;
    pulseReconnectTimer = setTimeout(() => {
      pulseReconnectDelay = Math.min(pulseReconnectDelay * 2, PULSE_MAX_DELAY);
      connectPulse();
    }, pulseReconnectDelay);
  });
}

function sendViaPulse(target, msgData, conversationHistory) {
  if (!pulseConnected || !pulseWs) {
    console.warn('[Pulse] Not connected — cannot send to', target);
    return false;
  }
  const envelope = {
    protocol: 'pulse/1.0',
    id: uuidv4(),
    conversationId: msgData.conversation_id || 'general',
    from: 'shrimpnet',
    to: target,
    type: 'message',
    timestamp: new Date().toISOString(),
    payload: {
      body: msgData.body || '',
      subject: msgData.subject || null,
      sender: msgData.sender || USER_NAME,
      conversationHistory: conversationHistory || [],
    },
  };
  sentMsgIds.add(envelope.id);
  setTimeout(() => sentMsgIds.delete(envelope.id), 5 * 60 * 1000);
  pulseWs.send(JSON.stringify(envelope));
  return true;
}

// ─── Agent history helper ─────────────────────────────────────────────────────
function getAgentHistory(agentName) {
  // Count conversations this agent participated in
  const countRow = db.prepare(`
    SELECT COUNT(DISTINCT cp.conversation_id) as count
    FROM conversation_participants cp
    JOIN conversations c ON c.id = cp.conversation_id
    WHERE cp.agent_name = ? AND (c.deleted IS NULL OR c.deleted = 0)
  `).get(agentName);

  // Last 3 conversation titles
  const recentRows = db.prepare(`
    SELECT c.title, c.last_message_at
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id
    WHERE cp.agent_name = ? AND (c.deleted IS NULL OR c.deleted = 0)
    ORDER BY c.last_message_at DESC
    LIMIT 3
  `).all(agentName);

  return {
    count: countRow ? countRow.count : 0,
    recentTitles: recentRows.map(r => r.title || r.id),
  };
}


// ─── Brain Search ─────────────────────────────────────────────────────────────
async function searchBrain(query, agentName, topK = 3) {
  if (!BRAIN_SEARCH_URL) return '';
  try {
    const res = await fetch(BRAIN_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, top_k: topK, agent: agentName }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const results = data.results || [];
    if (results.length === 0) return '';
    const summaries = results.map((r, i) => 
      `${i+1}. [${r.agent || '?'}/${r.source_file || '?'}] ${(r.text || '').substring(0, 200)}`
    ).join('\n');
    return `\n\n[Brain search - relevant memories for ${agentName}:]\n${summaries}`;
  } catch(e) {
    return '';
  }
}

async function sendAgentWebhook(agentName, conversationId, message, history, previousContext) {
  const hook = AGENT_HOOKS[agentName];
  if (!hook) return;

  const histText = history.slice(-100).map(h => `${h.sender}: ${h.body}`).join('\n');
  const contextLine = previousContext ? `\n\n${previousContext}` : '';
  
  // Fetch relevant memories from brain search (if configured)
  const brainContext = await searchBrain(message, agentName);
  const payload = {
    message: `[ShrimpNet:${conversationId}] ${USER_NAME} says: ${message}${contextLine}${histText ? '\n\nConversation so far:\n' + histText : ''}${brainContext}\n\nAfter responding, send your reply to ShrimpNet so ${USER_NAME} sees it in the chat UI:\ncurl -s -X POST ${PUBLIC_URL}/api/ingest -H "Content-Type: application/json" -H "Authorization: Bearer ${config.ingestToken}" -d '{"protocol":"pulse/1.0","conversationId":"${conversationId}","from":"${agentName}","type":"response","payload":{"body":"YOUR_REPLY_HERE"}}'\nReplace YOUR_REPLY_HERE with your actual response. Use proper JSON escaping for quotes and newlines.`,
    sessionKey: `hook:shrimpnet:${conversationId}`,
  };

  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${hook.token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[Webhook] ${agentName}: ${res.status}`);
  } catch(e) {
    console.warn(`[Webhook] ${agentName} failed: ${e.message}`);
  }
}

const respondedConversations = new Map();

async function pollAgentResponse(agentName, conversationId, webhookTime) {
  const ip = AGENT_IPS[agentName];
  if (!ip || !MEMORY_API_TOKEN) return;

  const delays = [12000, 25000, 45000];

  for (const delay of delays) {
    await new Promise(r => setTimeout(r, delay));

    const key = `${conversationId}:${agentName}`;
    if (respondedConversations.has(key)) {
      console.log(`[Poller] ${agentName} already responded`);
      // Clear typing indicator
      broadcast('typing_stop', { agentName, conversationId });
      return;
    }

    try {
      const sessRes = await fetch(`http://${ip}:8850/sessions/list`, {
        headers: { 'Authorization': `Bearer ${MEMORY_API_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!sessRes.ok) continue;

      const sessions = await sessRes.json();
      const allSessions = (Array.isArray(sessions) ? sessions : sessions.sessions || sessions.files || [])
        .sort((a, b) => new Date(b.modified || b.lastModified || 0).getTime() - new Date(a.modified || a.lastModified || 0).getTime())
        .slice(0, 3);

      for (const sess of allSessions) {
        const sessId = sess.id;
        const fileRes = await fetch(`http://${ip}:8850/sessions/file?id=${sessId}`, {
          headers: { 'Authorization': `Bearer ${MEMORY_API_TOKEN}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!fileRes.ok) continue;

        const fileData = await fileRes.json();
        const content = fileData.content || '';

        const lines = content.split('\n').filter(l => l.trim());
        let foundOurMessage = false;
        let assistantResponse = null;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type !== 'message') continue;
            const msg = entry.message || {};
            const role = msg.role;
            let text = '';
            const c = msg.content;
            if (typeof c === 'string') text = c;
            else if (Array.isArray(c)) text = c.filter(p => p && p.type === 'text').map(p => p.text || '').join('');

            if (role === 'user' && text.includes('[ShrimpNet')) {
              foundOurMessage = true;
            }

            if (role === 'assistant' && foundOurMessage) {
              let cleaned = text.replace(/\[\[reply_to_current\]\]/g, '').replace(/\[\[reply_to:[^\]]*\]\]/g, '').trim();
              if (cleaned && cleaned !== 'HEARTBEAT_OK' && cleaned !== 'NO_REPLY' && cleaned.length > 3) {
                assistantResponse = cleaned;
              }
            }
          } catch(_) {}
        }

        if (assistantResponse) {
          if (respondedConversations.has(key)) return;
          const recentAgentMsg = db.prepare(
            "SELECT id FROM messages WHERE conversation_id=? AND sender=? AND timestamp > datetime('now', '-60 seconds')"
          ).get(conversationId, agentName);
          if (recentAgentMsg) {
            console.log(`[Poller] ${agentName} already responded (DB check)`);
            respondedConversations.set(key, Date.now());
            broadcast('typing_stop', { agentName, conversationId });
            return;
          }
          respondedConversations.set(key, Date.now());
          setTimeout(() => respondedConversations.delete(key), 10 * 60 * 1000);

          const storedMsg = {
            id: uuidv4(),
            conversation_id: conversationId,
            sender: agentName,
            sender_type: 'agent',
            type: 'message',
            subject: null,
            body: assistantResponse,
            file_path: null, file_name: null, file_size: null, file_type: null, thumbnail_path: null,
            timestamp: new Date().toISOString(),
          };
          storeMessage(storedMsg);
          broadcast('new_message', storedMsg);
          broadcast('typing_stop', { agentName, conversationId });
          console.log(`[Poller] Got ${agentName} response (${assistantResponse.length} chars) via session poll`);
          return;
        }
      }
    } catch(e) {
      console.warn(`[Poller] ${agentName} poll error: ${e.message}`);
    }
  }
  // Timed out — stop typing indicator
  broadcast('typing_stop', { agentName, conversationId });
  console.warn(`[Poller] ${agentName} no response found after 45s`);
}

function markConversationResponded(conversationId, agentName) {
  const key = `${conversationId}:${agentName}`;
  respondedConversations.set(key, Date.now());
  // Also stop typing indicator when agent responds via ingest
  broadcast('typing_stop', { agentName, conversationId });
  setTimeout(() => respondedConversations.delete(key), 10 * 60 * 1000);
}

connectPulse();

// ─── Presence polling ─────────────────────────────────────────────────────────
async function pollPresence() {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${PULSE_HUB_HTTP}/status`, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return;
    const data = await res.json();

    const peers = Array.isArray(data) ? data : (data.peers || data.agents || []);

    for (const peer of peers) {
      const name = typeof peer === 'string' ? peer : (peer.agent || peer.name);
      if (name) stmts.upsertPresence.run(name, 'online', peer.latency_ms || null);
    }

    if (peers.length > 0) {
      const onlineNames = new Set(peers.map(p => typeof p === 'string' ? p : (p.agent || p.name)));
      for (const a of AGENTS) {
        if (!onlineNames.has(a.name)) {
          stmts.upsertPresence.run(a.name, 'offline', null);
        }
      }
    }

    broadcast('presence_update', stmts.getPresence.all());
  } catch (e) {}
}
setInterval(pollPresence, 30000);
setTimeout(pollPresence, 3000);

// ─── Multer ───────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSize },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
const IMAGE_TYPES = new Set(['image/jpeg','image/png','image/gif','image/webp']);

async function saveUpload(file) {
  const ext = path.extname(file.originalname) || '';
  const uid = uuidv4();
  const filename = uid + ext;
  const filePath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(filePath, file.buffer);

  let thumbnailPath = null;
  if (IMAGE_TYPES.has(file.mimetype)) {
    const thumbName = uid + '_thumb.webp';
    const thumbPath = path.join(THUMBS_DIR, thumbName);
    await sharp(file.buffer)
      .resize(config.thumbnailWidth, config.thumbnailHeight, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(thumbPath);
    thumbnailPath = thumbName;
  }

  return { filename, thumbnailPath, size: file.size };
}

const recentMsgIds = new Set();
const sentMsgIds = new Set();
const DEDUP_WINDOW = 5 * 60 * 1000;


// ─── Push notification sender ─────────────────────────────────────────────────
async function sendPushNotifications(msg) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  if (msg.sender_type !== 'agent') return;
  if (!msg.body || msg.body.length < 2) return;

  const agent = AGENTS.find(a => a.name === msg.sender) || {};
  const title = '\u{1F990} ' + (agent.label || agent.name || msg.sender);
  const bodyText = msg.body.substring(0, 200);

  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  if (subs.length === 0) return;

  const payload = JSON.stringify({
    title,
    body: bodyText,
    conversationId: msg.conversation_id || 'general',
    url: '/',
  });

  const dead = [];
  await Promise.allSettled(subs.map(async (row) => {
    const subscription = {
      endpoint: row.endpoint,
      keys: { p256dh: row.keys_p256dh, auth: row.keys_auth },
    };
    try {
      await webpush.sendNotification(subscription, payload);
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(row.endpoint);
      else console.warn('[Push] send error:', e.statusCode || e.message);
    }
  }));

  for (const ep of dead) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(ep);
    console.log('[Push] Removed expired subscription');
  }
}

function storeMessage(msg) {
  if (msg.sender === 'shrimpnet' || msg.sender === 'Shrimpnet') return null;
  if (recentMsgIds.has(msg.id)) return null;
  const existing = db.prepare('SELECT id FROM messages WHERE id = ?').get(msg.id);
  if (existing) return null;
  recentMsgIds.add(msg.id);
  setTimeout(() => recentMsgIds.delete(msg.id), DEDUP_WINDOW);

  stmts.insertMsg.run(msg);
  if (msg.conversation_id) {
    stmts.upsertConv.run({
      id: msg.conversation_id,
      title: msg.conversation_id,
      last_message_at: msg.timestamp,
    });
  }
  broadcast('message', msg);
  // Push notify for agent messages (non-blocking)
  if (msg.sender_type === 'agent') sendPushNotifications(msg).catch(e => console.warn('[Push]', e.message));
  return msg;
}

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not found');
    return;
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=86400',
  });
  fs.createReadStream(filePath).pipe(res);
}

function mime(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.html':'text/html','.css':'text/css','.js':'application/javascript',
    '.json':'application/json','.png':'image/png','.jpg':'image/jpeg',
    '.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon',
    '.pdf':'application/pdf','.txt':'text/plain','.csv':'text/csv',
    '.svg':'image/svg+xml',
  };
  return map[ext] || 'application/octet-stream';
}

function json(res, data, status=200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)});
  res.end(body);
}

function err(res, msg, status=400) {
  json(res, {error: msg}, status);
}

function checkIngestAuth(req) {
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${config.ingestToken}`;
}

function runMulter(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (e) => e ? reject(e) : resolve());
  });
}

// ─── Slash command processor ──────────────────────────────────────────────────
function processSlashCommand(text, conversationId) {
  const trimmed = text.trim();

  if (trimmed.startsWith('/broadcast ')) {
    const msgBody = trimmed.slice('/broadcast '.length).trim();
    if (!msgBody) return { ok: false, error: 'Usage: /broadcast <message>' };
    const results = [];
    for (const agent of AGENTS) {
      const sent = sendViaPulse(agent.name, { body: msgBody, conversation_id: conversationId });
      results.push({ agent: agent.name, sent });
    }
    return { ok: true, type: 'broadcast', targets: AGENTS.map(a => a.name), results };
  }

  if (trimmed.startsWith('/rally ')) {
    const rest = trimmed.slice('/rally '.length).trim();
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) return { ok: false, error: 'Usage: /rally <agents> <question>' };
    const agentStr = rest.slice(0, spaceIdx);
    const question = rest.slice(spaceIdx + 1).trim();
    const targetNames = agentStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const results = [];
    for (const name of targetNames) {
      const sent = sendViaPulse(name, { body: question, conversation_id: conversationId });
      results.push({ agent: name, sent });
    }
    return { ok: true, type: 'rally', targets: targetNames, question };
  }

  if (trimmed === '/agents') {
    const presence = stmts.getPresence.all();
    return { ok: true, type: 'agents_list', agents: AGENTS, presence };
  }

  return null;
}

// ─── Router ───────────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── SSE ──────────────────────────────────────────────────────────────────
  if (pathname === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch(_){} }, 25000);
    sseClients.add(res);

    res.write(`event: pulse_status\ndata: ${JSON.stringify({ connected: pulseConnected })}\n\n`);

    req.on('close', () => { sseClients.delete(res); clearInterval(heartbeat); });
    return;
  }

  // ── API ───────────────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) {

    // GET /api/config — client-side config (safe, non-secret values only)
    if (pathname === '/api/config' && method === 'GET') {
      json(res, { userName: USER_NAME });
      return;
    }

    // GET /api/agents
    if (pathname === '/api/agents' && method === 'GET') {
      const presence = stmts.getPresence.all();
      const presenceMap = {};
      for (const p of presence) presenceMap[p.agent_name] = p;
      const result = AGENTS.map(a => ({
        ...a,
        status: presenceMap[a.name]?.status || 'unknown',
        last_seen: presenceMap[a.name]?.last_seen || null,
        latency_ms: presenceMap[a.name]?.latency_ms || null,
      }));
      json(res, result);
      return;
    }

    // GET /api/agents/:name/history
    if (pathname.match(/^\/api\/agents\/[^/]+\/history$/) && method === 'GET') {
      const agentName = pathname.split('/')[3].toLowerCase();
      const history = getAgentHistory(agentName);
      json(res, history);
      return;
    }

    // GET /api/agents/status
    if (pathname === '/api/agents/status' && method === 'GET') {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(`${PULSE_HUB_HTTP}/status`, { signal: ctrl.signal });
        clearTimeout(timeout);
        const data = await r.json();
        json(res, { ok: true, pulse_connected: pulseConnected, hub_data: data, agents: AGENTS });
      } catch(e) {
        const presence = stmts.getPresence.all();
        json(res, { ok: false, pulse_connected: pulseConnected, error: e.message, cached_presence: presence, agents: AGENTS });
      }
      return;
    }

    // GET /api/messages
    if (pathname === '/api/messages' && method === 'GET') {
      const before = url.searchParams.get('before') || null;
      const rows = stmts.getMessages.all({ before });
      json(res, rows.reverse());
      return;
    }

    // GET /api/messages/:conversationId
    if (pathname.startsWith('/api/messages/') && method === 'GET') {
      const conv = decodeURIComponent(pathname.slice('/api/messages/'.length));
      json(res, stmts.getMsgsByConv.all({ conv }));
      return;
    }

    // POST /api/messages
    if (pathname === '/api/messages' && method === 'POST') {
      let body;
      try { body = await jsonBody(req); } catch(_) { err(res,'Invalid JSON'); return; }
      if (!body.sender || !body.body) { err(res,'sender and body required'); return; }

      const slashResult = processSlashCommand(body.body, body.conversationId || 'general');
      if (slashResult !== null) {
        if (!slashResult.ok) { err(res, slashResult.error); return; }
        const sysmsg = {
          id: uuidv4(),
          conversation_id: body.conversationId || 'general',
          sender: 'system',
          sender_type: 'system',
          type: 'command',
          subject: null,
          body: slashResult.type === 'broadcast'
            ? '📢 Broadcast sent to ' + slashResult.targets.join(', ')
            : slashResult.type === 'rally'
            ? '⚡ Rally to ' + (slashResult.targets || []).join(', ') + ': ' + (slashResult.question || '')
            : slashResult.type === 'agents_list'
            ? '🤖 Agent status check'
            : JSON.stringify(slashResult),
          file_path: null, file_name: null, file_size: null, file_type: null, thumbnail_path: null,
          timestamp: new Date().toISOString(),
        };
        storeMessage(sysmsg);
        json(res, { ok: true, command: slashResult, message: sysmsg }, 201);
        return;
      }

      const targets = body.targets || (body.target ? [body.target] : []);
      const msg = {
        id: uuidv4(),
        conversation_id: body.conversationId || 'general',
        sender: body.sender,
        sender_type: body.senderType || 'human',
        type: 'message',
        subject: body.subject || null,
        body: body.body,
        file_path: null, file_name: null, file_size: null, file_type: null, thumbnail_path: null,
        timestamp: new Date().toISOString(),
      };
      storeMessage(msg);

      let conversationHistory = [];
      if (msg.conversation_id) {
        try {
          const histMsgs = stmts.getMsgsByConv.all({ conv: msg.conversation_id });
          conversationHistory = histMsgs.map(m => ({
            sender: m.sender,
            senderType: m.sender_type,
            body: m.body || '',
            timestamp: m.timestamp,
          }));
        } catch(e) {
          console.error('[ShrimpNet] Failed to fetch conversation history:', e.message);
        }
      }

      if (targets.length > 0) {
        for (const target of targets) {
          if (target === 'all') {
            for (const agent of AGENTS) sendViaPulse(agent.name, msg, conversationHistory);
          } else {
            sendViaPulse(target, msg, conversationHistory);
          }
        }
      }

      const getMsgsByConv = db.prepare('SELECT sender, sender_type, body, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC');
      const histRows = getMsgsByConv.all(msg.conversation_id);
      const hist = histRows.map(r => ({ sender: r.sender, body: r.body }));
      for (const t of targets) {
        if (t === 'all') {
          for (const a of AGENTS) sendAgentWebhook(a.name, msg.conversation_id, msg.body, hist);
        } else {
          // Get previous context for this agent
          const agentHistory = getAgentHistory(t);
          let previousContext = null;
          if (agentHistory.count > 0) {
            const titles = agentHistory.recentTitles.filter(Boolean).slice(0, 3);
            previousContext = `[Previous context: You've had ${agentHistory.count} conversation${agentHistory.count !== 1 ? 's' : ''} with ${USER_NAME} on ShrimpNet. Most recent topics: ${titles.join(', ')}]`;
          }
          sendAgentWebhook(t, msg.conversation_id, msg.body, hist, previousContext);
          // Broadcast typing start
          broadcast('typing_start', { agentName: t, conversationId: msg.conversation_id });
          pollAgentResponse(t, msg.conversation_id, Date.now());
        }
      }

      json(res, msg, 201);
      return;
    }

    // POST /api/upload
    if (pathname === '/api/upload' && method === 'POST') {
      try {
        await runMulter(req, res);
        if (!req.file) { err(res,'No file'); return; }
        const { filename, thumbnailPath, size } = await saveUpload(req.file);
        const body = req.body || {};
        const msg = {
          id: uuidv4(),
          conversation_id: body.conversationId || 'general',
          sender: body.sender || USER_NAME,
          sender_type: 'human',
          type: 'file',
          subject: null,
          body: null,
          file_path: filename,
          file_name: req.file.originalname,
          file_size: size,
          file_type: req.file.mimetype,
          thumbnail_path: thumbnailPath,
          timestamp: new Date().toISOString(),
        };
        storeMessage(msg);
        json(res, msg, 201);
      } catch(e) {
        console.error('Upload error:', e);
        err(res, e.message, 500);
      }
      return;
    }

    // GET /api/conversations
    if (pathname === '/api/conversations' && method === 'GET') {
      const convs = stmts.getConversations.all();
      for (const c of convs) {
        const parts = stmts.getParticipants.all(c.id);
        c.participants = parts.map(p => p.agent_name);
      }
      json(res, convs);
      return;
    }

    // PATCH /api/conversations/:id — update title or pinned
    if (pathname.match(/^\/api\/conversations\/[^/]+$/) && method === 'PATCH') {
      const convId = decodeURIComponent(pathname.split('/')[3]);
      let body;
      try { body = await jsonBody(req); } catch(_) { err(res,'Invalid JSON'); return; }

      const updates = [];
      const params = [];
      if (typeof body.title === 'string') { updates.push('title = ?'); params.push(body.title); }
      if (typeof body.pinned === 'boolean' || typeof body.pinned === 'number') {
        updates.push('pinned = ?');
        params.push(body.pinned ? 1 : 0);
      }

      if (updates.length === 0) { err(res, 'Nothing to update'); return; }
      params.push(convId);
      db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      // Broadcast update so all clients refresh
      broadcast('conversation_updated', { id: convId, ...body });
      json(res, { ok: true });
      return;
    }

    // DELETE /api/conversations/:id
    if (pathname.match(/^\/api\/conversations\/[^/]+$/) && method === 'DELETE') {
      const convId = decodeURIComponent(pathname.split('/')[3]);
      // Soft delete conversation + hard delete messages
      db.prepare(`UPDATE conversations SET deleted = 1 WHERE id = ?`).run(convId);
      db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(convId);
      db.prepare(`DELETE FROM conversation_participants WHERE conversation_id = ?`).run(convId);
      broadcast('conversation_deleted', { id: convId });
      json(res, { ok: true });
      return;
    }

    // POST /api/conversations
    if (pathname === '/api/conversations' && method === 'POST') {
      let body;
      try { body = await jsonBody(req); } catch(_) { err(res,'Invalid JSON'); return; }
      const convId = body.id || uuidv4();
      const title = body.title || convId;
      const participants = body.participants || [];

      db.prepare(`
        INSERT OR IGNORE INTO conversations (id, title, last_message_at, participant_count)
        VALUES (?, ?, datetime('now'), ?)
      `).run(convId, title, participants.length);

      for (const agent of participants) {
        stmts.addParticipant.run(convId, agent);
      }

      let firstMsg = null;
      if (body.firstMessage) {
        firstMsg = {
          id: uuidv4(),
          conversation_id: convId,
          sender: body.sender || USER_NAME,
          sender_type: 'human',
          type: 'message',
          subject: body.subject || null,
          body: body.firstMessage,
          file_path: null, file_name: null, file_size: null, file_type: null, thumbnail_path: null,
          timestamp: new Date().toISOString(),
        };
        storeMessage(firstMsg);

        const firstMsgHistory = [{
          sender: firstMsg.sender,
          senderType: firstMsg.sender_type,
          body: firstMsg.body || '',
          timestamp: firstMsg.timestamp,
        }];
        for (const agent of participants) {
          sendViaPulse(agent, firstMsg, firstMsgHistory);

          // Get previous context for each agent
          const agentHistory = getAgentHistory(agent);
          let previousContext = null;
          if (agentHistory.count > 0) {
            const titles = agentHistory.recentTitles.filter(Boolean).slice(0, 3);
            previousContext = `[Previous context: You've had ${agentHistory.count} conversation${agentHistory.count !== 1 ? 's' : ''} with ${USER_NAME} on ShrimpNet. Most recent topics: ${titles.join(', ')}]`;
          }

          sendAgentWebhook(agent, convId, firstMsg.body, firstMsgHistory, previousContext);
          // Broadcast typing start
          broadcast('typing_start', { agentName: agent, conversationId: convId });
          pollAgentResponse(agent, convId, Date.now());
        }
      }

      json(res, { id: convId, title, participants, firstMessage: firstMsg }, 201);
      return;
    }

    // GET /api/conversations/:id/participants
    if (pathname.match(/^\/api\/conversations\/[^/]+\/participants$/) && method === 'GET') {
      const convId = decodeURIComponent(pathname.split('/')[3]);
      json(res, stmts.getParticipants.all(convId));
      return;
    }

    // POST /api/conversations/:id/participants
    if (pathname.match(/^\/api\/conversations\/[^/]+\/participants$/) && method === 'POST') {
      const convId = decodeURIComponent(pathname.split('/')[3]);
      let body;
      try { body = await jsonBody(req); } catch(_) { err(res,'Invalid JSON'); return; }
      if (!body.agent_name) { err(res,'agent_name required'); return; }
      stmts.addParticipant.run(convId, body.agent_name);
      json(res, { ok: true });
      return;
    }

    // DELETE /api/conversations/:id/participants/:agentName
    if (pathname.match(/^\/api\/conversations\/[^/]+\/participants\/[^/]+$/) && method === 'DELETE') {
      const parts = pathname.split('/');
      const convId = decodeURIComponent(parts[3]);
      const agentName = decodeURIComponent(parts[5]);
      db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ? AND agent_name = ?').run(convId, agentName);
      // Broadcast participant removal
      broadcast('participant_removed', { conversationId: convId, agentName });
      json(res, { ok: true });
      return;
    }

    // POST /api/ingest
    if (pathname === '/api/ingest' && method === 'POST') {
      if (!checkIngestAuth(req)) { err(res,'Unauthorized',401); return; }
      let body;
      try { body = await jsonBody(req); } catch(_) { err(res,'Invalid JSON'); return; }

      const convId = body.conversationId || body.conv_id || 'general';
      const sender = body.from || body.sender || 'agent';
      const msgBody = (body.payload && (body.payload.body || body.payload.text || body.payload.subject))
        || body.body || body.text || '';
      const subject = (body.payload && body.payload.subject) || body.subject || null;

      const msg = {
        id: body.id || uuidv4(),
        conversation_id: convId,
        sender,
        sender_type: body.sender_type || 'agent',
        type: body.type || 'message',
        subject,
        body: msgBody,
        file_path: null, file_name: null, file_size: null, file_type: null, thumbnail_path: null,
        timestamp: body.timestamp || new Date().toISOString(),
      };
      storeMessage(msg);
      markConversationResponded(convId, sender);
      json(res, { ok: true, id: msg.id }, 201);
      return;
    }

    // GET /api/pulse/status
    if (pathname === '/api/pulse/status' && method === 'GET') {
      json(res, { connected: pulseConnected });
      return;
    }

    // GET /api/push/vapid-public-key
    if (pathname === '/api/push/vapid-public-key' && method === 'GET') {
      json(res, { publicKey: VAPID_PUBLIC_KEY });
      return;
    }

    // POST /api/push/subscribe
    if (pathname === '/api/push/subscribe' && method === 'POST') {
      let body;
      try { body = await jsonBody(req); } catch(_) { err(res,'Invalid JSON'); return; }
      const { endpoint, keys } = body;
      if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
        err(res, 'endpoint, keys.p256dh and keys.auth required');
        return;
      }
      db.prepare(`
        INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth)
        VALUES (?, ?, ?)
      `).run(endpoint, keys.p256dh, keys.auth);
      console.log('[Push] Subscription saved');
      json(res, { ok: true });
      return;
    }

    // POST /api/push/unsubscribe
    if (pathname === '/api/push/unsubscribe' && method === 'POST') {
      let body;
      try { body = await jsonBody(req); } catch(_) { err(res,'Invalid JSON'); return; }
      if (!body.endpoint) { err(res, 'endpoint required'); return; }
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(body.endpoint);
      json(res, { ok: true });
      return;
    }

    err(res,'Not found',404);
    return;
  }

  // ── Static uploads / thumbnails ───────────────────────────────────────────
  if (pathname.startsWith('/uploads/')) {
    const fname = path.basename(pathname);
    serveFile(res, path.join(UPLOADS_DIR, fname), mime(fname));
    return;
  }
  if (pathname.startsWith('/thumbnails/')) {
    const fname = path.basename(pathname);
    serveFile(res, path.join(THUMBS_DIR, fname), 'image/webp');
    return;
  }

  // ── Public static files ───────────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath.replace(/\.\./g,''));
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serveFile(res, filePath, mime(filePath));
    return;
  }

  serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html');
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    console.error('Unhandled error:', e);
    if (!res.headersSent) err(res, 'Internal server error', 500);
  }
});

server.listen(PORT, () => {
  console.log(`[ShrimpNet] Server running on http://0.0.0.0:${PORT}`);
  console.log(`[ShrimpNet] DB: ${DB_PATH}`);
  console.log(`[ShrimpNet] Uploads: ${UPLOADS_DIR}`);
  console.log(`[ShrimpNet] Pulse hub: ${PULSE_HUB_WS}`);
});

process.on('SIGTERM', () => {
  if (pulseWs) try { pulseWs.close(); } catch(_) {}
  server.close();
  db.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  if (pulseWs) try { pulseWs.close(); } catch(_) {}
  server.close();
  db.close();
  process.exit(0);
});
