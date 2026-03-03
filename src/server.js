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
const apnModule = require('./apn');

// ─── Config ──────────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/config.json'), 'utf8'));
const PORT = parseInt(process.env.PORT || config.port || 3000);
const PEER_ID = config.peerId || 'pulsenet';
const UPLOADS_DIR = path.join(ROOT, config.uploadsDir);
const THUMBS_DIR  = path.join(ROOT, config.thumbnailsDir);
const DB_PATH     = path.join(ROOT, config.dbPath);

const PUBLIC_DIR  = path.join(ROOT, 'public');

const PULSE_TOKEN = config.pulseToken || process.env.PULSE_TOKEN || 'changeme';

// ─── VAPID / Push ─────────────────────────────────────────────────────────────
let VAPID_PUBLIC_KEY  = '';
let VAPID_PRIVATE_KEY = '';
try {
  const vapidPath = path.join(ROOT, 'config/vapid-keys.json');
  const vapidKeys = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
  VAPID_PUBLIC_KEY  = vapidKeys.publicKey;
  VAPID_PRIVATE_KEY = vapidKeys.privateKey;
  webpush.setVapidDetails('mailto:admin@pulsenet.local', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('[Push] VAPID keys loaded');
} catch(e) {
  console.warn('[Push] No VAPID keys found — push disabled:', e.message);
}

// Ensure dirs exist
[UPLOADS_DIR, THUMBS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── Agent registry ───────────────────────────────────────────────────────────
const AGENTS = [
  { name: 'ltdan',      label: 'LtDan',      color: '#5b7fff' },
  { name: 'bayou',      label: 'Bayou',       color: '#4ade80' },
  { name: 'wesley',     label: 'Wesley',      color: '#f59e0b' },
  { name: 'greenbow',   label: 'Greenbow',    color: '#10b981' },
  { name: 'danwatch',   label: 'DanWatch',    color: '#ef4444' },
  { name: 'feather',    label: 'Feather',     color: '#a78bfa' },
  { name: 'jenny',      label: 'Jenny',       color: '#ec4899' },
  { name: 'bubbawatch', label: 'BubbaWatch',  color: '#6366f1' },
  { name: 'sully',      label: 'Sully',       color: '#14b8a6' },
];

// ─── Agent WebSocket endpoints (loaded from config) ──────────────────────────
const AGENT_WS_URLS = config.agentWsUrls || {};

// Legacy HTTP webhook fallback (loaded from config)
const AGENT_HOOKS = config.agentHooks || {};
// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);

// ─── APN Push Notifications ─────────────────────────────────────────────────
const apnConfig = config.apn || {};
if (apnConfig.keyId && apnConfig.teamId) {
  apnModule.init({
    keyPath: path.join(ROOT, apnConfig.keyPath || 'config/apn-key.p8'),
    keyId: apnConfig.keyId,
    teamId: apnConfig.teamId,
  }, db);
}
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
    targets TEXT,
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
try { db.exec(`ALTER TABLE conversations ADD COLUMN conv_type TEXT DEFAULT 'human'`); } catch(_) {}

// ─── MESH Consolidation: delivery tracking + dedup tables ────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS message_delivery (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    target_agent TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 4,
    next_retry_at TEXT,
    delivered_at TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(message_id, target_agent)
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_status ON message_delivery(status, next_retry_at);
  CREATE INDEX IF NOT EXISTS idx_delivery_agent ON message_delivery(target_agent, status);

  CREATE TABLE IF NOT EXISTS dedup_cache (
    dedup_key TEXT PRIMARY KEY,
    first_seen TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    message_id TEXT,
    count INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_dedup_expires ON dedup_cache(expires_at);
`);

// Seed agent_presence if empty
const presenceCount = db.prepare('SELECT COUNT(*) as c FROM agent_presence').get();
if (presenceCount.c === 0) {
  const ins = db.prepare('INSERT OR IGNORE INTO agent_presence (agent_name, status) VALUES (?, ?)');
  for (const a of AGENTS) ins.run(a.name, 'unknown');
}


// ─── Delivery & Dedup Helpers ─────────────────────────────────────────────────
const crypto = require('crypto');

function dedupKey(sender, convId, body) {
  const sig = (sender || '') + '|' + (convId || '') + '|' + (body || '').slice(0, 200);
  return crypto.createHash('sha256').update(sig).digest('hex').slice(0, 32);
}

function checkDedup(sender, convId, body, windowHours = 4) {
  const key = dedupKey(sender, convId, body);
  const now = new Date();
  // Purge expired
  db.prepare("DELETE FROM dedup_cache WHERE expires_at < ?").run(now.toISOString());
  const existing = db.prepare("SELECT * FROM dedup_cache WHERE dedup_key = ?").get(key);
  if (existing) {
    db.prepare("UPDATE dedup_cache SET count = count + 1 WHERE dedup_key = ?").run(key);
    return { duplicate: true, firstMessageId: existing.message_id, count: existing.count + 1 };
  }
  const expiresAt = new Date(now.getTime() + windowHours * 3600 * 1000).toISOString();
  // Will be stored after message is created — return key for later insertion
  return { duplicate: false, key, expiresAt };
}

function storeDedupEntry(key, expiresAt, messageId) {
  try {
    db.prepare("INSERT OR IGNORE INTO dedup_cache (dedup_key, expires_at, message_id) VALUES (?, ?, ?)").run(key, expiresAt, messageId);
  } catch(_) {}
}

function createDeliveryRecord(messageId, targetAgent) {
  try {
    db.prepare(`INSERT OR IGNORE INTO message_delivery (id, message_id, target_agent, status, next_retry_at)
      VALUES (?, ?, ?, 'pending', datetime('now', '+30 seconds'))`
    ).run(uuidv4(), messageId, targetAgent);
  } catch(e) {
    console.warn('[Delivery] Failed to create record:', e.message);
  }
}

function markDelivered(messageId, targetAgent) {
  try {
    db.prepare(`UPDATE message_delivery SET status = 'delivered', delivered_at = datetime('now')
      WHERE message_id = ? AND target_agent = ?`).run(messageId, targetAgent);
  } catch(_) {}
}

function getDeadLetters() {
  return db.prepare(`SELECT md.*, m.body, m.sender, m.conversation_id, m.timestamp
    FROM message_delivery md LEFT JOIN messages m ON md.message_id = m.id
    WHERE md.status = 'dead' ORDER BY md.created_at DESC LIMIT 100`).all();
}

function retryDeadLetter(deliveryId) {
  const rec = db.prepare("SELECT * FROM message_delivery WHERE id = ?").get(deliveryId);
  if (!rec) return null;
  db.prepare(`UPDATE message_delivery SET status = 'pending', retry_count = 0,
    next_retry_at = datetime('now') WHERE id = ?`).run(deliveryId);
  return rec;
}

// Retry engine: check pending deliveries, attempt to re-deliver to reconnected agents
function runRetryEngine() {
  try {
    const now = new Date().toISOString();
    const pending = db.prepare(`SELECT md.*, m.id as msg_id, m.conversation_id, m.sender,
      m.body, m.type, m.timestamp, m.targets
      FROM message_delivery md JOIN messages m ON md.message_id = m.id
      WHERE md.status = 'pending' AND md.next_retry_at <= ?
      ORDER BY md.created_at ASC LIMIT 50`).all(now);

    for (const rec of pending) {
      const agentState = agentWsState[rec.target_agent];
      const isConnected = agentState && agentState.ws &&
        agentState.ws.readyState === 1; // WebSocket.OPEN

      if (isConnected) {
        // Agent is online — push the message
        const payload = JSON.stringify({
          type: 'message',
          message: {
            id: rec.msg_id,
            conversation_id: rec.conversation_id,
            sender: rec.sender,
            body: rec.body,
            type: rec.type,
            timestamp: rec.timestamp,
            targets: rec.targets ? JSON.parse(rec.targets) : null,
            _retry: true,
            _retryCount: rec.retry_count + 1
          }
        });
        try {
          agentState.ws.send(payload);
          markDelivered(rec.msg_id, rec.target_agent);
          console.log(`[Retry] Delivered msg ${rec.msg_id} to ${rec.target_agent} (attempt ${rec.retry_count + 1})`);
        } catch(e) {
          escalateDeliveryFailure(rec, e.message);
        }
      } else {
        // Agent offline — escalate with backoff
        escalateDeliveryFailure(rec, 'Agent offline');
      }
    }
  } catch(e) {
    console.error('[RetryEngine] Error:', e.message);
  }
}

function escalateDeliveryFailure(rec, errMsg) {
  const newCount = rec.retry_count + 1;
  if (newCount >= rec.max_retries) {
    db.prepare(`UPDATE message_delivery SET status = 'dead', retry_count = ?, error = ?
      WHERE id = ?`).run(newCount, errMsg, rec.id);
    console.warn(`[Delivery] Dead letter: msg ${rec.message_id} → ${rec.target_agent} after ${newCount} retries`);
  } else {
    // Exponential backoff: 30s, 60s, 120s, 240s
    const backoffSec = Math.pow(2, newCount) * 15;
    const nextRetry = new Date(Date.now() + backoffSec * 1000).toISOString();
    db.prepare(`UPDATE message_delivery SET retry_count = ?, next_retry_at = ?, error = ?
      WHERE id = ?`).run(newCount, nextRetry, errMsg, rec.id);
  }
}

// Start retry engine — runs every 30 seconds
setInterval(runRetryEngine, 30000);


// Prepared statements
const stmts = {
  insertMsg: db.prepare(`
    INSERT OR REPLACE INTO messages
      (id,conversation_id,sender,sender_type,type,subject,body,file_path,file_name,file_size,file_type,thumbnail_path,timestamp,reply_to,targets)
    VALUES
      (@id,@conversation_id,@sender,@sender_type,@type,@subject,@body,@file_path,@file_name,@file_size,@file_type,@thumbnail_path,@timestamp,@reply_to,@targets)
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
    ORDER BY timestamp DESC LIMIT 100
  `),
  getMsgsByConvSince: db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id=@conv AND timestamp > @since
    ORDER BY timestamp ASC LIMIT 200
  `),
  getConversations: db.prepare(`
    SELECT c.id, c.title, c.last_message_at, c.participant_count, c.created_at,
           c.pinned, c.deleted, c.conv_type, c.category,
           m.sender AS last_sender, m.body AS last_body,
           m.file_name AS last_file_name, m.file_type AS last_file_type
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

// ─── Per-agent WebSocket connections ─────────────────────────────────────────
// agentWsState[agentName] = { ws, connected, reconnectDelay, reconnectTimer, authed }
const agentWsState = {};
const PULSE_MAX_DELAY = 30000;

function connectAgentWs(agentName) {
  const url = AGENT_WS_URLS[agentName];
  if (!url) return;

  const state = agentWsState[agentName];

  // Kill existing connection if any
  if (state.ws) {
    try { state.ws.terminate(); } catch(_) {}
    state.ws = null;
  }

  console.log(`[Pulse:${agentName}] Connecting to ${url}...`);
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.on('open', () => {
    console.log(`[Pulse:${agentName}] Connected — authenticating`);
    clearTimeout(state.reconnectTimer);

    // Send auth handshake
    ws.send(JSON.stringify({
      type: 'auth',
      token: PULSE_TOKEN,
      agent: PEER_ID,
      version: '1.0',
    }));
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(_) { return; }

    // Auth acknowledgement
    if (msg.type === 'auth-ok') {
      state.connected = true;
      state.authed = true;
      state.reconnectDelay = 1000;  // reset backoff on successful auth
      console.log(`[Pulse:${agentName}] Auth OK — connection ready`);
      stmts.upsertPresence.run(agentName, 'online', null);
      broadcast('agent_presence', { agent: agentName, status: 'online' });

      // After reconnect, check for unanswered messages in the last 5 minutes
      // ONLY retry messages that were originally targeted at this agent (or had no targets = broadcast)
      try {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const unanswered = db.prepare(`
          SELECT m.id, m.body, m.conversation_id, m.timestamp, m.targets
          FROM messages m
          WHERE m.sender = 'Richard' 
            AND m.timestamp > ?
            AND m.conversation_id IN (
              SELECT cp.conversation_id FROM conversation_participants cp WHERE cp.agent_name = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM messages m2 
              WHERE m2.conversation_id = m.conversation_id 
                AND m2.sender = ?
                AND m2.timestamp > m.timestamp
            )
          ORDER BY m.timestamp DESC LIMIT 1
        `).all(fiveMinAgo, agentName, agentName);
        
        // Filter: only retry messages that targeted this agent (or were broadcasts with no targets)
        const relevant = unanswered.filter(msg => {
          if (!msg.targets) return true;  // no targets = broadcast to all
          try {
            const targetList = JSON.parse(msg.targets);
            return targetList.includes(agentName) || targetList.includes('all');
          } catch(_) { return true; }  // malformed targets = treat as broadcast
        });

        if (relevant.length > 0) {
          console.log(`[Pulse:${agentName}] Found ${relevant.length} targeted unanswered message(s) after reconnect — retrying (filtered ${unanswered.length - relevant.length} non-targeted)`);
          for (const msg of relevant) {
            const hist = db.prepare('SELECT sender, body FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT 20').all(msg.conversation_id).reverse();
            postToAgent(agentName, msg.conversation_id, msg.body, hist, null, null);
          }
        }
      } catch(e) {
        console.warn(`[Pulse:${agentName}] Reconnect retry check failed: ${e.message}`);
      }

      return;
    }

    // Auth failure
    if (msg.type === 'auth-error' || msg.type === 'auth-fail') {
      console.error(`[Pulse:${agentName}] Auth failed:`, msg.reason || msg.message || '');
      return;
    }

    // Response from agent
    if (msg.type === 'response') {
      const from = msg.from || agentName;
      const payload = msg.payload || {};
      const convId = payload.conversationId || msg.conversationId || `pulse-${from}`;
      let msgBody = payload.body || payload.text || msg.body || '';

      // Agent file/media attachments
      if (payload.media && Array.isArray(payload.media)) {
        for (const m of payload.media) {
          if (m.url) {
            const ext = (m.url.split('.').pop() || 'bin').split('?')[0].slice(0, 8);
            const fname = require('crypto').randomUUID() + '.' + ext;
            const fpath = require('path').join(UPLOADS_DIR, fname);
            try {
              const resp = await fetch(m.url);
              const buf = Buffer.from(await resp.arrayBuffer());
              require('fs').writeFileSync(fpath, buf);
              msgBody += `\n\n![${m.fileName || fname}](/uploads/${fname})`;
            } catch(e) {
              console.warn('[Media] Failed to download agent attachment:', e.message);
              msgBody += `\n\n[Attachment: ${m.url}]`;
            }
          }
        }
      }

      if (!msgBody) return;

      // Suppress NO_REPLY and HEARTBEAT_OK — these are agent internal signals, not user-visible
      const trimmedBody = msgBody.trim();
      if (trimmedBody === 'NO_REPLY' || trimmedBody === 'HEARTBEAT_OK' || /NO_REPLY/i.test(trimmedBody)) {
        console.log(`[Pulse:${agentName}] Suppressed NO_REPLY/HEARTBEAT_OK for conv ${convId}`);
        return;
      }

      console.log(`[Pulse:${agentName}] Response received for conv ${convId} (${msgBody.length} chars)`);

      // Track last uploaded file for structured file fields
      let lastFile = null;
      if (payload.media && Array.isArray(payload.media)) {
        for (const m of payload.media) {
          if (m._storedPath) lastFile = m;
        }
      }

      const stored = {
        id: msg.id || uuidv4(),
        conversation_id: convId,
        sender: from,
        sender_type: 'agent',
        type: lastFile ? 'file' : 'message',
        subject: payload.subject || null,
        body: msgBody,
        file_path: lastFile ? lastFile._storedPath : null,
        file_name: lastFile ? (lastFile.fileName || lastFile._storedPath) : null,
        file_size: lastFile ? (lastFile._size || null) : null,
        file_type: lastFile ? (lastFile.mimeType || lastFile.contentType || null) : null,
        thumbnail_path: null,
        timestamp: msg.timestamp || new Date().toISOString(),
      };

      storeMessage(stored);
      relayAgentMentions(stored).catch(e => console.warn('[Relay] Error:', e.message));
      stmts.upsertPresence.run(from, 'online', null);
      broadcast('agent_presence', { agent: from, status: 'online' });
      broadcast('typing_stop', { agentName: from, conversationId: convId });
      return;
    }

    // Streaming response chunk — one block from the LLM dispatcher
    if (msg.type === 'response-chunk') {
      const from = msg.from || agentName;
      const payload = msg.payload || {};
      const streamId = msg.streamId;
      const chunkIndex = msg.index || 0;
      const convId = payload.conversationId || msg.conversationId || `pulse-${from}`;
      const chunkBody = payload.body || payload.text || '';

      if (!streamId || !chunkBody) return;

      // Accumulate stream state in memory
      if (!agentWsState[agentName]._streams) agentWsState[agentName]._streams = {};
      const streams = agentWsState[agentName]._streams;

      if (!streams[streamId]) {
        // First chunk — create a placeholder message in DB
        const msgId = uuidv4();
        streams[streamId] = {
          msgId,
          convId,
          from,
          body: chunkBody,
          timestamp: msg.timestamp || new Date().toISOString(),
        };
        // Insert initial message row
        const initialMsg = {
          id: msgId,
          conversation_id: convId,
          sender: from,
          sender_type: 'agent',
          type: 'message',
          subject: null,
          body: chunkBody,
          file_path: null, file_name: null, file_size: null, file_type: null, thumbnail_path: null,
          timestamp: msg.timestamp || new Date().toISOString(),
          reply_to: null,
          targets: null,
        };
        // Use INSERT OR REPLACE so we can update later
        stmts.insertMsg.run(initialMsg);
        if (convId) {
          stmts.upsertConv.run({
            id: convId,
            title: convId,
            last_message_at: initialMsg.timestamp,
          });
        }
        stmts.upsertPresence.run(from, 'online', null);
        console.log(`[Pulse:${agentName}] Stream ${streamId} started (chunk 0, conv ${convId})`);
        // Auto-timeout: close stream if no chunk in 60s
        streams[streamId]._timeout = setTimeout(() => {
          if (streams[streamId]) {
            console.log(`[Pulse:${agentName}] Stream ${streamId} TIMED OUT (60s) — force-closing`);
            broadcast("message_complete", { streamId, conversationId: convId, msgId: streams[streamId].msgId, sender: from, body: streams[streamId].body });
            broadcast("thinking", { agent: from, conversationId: convId, thinking: false });
            delete streams[streamId];
          }
        }, 60000);
      } else {
        // Subsequent chunk — append text and UPDATE the DB row
        // Reset stream timeout
        if (streams[streamId]._timeout) clearTimeout(streams[streamId]._timeout);
        streams[streamId]._timeout = setTimeout(() => {
          if (streams[streamId]) {
            console.log(`[Pulse:${agentName}] Stream ${streamId} TIMED OUT (60s)`);
            broadcast("message_complete", { streamId, conversationId: streams[streamId].convId, msgId: streams[streamId].msgId, sender: from, body: streams[streamId].body });
            broadcast("thinking", { agent: from, conversationId: streams[streamId].convId, thinking: false });
            delete streams[streamId];
          }
        }, 60000);
        streams[streamId].body += chunkBody;
        try {
          db.prepare('UPDATE messages SET body = ? WHERE id = ?').run(
            streams[streamId].body,
            streams[streamId].msgId
          );
        } catch(e) {
          console.warn(`[Pulse:${agentName}] Stream update error: ${e.message}`);
        }
        console.log(`[Pulse:${agentName}] Stream ${streamId} chunk ${chunkIndex} (total ${streams[streamId].body.length} chars)`);
      }

      // Broadcast SSE chunk event to frontends
      broadcast('message_chunk', {
        streamId,
        conversationId: convId,
        msgId: streams[streamId].msgId,
        body: streams[streamId].body,
        sender: from,
        index: chunkIndex,
      });
      return;
    }

    // Streaming response complete
    if (msg.type === 'response-end') {
      const from = msg.from || agentName;
      const streamId = msg.streamId;
      const payload = msg.payload || {};
      const convId = payload.conversationId || msg.conversationId || `pulse-${from}`;

      if (!streamId) return;

      const streams = agentWsState[agentName]._streams || {};
      const stream = streams[streamId];

      if (stream) {
        // Clear stream timeout
        if (stream._timeout) clearTimeout(stream._timeout);

        // Suppress NO_REPLY/HEARTBEAT_OK streams — delete the partial message and don't broadcast
        const streamTrimmed = (stream.body || '').trim();
      if (streamTrimmed === 'NO_REPLY' || streamTrimmed === 'HEARTBEAT_OK' || /NO_REPLY/i.test(streamTrimmed)) {
          console.log(`[Pulse:${agentName}] Suppressed NO_REPLY stream ${streamId} for conv ${stream.convId}`);
          // Delete the partial message that was stored during streaming
          try { db.prepare('DELETE FROM messages WHERE id = ?').run(stream.msgId); } catch(_) {}
          broadcast('message_deleted', { id: stream.msgId, conversationId: stream.convId });
          broadcast('typing_stop', { agentName: stream.from, conversationId: stream.convId });
          delete streams[streamId];
          return;
        }

        console.log(`[Pulse:${agentName}] Stream ${streamId} complete (${stream.body.length} chars, conv ${stream.convId})`);

        // Broadcast SSE completion event
        broadcast('message_complete', {
          streamId,
          conversationId: stream.convId,
          msgId: stream.msgId,
          sender: stream.from,
        });

        // Update conversation last_message_at with final body
        if (stream.convId) {
          stmts.upsertConv.run({
            id: stream.convId,
            title: stream.convId,
            last_message_at: stream.timestamp,
          });
        }

        // Broadcast the final complete message so the conversation list updates
        const finalMsg = {
          id: stream.msgId,
          conversation_id: stream.convId,
          sender: stream.from,
          sender_type: 'agent',
          type: 'message',
          subject: null,
          body: stream.body,
          file_path: null, file_name: null, file_size: null, file_type: null, thumbnail_path: null,
          timestamp: stream.timestamp,
        };
        // Broadcast message event (using the already-stored id, dedup will skip re-insert)
        const payload2 = `event: message
data: ${JSON.stringify(finalMsg)}

`;
        for (const res of sseClients) {
          try { res.write(payload2); } catch(_) { sseClients.delete(res); }
        }

        broadcast('agent_presence', { agent: stream.from, status: 'online' });
        broadcast('typing_stop', { agentName: stream.from, conversationId: stream.convId });

        // Relay @mentions to other agents from the completed response
        relayAgentMentions(finalMsg).catch(e => console.warn('[Relay] Error:', e.message));

        // Cleanup stream state
        delete streams[streamId];
      } else {
        // No stream state (may have been lost on reconnect) — just signal complete
        broadcast('message_complete', {
          streamId,
          conversationId: convId,
          sender: from,
        });
        broadcast('typing_stop', { agentName: from, conversationId: convId });
      }
      return;
    }

    // Presence / peer announcements
    if (msg.type === 'peers' || msg.type === 'presence') {
      const peers = msg.peers || msg.agents || [];
      for (const peer of peers) {
        const name = typeof peer === 'string' ? peer : peer.agent || peer.name;
        if (name && name !== PEER_ID) {
          stmts.upsertPresence.run(name, 'online', null);
        }
      }
      broadcast('agent_presence', { peers });
      return;
    }

    // Generic protocol message (pulse/1.0 envelope from the agent hub)
    if (msg.protocol === 'pulse/1.0' && msg.from) {
      if (msg.from === PEER_ID) return;
      if (msg.from === 'richard' || msg.from === 'Richard') return;
      if (msg.payload && (msg.payload.sender === 'Richard' || msg.payload.sender === 'richard')) return;

      const convId = msg.conversationId || msg.conv_id || `pulse-${msg.from}`;
      const msgBody = (msg.payload && (msg.payload.body || msg.payload.text || msg.payload.subject))
        || msg.body || '';
      const subject = (msg.payload && msg.payload.subject) || msg.subject || null;

      if (!msgBody) return;

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
      relayAgentMentions(stored).catch(e => console.warn('[Relay] Error:', e.message));
      stmts.upsertPresence.run(msg.from, 'online', null);
      broadcast('agent_presence', { agent: msg.from, status: 'online' });
      broadcast('typing_stop', { agentName: msg.from, conversationId: convId });
    }
  });

  ws.on('error', (err) => {
    // Only log once per cycle to avoid spam during reconnect
    if (state.connected || !state._lastErrTime || Date.now() - state._lastErrTime > 30000) {
      console.warn(`[Pulse:${agentName}] Error: ${err.message}`);
      state._lastErrTime = Date.now();
    }
    state.connected = false;
    state.authed = false;
  });

  ws.on('close', () => {
    const wasConnected = state.connected;
    state.connected = false;
    state.authed = false;
    state.ws = null;
    if (wasConnected) {
      console.log(`[Pulse:${agentName}] Disconnected — reconnecting in ${state.reconnectDelay}ms`);
      stmts.upsertPresence.run(agentName, 'offline', null);
      broadcast('agent_presence', { agent: agentName, status: 'offline' });
    }
    state.reconnectTimer = setTimeout(() => {
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, PULSE_MAX_DELAY);
      connectAgentWs(agentName);
    }, state.reconnectDelay);
  });
}

// Initialize state and connect all agents
for (const agentName of Object.keys(AGENT_WS_URLS)) {
  agentWsState[agentName] = {
    ws: null,
    connected: false,
    authed: false,
    reconnectDelay: 1000,
    reconnectTimer: null,
  };
  // Stagger connections slightly to avoid thundering herd
  const idx = Object.keys(AGENT_WS_URLS).indexOf(agentName);
  setTimeout(() => connectAgentWs(agentName), idx * 200);
}

// ─── Send message via per-agent WebSocket ─────────────────────────────────────
const sentMsgIds = new Set();

function sendViaAgentWs(agentName, conversationId, messageText, sender, media) {
  const state = agentWsState[agentName];
  if (!state || !state.connected || !state.authed || !state.ws) {
    return false;
  }

  const payload = {
    body: messageText,
    conversationId: conversationId,
    sender: sender || 'Richard',
  };
  if (media && media.length > 0) {
    payload.media = media;
    console.log('[sendViaAgentWs:' + agentName + '] Sending ' + media.length + ' media attachment(s): ' + media.map(m => m.url).join(', '));
  }

  const envelope = {
    id: uuidv4(),
    type: 'message',
    from: PEER_ID,
    to: agentName,
    payload,
    timestamp: new Date().toISOString(),
  };

  sentMsgIds.add(envelope.id);
  setTimeout(() => sentMsgIds.delete(envelope.id), 5 * 60 * 1000);

  try {
    state.ws.send(JSON.stringify(envelope));
    console.log(`[Pulse:${agentName}] Message sent for conv ${conversationId}`);
    return true;
  } catch(e) {
    console.warn(`[Pulse:${agentName}] Send failed: ${e.message}`);
    state.connected = false;
    state.authed = false;
    return false;
  }
}

// ─── Jenny Brain Search ──────────────────────────────────────────────────────
async function searchJennyBrain(query, agentName, topK = 3) {
  try {
    const res = await fetch((config.jennyBrainUrl || 'http://localhost:8900') + '/search', {
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
    return `\n\n[Jenny\'s Brain - relevant memories for ${agentName}:]\n${summaries}`;
  } catch(e) {
    return '';
  }
}

// ─── Agent history helper ─────────────────────────────────────────────────────
function getAgentHistory(agentName) {
  const countRow = db.prepare(`
    SELECT COUNT(DISTINCT cp.conversation_id) as count
    FROM conversation_participants cp
    JOIN conversations c ON c.id = cp.conversation_id
    WHERE cp.agent_name = ? AND (c.deleted IS NULL OR c.deleted = 0)
  `).get(agentName);

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

// ─── Post to agent (WS primary, HTTP fallback) ────────────────────────────────
// ─── Agent relay: detect @mentions in agent responses and forward ────────────
const AGENT_RELAY_DEPTH = 0;  // DISABLED: agent-to-agent relay causes chain reactions. Agents use pulsenet-send.sh directly.  // max relay hops to prevent loops
const relayTracker = new Map();  // conversationId -> { depth, lastRelay }

async function relayAgentMentions(msg) {
  if (msg.sender_type !== 'agent') return;
  if (!msg.body) return;
  
  const convId = msg.conversation_id;
  const tracker = relayTracker.get(convId) || { depth: 0, lastRelay: 0 };
  
  // Rate limit: no more than AGENT_RELAY_DEPTH consecutive agent-to-agent relays
  const now = Date.now();
  if (now - tracker.lastRelay > 60000) {
    tracker.depth = 0;  // reset if more than 60s since last relay
  }
  if (tracker.depth >= AGENT_RELAY_DEPTH) {
    console.log(`[Relay:${convId}] Max relay depth ${AGENT_RELAY_DEPTH} reached — stopping chain`);
    return;
  }
  
  // Detect @mentions of agents in the response
  const mentionPattern = /@(\w+)/g;
  let match;
  const mentionedAgents = new Set();
  while ((match = mentionPattern.exec(msg.body)) !== null) {
    const name = match[1].toLowerCase();
    const agent = AGENTS.find(a => a.name === name);
    if (agent && agent.name !== msg.sender.toLowerCase()) {
      mentionedAgents.add(agent.name);
    }
  }
  
  if (mentionedAgents.size === 0) return;
  
  // Dedup: check if these agents were already directly targeted by the original human message
  // Look at the most recent human message in this conversation to get its targets
  try {
    const lastHumanMsg = db.prepare(
      "SELECT targets FROM messages WHERE conversation_id = ? AND sender_type = 'human' ORDER BY timestamp DESC LIMIT 1"
    ).get(convId);
    if (lastHumanMsg && lastHumanMsg.targets) {
      const originalTargets = JSON.parse(lastHumanMsg.targets);
      for (const t of originalTargets) {
        if (mentionedAgents.has(t)) {
          console.log(`[Relay:${msg.sender}] Skipping @${t} — already in original targets`);
          mentionedAgents.delete(t);
        }
      }
      if (mentionedAgents.size === 0) {
        console.log(`[Relay:${msg.sender}] All mentioned agents already targeted — no relay needed`);
        return;
      }
    }
  } catch(_) {}
  
  console.log(`[Relay:${msg.sender}] Detected @mentions: ${[...mentionedAgents].join(', ')} — forwarding`);
  
  // Update tracker
  tracker.depth++;
  tracker.lastRelay = now;
  relayTracker.set(convId, tracker);
  
  // Build conversation history
  // Tiered context: Start with 20 messages (Tier 1), agents can request more
  const TIER1_LIMIT = 20;
  const TIER2_LIMIT = 100;
  const histRows = db.prepare('SELECT sender, sender_type, body, type, file_path, file_name, file_type, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?').all(convId, TIER1_LIMIT).reverse();
  const hist = histRows.map(r => ({ sender: r.sender, body: r.body }));
  const totalMsgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?').get(convId)?.c || 0;
  
  for (const agentName of mentionedAgents) {
    const agentHistory = getAgentHistory(agentName);
    let previousContext = null;
    if (agentHistory.count > 0) {
      const titles = agentHistory.recentTitles.filter(Boolean).slice(0, 3);
      previousContext = '[Previous context: You have had ' + agentHistory.count + ' conversation' + (agentHistory.count !== 1 ? 's' : '') + ' with Richard on PulseNet. Most recent topics: ' + titles.join(', ') + ']';
    }
    
    // Frame as agent-to-agent message, not Richard's message
    const relayBody = '[PulseNet:' + convId + '] ' + msg.sender + ' says (addressing you): ' + msg.body + (previousContext ? '\n\n' + previousContext : '') + (hist.length > 0 ? '\n\nConversation so far:\n' + hist.slice(-15).map(h => h.sender + ': ' + (h.body || '').substring(0, 200)).join('\n') : '');
    
    broadcast('typing_start', { agentName, conversationId: convId });
    
    const wsSent = sendViaAgentWs(agentName, convId, relayBody, msg.sender);
    if (!wsSent) {
      // HTTP fallback
      const hook = AGENT_HOOKS[agentName];
      if (hook) {
        try {
          await fetch(hook.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + hook.token },
            body: JSON.stringify({ message: relayBody, sessionKey: 'hook:' + PEER_ID + ':' + convId }),
            signal: AbortSignal.timeout(10000),
          });
        } catch(e) {
          console.warn('[Relay:' + agentName + '] Failed:', e.message);
        }
      }
    }
  }
}

async function postToAgent(agentName, conversationId, messageText, history, previousContext, media, targetHint) {
  // Build full message body with conversation history
  const histText = history.slice(-20).map(h => `${h.sender}: ${(h.body || '').substring(0, 200)}`).join('\n');
  const contextLine = previousContext ? `\n\n${previousContext}` : '';
  const brainContext = await searchJennyBrain(messageText, agentName);

  let fullBody = `[PulseNet:${conversationId}] Richard says: ${messageText}${contextLine}${histText ? '\n\nConversation so far:\n' + histText : ''}${brainContext}`;

  // Try WebSocket first
  // If this message was targeted at specific agents, tell the receiving agent
  if (targetHint && targetHint.length > 0 && !targetHint.includes('all')) {
    const isTargeted = targetHint.includes(agentName);
    if (isTargeted) {
      fullBody = '[IMPORTANT: You are being directly addressed by @mention. You MUST provide a substantive response. Do NOT reply with NO_REPLY or HEARTBEAT_OK. Read the conversation history carefully and respond helpfully.]\n' + fullBody;
    } else {
      fullBody = '[Note: This message was addressed to ' + targetHint.join(', ') + ', not you. Only respond if you have something uniquely valuable to add.]\n' + fullBody;
    }
  }

  const wsSent = sendViaAgentWs(agentName, conversationId, fullBody, 'Richard', media);
  if (wsSent) {
    return true;
  }

  // Fall back to HTTP webhook
  const hook = AGENT_HOOKS[agentName];
  if (!hook) {
    console.warn(`[postToAgent] No hook config for ${agentName}`);
    return false;
  }

  console.log(`[postToAgent:${agentName}] WS not ready — falling back to HTTP webhook`);
  const payload = {
    message: fullBody,
    sessionKey: `hook:${PEER_ID}:${conversationId}`,
  };

  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${hook.token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[Webhook:${agentName}] HTTP fallback: ${res.status}`);
    return res.ok;
  } catch(e) {
    console.warn(`[Webhook:${agentName}] HTTP fallback failed: ${e.message}`);
    return false;
  }
}

// ─── Presence polling (via agent WS connection states) ────────────────────────
function updatePresenceFromWsStates() {
  for (const [agentName, state] of Object.entries(agentWsState)) {
    const status = state.connected ? 'online' : 'offline';
    stmts.upsertPresence.run(agentName, status, null);
  }
  broadcast('presence_update', stmts.getPresence.all());
}
setInterval(updatePresenceFromWsStates, 30000);
setTimeout(updatePresenceFromWsStates, 5000);

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
const DEDUP_WINDOW = 5 * 60 * 1000;

// ─── Undo Send: pending dispatch timers ───────────────────────────────────────
const pendingDispatches = new Map();  // msgId -> { timer, cancelled }
const DISPATCH_DELAY_MS = 2000;

// ─── Upload dedup: prevent rapid-fire duplicate file uploads ──────────────────
const recentUploads = new Map();  // key -> timestamp
const UPLOAD_DEDUP_WINDOW = 5000;  // 5 second window
function uploadDedupKey(convId, sender, body, fileName) {
  return convId + ':' + sender + ':' + (body || '').substring(0, 50) + ':' + (fileName || '');
}
  // 4 second undo window


// ─── Push notification sender ─────────────────────────────────────────────────
async function sendPushNotifications(msg) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  if (msg.sender_type !== 'agent') return;
  if (!msg.body || msg.body.length < 2) return;

  const agent = AGENTS.find(a => a.name === msg.sender) || {};
  // Context-aware push notification title
  let pushTitle = '\u{1F990} ' + (agent.label || agent.name || msg.sender);
  try {
    const pushConv = db.prepare('SELECT title, conv_type FROM conversations WHERE id = ?').get(msg.conversation_id);
    if (pushConv && pushConv.conv_type === 'report') {
      pushTitle = '\u{1F4CB} ' + (pushConv.title || 'Report') + ' \u2014 ' + msg.sender;
    } else if (pushConv && pushConv.conv_type === 'agent') {
      pushTitle = '\u{1F916} Agent Chat \u2014 ' + msg.sender;
    }
  } catch(_) {}
  const title = pushTitle;
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

  // APN push to iOS devices
  try {
    await apnModule.sendPush('Richard', {
      title,
      body: bodyText,
      conversationId: msg.conversation_id || 'general',
      messageId: msg.id,
    });
  } catch (apnErr) {
    console.warn('[APN] Push error:', apnErr.message);
  }
}

function storeMessage(msg) {
  if (msg.sender === PEER_ID || msg.sender === PEER_ID.charAt(0).toUpperCase() + PEER_ID.slice(1)) return null;
  if (recentMsgIds.has(msg.id)) return null;
  const existing = db.prepare('SELECT id FROM messages WHERE id = ?').get(msg.id);
  if (existing) return null;
  recentMsgIds.add(msg.id);
  setTimeout(() => recentMsgIds.delete(msg.id), DEDUP_WINDOW);

  if (msg.reply_to === undefined) msg.reply_to = null;
  if (msg.targets === undefined) msg.targets = null;
  stmts.insertMsg.run(msg);
  if (msg.conversation_id) {
    stmts.upsertConv.run({
      id: msg.conversation_id,
      title: msg.conversation_id,
      last_message_at: msg.timestamp,
    });
  }
  broadcast('message', msg);
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
  // No cache for JS/CSS/HTML (iOS Safari is aggressive); cache images/uploads
  const isCode = filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html');
  const cacheHeader = isCode ? 'no-cache, no-store, must-revalidate' : 'public, max-age=86400';
  res.writeHead(200, {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cacheHeader,
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
    '.svg':'image/svg+xml','.ipa':'application/octet-stream','.plist':'text/xml',
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
      const sent = sendViaAgentWs(agent.name, conversationId, msgBody, 'Richard');
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
      const sent = sendViaAgentWs(name, conversationId, question, 'Richard');
      results.push({ agent: name, sent });
    }
    return { ok: true, type: 'rally', targets: targetNames, question };
  }

  if (trimmed === '/stop') {
    // Cancel all pending dispatches for this conversation
    let cancelled = 0;
    for (const [msgId, entry] of pendingDispatches.entries()) {
      const msg = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(msgId);
      if (msg && msg.conversation_id === conversationId) {
        entry.cancelled = true;
        clearTimeout(entry.timer);
        pendingDispatches.delete(msgId);
        cancelled++;
      }
    }
    // Stop all typing indicators for this conversation
    for (const agent of AGENTS) {
      broadcast('typing_stop', { agentName: agent.name, conversationId });
    }
    return { ok: true, type: 'stop', cancelled, message: cancelled > 0 ? 'Stopped ' + cancelled + ' pending dispatch(es)' : 'No pending dispatches (agents may already be processing)' };
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
    const agentQuery = new URL(req.url, 'http://localhost').searchParams.get('agent') || 'unknown';
    const convQuery = new URL(req.url, 'http://localhost').searchParams.get('conversation') || 'none';
    console.log('[SSE] Client connected: agent=' + agentQuery + ', conv=' + convQuery.substring(0,12) + '..., total=' + sseClients.size);

    // Send current WS connection status
    const wsStatus = {};
    for (const [name, state] of Object.entries(agentWsState)) {
      wsStatus[name] = state.connected;
    }
    res.write(`event: pulse_status\ndata: ${JSON.stringify({ connected: true, agents: wsStatus })}\n\n`);

    req.on('close', () => { sseClients.delete(res); clearInterval(heartbeat); console.log('[SSE] Client disconnected: agent=' + agentQuery + ', remaining=' + sseClients.size); });
    return;
  }

  // ── API ───────────────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) {

    // POST /api/devices — register iOS device for push notifications
    if (pathname === '/api/devices' && method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { userId, token, action } = data;
          if (!userId || !token) {
            res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ error: 'userId and token required' }));
            return;
          }
          if (action === 'log') {
            console.log('[APN:iOS]', token); // token contains the log message
            res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true, action: 'logged' }));
          } else if (action === 'unregister') {
            apnModule.unregisterDevice(userId, token);
            res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true, action: 'unregistered' }));
          } else {
            apnModule.registerDevice(userId, token);
            res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true, action: 'registered', tokens: apnModule.getTokenCount(userId) }));
          }
        } catch (e) {
          res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ error: e.message }));
        }
      });
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
        ws_connected: agentWsState[a.name]?.connected || false,
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
      const wsStatus = {};
      for (const [name, state] of Object.entries(agentWsState)) {
        wsStatus[name] = { connected: state.connected, authed: state.authed };
      }
      const presence = stmts.getPresence.all();
      json(res, { ok: true, ws_connections: wsStatus, cached_presence: presence, agents: AGENTS });
      return;
    }

    // GET /api/messages
    if (pathname === '/api/messages' && method === 'GET') {
      const conv = url.searchParams.get('conversation');
      if (conv) {
        const since = url.searchParams.get('since');
        if (since) {
          json(res, stmts.getMsgsByConvSince.all({ conv, since }));
        } else {
          json(res, stmts.getMsgsByConv.all({ conv }).reverse());
        }
      } else {
        const before = url.searchParams.get('before') || null;
        const rows = stmts.getMessages.all({ before });
        json(res, rows.reverse());
      }
      return;
    }

    // GET /api/messages/:conversationId
    if (pathname.startsWith('/api/messages/') && method === 'GET') {
      const conv = decodeURIComponent(pathname.slice('/api/messages/'.length));
      const since = url.searchParams.get('since');
      if (since) {
        json(res, stmts.getMsgsByConvSince.all({ conv, since }));
      } else {
        json(res, stmts.getMsgsByConv.all({ conv }).reverse());
      }
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

      let targets = (body.targets || (body.target ? [body.target] : [])).map(t => t.toLowerCase()).filter(t => t.length > 0);
      console.log('[Dispatch] Received targets:', JSON.stringify(targets), 'from sender:', body.sender, 'body:', (body.body || '').substring(0, 50));
      // Smart routing: if no @mentions, reply to the most recent agent (not broadcast to all)
      if (!targets || targets.length === 0) {
        const cid = body.conversationId || "general";
        // Find the most recent agent message in this conversation
        const lastAgent = db.prepare(
          "SELECT sender FROM messages WHERE conversation_id = ? AND sender_type = 'agent' ORDER BY timestamp DESC LIMIT 1"
        ).get(cid);
        if (lastAgent) {
          // Route to the last agent who spoke (conversational reply)
          targets = [lastAgent.sender.toLowerCase()];
          console.log('[SmartRoute] No @mention — routing to last agent: ' + targets[0]);
        } else {
          // No agent has spoken yet — broadcast to all participants
          const parts = db.prepare("SELECT agent_name FROM conversation_participants WHERE conversation_id = ?").all(cid);
          targets = parts.map(p => p.agent_name).filter(n => n !== body.sender);
          console.log('[SmartRoute] No @mention, no previous agent — broadcasting to ' + targets.length + ' participants');
        }
      }
      const msg = {
        id: uuidv4(),
        conversation_id: body.conversationId || 'general',
        sender: body.sender,
        sender_type: body.senderType || 'human',
        type: 'message',
        subject: body.subject || null,
        body: body.body,
        reply_to: body.replyTo || null,
        file_path: null, file_name: null, file_size: null, file_type: null, thumbnail_path: null,
        timestamp: new Date().toISOString(),
        targets: targets.length > 0 ? JSON.stringify(targets) : null,
      };
      storeMessage(msg);

      // ─── Delayed dispatch with undo window ──────────────────────────────
      const dispatchFn = () => {
        if (pendingDispatches.get(msg.id)?.cancelled) {
          console.log('[Dispatch] Cancelled for msg ' + msg.id);
          pendingDispatches.delete(msg.id);
          return;
        }
        pendingDispatches.delete(msg.id);

      // Build conversation history for context
      const histRows = db.prepare('SELECT sender, sender_type, body, type, file_path, file_name, file_type, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC').all(msg.conversation_id);
      const hist = histRows.map(r => ({ sender: r.sender, body: r.body }));

      // ─── Sequenced dispatch: supporters first, then coordinator ──────────
      // When multiple agents are targeted, the FIRST @mentioned is the coordinator.
      // Supporting agents respond first; coordinator gets their responses as context.
      // Expand targets — @all expands to all conversation participants
      const convParts = db.prepare('SELECT agent_name FROM conversation_participants WHERE conversation_id = ?').all(msg.conversation_id);
      const convParticipants = convParts.map(r => r.agent_name);
      const allAgents = [];
      for (const t of targets) {
        if (t === 'all') {
          // Use conversation participants if available, else fall back to global AGENTS
          const pool = convParticipants.length > 0 ? convParticipants : AGENTS.map(a => a.name);
          allAgents.push(...pool);
        } else {
          allAgents.push(t);
        }
      }
      const uniqueAgents = [...new Set(allAgents.map(a => a.toLowerCase()))];
      
      // Collect file attachments from the CURRENT interaction only (last 60s)
      // Fixes stale media bug where old uploads were re-attached to every dispatch
      const cutoff = new Date(Date.now() - 60000).toISOString();
      const recentFiles = histRows
        .filter(r => r.type === 'file' && r.file_path && r.timestamp > cutoff)
        .slice(-3)
        .map(r => ({
          url: (config.publicUrl || 'http://localhost:3000') + '/uploads/' + r.file_path,
          mimeType: r.file_type || 'application/octet-stream',
          fileName: r.file_name,
        }));
      const mediaArg = recentFiles.length > 0 ? recentFiles : undefined;
      
      if (uniqueAgents.length <= 1) {
        // Single agent — dispatch immediately
        for (const agentName of uniqueAgents) {
          const agentHistory = getAgentHistory(agentName);
          let previousContext = null;
          if (agentHistory.count > 0) {
            const titles = agentHistory.recentTitles.filter(Boolean).slice(0, 3);
            previousContext = `[Previous context: You have had ${agentHistory.count} conversation${agentHistory.count !== 1 ? 's' : ''} with Richard on PulseNet. Most recent topics: ${titles.join(', ')}]`;
          }
          broadcast('typing_start', { agentName, conversationId: msg.conversation_id });
          postToAgent(agentName, msg.conversation_id, msg.body, hist, previousContext, mediaArg, targets);
        }
      } else {
        // ─── Pipeline dispatch: agents run in @mention order ─────────────
        // @Bayou @Wesley = Bayou runs first, Wesley gets Bayou's response as context
        // Each agent sees all previous agents' responses before they start
        
        console.log(`[Pipeline] ${uniqueAgents.length} agents in sequence: ${uniqueAgents.join(' → ')}`);
        
        const runPipeline = async () => {
          const collectedResponses = [];  // { agent, body }
          
          for (let i = 0; i < uniqueAgents.length; i++) {
            const agentName = uniqueAgents[i];
            const isLast = (i === uniqueAgents.length - 1);
            
            // Check if dispatch was cancelled
            if (pendingDispatches.get(msg.id)?.cancelled) {
              console.log('[Pipeline] Cancelled — stopping at step ' + (i + 1));
              return;
            }
            
            // Build context from previous agents' responses
            let pipelineContext = '';
            if (collectedResponses.length > 0) {
              pipelineContext = '\n\n[PIPELINE CONTEXT: The following agent(s) have already responded to this request. ' +
                'Their responses are provided below for your reference. Build on their work' +
                (isLast ? ' and provide a final synthesis for Richard.' : '.') + ']\n\n' +
                collectedResponses.map(r => '--- ' + r.agent + ' said ---\n' + r.body).join('\n\n');
            }
            
            // Get fresh history (includes any new messages from previous pipeline steps)
            const freshHistRows = db.prepare('SELECT sender, sender_type, body, type, file_path, file_name, file_type, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC').all(msg.conversation_id);
            const freshHist = freshHistRows.map(r => ({ sender: r.sender, body: r.body }));
            
            const agentHistory = getAgentHistory(agentName);
            let previousContext = null;
            if (agentHistory.count > 0) {
              const titles = agentHistory.recentTitles.filter(Boolean).slice(0, 3);
              previousContext = `[Previous context: You have had ${agentHistory.count} conversation${agentHistory.count !== 1 ? 's' : ''} with Richard on PulseNet. Most recent topics: ${titles.join(', ')}]`;
            }
            
            console.log(`[Pipeline] Step ${i + 1}/${uniqueAgents.length}: dispatching ${agentName}` + (collectedResponses.length > 0 ? ` (with ${collectedResponses.length} prior response(s))` : ''));
            
            broadcast('typing_start', { agentName, conversationId: msg.conversation_id });
            postToAgent(agentName, msg.conversation_id, msg.body + pipelineContext, freshHist, previousContext, mediaArg, targets);
            
            // Wait for this agent's response before dispatching the next one
            // (Skip waiting for the last agent — they just need to respond normally)
            if (!isLast) {
              const startTime = Date.now();
              const maxWait = 60000;  // 60 seconds per agent
              const pollInterval = 2000;
              let responded = false;
              
              while (Date.now() - startTime < maxWait) {
                const newMsgs = db.prepare(
                  "SELECT sender, body FROM messages WHERE conversation_id = ? AND sender_type = 'agent' AND sender = ? AND timestamp > ? ORDER BY timestamp DESC LIMIT 1"
                ).all(msg.conversation_id, agentName, msg.timestamp);
                
                if (newMsgs.length > 0) {
                  collectedResponses.push({ agent: agentName, body: (newMsgs[0].body || '').substring(0, 1500) });
                  console.log(`[Pipeline] ${agentName} responded (${Math.round((Date.now() - startTime) / 1000)}s) — proceeding to next agent`);
                  responded = true;
                  break;
                }
                
                await new Promise(r => setTimeout(r, pollInterval));
              }
              
              if (!responded) {
                console.log(`[Pipeline] ${agentName} timed out after 60s — proceeding anyway`);
                collectedResponses.push({ agent: agentName, body: '[No response — agent timed out]' });
              }
            }
          }
        };
        
        // Run async — don't block the HTTP response
        runPipeline().catch(e => console.warn('[Pipeline] Error:', e.message));
      }

      }; // end dispatchFn

      if (targets.length > 0) {
        const entry = { timer: null, cancelled: false };
        entry.timer = setTimeout(dispatchFn, DISPATCH_DELAY_MS);
        pendingDispatches.set(msg.id, entry);
        json(res, { ...msg, undoWindowMs: DISPATCH_DELAY_MS }, 201);
      } else {
        json(res, msg, 201);
      }
      return;
    }


    // DELETE /api/messages/:id
    const msgDeleteMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (msgDeleteMatch && method === 'DELETE') {
      const msgId = decodeURIComponent(msgDeleteMatch[1]);
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
      if (!msg) { err(res, 'Message not found', 404); return; }
      // Cancel any pending dispatch
      const pending = pendingDispatches.get(msgId);
      if (pending) {
        pending.cancelled = true;
        clearTimeout(pending.timer);
        pendingDispatches.delete(msgId);
        console.log('[UndoSend] Cancelled dispatch for msg ' + msgId);
      }
      db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
      broadcast('message_deleted', { id: msgId, conversationId: msg.conversation_id });
      json(res, { ok: true, deleted: msgId, dispatchCancelled: !!pending });
      return;
    }

    // POST /api/upload
    if (pathname === '/api/upload' && method === 'POST') {
      try {
        await runMulter(req, res);
        if (!req.file) { err(res,'No file'); return; }
        const { filename, thumbnailPath, size } = await saveUpload(req.file);
        const body = req.body || {};
        
        // Dedup rapid-fire uploads (iOS can send the same file multiple times)
        const dedupKey = uploadDedupKey(body.conversationId, body.sender, body.message, req.file.originalname);
        const now = Date.now();
        const lastUpload = recentUploads.get(dedupKey);
        if (lastUpload && (now - lastUpload) < UPLOAD_DEDUP_WINDOW) {
          console.log('[Upload] Dedup — skipping duplicate upload within ' + UPLOAD_DEDUP_WINDOW + 'ms');
          json(res, { ok: true, deduplicated: true });
          return;
        }
        recentUploads.set(dedupKey, now);
        setTimeout(() => recentUploads.delete(dedupKey), UPLOAD_DEDUP_WINDOW);
        const msg = {
          id: uuidv4(),
          conversation_id: body.conversationId || 'general',
          sender: body.sender || 'Richard',
          sender_type: body.senderType || body.sender_type || (AGENTS.some(a => a.name === (body.sender || '').toLowerCase() || a.id === (body.sender || '').toLowerCase()) ? 'agent' : 'human'),
          type: 'file',
          subject: null,
          body: body.message || null,
          file_path: filename,
          file_name: req.file.originalname,
          file_size: size,
          file_type: req.file.mimetype,
          thumbnail_path: thumbnailPath,
          timestamp: new Date().toISOString(),
          targets: body.targets ? body.targets : null,
        };
        storeMessage(msg);

        // Parse targets for dispatch
        const uploadTargets = body.targets ? JSON.parse(body.targets) : [];
        
        // Notify agents about the file attachment (skip if uploader is an agent — prevents echo loops)
        const isAgentUpload = msg.sender_type === 'agent';
        const convId = msg.conversation_id;
        if (convId && convId !== 'general' && !isAgentUpload) {
          const fileUrl = (config.publicUrl || 'http://localhost:3000') + '/uploads/' + msg.file_path;
          const fileDesc = msg.file_type && msg.file_type.startsWith('image/')
            ? '[Image attached: ' + (msg.file_name || 'image') + ' — ' + fileUrl + ']'
            : '[File attached: ' + (msg.file_name || 'file') + ' — ' + fileUrl + ']';
          const textMsg = (body.message || '').trim();
          const fullMsg = textMsg ? textMsg + '\n' + fileDesc : fileDesc;
          
          // Smart routing for uploads: if no targets, reply to last agent (not broadcast all)
          let targets = uploadTargets;
          if (!targets || targets.length === 0) {
            const lastAgent = db.prepare(
              "SELECT sender FROM messages WHERE conversation_id = ? AND sender_type = 'agent' ORDER BY timestamp DESC LIMIT 1"
            ).get(convId);
            if (lastAgent) {
              targets = [lastAgent.sender.toLowerCase()];
              console.log('[Upload:SmartRoute] No targets — routing to last agent: ' + targets[0]);
            } else {
              const parts = stmts.getParticipants ? stmts.getParticipants.all(convId) : [];
              targets = parts.length > 0 ? parts.map(p => p.agent_name) : [];
              console.log('[Upload:SmartRoute] No targets, no previous agent — broadcasting');
            }
          }
          const histRows = stmts.getRecentMessages ? stmts.getRecentMessages.all(convId) : [];
          const hist = histRows.map(r => ({ sender: r.sender, body: r.body || (r.file_name ? '[File: ' + r.file_name + ']' : '') }));
          
          const fileMedia = [{
            url: (config.publicUrl || 'http://localhost:3000') + '/uploads/' + msg.file_path,
            mimeType: msg.file_type || 'application/octet-stream',
            fileName: msg.file_name,
          }];
          for (const agentName of targets) {
            broadcast('typing_start', { agentName, conversationId: convId });
            postToAgent(agentName, convId, fullMsg, hist, null, fileMedia);
          }
        }
        
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
      if (typeof body.category === 'string') { updates.push('category = ?'); params.push(body.category); }
      if (typeof body.conv_type === 'string') { updates.push('conv_type = ?'); params.push(body.conv_type); }

      if (updates.length === 0) { err(res, 'Nothing to update'); return; }
      params.push(convId);
      db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      broadcast('conversation_updated', { id: convId, ...body });
      json(res, { ok: true });
      return;
    }

    // DELETE /api/conversations/:id
    if (pathname.match(/^\/api\/conversations\/[^/]+$/) && method === 'DELETE') {
      const convId = decodeURIComponent(pathname.split('/')[3]);
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
          sender: body.sender || 'Richard',
          sender_type: body.senderType || body.sender_type || 'human',
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
          const agentHistory = getAgentHistory(agent);
          let previousContext = null;
          if (agentHistory.count > 0) {
            const titles = agentHistory.recentTitles.filter(Boolean).slice(0, 3);
            previousContext = `[Previous context: You have had ${agentHistory.count} conversation${agentHistory.count !== 1 ? 's' : ''} with Richard on PulseNet. Most recent topics: ${titles.join(', ')}]`;
          }

          broadcast('typing_start', { agentName: agent, conversationId: convId });
          postToAgent(agent, convId, firstMsg.body, firstMsgHistory, previousContext);
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
      broadcast('participant_removed', { conversationId: convId, agentName });
      json(res, { ok: true });
      return;
    }

    // POST /api/ingest — fallback for agents not yet on pulse WebSocket
    if (pathname === '/api/ingest' && method === 'POST') {
      if (!checkIngestAuth(req)) { err(res,'Unauthorized',401); return; }
      let body;
      try { body = await jsonBody(req); } catch(_) { err(res,'Invalid JSON'); return; }

      const convId = body.conversationId || body.conv_id || 'general';
      const sender = body.from || body.sender || 'agent';

      // Guard: reject ingest to non-existent conversations (prevents rogue auto-creation)
      const existingConv = db.prepare('SELECT id FROM conversations WHERE id = ? AND (deleted IS NULL OR deleted = 0)').get(convId);
      if (!existingConv) {
        console.log(`[Ingest] BLOCKED: agent "${sender}" tried to post to non-existent conv "${convId}"`);
        // Alert LtDan via the alerts channel so rogue posts are visible
        const alertMsg = {
          id: uuidv4(),
          conversation_id: 'channel-alerts',
          sender: 'pulsenet',
          sender_type: 'system',
          type: 'message',
          subject: null,
          body: `⚠️ Rogue post blocked: agent "${sender}" tried to post to non-existent conversation "${convId}". Message was dropped. Fix the agent's script.`,
          file_path: null, file_name: null, file_size: null, file_type: null, thumbnail_path: null,
          timestamp: new Date().toISOString(),
        };
        try { storeMessage(alertMsg); broadcast('new_message', alertMsg); } catch(_) {}
        err(res, `Conversation "${convId}" does not exist. Use /api/conversations to create one first.`, 404);
        return;
      }
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

      // Use custom title if provided (for reporting conversations)
      if (body.title) {
        try {
          db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND title = ?').run(body.title, convId, convId);
        } catch(_) {}
      }

      // Note: Auto-creation of conversations via ingest is disabled.
      // Use /api/conversations POST to create new conversations first.

      // Auto-add sender as participant
      try {
        db.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, agent_name) VALUES (?, ?)').run(convId, sender);
      } catch(_) {}

      // Dedup check
      const dedupResult = checkDedup(sender, convId, msgBody);
      if (dedupResult.duplicate) {
        json(res, { ok: true, deduplicated: true, firstMessageId: dedupResult.firstMessageId, count: dedupResult.count }, 200);
        return;
      }

      storeMessage(msg);

      // Store dedup entry
      if (dedupResult.key) storeDedupEntry(dedupResult.key, dedupResult.expiresAt, msg.id);

      // Create delivery records for targeted agents
      if (msg.targets) {
        let targets = [];
        try { targets = JSON.parse(msg.targets); } catch(_) {}
        for (const t of targets) createDeliveryRecord(msg.id, t);
      }

      // Stop typing indicator for this agent
      broadcast('typing_stop', { agentName: sender, conversationId: convId });
      json(res, { ok: true, id: msg.id }, 201);
      return;
    }

    // POST /api/mesh-tap — agent-to-agent MESH message tap
    // Agents send copies of inter-agent messages here for visibility
    if (pathname === '/api/mesh-tap' && method === 'POST') {
      if (!checkIngestAuth(req)) { err(res,'Unauthorized',401); return; }
      let body;
      try { body = await jsonBody(req); } catch(_) { err(res,'Invalid JSON'); return; }

      const fromAgent = body.from || 'unknown';
      const toAgent = body.to || 'unknown';
      const meshId = body.meshId || body.id || uuidv4();
      const meshType = body.meshType || 'notification';
      const msgBody = body.body || body.text || '';
      const subject = body.subject || null;
      const convId = body.conversationId || `mesh-${fromAgent}-${toAgent}`;

      // Auto-create conversation if needed
      stmts.upsertConv.run({
        id: convId,
        title: `${fromAgent} \u2194 ${toAgent}`,
        last_message_at: new Date().toISOString(),
      });

      // Add both agents as participants
      const ensureParticipant = db.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, agent_name) VALUES (?, ?)');
      ensureParticipant.run(convId, fromAgent);
      ensureParticipant.run(convId, toAgent);

      // Mark conversation as agent-to-agent type (conv_type column added in migration)
      db.prepare("UPDATE conversations SET conv_type = 'agent' WHERE id = ?").run(convId);

      const meshtapMsg = {
        id: uuidv4(),
        conversation_id: convId,
        sender: fromAgent,
        sender_type: 'agent',
        type: 'mesh',
        subject,
        body: `[${meshType.toUpperCase()}] ${msgBody}`,
        file_path: null, file_name: null, file_size: null, file_type: null, thumbnail_path: null,
        timestamp: body.timestamp || new Date().toISOString(),
      };
      storeMessage(meshtapMsg);

      // Broadcast to SSE clients so the UI updates in real-time
      broadcast('new_message', meshtapMsg);
      broadcast('conversation_updated', { id: convId, last_message_at: meshtapMsg.timestamp, conv_type: 'agent' });

      json(res, { ok: true, conversationId: convId, id: meshtapMsg.id }, 201);
      return;
    }

    // GET /api/pulse/status
    if (pathname === '/api/pulse/status' && method === 'GET') {
      const wsStatus = {};
      for (const [name, state] of Object.entries(agentWsState)) {
        wsStatus[name] = { connected: state.connected, authed: state.authed };
      }
      json(res, { agents: wsStatus });
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

    // GET /api/dead-letters — list dead letter messages
    if (pathname === '/api/dead-letters' && method === 'GET') {
      json(res, { ok: true, deadLetters: getDeadLetters() });
      return;
    }

    // POST /api/dead-letters/:id/retry — retry a dead letter
    const dlRetryMatch = pathname.match(/^\/api\/dead-letters\/([^/]+)\/retry$/);
    if (dlRetryMatch && method === 'POST') {
      const rec = retryDeadLetter(dlRetryMatch[1]);
      if (!rec) { err(res, 'Not found', 404); return; }
      json(res, { ok: true, queued: true, deliveryId: dlRetryMatch[1] });
      return;
    }

    // DELETE /api/dead-letters/:id — dismiss a dead letter
    const dlDismissMatch = pathname.match(/^\/api\/dead-letters\/([^/]+)$/);
    if (dlDismissMatch && method === 'DELETE') {
      db.prepare("UPDATE message_delivery SET status = 'dismissed' WHERE id = ?").run(dlDismissMatch[1]);
      json(res, { ok: true });
      return;
    }

    // GET /api/agents/health — per-agent delivery health stats
    if (pathname === '/api/agents/health' && method === 'GET') {
      const stats = db.prepare(`
        SELECT target_agent,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) as dead,
          MAX(delivered_at) as last_delivered_at
        FROM message_delivery GROUP BY target_agent
      `).all();
      const health = AGENTS.map(a => {
        const s = stats.find(x => x.target_agent === a.name) || {};
        const wsState = agentWsState[a.name];
        return {
          agent: a.name,
          connected: !!(wsState && wsState.ws && wsState.ws.readyState === 1),
          delivery: {
            total: s.total || 0,
            delivered: s.delivered || 0,
            pending: s.pending || 0,
            dead: s.dead || 0,
            lastDeliveredAt: s.last_delivered_at || null
          }
        };
      });
      json(res, { ok: true, health });
      return;
    }

    // GET /api/delivery/:msgId — delivery status for a specific message
    const deliveryMatch = pathname.match(/^\/api\/delivery\/([^/]+)$/);
    if (deliveryMatch && method === 'GET') {
      const records = db.prepare("SELECT * FROM message_delivery WHERE message_id = ?").all(deliveryMatch[1]);
      json(res, { ok: true, messageId: deliveryMatch[1], deliveries: records });
      return;
    }

    err(res,'Not found',404);
    return;
  }

  // ── Static uploads / thumbnails ───────────────────────────────────────────
  if (pathname.startsWith('/uploads/')) {
    const fname = path.basename(pathname);
    // Look up original filename from DB for proper Content-Disposition
    let originalName = fname;
    try {
      const row = db.prepare('SELECT file_name, file_type FROM messages WHERE file_path = ?').get(fname);
      if (row && row.file_name) originalName = row.file_name;
    } catch(_) {}
    const uploadFilePath = path.join(UPLOADS_DIR, fname);
    if (!fs.existsSync(uploadFilePath)) { res.writeHead(404); res.end('Not found'); return; }
    const stat = fs.statSync(uploadFilePath);
    const contentType = mime(originalName) || 'application/octet-stream';
    // Force download for non-image files (fixes iOS PWA file opening)
    const isImage = contentType.startsWith('image/');
    const safeFilename = originalName.replace(/"/g, '');
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Content-Disposition': isImage ? 'inline' : 'attachment; filename="' + safeFilename + '"',
      'Cache-Control': 'public, max-age=86400',
    });
    fs.createReadStream(uploadFilePath).pipe(res);
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
  console.log(`[PulseNet] Server running on http://0.0.0.0:${PORT}`);
  console.log(`[PulseNet] DB: ${DB_PATH}`);
  console.log(`[PulseNet] Uploads: ${UPLOADS_DIR}`);
  console.log(`[PulseNet] Pulse WebSocket: connecting to ${Object.keys(AGENT_WS_URLS).length} agents on port 18800`);
});

process.on('SIGTERM', () => {
  for (const state of Object.values(agentWsState)) {
    if (state.ws) try { state.ws.close(); } catch(_) {}
    clearTimeout(state.reconnectTimer);
  }
  server.close();
  db.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  for (const state of Object.values(agentWsState)) {
    if (state.ws) try { state.ws.close(); } catch(_) {}
    clearTimeout(state.reconnectTimer);
  }
  server.close();
  db.close();
  process.exit(0);
});
