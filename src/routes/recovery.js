'use strict';
// Recuperar el acceso: enlace por correo o código de recuperación
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { sendMail } = require('../services/mailer');
const sec = require('../services/security');
const { log } = require('../services/audit');

const router = express.Router();
const GENERIC = 'Si existe una cuenta con ese correo, te enviamos un enlace para crear una contraseña nueva. Revisa tu bandeja de entrada (y la carpeta de spam).';

const { publicUrl } = require('../utils/url');
const baseUrl = (req) => publicUrl(req);

router.get('/recuperar', (req, res) => {
  res.render('auth/recover', { title: 'Recuperar acceso', mode: req.query.modo === 'codigo' ? 'codigo' : 'correo' });
});

router.post('/recuperar', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
    if (user && sec.recentResetCount(user.id) < 3) {
      const token = sec.createResetToken(user.id);
      const link = `${baseUrl(req)}/restablecer/${token}`;
      await sendMail({
        to: user.email,
        subject: 'EriJuli · Crea una contraseña nueva',
        text: `Hola${user.name ? ' ' + user.name : ''}:\n\nPara crear una contraseña nueva entra a este enlace (vale por 1 hora y se usa una sola vez):\n${link}\n\nSi no fuiste tú, ignora este correo; tu contraseña sigue igual.`,
        html: `<p>Hola${user.name ? ' ' + user.name : ''}:</p><p>Para crear una contraseña nueva entra a este enlace (vale por 1 hora y se usa una sola vez):</p><p><a href="${link}">Crear contraseña nueva</a></p><p>Si no fuiste tú, ignora este correo; tu contraseña sigue igual.</p>`,
      });
      log(user.id, 'user', user.id, 'recuperar contraseña', 'Enlace enviado');
    }
    setFlash(req, 'success', GENERIC);
    res.redirect('/login');
  } catch (e) { next(e); }
});

router.get('/restablecer/:token', (req, res) => {
  const row = sec.findResetToken(req.params.token);
  if (!row) { setFlash(req, 'error', 'El enlace ya se usó o venció. Pide uno nuevo.'); return res.redirect('/recuperar'); }
  res.render('auth/reset', { title: 'Contraseña nueva', token: req.params.token });
});

router.post('/restablecer/:token', (req, res) => {
  const row = sec.findResetToken(req.params.token);
  if (!row) { setFlash(req, 'error', 'El enlace ya se usó o venció. Pide uno nuevo.'); return res.redirect('/recuperar'); }
  const { password, password2 } = req.body;
  if (!sec.validPassword(password)) { setFlash(req, 'error', 'La contraseña debe tener al menos 8 caracteres.'); return res.redirect(req.originalUrl); }
  if (password !== password2) { setFlash(req, 'error', 'Las dos contraseñas no coinciden.'); return res.redirect(req.originalUrl); }
  sec.setPassword(row.user_id, password);
  db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`).run(row.user_id);
  log(row.user_id, 'user', row.user_id, 'contraseña', 'Restablecida con enlace');
  setFlash(req, 'success', 'Listo, ya tienes contraseña nueva. Inicia sesión con ella.');
  res.redirect('/login');
});

// Con un código de recuperación (sin correo)
router.post('/recuperar/codigo', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
  const { password, password2, code } = req.body;
  if (!sec.validPassword(password)) { setFlash(req, 'error', 'La contraseña debe tener al menos 8 caracteres.'); return res.redirect('/recuperar?modo=codigo'); }
  if (password !== password2) { setFlash(req, 'error', 'Las dos contraseñas no coinciden.'); return res.redirect('/recuperar?modo=codigo'); }
  if (!user || !sec.useRecoveryCode(user.id, code)) {
    setFlash(req, 'error', 'El correo o el código no son válidos. Cada código sirve una sola vez.');
    return res.redirect('/recuperar?modo=codigo');
  }
  sec.setPassword(user.id, password);
  log(user.id, 'user', user.id, 'contraseña', 'Restablecida con código de recuperación');
  setFlash(req, 'success', `Contraseña cambiada. Te quedan ${sec.recoveryCodesLeft(user.id)} códigos de recuperación.`);
  res.redirect('/login');
});

module.exports = router;
