'use strict';
const express = require('express');
const { db } = require('../db');
const { formatMoney } = require('../utils/money');
const { todayISO, formatDate } = require('../utils/dates');
const { ensurePeriod, periodSpend, periodTotalExpenses, periodIncome, periodPendingFixed, listPeriods } = require('../services/periods');
const { bankTotals, containerBalances } = require('../services/balances');
const { computeAlerts } = require('../services/alerts');
const { listCards } = require('../services/cards');
const { limitsWithProgress } = require('../services/limits');
const { runway, monthlySeries } = require('../services/insights');

const router = express.Router();

// Saludo según la hora de Bogotá (o la zona de la persona)
function greeting(user) {
  const h = Number(new Intl.DateTimeFormat('es-CO', { hour: 'numeric', hour12: false, timeZone: user.timezone || 'America/Bogota' }).format(new Date()));
  const first = String(user.name || '').trim().split(/\s+/)[0];
  const base = h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
  return first ? `${base}, ${first}` : base;
}
function todayLong() {
  const s = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota' }).format(new Date());
  return s.charAt(0).toUpperCase() + s.slice(1);
}

router.get('/', (req, res) => {
  const user = req.user;
  const period = ensurePeriod(user);
  const { banks, total } = bankTotals(user.id);

  const spent = periodSpend(period.id, user);
  const totalExpenses = periodTotalExpenses(period.id);
  const income = periodIncome(period.id);
  const pending = periodPendingFixed(period.id);
  const budgetBase = period.budget_amount + period.rollover_amount;
  const available = budgetBase - spent;

  const recent = db.prepare(`
    SELECT t.*, COALESCE(cf.name, cc.name) AS from_name, ct.name AS to_name, c.name AS category_name, s.name AS source_name,
      (SELECT COUNT(*) FROM transaction_splits sp WHERE sp.transaction_id = t.id) AS split_count
    FROM transactions t
    LEFT JOIN credit_cards cc ON cc.id = t.card_id
    LEFT JOIN containers cf ON cf.id = t.container_from_id
    LEFT JOIN containers ct ON ct.id = t.container_to_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN income_sources s ON s.id = t.income_source_id
    WHERE t.user_id = ? ORDER BY t.date DESC, t.id DESC LIMIT 8
  `).all(user.id);

  const balancesById = new Map(containerBalances(user.id).map((c) => [c.id, c.balance]));
  const goals = db.prepare(`
    SELECT g.*, c.name AS container_name
    FROM goals g LEFT JOIN containers c ON c.id = g.container_id
    WHERE g.user_id = ? AND g.archived = 0 ORDER BY g.target_date LIMIT 3
  `).all(user.id).map((g) => ({
    ...g,
    saved: g.container_id ? (balancesById.get(g.container_id) || 0) : 0,
  }));

  const pendingInbox = db.prepare(`SELECT COUNT(*) AS n FROM proposed_movements WHERE user_id = ? AND status IN ('propuesto','sin_procesar')`).get(user.id).n;

  const cards = listCards(user.id);
  const cardDebt = cards.reduce((sum, c) => sum + Math.max(0, c.status.debt), 0);
  const series = monthlySeries(user.id, 2);
  const monthNet = series.length ? series[series.length - 1].net : 0;
  const limits = limitsWithProgress(user, period).slice(0, 4);
  const free = budgetBase - spent - pending.total;

  res.render('dashboard', {
    cards, cardDebt, monthNet, limits,
    run: runway(user, period, free),
    title: 'Inicio',
    heading: greeting(user),
    subheading: todayLong(),
    period, banks, total, spent, totalExpenses, income, pending, available, budgetBase,
    recent, goals, alerts: computeAlerts(user, period), pendingInbox,
    periods: listPeriods(user, 6),
  });
});

// Página "Más" (menú completo en móvil)
router.get('/mas', (req, res) => {
  res.render('more', { title: 'Más' });
});

module.exports = router;
