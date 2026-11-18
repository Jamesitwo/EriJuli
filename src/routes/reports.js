'use strict';
const express = require('express');
const { db } = require('../db');
const { formatMoney } = require('../utils/money');
const { ensurePeriod, listPeriods, periodById, periodSpend, periodTotalExpenses, periodIncome, periodPendingFixed } = require('../services/periods');

const { monthlySeries, chartGeometry } = require('../services/insights');

const router = express.Router();

router.get('/reportes', (req, res) => {
  const user = req.user;
  const period = ensurePeriod(user);
  const selected = req.query.periodo ? periodById(user, Number(req.query.periodo)) || period : period;

  // Gastos por categoría del periodo
  const byCategory = db.prepare(`
    SELECT COALESCE(c.name, 'Sin categoría') AS name, COALESCE(c.color, '#5a6560') AS color, SUM(l.amount) AS total
    FROM category_lines l LEFT JOIN categories c ON c.id = l.category_id
    WHERE l.user_id = ? AND l.period_id = ? AND l.kind = 'gasto'
    GROUP BY l.category_id ORDER BY total DESC
  `).all(user.id, selected.id);

  // Ingresos por fuente
  const bySource = db.prepare(`
    SELECT COALESCE(s.name, 'Sin fuente (extra)') AS name, SUM(t.amount) AS total
    FROM transactions t LEFT JOIN income_sources s ON s.id = t.income_source_id
    WHERE t.user_id = ? AND t.period_id = ? AND t.kind = 'ingreso'
    GROUP BY t.income_source_id ORDER BY total DESC
  `).all(user.id, selected.id);

  // Gastos por bolsillo/cuenta de origen
  const byContainer = db.prepare(`
    SELECT COALESCE(cf.name, 'Tarjeta ' || cc.name, 'Sin cuenta') AS name, SUM(t.amount) AS total
    FROM transactions t LEFT JOIN containers cf ON cf.id = t.container_from_id LEFT JOIN credit_cards cc ON cc.id = t.card_id
    WHERE t.user_id = ? AND t.period_id = ? AND t.kind = 'gasto'
    GROUP BY t.container_from_id, t.card_id ORDER BY total DESC
  `).all(user.id, selected.id);

  // Comparación entre periodos (últimos 6)
  const periods = listPeriods(user, 6).reverse();
  const comparison = periods.map((p) => ({
    label: p.label,
    income: periodIncome(p.id),
    expenses: periodTotalExpenses(p.id),
    budget: p.budget_amount + p.rollover_amount,
    spent: periodSpend(p.id, user),
    pending: periodPendingFixed(p.id).total,
    id: p.id,
    isCurrent: p.id === selected.id,
  }));

  const series = monthlySeries(user.id, 12);
  const chart = chartGeometry(series, { width: 640, height: 220, pad: 32 });
  const barChart = chartGeometry(series, { width: 640, height: 180, pad: 28 });
  const first = series[0], last = series[series.length - 1];
  const evolution = { series, chart, barChart, change: last.netWorth - first.netWorth, first, last,
    avgSaving: Math.round(series.reduce((s2, p) => s2 + p.net, 0) / series.length) };

  const maxCat = byCategory.reduce((m, c) => Math.max(m, c.total), 0) || 1;

  res.render('reports/index', {
    title: 'Reportes', period, selected, evolution, byCategory, bySource, byContainer, comparison, maxCat,
    periods: listPeriods(user, 12), formatMoney,
  });
});

module.exports = router;
