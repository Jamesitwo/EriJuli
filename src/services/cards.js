'use strict';
/**
 * Tarjetas de crédito.
 * - Una compra con tarjeta es un gasto con card_id (cuenta en el presupuesto, no saca dinero de tus bolsillos).
 * - Un pago a la tarjeta es una transferencia con card_id desde una cuenta o bolsillo (no es gasto).
 */
const { db } = require('../db');
const { todayISO, parseISO, toISO } = require('../utils/dates');

const clampDay = (y, m, d) => Math.min(d, new Date(y, m + 1, 0).getDate());
const dateOf = (y, m, d) => toISO(new Date(y, m, clampDay(y, m, d)));

/** Último corte (hoy incluido) y siguiente corte. */
function cutDates(card, today = todayISO()) {
  const t = parseISO(today);
  let y = t.getFullYear(), m = t.getMonth();
  let last = dateOf(y, m, card.cut_day);
  if (last > today) { m -= 1; if (m < 0) { m = 11; y -= 1; } last = dateOf(y, m, card.cut_day); }
  const lp = parseISO(last);
  let ny = lp.getFullYear(), nm = lp.getMonth() + 1; if (nm > 11) { nm = 0; ny += 1; }
  const next = dateOf(ny, nm, card.cut_day);
  // Fecha límite de pago del último corte: el siguiente due_day después del corte
  let dy = lp.getFullYear(), dm = lp.getMonth();
  let due = dateOf(dy, dm, card.due_day);
  if (due <= last) { dm += 1; if (dm > 11) { dm = 0; dy += 1; } due = dateOf(dy, dm, card.due_day); }
  // Fecha límite del siguiente corte
  const np = parseISO(next);
  let ey = np.getFullYear(), em = np.getMonth();
  let nextDue = dateOf(ey, em, card.due_day);
  if (nextDue <= next) { em += 1; if (em > 11) { em = 0; ey += 1; } nextDue = dateOf(ey, em, card.due_day); }
  return { lastCut: last, nextCut: next, due, nextDue };
}

function sums(cardId, untilDate) {
  const cond = untilDate ? 'AND date <= ?' : '';
  const args = untilDate ? [cardId, untilDate] : [cardId];
  const purchases = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM transactions WHERE card_id = ? AND kind = 'gasto' ${cond}`).get(...args).t;
  const payments = db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM transactions WHERE card_id = ? AND kind = 'transferencia' ${cond}`).get(...args).t;
  return { purchases, payments };
}

/** Estado de la tarjeta: deuda, disponible y cuánto pagar en la próxima fecha límite. */
function cardStatus(card, today = todayISO()) {
  const all = sums(card.id);
  const debt = card.initial_debt + all.purchases - all.payments;
  const { lastCut, nextCut, due, nextDue } = cutDates(card, today);
  const atCut = sums(card.id, lastCut);
  const statement = Math.max(0, card.initial_debt + atCut.purchases - atCut.payments);
  const paidAfterCut = all.payments - atCut.payments;
  const toPay = Math.max(0, statement - paidAfterCut);
  const daysToDue = Math.round((parseISO(due) - parseISO(today)) / 86400000);
  const used = card.credit_limit > 0 ? Math.round((debt / card.credit_limit) * 100) : 0;
  return {
    debt, available: card.credit_limit - debt, used, lastCut, nextCut, due, nextDue, statement, toPay, daysToDue,
    sinceCut: all.purchases - atCut.purchases,
    overdue: toPay > 0 && daysToDue < 0,
  };
}

function listCards(userId, { withArchived = false } = {}) {
  const cards = db.prepare(`SELECT cc.*, b.name AS bank_name FROM credit_cards cc LEFT JOIN banks b ON b.id = cc.bank_id
    WHERE cc.user_id = ? ${withArchived ? '' : 'AND cc.archived = 0'} ORDER BY cc.name`).all(userId);
  return cards.map((c) => ({ ...c, status: cardStatus(c) }));
}

function cardById(userId, id) {
  return db.prepare('SELECT * FROM credit_cards WHERE user_id = ? AND id = ?').get(userId, Number(id) || 0);
}

function totalDebt(userId) {
  return listCards(userId).reduce((s, c) => s + Math.max(0, c.status.debt), 0);
}

module.exports = { cardStatus, listCards, cardById, totalDebt, cutDates };
