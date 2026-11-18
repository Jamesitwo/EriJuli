'use strict';
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { parseAmount, formatMoney } = require('../utils/money');
const { todayISO } = require('../utils/dates');
const { ensurePeriod } = require('../services/periods');
const { containerBalances } = require('../services/balances');
const hh = require('../services/household');
const { log } = require('../services/audit');

const router = express.Router();

function requireHousehold(req, res) {
  const h = hh.membership(req.user.id);
  if (!h) { res.redirect('/hogar'); return null; }
  return h;
}

router.get('/hogar', (req, res) => {
  const h = hh.membership(req.user.id);
  if (!h) return res.render('household/start', { title: 'Hogar compartido', code: req.query.codigo || '' });
  const ms = hh.members(h.id);
  const byId = new Map(ms.map((m) => [m.id, m]));
  const { net, transfers } = hh.balances(h.id);
  const ym = todayISO().slice(0, 7);
  const expenses = db.prepare(`SELECT e.*, u.name AS payer_name, u.email AS payer_email FROM household_expenses e JOIN users u ON u.id = e.paid_by
    WHERE e.household_id = ? ORDER BY e.date DESC, e.id DESC LIMIT 60`).all(h.id);
  const settlements = db.prepare(`SELECT * FROM household_settlements WHERE household_id = ? ORDER BY date DESC, id DESC LIMIT 20`).all(h.id);
  const categories = db.prepare("SELECT DISTINCT category FROM household_expenses WHERE household_id = ? AND category <> '' ORDER BY category").all(h.id).map((r) => r.category);
  res.render('household/index', {
    title: h.name, household: h, members: ms, byId, net, transfers,
    expenses, settlements, categories,
    monthSpent: hh.monthSpend(h.id, ym),
    containers: containerBalances(req.user.id),
    myCategories: db.prepare("SELECT * FROM categories WHERE user_id = ? AND kind = 'gasto' AND archived = 0 ORDER BY name").all(req.user.id),
    formatMoney,
  });
});

router.post('/hogar', (req, res) => {
  if (hh.membership(req.user.id)) return res.redirect('/hogar');
  const name = String(req.body.name || '').trim() || 'Nuestro hogar';
  const id = hh.create(req.user.id, name);
  log(req.user.id, 'household', id, 'crear', name);
  setFlash(req, 'success', `Hogar "${name}" creado. Comparte el código para invitar a tu pareja o familia.`);
  res.redirect('/hogar');
});

router.post('/hogar/unirse', (req, res) => {
  if (hh.membership(req.user.id)) { setFlash(req, 'error', 'Ya perteneces a un hogar. Sal de él para unirte a otro.'); return res.redirect('/hogar'); }
  const h = hh.join(req.user.id, req.body.code);
  if (!h) { setFlash(req, 'error', 'Ese código no existe. Revísalo con quien te invitó.'); return res.redirect('/hogar'); }
  log(req.user.id, 'household', h.id, 'unirse', h.name);
  setFlash(req, 'success', `Te uniste a "${h.name}".`);
  res.redirect('/hogar');
});

router.post('/hogar/gastos', (req, res) => {
  const h = requireHousehold(req, res); if (!h) return;
  const amount = parseAmount(req.body.amount);
  const ms = hh.members(h.id);
  const payer = ms.find((m) => String(m.id) === String(req.body.paid_by)) || ms.find((m) => m.id === req.user.id);
  if (amount <= 0) { setFlash(req, 'error', 'El valor debe ser mayor que cero.'); return res.redirect('/hogar'); }
  const date = req.body.date || todayISO();
  const description = String(req.body.description || '').trim() || 'Gasto del hogar';
  const split = req.body.split === 'completo' ? 'completo' : 'igual';
  let txId = null;
  // Si lo pagué yo, opcionalmente también queda como gasto en mis movimientos (descuenta de mi bolsillo)
  if (payer.id === req.user.id && req.body.also_mine && req.body.container_from_id) {
    const from = db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, req.body.container_from_id);
    if (from) {
      const p = ensurePeriod(req.user, date);
      txId = db.prepare(`INSERT INTO transactions (user_id, kind, amount, date, description, category_id, container_from_id, expense_type, period_id, origin, notes)
        VALUES (?, 'gasto', ?, ?, ?, ?, ?, 'variable', ?, 'manual', 'Gasto del hogar compartido')`)
        .run(req.user.id, amount, date, description, req.body.category_id || null, from.id, p.id).lastInsertRowid;
    }
  }
  db.prepare(`INSERT INTO household_expenses (household_id, paid_by, amount, date, description, category, split, transaction_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(h.id, payer.id, amount, date, description, String(req.body.category || '').trim().slice(0, 40), split, txId);
  log(req.user.id, 'household', h.id, 'gasto compartido', `${formatMoney(amount, req.user.currency)} · ${description}`);
  setFlash(req, 'success', `Gasto compartido registrado: ${formatMoney(amount, req.user.currency)}.`);
  res.redirect('/hogar');
});

router.post('/hogar/gastos/:id/eliminar', (req, res) => {
  const h = requireHousehold(req, res); if (!h) return;
  const e = db.prepare('SELECT * FROM household_expenses WHERE household_id = ? AND id = ?').get(h.id, req.params.id);
  if (e) {
    db.prepare('DELETE FROM household_expenses WHERE id = ?').run(e.id);
    log(req.user.id, 'household', h.id, 'eliminar gasto compartido', e.description);
    setFlash(req, 'success', 'Gasto compartido eliminado.' + (e.transaction_id ? ' El gasto en tus movimientos se conserva; bórralo allá si quieres.' : ''));
  }
  res.redirect('/hogar');
});

router.post('/hogar/saldar', (req, res) => {
  const h = requireHousehold(req, res); if (!h) return;
  const ms = hh.members(h.id);
  const to = ms.find((m) => String(m.id) === String(req.body.to_user));
  const from = ms.find((m) => String(m.id) === String(req.body.from_user || req.user.id));
  const amount = parseAmount(req.body.amount);
  if (!to || !from || to.id === from.id || amount <= 0) { setFlash(req, 'error', 'Revisa a quién y cuánto pagas.'); return res.redirect('/hogar'); }
  db.prepare('INSERT INTO household_settlements (household_id, from_user, to_user, amount, date, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(h.id, from.id, to.id, amount, req.body.date || todayISO(), String(req.body.note || '').trim());
  log(req.user.id, 'household', h.id, 'saldar', `${from.label} → ${to.label} ${formatMoney(amount, req.user.currency)}`);
  setFlash(req, 'success', `Registrado: ${from.label} le pagó ${formatMoney(amount, req.user.currency)} a ${to.label}.`);
  res.redirect('/hogar');
});

router.post('/hogar/ajustes', (req, res) => {
  const h = requireHousehold(req, res); if (!h) return;
  const name = String(req.body.name || h.name).trim() || h.name;
  db.prepare('UPDATE households SET name = ?, monthly_budget = ? WHERE id = ?').run(name, Math.max(0, parseAmount(req.body.monthly_budget)), h.id);
  if (req.body.new_code) {
    let code; do { code = hh.newCode(); } while (db.prepare('SELECT 1 FROM households WHERE invite_code = ?').get(code));
    db.prepare('UPDATE households SET invite_code = ? WHERE id = ?').run(code, h.id);
  }
  setFlash(req, 'success', req.body.new_code ? 'Código nuevo creado; el anterior ya no sirve.' : 'Hogar actualizado.');
  res.redirect('/hogar');
});

router.post('/hogar/salir', (req, res) => {
  const h = requireHousehold(req, res); if (!h) return;
  const { net } = hh.balances(h.id);
  const mine = net.get(req.user.id) || 0;
  if (mine !== 0 && !req.body.force) {
    setFlash(req, 'error', mine < 0 ? `Antes de salir, salda lo que debes (${formatMoney(-mine, req.user.currency)}).` : `Te deben ${formatMoney(mine, req.user.currency)}. Saldalo antes de salir.`);
    return res.redirect('/hogar');
  }
  db.prepare('DELETE FROM household_members WHERE household_id = ? AND user_id = ?').run(h.id, req.user.id);
  const left = db.prepare('SELECT COUNT(*) AS n FROM household_members WHERE household_id = ?').get(h.id).n;
  if (!left) db.prepare('DELETE FROM households WHERE id = ?').run(h.id);
  log(req.user.id, 'household', h.id, 'salir', h.name);
  setFlash(req, 'success', `Saliste de "${h.name}".`);
  res.redirect('/hogar');
});

module.exports = router;
