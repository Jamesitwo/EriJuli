'use strict';
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { log } = require('../services/audit');
const gmail = require('../services/gmail');

const router = express.Router();

// Conectar cuenta de Gmail (OAuth de solo lectura)
router.get('/gmail/conectar', async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    setFlash(req, 'error', 'Gmail aún no está configurado en el servidor (faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET).');
    return res.redirect('/bandeja');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.gmailState = state;
  res.redirect(gmail.authUrl(req, state));
});

// Callback de Google
router.get('/gmail/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.gmailState) {
    setFlash(req, 'error', 'La autorización de Google no fue válida. Intenta de nuevo.');
    return res.redirect('/bandeja');
  }
  delete req.session.gmailState;
  try {
    const tokens = await gmail.exchangeCode(req, code);
    gmail.saveConnection(req.user.id, tokens);
    log(req.user.id, 'gmail', null, 'conectar', `Cuenta ${tokens.email} conectada (solo lectura)`);
    setFlash(req, 'success', `Gmail conectado como ${tokens.email}. Agrega los remitentes de tu banco y sincroniza.`);
  } catch (e) {
    setFlash(req, 'error', e.message);
  }
  res.redirect('/bandeja');
});

// Desconectar y borrar credenciales (RC-15)
router.post('/gmail/desconectar', async (req, res) => {
  await gmail.revoke(req.user.id);
  if (req.body.borrar_propuestas) {
    const info = db.prepare(`DELETE FROM proposed_movements WHERE user_id = ? AND status IN ('propuesto','sin_procesar')`).run(req.user.id);
    db.prepare('DELETE FROM processed_emails WHERE user_id = ?').run(req.user.id);
    log(req.user.id, 'gmail', null, 'borrar importado', `${info.changes} propuestas eliminadas`);
    setFlash(req, 'success', 'Gmail desconectado y propuestas eliminadas.');
  } else {
    setFlash(req, 'success', 'Gmail desconectado. Tus credenciales fueron borradas.');
  }
  log(req.user.id, 'gmail', null, 'desconectar', '');
  res.redirect('/bandeja');
});

// Sincronizar buzón (lectura periódica bajo demanda, RC-13)
router.post('/gmail/sincronizar', async (req, res) => {
  try {
    const days = Math.min(Math.max(1, Number(req.body.dias) || 30), 365);
    const r = await gmail.syncUser(req.user.id, { days });
    log(req.user.id, 'gmail', null, 'sincronizar', `${r.leidos} leídos, ${r.propuestos} propuestos, ${r.duplicados} duplicados, ${r.sinProcesar} sin procesar`);
    setFlash(req, 'success', `Sincronización lista: ${r.leidos} correos leídos, ${r.propuestos} movimientos propuestos, ${r.duplicados} duplicados ignorados, ${r.sinProcesar} sin procesar.`);
  } catch (e) {
    setFlash(req, 'error', e.message);
  }
  res.redirect('/bandeja');
});

// Remitentes autorizados (RC-02)
router.post('/gmail/remitentes', (req, res) => {
  const sender = String(req.body.sender || '').trim().toLowerCase();
  if (!sender || !sender.includes('@')) {
    setFlash(req, 'error', 'Escribe el correo del remitente (ej. alertas@bancolombia.com).');
    return res.redirect('/bandeja');
  }
  db.prepare('INSERT INTO email_senders (user_id, bank_id, sender, label) VALUES (?, ?, ?, ?)')
    .run(req.user.id, req.body.bank_id || null, sender, String(req.body.label || '').trim());
  log(req.user.id, 'email_sender', null, 'agregar remitente', sender);
  setFlash(req, 'success', `Remitente ${sender} autorizado. La app solo leerá correos de remitentes autorizados.`);
  res.redirect('/bandeja');
});

router.post('/gmail/remitentes/:id/eliminar', (req, res) => {
  db.prepare('DELETE FROM email_senders WHERE user_id = ? AND id = ?').run(req.user.id, req.params.id);
  setFlash(req, 'success', 'Remitente eliminado.');
  res.redirect('/bandeja');
});

module.exports = router;
