'use strict';
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { log } = require('../services/audit');

const { validTimeZone } = require('../utils/dates');
const router = express.Router();

router.get('/configuracion', (req, res) => {
  res.render('settings/index', {
    title: 'Configuración',
    categories: db.prepare('SELECT * FROM categories WHERE user_id = ? ORDER BY kind, archived, name').all(req.user.id),
  });
});

router.post('/configuracion', (req, res) => {
  const u = req.user;
  const { name, currency, timezone, period_type, quincena_dia1, quincena_dia2, budget_includes_fixed, rollover_enabled, alert_days_fixed, alert_low_balance } = req.body;
  db.prepare(`UPDATE users SET name = ?, currency = ?, timezone = ?, period_type = ?, quincena_dia1 = ?, quincena_dia2 = ?,
    budget_includes_fixed = ?, rollover_enabled = ?, alert_days_fixed = ?, alert_low_balance = ? WHERE id = ?`)
    .run(String(name || '').trim(), currency || u.currency, (timezone && validTimeZone(timezone)) ? timezone : u.timezone,
      period_type === 'quincenal' ? 'quincenal' : 'mensual',
      Math.min(Math.max(1, Number(quincena_dia1) || 1), 28),
      Math.min(Math.max(2, Number(quincena_dia2) || 16), 28),
      budget_includes_fixed ? 1 : 0, rollover_enabled ? 1 : 0,
      Math.max(0, Number(alert_days_fixed) || 0), Math.max(0, Number(alert_low_balance) || 0), u.id);
  const theme = ['auto', 'claro', 'oscuro'].includes(req.body.theme) ? req.body.theme : 'auto';
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, u.id);
  const motion = ['auto', 'si', 'no'].includes(req.body.motion) ? req.body.motion : 'auto';
  db.prepare('UPDATE users SET motion = ? WHERE id = ?').run(motion, u.id);
  log(u.id, 'user', u.id, 'configuración', 'Actualizada');
  setFlash(req, 'success', 'Configuración guardada.');
  res.redirect('/configuracion');
});

router.post('/categorias', (req, res) => {
  const name = String(req.body.name || '').trim();
  const kind = req.body.kind === 'ingreso' ? 'ingreso' : 'gasto';
  if (!name) { setFlash(req, 'error', 'Escribe el nombre de la categoría.'); return res.redirect('/configuracion'); }
  const info = db.prepare('INSERT INTO categories (user_id, name, kind, color) VALUES (?, ?, ?, ?)')
    .run(req.user.id, name, kind, req.body.color || '#5a6560');
  log(req.user.id, 'category', info.lastInsertRowid, 'crear', name);
  setFlash(req, 'success', `Categoría "${name}" creada.`);
  res.redirect('/configuracion');
});

router.post('/categorias/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM categories WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!c) return res.redirect('/configuracion');
  db.prepare('UPDATE categories SET name = ?, color = ?, archived = ? WHERE id = ?')
    .run(String(req.body.name || c.name).trim(), req.body.color || c.color, req.body.archived ? 1 : 0, c.id);
  setFlash(req, 'success', 'Categoría actualizada.');
  res.redirect('/configuracion');
});

// Eliminar la cuenta con todo lo guardado (RN-05)
router.post('/cuenta/eliminar', async (req, res) => {
  const bcrypt = require('bcryptjs');
  if (!bcrypt.compareSync(String(req.body.password || ''), req.user.password_hash)) {
    setFlash(req, 'error', 'La contraseña no es correcta. Tu cuenta sigue intacta.');
    return res.redirect('/configuracion#eliminar-cuenta');
  }
  if (String(req.body.confirmacion || '').trim().toUpperCase() !== 'ELIMINAR') {
    setFlash(req, 'error', 'Escribe ELIMINAR para confirmar. Tu cuenta sigue intacta.');
    return res.redirect('/configuracion#eliminar-cuenta');
  }
  const userId = req.user.id;
  try { await require('../services/gmail').revoke(userId); } catch { /* mejor esfuerzo: igual se borran las credenciales */ }
  require('../services/account').deleteAccount(userId);
  console.log(`Cuenta ${userId} eliminada a pedido de la persona.`);
  req.session.regenerate(() => {
    req.session.flash = { type: 'success', text: 'Tu cuenta y todos tus datos fueron eliminados. Gracias por usar EriJuli.' };
    res.redirect('/login');
  });
});

module.exports = router;
