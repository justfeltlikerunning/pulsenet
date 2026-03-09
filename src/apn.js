// PulseNet APNs Push Notification Module
const apn = require('@parse/node-apn');
const path = require('path');
const fs = require('fs');

let provider = null;
let db = null;

function init(config, database) {
  db = database;
  const keyPath = config.keyPath || path.join(__dirname, '..', 'config', 'apn-key.p8');
  
  if (!fs.existsSync(keyPath)) {
    console.log('[APN] Key file not found at', keyPath, '— push notifications disabled');
    return false;
  }
  
  provider = new apn.Provider({
    token: {
      key: keyPath,
      keyId: config.keyId,
      teamId: config.teamId,
    },
    production: false,
  });
  
  // Load existing tokens from DB
  const count = db.prepare('SELECT COUNT(*) as c FROM apn_devices').get().c;
  console.log('[APN] Push notifications enabled (keyId:', config.keyId + ', teamId:', config.teamId + ', devices:', count + ')');
  return true;
}

function registerDevice(userId, token) {
  if (!db) return;
  db.prepare(`INSERT OR REPLACE INTO apn_devices (user_id, token, registered_at) VALUES (?, ?, datetime('now'))`).run(userId, token);
  const count = db.prepare('SELECT COUNT(*) as c FROM apn_devices WHERE user_id = ?').get(userId).c;
  console.log('[APN] Registered device for', userId, '- total tokens:', count);
}

function unregisterDevice(userId, token) {
  if (!db) return;
  db.prepare('DELETE FROM apn_devices WHERE user_id = ? AND token = ?').run(userId, token);
}

async function sendPush(userId, { title, body, conversationId, messageId, badge }) {
  if (!provider || !db) return;
  
  const rows = db.prepare('SELECT token FROM apn_devices WHERE user_id = ?').all(userId);
  if (rows.length === 0) return;
  
  const notification = new apn.Notification();
  notification.expiry = Math.floor(Date.now() / 1000) + 3600;
  notification.badge = badge || 1;
  notification.sound = 'default';
  notification.alert = { title, body };
  notification.topic = 'com.pulsenet.ios';
  notification.payload = {
    conversationId: conversationId || '',
    messageId: messageId || '',
  };
  notification.collapseId = conversationId || 'general';
  
  const tokens = rows.map(r => r.token);
  try {
    const result = await provider.send(notification, tokens);
    if (result.failed && result.failed.length > 0) {
      for (const fail of result.failed) {
        if (fail.status === '410' || (fail.response && fail.response.reason === 'Unregistered')) {
          db.prepare('DELETE FROM apn_devices WHERE token = ?').run(fail.device);
          console.log('[APN] Removed invalid token for', userId);
        } else {
          console.log('[APN] Push failed:', JSON.stringify(fail.response || fail.error || fail.status));
        }
      }
    }
    if (result.sent && result.sent.length > 0) {
      console.log('[APN] Push sent to', userId, '(' + result.sent.length + ' devices)');
    }
  } catch (err) {
    console.error('[APN] Send error:', err.message);
  }
}

function getTokenCount(userId) {
  if (!db) return 0;
  return db.prepare('SELECT COUNT(*) as c FROM apn_devices WHERE user_id = ?').get(userId).c;
}

function shutdown() {
  if (provider) provider.shutdown();
}

module.exports = { init, registerDevice, unregisterDevice, sendPush, getTokenCount, shutdown };
