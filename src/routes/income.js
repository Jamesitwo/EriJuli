'use strict';
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { parseAmount, formatMoney } = require('../utils/money');
const { todayISO } = require('../utils/dates');
const { ensurePeriod, listPeriods, periodById, periodIncome } = require('../services/periods');
const { log } = require('../services/audit');

const router = express.Router();

router.get('/ingresos', (req, res) => {
  const user = req.user;
  const period = ensurePeriod(user);
  const sources = db.prepare(`
    SELECT s.*,
      COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.income_source_id = s.id AND t.kind = 'ingreso' AND t.period_id = ?), 0) AS received
    FROM income_sources s WHERE s.user_id = ? AND s.archived = 0 ORDER BY s.name
  `).all(period.id, user.id);

  const incomes = db.prepare(`
    SELECT t.*, c.name AS container_name, s.name AS source_name
    FROM transactions t
    LEFT JOIN containers c ON c.id = t.container_to_id
    LEFT JOIN income_sources s ON s.id = t.income_source_id
    WHERE t.user_id = ? AND t.kind = 'ingreso' AND t.period_id = ?
    ORDER BY t.date DESC
  `).all(user.id, period.id);

  const extras = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions
    WHERE user_id = ? AND kind = 'ingreso' AND period_id = ? AND income_source_id IS NULL`).get(user.id, period.id).total;

  res.render('income/index', {
    title: 'Ingresos', period, sources, incomes, extras,
    total: periodIncome(period.id),
    containers: db.prepare(`SELECT c.*, b.name AS bank_name FROM containers c JOIN banks b ON b.id = c.bank_id
      WHERE c.user_id = ? AND c.archived = 0 ORDER BY b.name, c.name`).all(user.id),
    formatMoney,
  });
});

router.post('/fuentes-ingreso', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) { setFlash(req, 'error', 'Escribe el nombre de la fuente de ingreso.'); return res.redirect('/ingresos'); }
  const info = db.prepare('INSERT INTO income_sources (user_id, name, expected_amount, frequency, notes) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, name, parseAmount(req.body.expected_amount), req.body.frequency || 'mensual', String(req.body.notes || '').trim());
  log(req.user.id, 'income_source', info.lastInsertRowid, 'crear', name);
  setFlash(req, 'success', `Fuente de ingreso "${name}" creada.`);
  res.redirect('/ingresos');
});

router.post('/fuentes-ingreso/:id/editar', (req, res) => {
  const s = db.prepare('SELECT * FROM income_sources WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!s) return res.redirect('/ingresos');
  db.prepare('UPDATE income_sources SET name = ?, expected_amount = ?, frequency = ?, notes = ?, archived = ? WHERE id = ?')
    .run(String(req.body.name || s.name).trim(), parseAmount(req.body.expected_amount), req.body.frequency || s.frequency,
      String(req.body.notes || '').trim(), req.body.archived ? 1 : 0, s.id);
  log(req.user.id, 'income_source', s.id, 'editar', req.body.name || s.name);
  setFlash(req, 'success', 'Fuente de ingreso actualizada.');
  res.redirect('/ingresos');
});

// "Dinero extra": ingreso no contemplado (sin fuente registrada o marcado como extra)
router.post('/ingresos', (req, res) => {
  const amount = parseAmount(req.body.amount);
  const date = req.body.date || todayISO();
  if (amount <= 0) { setFlash(req, 'error', 'El valor debe ser mayor que cero.'); return res.redirect('/ingresos'); }
  const to = db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, req.body.container_to_id);
  if (!to) { setFlash(req, 'error', 'Elige a qué cuenta o bolsillo entra el dinero.'); return res.redirect('/ingresos'); }
  const period = ensurePeriod(req.user, date);
  const isExtra = req.body.is_extra ? 1 : 0;
  const info = db.prepare(`INSERT INTO transactions (user_id, kind, amount, date, description, income_source_id, container_to_id, period_id, origin, notes, expense_type)
    VALUES (?, 'ingreso', ?, ?, ?, ?, ?, ?, 'manual', ?, 'variable')`)
    .run(req.user.id, amount, date,
      String(req.body.description || '').trim() || (isExtra ? 'Dinero extra' : 'Ingreso'),
      isExtra ? null : (req.body.income_source_id || null), to.id, period.id, String(req.body.notes || '').trim());
  log(req.user.id, 'transaction', info.lastInsertRowid, 'crear ingreso', `${formatMoney(amount, req.user.currency)} en ${to.name}`);
  setFlash(req, 'success', `Ingreso de ${formatMoney(amount, req.user.currency)} registrado en ${to.name}.`);
  res.redirect('/ingresos');
});

module.exports = router;
