'use strict';
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { parseAmount, formatMoney } = require('../utils/money');
const { todayISO } = require('../utils/dates');
const { ensurePeriod, listPeriods, periodById, periodSpend, periodTotalExpenses, periodIncome, periodPendingFixed, closePeriod } = require('../services/periods');
const { log } = require('../services/audit');
const { limitsWithProgress, setLimit } = require('../services/limits');
const { runway } = require('../services/insights');

const router = express.Router();

function budgetSummary(user, period) {
  const spent = periodSpend(period.id, user);
  const totalExpenses = periodTotalExpenses(period.id);
  const income = periodIncome(period.id);
  const pending = periodPendingFixed(period.id);
  const base = period.budget_amount + period.rollover_amount;
  return { spent, totalExpenses, income, pending, base, available: base - spent };
}

// Sugerencia de presupuesto: ingresos esperados − gastos fijos − aportes a metas
function suggestBudget(user) {
  const expected = db.prepare(`SELECT COALESCE(SUM(expected_amount),0) AS total FROM income_sources WHERE user_id = ? AND archived = 0`).get(user.id).total;
  const fixed = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM fixed_expenses WHERE user_id = ? AND active = 1`).get(user.id).total;
  const goals = db.prepare(`SELECT COALESCE(SUM(contribution_per_period),0) AS total FROM goals WHERE user_id = ? AND archived = 0`).get(user.id).total;
  return Math.max(0, expected - fixed - goals);
}

router.get('/presupuesto', (req, res) => {
  const user = req.user;
  const period = ensurePeriod(user);
  const selected = req.query.periodo ? periodById(user, Number(req.query.periodo)) || period : period;
  const summary = budgetSummary(user, selected);

  const detail = db.prepare(`
    SELECT t.*, COALESCE(cf.name, cc.name) AS from_name, c.name AS category_name,
      (SELECT COUNT(*) FROM transaction_splits sp WHERE sp.transaction_id = t.id) AS split_count
    FROM transactions t
    LEFT JOIN containers cf ON cf.id = t.container_from_id
    LEFT JOIN credit_cards cc ON cc.id = t.card_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ? AND t.period_id = ? AND t.kind = 'gasto' AND t.expense_type IN ('fijo','variable')
    ORDER BY t.date DESC
  `).all(user.id, selected.id);

  const extraDetail = db.prepare(`
    SELECT t.*, COALESCE(cf.name, cc.name) AS from_name, c.name AS category_name,
      (SELECT COUNT(*) FROM transaction_splits sp WHERE sp.transaction_id = t.id) AS split_count
    FROM transactions t
    LEFT JOIN containers cf ON cf.id = t.container_from_id
    LEFT JOIN credit_cards cc ON cc.id = t.card_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ? AND t.period_id = ? AND t.kind = 'gasto' AND t.expense_type = 'extra'
    ORDER BY t.date DESC
  `).all(user.id, selected.id);

  res.render('budget/index', {
    title: 'Presupuesto', period, selected, summary, detail, extraDetail,
    periods: listPeriods(user, 12),
    suggestion: suggestBudget(user),
    limits: limitsWithProgress(user, selected),
    expenseCategories: db.prepare("SELECT * FROM categories WHERE user_id = ? AND kind = 'gasto' AND archived = 0 ORDER BY name").all(user.id),
    run: selected.id === period.id ? runway(user, selected, summary.available - summary.pending.total) : null,
    formatMoney,
  });
});

router.post('/presupuesto', (req, res) => {
  const period = periodById(req.user, Number(req.body.period_id));
  if (!period) return res.redirect('/presupuesto');
  const amount = parseAmount(req.body.budget_amount);
  db.prepare('UPDATE periods SET budget_amount = ? WHERE id = ?').run(Math.max(0, amount), period.id);
  log(req.user.id, 'period', period.id, 'presupuesto', formatMoney(amount, req.user.currency));
  setFlash(req, 'success', `Presupuesto de ${period.label} guardado: ${formatMoney(amount, req.user.currency)}.`);
  res.redirect('/presupuesto');
});

router.post('/presupuesto/topes', (req, res) => {
  const cat = db.prepare("SELECT * FROM categories WHERE user_id = ? AND id = ? AND kind = 'gasto'").get(req.user.id, req.body.category_id);
  if (!cat) { setFlash(req, 'error', 'Elige una categoría de gasto.'); return res.redirect('/presupuesto#topes'); }
  const amount = Math.max(0, parseAmount(req.body.amount));
  setLimit(req.user.id, cat.id, amount);
  log(req.user.id, 'category', cat.id, 'tope', amount ? formatMoney(amount, req.user.currency) : 'quitado');
  setFlash(req, 'success', amount ? `Tope de ${cat.name}: ${formatMoney(amount, req.user.currency)} por periodo.` : `Quitaste el tope de ${cat.name}.`);
  res.redirect('/presupuesto#topes');
});

router.post('/presupuesto/:id/cerrar', (req, res) => {
  const period = periodById(req.user, Number(req.params.id));
  if (!period) return res.redirect('/presupuesto');
  const next = closePeriod(req.user, period);
  log(req.user.id, 'period', period.id, 'cerrar periodo', period.label);
  setFlash(req, 'success', `${period.label} cerrado. Se abrió ${next.label} con tus gastos fijos precargados.`);
  res.redirect('/presupuesto');
});

module.exports = router;
