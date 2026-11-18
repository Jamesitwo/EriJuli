'use strict';
/**
 * Notificaciones en el celular (Web Push).
 * Las claves VAPID se toman de .env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) o se generan una vez y se guardan en la base.
 * El celular debe abrir la app por HTTPS (o localhost) y tenerla instalada en iPhone (iOS 16.4+).
 */
const crypto = require('crypto');
const webpush = require('web-push');
const { db } = require('../db');

let ready = false;
function setting(key) { const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key); return r && r.value; }
function setSetting(key, value) { db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }

function keys() {
  let pub = process.env.VAPID_PUBLIC_KEY || setting('vapid_public');
  let priv = process.env.VAPID_PRIVATE_KEY || setting('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey; priv = k.privateKey;
    setSetting('vapid_public', pub); setSetting('vapid_private', priv);
  }
  if (!ready) { webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:soporte@erijuli.app', pub, priv); ready = true; }
  return { publicKey: pub };
}

function subscribe(userId, sub) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error('Suscripción inválida');
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}
function unsubscribe(userId, endpoint) {
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
  else db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
}
function count(userId) { return db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId).n; }

async function sendToUser(userId, payload) {
  keys();
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 12 });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      else console.error('Push:', e.statusCode || '', e.message);
    }
  }
  return sent;
}

/** Envía una notificación solo una vez por clave (ej. "fijo-12-2026-11-18"). */
async function notifyOnce(userId, key, payload) {
  const done = db.prepare('SELECT 1 FROM notifications_sent WHERE user_id = ? AND key = ?').get(userId, key);
  if (done) return 0;
  const n = await sendToUser(userId, payload);
  if (n > 0) db.prepare('INSERT OR IGNORE INTO notifications_sent (user_id, key) VALUES (?, ?)').run(userId, key);
  return n;
}

/** Revisa las alertas de cada persona con notificaciones activas y avisa lo nuevo (de 7 a. m. a 9 p. m. hora de Bogotá). */
async function runAlertCycle() {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Bogota' }).format(new Date()));
  if (hour < 7 || hour >= 21) return;
  const { computeAlerts } = require('./alerts');
  const { ensurePeriod } = require('./periods');
  const { todayISO } = require('../utils/dates');
  const users = db.prepare(`SELECT u.* FROM users u WHERE u.notify_push = 1 AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id)`).all();
  for (const u of users) {
    try {
      const alerts = computeAlerts(u, ensurePeriod(u)).filter((a) => a.type !== 'info');
      for (const a of alerts) {
        const key = `${todayISO()}-${crypto.createHash('sha1').update(a.text).digest('hex').slice(0, 16)}`;
        await notifyOnce(u.id, key, { title: 'EriJuli', body: a.text, url: a.href || '/' });
      }
    } catch (e) { console.error('Alertas push:', e.message); }
  }
  db.prepare(`DELETE FROM notifications_sent WHERE sent_at < datetime('now', '-40 days')`).run();
}

function scheduleAlerts() {
  if (process.env.PUSH_DISABLED === 'true') return;
  setTimeout(() => runAlertCycle().catch(() => {}), 60 * 1000).unref();
  setInterval(() => runAlertCycle().catch(() => {}), 60 * 60 * 1000).unref();
}

module.exports = { keys, subscribe, unsubscribe, count, sendToUser, notifyOnce, runAlertCycle, scheduleAlerts };
