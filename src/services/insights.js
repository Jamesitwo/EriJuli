'use strict';
// Cálculos para ayudar a decidir: cuánto queda por día y cómo evoluciona tu dinero
const { db } = require('../db');
const { todayISO, parseISO } = require('../utils/dates');

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

/** Ingresos esperados que faltan por llegar en el periodo, según las fuentes de ingreso. */
function expectedIncomePending(user, period) {
  const sources = db.prepare('SELECT * FROM income_sources WHERE user_id = ? AND archived = 0 AND expected_amount > 0').all(user.id);
  let pending = 0;
  for (const s of sources) {
    let expected = s.expected_amount;
    if (user.period_type === 'mensual' && s.frequency === 'quincenal') expected *= 2;
    if (user.period_type === 'quincenal' && s.frequency === 'mensual') expected = Math.round(expected / 2);
    const got = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM transactions WHERE user_id = ? AND period_id = ? AND kind = 'ingreso' AND income_source_id = ?`)
      .get(user.id, period.id, s.id).t;
    pending += Math.max(0, expected - got);
  }
  return pending;
}

/** Lo libre del periodo repartido entre los días que faltan (hoy incluido). */
function runway(user, period, free) {
  const today = todayISO();
  const end = period.end_date;
  const daysLeft = Math.max(1, Math.round((parseISO(end) - parseISO(today < period.start_date ? period.start_date : today)) / 86400000) + 1);
  return {
    daysLeft,
    free,
    perDay: free > 0 ? Math.floor(free / daysLeft) : 0,
    endDate: end,
    expectedPending: expectedIncomePending(user, period),
  };
}

/** Serie mensual de los últimos meses: ingresos, gastos y patrimonio neto al cierre de cada mes. */
function monthlySeries(userId, months = 12) {
  const base = db.prepare('SELECT COALESCE(SUM(initial_balance),0) AS t FROM containers WHERE user_id = ?').get(userId).t
    - db.prepare('SELECT COALESCE(SUM(initial_debt),0) AS t FROM credit_cards WHERE user_id = ?').get(userId).t;
  const rows = db.prepare(`SELECT substr(date, 1, 7) AS ym,
      SUM(CASE WHEN kind = 'ingreso' THEN amount ELSE 0 END) AS income,
      SUM(CASE WHEN kind = 'gasto' THEN amount ELSE 0 END) AS expenses
    FROM transactions WHERE user_id = ? GROUP BY ym ORDER BY ym`).all(userId);
  const now = parseISO(todayISO());
  const list = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    list.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const byYm = new Map(rows.map((r) => [r.ym, r]));
  let cumulative = base + rows.filter((r) => r.ym < list[0]).reduce((s, r) => s + r.income - r.expenses, 0);
  const firstData = rows.length ? rows[0].ym : null;
  const out = list.map((ym) => {
    const r = byYm.get(ym) || { income: 0, expenses: 0 };
    cumulative += r.income - r.expenses;
    const [y, m] = ym.split('-').map(Number);
    return { ym, label: `${MESES[m - 1]}${m === 1 || ym === list[0] ? ' ' + String(y).slice(2) : ''}`, income: r.income, expenses: r.expenses, net: r.income - r.expenses, netWorth: cumulative, hasData: !!firstData && ym >= firstData };
  });
  // Mostrar desde el primer mes con datos (mínimo 3 meses para que la gráfica tenga sentido)
  const firstIdx = Math.min(out.findIndex((p) => p.hasData) === -1 ? out.length - 1 : out.findIndex((p) => p.hasData), out.length - 3);
  return out.slice(Math.max(0, firstIdx));
}

/** Geometría simple para dibujar las gráficas en SVG desde la vista. */
function chartGeometry(series, { width = 640, height = 200, pad = 28 } = {}) {
  const values = series.map((p) => p.netWorth);
  const maxBar = Math.max(1, ...series.map((p) => Math.max(p.income, p.expenses)));
  let min = Math.min(...values), max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const innerW = width - pad * 2, innerH = height - pad * 2;
  const step = series.length > 1 ? innerW / (series.length - 1) : 0;
  const pts = series.map((p, i) => ({ x: pad + i * step, y: pad + innerH - ((p.netWorth - min) / span) * innerH, ...p }));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${pad + innerH} L${pts[0].x.toFixed(1)},${pad + innerH} Z`;
  const slot = innerW / series.length;
  const barW = Math.min(14, slot / 3);
  const bars = series.map((p, i) => {
    const cx = pad + slot * i + slot / 2;
    return { cx, barW, inH: (p.income / maxBar) * innerH, exH: (p.expenses / maxBar) * innerH, ...p };
  });
  return { width, height, pad, innerH, pts, line, area, bars, min, max };
}

module.exports = { runway, monthlySeries, chartGeometry, expectedIncomePending };
