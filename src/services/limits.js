'use strict';
// Topes de gasto por categoría (por periodo)
const { db } = require('../db');
const { ensurePeriod } = require('./periods');

/** Gasto del periodo por categoría, contando las partes de los gastos divididos. */
function spendByCategory(userId, periodId) {
  const rows = db.prepare(`SELECT category_id, SUM(amount) AS total FROM category_lines
    WHERE user_id = ? AND period_id = ? AND kind = 'gasto' GROUP BY category_id`).all(userId, periodId);
  return new Map(rows.map((r) => [r.category_id, r.total]));
}

/** Lista de topes con lo gastado: [{ category_id, name, color, limit, spent, left, pct, state }] */
function limitsWithProgress(user, period) {
  const p = period || ensurePeriod(user);
  const spent = spendByCategory(user.id, p.id);
  return db.prepare(`SELECT l.*, c.name, c.color FROM category_limits l JOIN categories c ON c.id = l.category_id
    WHERE l.user_id = ? AND c.archived = 0 ORDER BY c.name`).all(user.id).map((l) => {
    const s = spent.get(l.category_id) || 0;
    const pct = l.amount > 0 ? Math.round((s / l.amount) * 100) : 0;
    return { id: l.id, category_id: l.category_id, name: l.name, color: l.color, limit: l.amount, spent: s, left: l.amount - s, pct,
      state: pct >= 100 ? 'over' : pct >= 80 ? 'near' : 'ok' };
  }).sort((a, b) => b.pct - a.pct);
}

/** Mapa category_id → progreso, para el formulario de movimientos. */
function categoryProgress(user) {
  const out = {};
  for (const l of limitsWithProgress(user)) out[l.category_id] = l;
  return out;
}

function setLimit(userId, categoryId, amount) {
  if (amount > 0) {
    db.prepare(`INSERT INTO category_limits (user_id, category_id, amount) VALUES (?, ?, ?)
      ON CONFLICT(user_id, category_id) DO UPDATE SET amount = excluded.amount`).run(userId, categoryId, amount);
  } else {
    db.prepare('DELETE FROM category_limits WHERE user_id = ? AND category_id = ?').run(userId, categoryId);
  }
}

module.exports = { spendByCategory, limitsWithProgress, categoryProgress, setLimit };
