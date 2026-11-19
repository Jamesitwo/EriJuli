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
  if (!req.query.acepto) {
    setFlash(req, 'error', 'Para conectar Gmail primero acepta cómo se usarán tus correos.');
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
  // Correo exacto (alertas@banco.com) o dominio (notificacionesbancolombia.com, RC-17)
  const sender = String(req.body.sender || '').trim().toLowerCase().replace(/^@/, '');
  const isEmail = /^[^\s@()]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(sender);
  const isDomain = /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(sender);
  if (!isEmail && !isDomain) {
    setFlash(req, 'error', 'Escribe un correo (alertas@banco.com) o un dominio (notificacionesbancolombia.com).');
    return res.redirect('/bandeja');
  }
  if (db.prepare('SELECT 1 FROM email_senders WHERE user_id = ? AND sender = ? AND active = 1').get(req.user.id, sender)) {
    setFlash(req, 'info', `${sender} ya estaba autorizado.`);
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

// Ver un correo del banco dentro de la app (solo los que la app ya procesó para esta persona)
router.get('/correo/:msgId', async (req, res) => {
  const msgId = String(req.params.msgId || '');
  const back = String(req.query.volver || '').startsWith('/') ? String(req.query.volver) : '/bandeja';
  const known = /^[0-9a-f]{10,}$/i.test(msgId) && (
    db.prepare('SELECT 1 FROM processed_emails WHERE user_id = ? AND message_id = ?').get(req.user.id, msgId)
    || db.prepare(`SELECT 1 FROM proposed_movements WHERE user_id = ? AND email_link LIKE ?`).get(req.user.id, '%/' + msgId)
    || db.prepare(`SELECT 1 FROM transactions WHERE user_id = ? AND email_link LIKE ?`).get(req.user.id, '%/' + msgId));
  if (!known) { setFlash(req, 'error', 'Ese correo no está entre los que la app leyó para ti.'); return res.redirect(back); }
  if (!gmail.getConnection(req.user.id)) { setFlash(req, 'error', 'Conecta Gmail para ver el correo dentro de la app.'); return res.redirect(back); }
  try {
    const mail = await gmail.getMessage(req.user.id, msgId);
    const images = req.query.imagenes === '1';
    res.setHeader('Cache-Control', 'no-store');
    res.render('inbox/email', {
      title: 'Correo del banco', mail, images, back, msgId,
      srcdoc: gmail.safeEmailHtml(mail, { images }),
      gmailLink: gmail.webLink(req.user.id, msgId),
    });
  } catch (e) {
    setFlash(req, 'error', e.message);
    res.redirect(back);
  }
});

module.exports = router;
