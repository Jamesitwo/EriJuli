'use strict';
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { parseAmount, formatMoney } = require('../utils/money');
const { todayISO, formatDate } = require('../utils/dates');
const { log } = require('../services/audit');
const { containerBalances, containerBalance } = require('../services/balances');

const router = express.Router();

function goalBalance(containerId, userId) {
  if (!containerId) return 0;
  return db.prepare(`
    SELECT COALESCE(c.initial_balance, 0)
      + COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = ? AND t.kind = 'ingreso' AND t.container_to_id = c.id), 0)
      + COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = ? AND t.kind = 'transferencia' AND t.container_to_id = c.id), 0)
      - COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = ? AND t.kind = 'gasto' AND t.container_from_id = c.id), 0)
      - COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = ? AND t.kind = 'transferencia' AND t.container_from_id = c.id), 0)
    AS balance FROM containers c WHERE c.id = ?
  `).get(userId, userId, userId, userId, containerId).balance;
}

router.get('/metas', (req, res) => {
  const goals = db.prepare(`
    SELECT g.*, c.name AS container_name, b.name AS bank_name
    FROM goals g LEFT JOIN containers c ON c.id = g.container_id LEFT JOIN banks b ON b.id = c.bank_id
    WHERE g.user_id = ? AND g.archived = 0 ORDER BY g.target_date
  `).all(req.user.id).map((g) => {
    const saved = goalBalance(g.container_id, req.user.id);
    const pct = g.target_amount > 0 ? Math.min(100, Math.round((saved / g.target_amount) * 100)) : 0;
    let monthsLeft = null;
    if (g.target_date) {
      monthsLeft = Math.max(0, Math.round((new Date(g.target_date) - new Date(todayISO())) / (86400000 * 30)));
    }
    const suggested = monthsLeft && monthsLeft > 0 ? Math.max(0, Math.ceil((g.target_amount - saved) / monthsLeft / 100) * 100) : g.contribution_per_period;
    return { ...g, saved, pct, suggested, monthsLeft };
  });

  res.render('goals/index', {
    title: 'Metas de ahorro', goals,
    containers: containerBalances(req.user.id),
    banks: db.prepare('SELECT * FROM banks WHERE user_id = ? ORDER BY name').all(req.user.id),
    formatMoney,
  });
});

/** "nuevo:<banco>" crea un bolsillo con el nombre de la meta; un id usa un bolsillo existente. */
function resolvePocket(req, name) {
  const v = String(req.body.container_id || '');
  const m = /^nuevo:(\d+)$/.exec(v);
  if (m) {
    const bank = db.prepare('SELECT * FROM banks WHERE user_id = ? AND id = ?').get(req.user.id, m[1]);
    if (!bank) return null;
    const info = db.prepare(`INSERT INTO containers (user_id, bank_id, kind, name, purpose, initial_balance) VALUES (?, ?, 'bolsillo', ?, ?, 0)`)
      .run(req.user.id, bank.id, name, `Meta: ${name}`);
    return info.lastInsertRowid;
  }
  if (!v) return null;
  const c = db.prepare('SELECT id FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, v);
  return c ? c.id : null;
}

router.post('/metas', (req, res) => {
  const name = String(req.body.name || '').trim();
  const target = parseAmount(req.body.target_amount);
  if (!name || target <= 0) { setFlash(req, 'error', 'Necesitas nombre y un monto objetivo mayor que cero.'); return res.redirect('/metas'); }
  const pocketId = resolvePocket(req, name);
  const info = db.prepare(`INSERT INTO goals (user_id, name, target_amount, target_date, container_id, contribution_per_period, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, name, target, req.body.target_date || null, pocketId,
      parseAmount(req.body.contribution_per_period), String(req.body.notes || '').trim());
  log(req.user.id, 'goal', info.lastInsertRowid, 'crear', `${name} · ${formatMoney(target, req.user.currency)}`);
  setFlash(req, 'success', pocketId
    ? `Meta "${name}" creada. Usa "Aportar" para mover dinero a su bolsillo.`
    : `Meta "${name}" creada. Asóciale un bolsillo para poder aportarle.`);
  res.redirect('/metas');
});

router.post('/metas/:id/aportar', (req, res) => {
  const g = db.prepare('SELECT * FROM goals WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!g) return res.redirect('/metas');
  const amount = parseAmount(req.body.amount);
  const from = db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, req.body.container_from_id);
  const to = db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, g.container_id);
  if (!to) { setFlash(req, 'error', `La meta "${g.name}" no tiene bolsillo. Crea o asóciale uno para guardar el dinero.`); return res.redirect('/metas'); }
  if (!from) { setFlash(req, 'error', 'Elige de qué cuenta o bolsillo sale el dinero.'); return res.redirect('/metas'); }
  if (from.id === to.id) { setFlash(req, 'error', `El dinero ya está en "${to.name}", el bolsillo de la meta. Elige otra cuenta o bolsillo de origen.`); return res.redirect('/metas'); }
  if (amount <= 0) { setFlash(req, 'error', 'El aporte debe ser mayor que cero.'); return res.redirect('/metas'); }
  const available = containerBalance(req.user.id, from.id);
  if (amount > available) {
    setFlash(req, 'error', available > 0
      ? `En "${from.name}" solo hay ${formatMoney(available, req.user.currency)}. Aporta hasta ese valor o elige otra cuenta.`
      : `"${from.name}" no tiene saldo. Registra primero el ingreso o elige otra cuenta.`);
    return res.redirect('/metas');
  }
  const { ensurePeriod } = require('../services/periods');
  const period = ensurePeriod(req.user, req.body.date || todayISO());
  const info = db.prepare(`INSERT INTO transactions (user_id, kind, amount, date, description, container_from_id, container_to_id, period_id, origin, notes)
    VALUES (?, 'transferencia', ?, ?, ?, ?, ?, ?, 'manual', ?)`)
    .run(req.user.id, amount, req.body.date || todayISO(), `Aporte a meta: ${g.name}`, from.id, to.id, period.id, 'aporte_meta');
  log(req.user.id, 'transaction', info.lastInsertRowid, 'aporte meta', `${g.name} · ${formatMoney(amount, req.user.currency)}`);
  setFlash(req, 'success', `Aportaste ${formatMoney(amount, req.user.currency)} a "${g.name}".`);
  res.redirect('/metas');
});

// Crear y asociar un bolsillo a una meta que no tiene
router.post('/metas/:id/bolsillo', (req, res) => {
  const g = db.prepare('SELECT * FROM goals WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!g) return res.redirect('/metas');
  const pocketId = resolvePocket(req, g.name);
  if (!pocketId) { setFlash(req, 'error', 'Elige un banco o un bolsillo.'); return res.redirect('/metas'); }
  db.prepare('UPDATE goals SET container_id = ? WHERE id = ?').run(pocketId, g.id);
  log(req.user.id, 'goal', g.id, 'bolsillo', `Asociado a ${pocketId}`);
  setFlash(req, 'success', `Listo: "${g.name}" ya tiene su bolsillo. Ahora puedes aportarle.`);
  res.redirect('/metas');
});

router.post('/metas/:id/editar', (req, res) => {
  const g = db.prepare('SELECT * FROM goals WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!g) return res.redirect('/metas');
  db.prepare('UPDATE goals SET name = ?, target_amount = ?, target_date = ?, container_id = ?, contribution_per_period = ?, notes = ?, archived = ? WHERE id = ?')
    .run(String(req.body.name || g.name).trim(), parseAmount(req.body.target_amount) || g.target_amount,
      req.body.target_date || null, req.body.container_id || null, parseAmount(req.body.contribution_per_period),
      String(req.body.notes || '').trim(), req.body.archived ? 1 : 0, g.id);
  log(req.user.id, 'goal', g.id, 'editar', req.body.name || g.name);
  setFlash(req, 'success', 'Meta actualizada.');
  res.redirect('/metas');
});

module.exports = router;
