'use strict';
const { db } = require('../db');
const { formatMoney } = require('../utils/money');
const { todayISO, addDays, formatDate } = require('../utils/dates');
const { periodSpend, periodPendingFixed } = require('./periods');
const { bankTotals } = require('./balances');

/** Alertas calculadas para el usuario (gastos fijos próximos, presupuesto, saldo bajo, metas, préstamos). */
function computeAlerts(user, period) {
  const alerts = [];
  const currency = user.currency;

  // 1. Gastos fijos pendientes próximos a vencer o vencidos
  const limitDate = addDays(todayISO(), user.alert_days_fixed || 5);
  const fixed = db.prepare(`
    SELECT * FROM fixed_instances
    WHERE user_id = ? AND status = 'pendiente' AND due_date <= ?
    ORDER BY due_date
  `).all(user.id, limitDate);
  for (const f of fixed) {
    const overdue = f.due_date < todayISO();
    alerts.push({
      type: overdue ? 'error' : 'warning',
      icon: 'calendar',
      text: `${overdue ? 'Vencido' : 'Próximo'}: ${f.description} por ${formatMoney(f.amount, currency)} — vence el ${formatDate(f.due_date)}`,
      href: '/gastos-fijos',
    });
  }

  // 2. Presupuesto consumido
  if (period && period.budget_amount > 0) {
    const available = period.budget_amount + period.rollover_amount - periodSpend(period.id, user);
    const pct = Math.round((periodSpend(period.id, user) / (period.budget_amount + period.rollover_amount || 1)) * 100);
    if (available <= 0) {
      alerts.push({ type: 'error', icon: 'wallet', text: `Presupuesto agotado de ${period.label}. Vas ${formatMoney(-available, currency)} por encima.`, href: '/presupuesto' });
    } else if (pct >= 80) {
      alerts.push({ type: 'warning', icon: 'wallet', text: `Llevas ${pct}% del presupuesto de ${period.label}. Quedan ${formatMoney(available, currency)}.`, href: '/presupuesto' });
    }
  }

  // 3. Saldo total bajo
  const { total } = bankTotals(user.id);
  if (total < (user.alert_low_balance || 0)) {
    alerts.push({ type: 'warning', icon: 'bank', text: `Tu saldo total (${formatMoney(total, currency)}) está por debajo de tu mínimo configurado.`, href: '/bancos' });
  }

  // 4. Metas sin avance
  const goals = db.prepare(`SELECT * FROM goals WHERE user_id = ? AND archived = 0 AND target_date IS NOT NULL`).all(user.id);
  for (const g of goals) {
    const daysLeft = Math.round((new Date(g.target_date) - new Date(todayISO())) / 86400000);
    if (daysLeft < 0) {
      alerts.push({ type: 'warning', icon: 'goal', text: `La meta "${g.name}" venció el ${formatDate(g.target_date)} y sigue abierta.`, href: '/metas' });
    }
  }

  // 5. Préstamos por cobrar vencidos
  const loans = db.prepare(`SELECT * FROM loans WHERE user_id = ? AND status = 'abierto' AND due_date IS NOT NULL AND due_date < ?`).all(user.id, todayISO());
  for (const l of loans) {
    alerts.push({ type: 'info', icon: 'loan', text: `Préstamos: ${l.person} tiene una fecha de pago vencida (${formatDate(l.due_date)}).`, href: '/prestamos' });
  }

  // 6. Tarjetas de crédito: pago próximo o vencido, cupo casi lleno
  const { listCards } = require('./cards');
  for (const c of listCards(user.id)) {
    const st = c.status;
    if (st.toPay > 0 && st.daysToDue < 0) {
      alerts.push({ type: 'error', icon: 'card', text: `Pago vencido de ${c.name}: ${formatMoney(st.toPay, currency)} (era hasta el ${formatDate(st.due)}).`, href: `/tarjetas/${c.id}` });
    } else if (st.toPay > 0 && st.daysToDue <= (user.alert_days_fixed || 5)) {
      alerts.push({ type: 'warning', icon: 'card', text: `Paga ${formatMoney(st.toPay, currency)} de ${c.name} ${st.daysToDue === 0 ? 'hoy' : `antes del ${formatDate(st.due)}`}.`, href: `/tarjetas/${c.id}` });
    }
    if (c.credit_limit > 0 && st.used >= 90) {
      alerts.push({ type: 'warning', icon: 'card', text: `${c.name}: usas el ${st.used}% del cupo.`, href: `/tarjetas/${c.id}` });
    }
  }

  // 7. Topes por categoría
  if (period) {
    const { limitsWithProgress } = require('./limits');
    for (const l of limitsWithProgress(user, period)) {
      if (l.state === 'over') alerts.push({ type: 'error', icon: 'wallet', text: `Te pasaste del tope de ${l.name} por ${formatMoney(-l.left, currency)}.`, href: '/presupuesto#topes' });
      else if (l.state === 'near') alerts.push({ type: 'warning', icon: 'wallet', text: `${l.name}: llevas el ${l.pct}% del tope. Quedan ${formatMoney(l.left, currency)}.`, href: '/presupuesto#topes' });
    }
  }

  return alerts;
}

module.exports = { computeAlerts };
