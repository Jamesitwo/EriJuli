'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Crea un enlace de un solo uso para restablecer la contraseña (válido 1 hora). */
function createResetToken(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))`)
    .run(userId, sha256(token));
  return token;
}

function findResetToken(token) {
  return db.prepare(`SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`)
    .get(sha256(token));
}

function recentResetCount(userId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > datetime('now', '-1 hour')`).get(userId).n;
}

/** Genera 8 códigos de recuperación nuevos (reemplaza los anteriores). Devuelve los códigos en claro una sola vez. */
function generateRecoveryCodes(userId) {
  const codes = Array.from({ length: 8 }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 caracteres
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  db.tx(() => {
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
    for (const c of codes) ins.run(userId, sha256(c));
  });
  return codes;
}

function useRecoveryCode(userId, code) {
  const clean = String(code || '').trim().toUpperCase().replace(/\s/g, '');
  const normalized = clean.includes('-') ? clean : `${clean.slice(0, 5)}-${clean.slice(5)}`;
  const row = db.prepare('SELECT * FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').get(userId, sha256(normalized));
  if (!row) return false;
  db.prepare(`UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ?`).run(row.id);
  return true;
}

function recoveryCodesLeft(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId).n;
}

/** Cambia la contraseña y cierra las demás sesiones abiertas de esa persona. */
function setPassword(userId, password, keepSid = null) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 10), userId);
  const sessions = db.prepare('SELECT sid, sess FROM sessions').all();
  for (const s of sessions) {
    try {
      if (JSON.parse(s.sess).userId === userId && s.sid !== keepSid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(s.sid);
    } catch { /* sesión dañada */ }
  }
}

function validPassword(p) { return typeof p === 'string' && p.length >= 8; }

module.exports = { createResetToken, findResetToken, recentResetCount, generateRecoveryCodes, useRecoveryCode, recoveryCodesLeft, setPassword, validPassword, sha256 };
