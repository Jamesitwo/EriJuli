'use strict';
// Fotos de recibos: se guardan como archivo junto a la base de datos (carpeta uploads/<usuario>/)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, DB_PATH } = require('../db');

const ROOT = process.env.UPLOADS_PATH || path.join(path.dirname(DB_PATH), 'uploads');
const MAX = 6 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function dirFor(userId) { const d = path.join(ROOT, String(userId)); fs.mkdirSync(d, { recursive: true }); return d; }

/** Guarda una imagen que llega como data URL (la app la reduce antes de enviarla). */
function saveDataUrl(userId, transactionId, dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX) return null;
  const name = `${transactionId}-${crypto.randomBytes(8).toString('hex')}.${TYPES[m[1]]}`;
  fs.writeFileSync(path.join(dirFor(userId), name), buf);
  const info = db.prepare('INSERT INTO attachments (user_id, transaction_id, filename, mime, size) VALUES (?, ?, ?, ?, ?)')
    .run(userId, transactionId, name, m[1], buf.length);
  return info.lastInsertRowid;
}

function forTransaction(userId, transactionId) {
  return db.prepare('SELECT * FROM attachments WHERE user_id = ? AND transaction_id = ? ORDER BY id').all(userId, transactionId);
}

function filePath(att) { return path.join(ROOT, String(att.user_id), path.basename(att.filename)); }

function remove(att) {
  try { fs.unlinkSync(filePath(att)); } catch { /* ya no existe */ }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
}

function removeForTransaction(userId, transactionId) {
  for (const a of forTransaction(userId, transactionId)) remove(a);
}

module.exports = { saveDataUrl, forTransaction, filePath, remove, removeForTransaction, ROOT };
