'use strict';
/**
 * Cifrado de credenciales (tokens de Gmail) en reposo (RN-03).
 * AES-256-GCM con clave derivada de SESSION_SECRET (o GMAIL_TOKEN_KEY si se define).
 */
const crypto = require('crypto');

const secret = process.env.GMAIL_TOKEN_KEY || process.env.SESSION_SECRET || 'cambia-esta-clave-en-produccion';
const key = crypto.scryptSync(secret, 'finanzas-personales-salt', 32);

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(payload) {
  if (!payload) return '';
  try {
    const [ivB64, tagB64, dataB64] = String(payload).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

module.exports = { encrypt, decrypt };
