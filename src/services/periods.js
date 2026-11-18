'use strict';
const { db } = require('../db');
const { periodFor, nextPeriodRange, todayISO, parseISO, toISO, addDays } = require('../utils/dates');

/** Devuelve el periodo que contiene la fecha; lo crea (y genera sus gastos fijos) si no existe. */
function ensurePeriod(user, iso = todayISO()) {
  const range = periodFor(user, iso);
  let period = db.prepare('SELECT * FROM periods WHERE user_id = ? AND start_date = ?').get(user.id, range.start_date);
  if (!period) {
    // Arrastre del periodo anterior si está habilitado
    let rollover = 0;
    if (user.rollover_enabled) {
      const prevRange = previousRange(user, range.start_date);
      const prev = db.prepare('SELECT * FROM periods WHERE user_id = ? AND start_date = ?').get(user.id, prevRange.start_date);
      if (prev && prev.status === 'cerrado') {
        const used = periodSpend(prev.id, user);
        rollover = Math.max(0, prev.budget_amount + prev.rollover_amount - used);
      }
    }
    const info = db.prepare(`INSERT INTO periods (user_id, label, start_date, end_date, budget_amount, rollover_amount)
      VALUES (?, ?, ?, ?, 0, ?)`).run(user.id, range.label, range.start_date, range.end_date, rollover);
    period = db.prepare('SELECT * FROM periods WHERE id = ?').get(info.lastInsertRowid);
  }
  generateFixedInstances(user, period);
  return period;
}

function previousRange(user, startDate) {
  const d = parseISO(startDate);
  const prevDay = toISO(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
  return periodFor(user, prevDay);
}

/**
 * Genera las instancias de gastos fijos del mes del periodo indicado (si faltan).
 * Cada gasto fijo se asigna al periodo que contiene su día de pago: en modo quincenal,
 * un fijo mensual cae en la quincena de su fecha, y uno quincenal genera en cada quincena.
 */
function generateFixedInstances(user, period) {
  const fixed = db.prepare('SELECT * FROM fixed_expenses WHERE user_id = ? AND active = 1').all(user.id);
  const insert = db.prepare(`INSERT OR IGNORE INTO fixed_instances
    (user_id, fixed_expense_id, period_id, description, amount, due_date, payment_method)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const [y, m] = period.start_date.split('-').map(Number);

  for (const f of fixed) {
    const last = new Date(y, m, 0).getDate();
    const day = Math.min(Math.max(1, f.due_day || 1), last);
    const dueDate = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    // Periodos del mes a los que aplica según la frecuencia del gasto fijo
    const targets = [];
    const range = periodFor(user, dueDate);
    targets.push(range);
    if (f.frequency === 'quincenal' && user.period_type === 'quincenal') {
      // Genera también en la otra quincena del mes
      const otherDay = day < (user.quincena_dia2 || 16) ? Math.min(last, user.quincena_dia2 || 16) : Math.max(1, (user.quincena_dia1 || 1));
      const otherRange = periodFor(user, `${y}-${String(m).padStart(2, '0')}-${String(otherDay).padStart(2, '0')}`);
      if (otherRange.start_date !== range.start_date) targets.push(otherRange);
    }

    for (const t of targets) {
      let target = db.prepare('SELECT * FROM periods WHERE user_id = ? AND start_date = ?').get(user.id, t.start_date);
      if (!target) {
        const info = db.prepare(`INSERT INTO periods (user_id, label, start_date, end_date, budget_amount, rollover_amount)
          VALUES (?, ?, ?, ?, 0, 0)`).run(user.id, t.label, t.start_date, t.end_date);
        target = db.prepare('SELECT * FROM periods WHERE id = ?').get(info.lastInsertRowid);
      }
      const [ty, tm] = t.start_date.split('-').map(Number);
      const tLast = new Date(ty, tm, 0).getDate();
      const tDay = Math.min(Math.max(1, f.due_day || 1), tLast);
      const tDue = `${ty}-${String(tm).padStart(2, '0')}-${String(tDay).padStart(2, '0')}`;
      insert.run(user.id, f.id, target.id, f.description, f.amount, tDue, f.payment_method || '');
    }
  }
}

/** Gastos del periodo que consumen presupuesto (según configuración del usuario). */
function periodSpend(periodId, user) {
  const kinds = user.budget_includes_fixed ? "('fijo','variable')" : "('variable')";
  const row = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions
    WHERE period_id = ? AND kind = 'gasto' AND expense_type IN ${kinds}`).get(periodId);
  return row.total;
}

/** Todos los gastos del periodo (incluye extra), para el resumen. */
function periodTotalExpenses(periodId) {
  const row = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions
    WHERE period_id = ? AND kind = 'gasto'`).get(periodId);
  return row.total;
}

function periodIncome(periodId) {
  const row = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions
    WHERE period_id = ? AND kind = 'ingreso'`).get(periodId);
  return row.total;
}

function periodPendingFixed(periodId) {
  const row = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM fixed_instances
    WHERE period_id = ? AND status = 'pendiente'`).get(periodId);
  return row;
}

/** Lista de periodos del usuario (más recientes primero). */
function listPeriods(user, limit = 24) {
  return db.prepare('SELECT * FROM periods WHERE user_id = ? ORDER BY start_date DESC LIMIT ?').all(user.id, limit);
}

function periodById(user, id) {
  const userId = typeof user === 'object' ? user.id : user;
  return db.prepare('SELECT * FROM periods WHERE user_id = ? AND id = ?').get(userId, Number(id) || 0);
}

function closePeriod(user, period) {
  db.prepare(`UPDATE periods SET status = 'cerrado', closed_at = datetime('now') WHERE id = ?`).run(period.id);
  return ensurePeriod(user, addDays(period.end_date, 1));
}

module.exports = {
  ensurePeriod, generateFixedInstances, periodSpend, periodTotalExpenses, periodIncome,
  periodPendingFixed, listPeriods, periodById, closePeriod, previousRange,
};
