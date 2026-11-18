'use strict';
/**
 * Integración con Gmail (RC-01..RC-13).
 *
 * - Conexión por OAuth de solo lectura (gmail.readonly); nunca se pide la contraseña.
 * - Se leen SOLO los correos de los remitentes que la persona autoriza (RC-02).
 * - Los mensajes se piden en modo "metadata" (asunto, remitente, fecha y extracto):
 *   NO se descarga ni se guarda el cuerpo completo del correo (RC-14).
 * - Cada movimiento detectado queda como PROPUESTO en la bandeja; nada afecta
 *   saldos hasta que se acepte, edite o descarte (RC-07).
 * - Evita duplicados entre correos y registros manuales (RC-10) y guarda el
 *   enlace al correo original para auditoría (RC-11).
 * - Lo que no se pueda interpretar queda "sin procesar" para registrarlo a mano (RC-12).
 */
const crypto = require('crypto');
const { db } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const { parseBankEmail } = require('./bankParsers');
const { todayISO, addDays } = require('../utils/dates');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function redirectUri(req) {
  const base = require('../utils/url').publicUrl(req);
  return `${base.replace(/\/$/, '')}/gmail/callback`;
}

function gmailStatus(userId) {
  const configured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const conn = userId ? getConnection(userId) : null;
  return {
    configured,
    connected: Boolean(conn),
    email: conn ? conn.email : '',
    message: !configured
      ? 'Gmail no está conectado. Puedes registrar movimientos a mano o importarlos por CSV mientras tanto.'
      : conn
        ? `Gmail conectado como ${conn.email}. Puedes sincronizar tus correos de banco.`
        : 'Credenciales de Google listas. Conecta tu cuenta de Gmail para leer los avisos de tu banco.',
    scopes: SCOPES,
  };
}

// ---------- conexión ----------
function getConnection(userId) {
  const row = db.prepare('SELECT * FROM gmail_connections WHERE user_id = ?').get(userId);
  if (!row) return null;
  return { ...row, access_token: decrypt(row.access_token), refresh_token: decrypt(row.refresh_token) };
}

function saveConnection(userId, data) {
  db.prepare(`INSERT INTO gmail_connections (user_id, email, access_token, refresh_token, token_expiry)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, access_token = excluded.access_token,
      refresh_token = excluded.refresh_token, token_expiry = excluded.token_expiry`)
    .run(userId, data.email || '', encrypt(data.access_token || ''), encrypt(data.refresh_token || ''), Number(data.token_expiry) || 0);
}

function deleteConnection(userId) {
  db.prepare('DELETE FROM gmail_connections WHERE user_id = ?').run(userId);
}

/** URL de autorización de Google (RC-01). */
function authUrl(req, state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: state || '',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Intercambia el código de autorización por tokens. */
async function exchangeCode(req, code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Google rechazó la autorización (${res.status})`);
  const data = await res.json();

  // Correo de la cuenta conectada (perfil básico)
  let email = '';
  try {
    const profile = await fetch(`${GMAIL_API}/profile`, { headers: { Authorization: `Bearer ${data.access_token}` } });
    if (profile.ok) email = (await profile.json()).emailAddress || '';
  } catch (e) { /* opcional */ }

  return {
    email,
    access_token: data.access_token,
    refresh_token: data.refresh_token || '',
    token_expiry: Date.now() + (Number(data.expires_in || 3600) * 1000),
  };
}

/** Token vigente, refrescando si venció (RN-03: revocable en cualquier momento). */
async function getAccessToken(userId) {
  const conn = getConnection(userId);
  if (!conn) throw new Error('Gmail no está conectado.');
  if (conn.token_expiry - 60000 > Date.now() && conn.access_token) return conn.access_token;
  if (!conn.refresh_token) throw new Error('La sesión de Gmail venció. Vuelve a conectar.');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      refresh_token: conn.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('No se pudo renovar el acceso a Gmail. Vuelve a conectar.');
  const data = await res.json();
  saveConnection(userId, {
    email: conn.email,
    access_token: data.access_token,
    refresh_token: conn.refresh_token || data.refresh_token,
    token_expiry: Date.now() + (Number(data.expires_in || 3600) * 1000),
  });
  return data.access_token;
}

/** Revoca el acceso en Google y borra las credenciales locales (RC-15). */
async function revoke(userId) {
  const conn = getConnection(userId);
  if (conn && conn.access_token) {
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: conn.access_token }),
      });
    } catch (e) { /* mejor esfuerzo */ }
  }
  deleteConnection(userId);
}

// ---------- lectura de correos ----------
/** Lista remitentes autorizados por la persona (RC-02). */
function listSenders(userId) {
  return db.prepare(`SELECT es.*, b.name AS bank_name FROM email_senders es
    LEFT JOIN banks b ON b.id = es.bank_id
    WHERE es.user_id = ? AND es.active = 1 ORDER BY es.id DESC`).all(userId);
}

async function fetchBankEmails(userId, { days = 30, max = 50 } = {}) {
  const senders = listSenders(userId).map((s) => s.sender);
  if (!senders.length) return { messages: [], senders: [] };
  const token = await getAccessToken(userId);
  const query = `from:(${senders.join(' OR ')}) newer_than:${days}d`;
  const listRes = await fetch(`${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=${max}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) throw new Error(`No se pudo leer el buzón (${listRes.status}).`);
  const list = await listRes.json();

  const messages = [];
  for (const item of (list.messages || [])) {
    // metadata: solo encabezados y extracto, nunca el cuerpo (RC-14)
    const msgRes = await fetch(`${GMAIL_API}/messages/${item.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!msgRes.ok) continue;
    const msg = await msgRes.json();
    const headers = Object.fromEntries((msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
    messages.push({
      id: msg.id,
      from: headers.from || '',
      subject: headers.subject || '',
      date: headers.date || '',
      snippet: msg.snippet || '',
    });
  }
  return { messages, senders };
}

/**
 * Busca la cuenta o tarjeta del correo: primero por los últimos 4 dígitos (RC-21),
 * luego por el banco asociado al remitente (RC-06). También ubica el efectivo para los retiros.
 */
function matchAccount(userId, parsed, from) {
  const out = {};
  if (parsed.last4) {
    out.card = db.prepare(`SELECT * FROM credit_cards WHERE user_id = ? AND last4 = ? AND archived = 0`).get(userId, parsed.last4) || null;
    if (!out.card) out.container = db.prepare(`SELECT * FROM containers WHERE user_id = ? AND last4 = ? AND archived = 0`).get(userId, parsed.last4) || null;
    out.byLast4 = Boolean(out.card || out.container);
  }
  if (!out.card && !out.container) {
    const sender = db.prepare(`SELECT * FROM email_senders WHERE user_id = ? AND active = 1 AND bank_id IS NOT NULL AND instr(lower(?), lower(replace(sender, '@', ''))) > 0`)
      .get(userId, String(from || '').replace(/@/g, '')) || null;
    if (sender) out.container = db.prepare(`SELECT * FROM containers WHERE user_id = ? AND bank_id = ? AND kind = 'cuenta' AND archived = 0`).get(userId, sender.bank_id) || null;
  }
  out.cash = db.prepare(`SELECT c.* FROM containers c JOIN banks b ON b.id = c.bank_id
    WHERE c.user_id = ? AND b.kind = 'efectivo' AND c.archived = 0 ORDER BY c.kind DESC, c.id LIMIT 1`).get(userId) || null;
  return out;
}

/**
 * Sincroniza el buzón: convierte correos en movimientos propuestos (RC-07).
 * Aplica reglas aprendidas (RC-09) y evita duplicados (RC-10).
 */
async function syncUser(userId, opts = {}) {
  const { messages, senders } = await fetchBankEmails(userId, opts);
  const result = { leidos: messages.length, propuestos: 0, duplicados: 0, sinProcesar: 0 };

  for (const msg of messages) {
    // Duplicado por mensaje ya procesado (RC-10)
    const seen = db.prepare('SELECT id FROM processed_emails WHERE user_id = ? AND message_id = ?').get(userId, msg.id);
    if (seen) { result.duplicados++; continue; }

    const parsed = parseBankEmail(msg, senders);
    const emailLink = `https://mail.google.com/mail/u/0/#inbox/${msg.id}`;

    // Duplicado contra movimientos manuales (mismo día, valor y descripción)
    if (parsed && parsed.date) {
      const dup = db.prepare(`SELECT id FROM transactions WHERE user_id = ? AND date = ? AND amount = ?
        AND (description = ? OR email_link = ?)`).get(userId, parsed.date, parsed.amount, parsed.description, emailLink);
      if (dup) {
        db.prepare('INSERT OR IGNORE INTO processed_emails (user_id, message_id, proposed_id) VALUES (?, ?, NULL)').run(userId, msg.id);
        result.duplicados++;
        continue;
      }
    }

    // Reglas aprendidas: "este comercio va a esta categoría y cuenta" (RC-09)
    let rule = null;
    if (parsed) {
      rule = db.prepare(`SELECT * FROM email_rules WHERE user_id = ? AND ? LIKE '%' || merchant_pattern || '%'`).get(userId, parsed.description) || null;
    }
    const m = parsed ? matchAccount(userId, parsed, msg.from) : {};
    let kind = parsed ? parsed.kind : 'gasto';
    let fromId = (rule && rule.container_from_id) || null;
    let toId = (rule && rule.container_to_id) || null;
    let cardId = null;
    // RC-06 / RC-21: los últimos 4 dígitos (o el banco del remitente) dicen de qué cuenta o tarjeta es
    if (m.card) { cardId = m.card.id; fromId = null; }
    else if (m.container) { if (kind === 'ingreso') toId = m.container.id; else fromId = m.container.id; }
    // Retiro en cajero: es un movimiento de la cuenta al efectivo, no un gasto
    if (parsed && parsed.cash && m.cash && !cardId) { kind = 'transferencia'; toId = m.cash.id; }
    if (kind === 'ingreso') fromId = null;
    if (kind === 'gasto') toId = null;

    const notes = [];
    if (parsed && parsed.time) notes.push(`Hora: ${parsed.time}`);
    if (parsed && parsed.last4) notes.push(`Cuenta *${parsed.last4}${m.byLast4 ? '' : ' (no la reconocí: agrégale los 4 dígitos a tu cuenta o tarjeta)'}`);
    if (parsed && parsed.noCategory && !(rule && rule.category_id)) notes.push('Pago por QR sin comercio: elige la categoría.');

    const status = parsed ? 'propuesto' : 'sin_procesar';
    const info = db.prepare(`INSERT INTO proposed_movements
      (user_id, status, kind, amount, date, description, category_id, income_source_id, container_from_id, container_to_id, card_id,
       email_sender, email_subject, email_date, email_link, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, status, kind,
        parsed ? parsed.amount : 0,
        (parsed && parsed.date) || todayISO(),
        parsed ? parsed.description : (msg.subject || 'Correo sin interpretar'),
        rule ? rule.category_id : null,
        rule ? rule.income_source_id : null,
        fromId, toId, cardId,
        msg.from, msg.subject, msg.date, emailLink,
        parsed ? notes.join(' · ') : 'No se pudo interpretar este correo: regístralo a mano.');

    db.prepare('INSERT OR IGNORE INTO processed_emails (user_id, message_id, proposed_id) VALUES (?, ?, ?)').run(userId, msg.id, info.lastInsertRowid);
    if (parsed) result.propuestos++; else result.sinProcesar++;
  }
  return result;
}

module.exports = {
  gmailStatus, authUrl, exchangeCode, getAccessToken, revoke, syncUser,
  getConnection, saveConnection, deleteConnection, listSenders, SCOPES, redirectUri, matchAccount,
};
