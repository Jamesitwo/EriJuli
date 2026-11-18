'use strict';
const { db } = require('../db');

/**
 * Saldos calculados a partir de movimientos + saldo inicial.
 * Un gasto descuenta del contenedor de origen; un ingreso suma al de destino;
 * una transferencia mueve sin contar como ingreso ni gasto.
 */
function containerBalances(userId) {
  const rows = db.prepare(`
    SELECT c.*, b.name AS bank_name, b.color AS bank_color,
      c.initial_balance
      + COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = c.user_id AND t.kind = 'ingreso' AND t.container_to_id = c.id), 0)
      + COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = c.user_id AND t.kind = 'transferencia' AND t.container_to_id = c.id), 0)
      - COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = c.user_id AND t.kind = 'gasto' AND t.container_from_id = c.id), 0)
      - COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = c.user_id AND t.kind = 'transferencia' AND t.container_from_id = c.id), 0)
      AS balance
    FROM containers c
    JOIN banks b ON b.id = c.bank_id
    WHERE c.user_id = ? AND c.archived = 0
    ORDER BY b.name, c.kind DESC, c.name
  `).all(userId);
  return rows;
}

function bankTotals(userId) {
  const balances = containerBalances(userId);
  const banks = new Map();
  let total = 0;
  for (const c of balances) {
    if (!banks.has(c.bank_id)) banks.set(c.bank_id, { id: c.bank_id, name: c.bank_name, color: c.bank_color, total: 0, containers: [] });
    const bank = banks.get(c.bank_id);
    bank.total += c.balance;
    bank.containers.push(c);
    total += c.balance;
  }
  return { banks: [...banks.values()], total };
}

function containerById(userId, id) {
  return db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(userId, id);
}

/** Saldo actual de una cuenta o bolsillo (o null si no existe). */
function containerBalance(userId, id) {
  const c = containerBalances(userId).find((x) => String(x.id) === String(id));
  return c ? c.balance : null;
}

module.exports = { containerBalances, bankTotals, containerById, containerBalance };
