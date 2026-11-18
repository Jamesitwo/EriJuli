'use strict';
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { log } = require('../services/audit');

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
    .run(String(name || '').trim(), currency || u.currency, timezone || u.timezone,
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

module.exports = router;
