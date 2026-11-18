'use strict';
// Seguridad: contraseña, códigos de recuperación, PIN, huella y notificaciones. También la pantalla de bloqueo.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const sec = require('../services/security');
const wa = require('../services/webauthn');
const push = require('../services/push');
const { log } = require('../services/audit');

const router = express.Router();

router.get('/seguridad', (req, res) => {
  const codes = req.session.newRecoveryCodes || null;
  delete req.session.newRecoveryCodes;
  res.render('security/index', {
    title: 'Seguridad',
    codes,
    codesLeft: sec.recoveryCodesLeft(req.user.id),
    devices: wa.credentials(req.user.id),
    pushDevices: push.count(req.user.id),
    vapidKey: push.keys().publicKey,
  });
});

router.post('/seguridad/contrasena', (req, res) => {
  const { current, password, password2 } = req.body;
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) { setFlash(req, 'error', 'La contraseña actual no es correcta.'); return res.redirect('/seguridad'); }
  if (!sec.validPassword(password)) { setFlash(req, 'error', 'La contraseña nueva debe tener al menos 8 caracteres.'); return res.redirect('/seguridad'); }
  if (password !== password2) { setFlash(req, 'error', 'Las dos contraseñas nuevas no coinciden.'); return res.redirect('/seguridad'); }
  sec.setPassword(req.user.id, password, req.sessionID);
  log(req.user.id, 'user', req.user.id, 'contraseña', 'Cambiada');
  setFlash(req, 'success', 'Contraseña cambiada. Cerramos tu sesión en los demás dispositivos.');
  res.redirect('/seguridad');
});

router.post('/seguridad/codigos', (req, res) => {
  req.session.newRecoveryCodes = sec.generateRecoveryCodes(req.user.id);
  log(req.user.id, 'user', req.user.id, 'códigos de recuperación', 'Generados');
  res.redirect('/seguridad#codigos');
});

router.post('/seguridad/pin', (req, res) => {
  const pin = String(req.body.pin || '');
  if (req.body.quitar) {
    db.prepare('UPDATE users SET pin_hash = NULL WHERE id = ?').run(req.user.id);
    db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(req.user.id);
    setFlash(req, 'success', 'Quitaste el bloqueo de la app.');
    return res.redirect('/seguridad');
  }
  if (!/^\d{4,6}$/.test(pin)) { setFlash(req, 'error', 'El PIN debe tener de 4 a 6 números.'); return res.redirect('/seguridad'); }
  if (pin !== String(req.body.pin2 || '')) { setFlash(req, 'error', 'Los dos PIN no coinciden.'); return res.redirect('/seguridad'); }
  const minutes = [1, 5, 15, 60].includes(Number(req.body.lock_minutes)) ? Number(req.body.lock_minutes) : 5;
  db.prepare('UPDATE users SET pin_hash = ?, lock_minutes = ? WHERE id = ?').run(bcrypt.hashSync(pin, 10), minutes, req.user.id);
  log(req.user.id, 'user', req.user.id, 'PIN', 'Configurado');
  setFlash(req, 'success', `PIN guardado. La app se bloqueará después de ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} sin uso.`);
  res.redirect('/seguridad');
});

router.post('/seguridad/bloqueo', (req, res) => {
  const minutes = [1, 5, 15, 60].includes(Number(req.body.lock_minutes)) ? Number(req.body.lock_minutes) : 5;
  db.prepare('UPDATE users SET lock_minutes = ? WHERE id = ?').run(minutes, req.user.id);
  setFlash(req, 'success', 'Tiempo de bloqueo actualizado.');
  res.redirect('/seguridad');
});

// --- Huella / Face ID
router.post('/seguridad/huella/opciones', async (req, res, next) => {
  try {
    if (!req.user.pin_hash) return res.status(400).json({ error: 'Primero crea un PIN.' });
    res.json(await wa.registrationOptions(req));
  } catch (e) { next(e); }
});
router.post('/seguridad/huella/registrar', async (req, res) => {
  try {
    const ok = await wa.verifyRegistration(req, req.body.credential, req.body.label);
    if (ok) log(req.user.id, 'user', req.user.id, 'huella', 'Dispositivo agregado');
    res.json({ ok });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
router.post('/seguridad/huella/:id/eliminar', (req, res) => {
  db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ? AND id = ?').run(req.user.id, req.params.id);
  setFlash(req, 'success', 'Dispositivo quitado.');
  res.redirect('/seguridad');
});

// --- Notificaciones
router.post('/push/suscribir', (req, res) => {
  try {
    push.subscribe(req.user.id, req.body.subscription);
    db.prepare('UPDATE users SET notify_push = 1 WHERE id = ?').run(req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
router.post('/push/cancelar', (req, res) => {
  push.unsubscribe(req.user.id, req.body.endpoint);
  res.json({ ok: true });
});
router.post('/push/prueba', async (req, res) => {
  const n = await push.sendToUser(req.user.id, { title: 'EriJuli', body: 'Las notificaciones funcionan. Te avisaremos de fijos por vencer, tarjetas y topes.', url: '/' });
  if (req.headers.accept && req.headers.accept.includes('application/json')) return res.json({ ok: n > 0, sent: n });
  setFlash(req, n ? 'success' : 'error', n ? 'Notificación de prueba enviada.' : 'No hay dispositivos con notificaciones activas.');
  res.redirect('/seguridad');
});

// --- Pantalla de bloqueo
router.get('/bloqueo', (req, res) => {
  if (!req.session.locked) return res.redirect('/');
  res.render('security/lock', { title: 'App bloqueada', layout: 'layout', locked: true, hasDevices: wa.credentials(req.user.id).length > 0 });
});
function unlock(req, res) {
  req.session.locked = false;
  req.session.pinFails = 0;
  const next = req.session.afterUnlock && req.session.afterUnlock.startsWith('/') && !req.session.afterUnlock.startsWith('//') ? req.session.afterUnlock : '/';
  delete req.session.afterUnlock;
  return next;
}
router.post('/bloqueo', (req, res) => {
  if (!req.session.locked) return res.redirect('/');
  if (req.user.pin_hash && bcrypt.compareSync(String(req.body.pin || ''), req.user.pin_hash)) return res.redirect(unlock(req, res));
  req.session.pinFails = (req.session.pinFails || 0) + 1;
  if (req.session.pinFails >= 5) {
    log(req.user.id, 'user', req.user.id, 'bloqueo', '5 intentos fallidos de PIN: sesión cerrada');
    return req.session.destroy(() => res.redirect('/login'));
  }
  setFlash(req, 'error', `PIN incorrecto. Te quedan ${5 - req.session.pinFails} intentos.`);
  res.redirect('/bloqueo');
});
router.post('/bloqueo/huella/opciones', async (req, res, next) => {
  try { res.json(await wa.authenticationOptions(req)); } catch (e) { next(e); }
});
router.post('/bloqueo/huella/verificar', async (req, res) => {
  try {
    if (await wa.verifyAuthentication(req, req.body.credential)) return res.json({ ok: true, next: unlock(req, res) });
    res.json({ ok: false });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

module.exports = router;
