'use strict';
const { db } = require('../db');

/**
 * Saldos calculados a partir de movimientos + saldo inicial.
 * Un gasto descuenta del contenedor de origen; un ingreso suma al de destino;
 * una transferencia mueve sin contar como ingreso ni gasto.
 */
function containerBalances(userId) {
  const rows = db.prepare(`
    SELECT c.*, b.name AS bank_name, b.color AS bank_color, b.kind AS bank_kind,
      c.initial_balance
      + COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = c.user_id AND t.kind = 'ingreso' AND t.container_to_id = c.id), 0)
      + COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = c.user_id AND t.kind = 'transferencia' AND t.container_to_id = c.id), 0)
      - COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = c.user_id AND t.kind = 'gasto' AND t.container_from_id = c.id), 0)
      - COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.user_id = c.user_id AND t.kind = 'transferencia' AND t.container_from_id = c.id), 0)
      AS balance
    FROM containers c
    JOIN banks b ON b.id = c.bank_id
    WHERE c.user_id = ? AND c.archived = 0
    ORDER BY (b.kind = 'efectivo'), b.name, c.kind DESC, c.name
  `).all(userId);
  return rows;
}

function bankTotals(userId) {
  const balances = containerBalances(userId);
  const banks = new Map();
  let total = 0;
  for (const c of balances) {
    if (!banks.has(c.bank_id)) banks.set(c.bank_id, { id: c.bank_id, name: c.bank_name, color: c.bank_color, kind: c.bank_kind, total: 0, containers: [] });
    const bank = banks.get(c.bank_id);
    bank.total += c.balance;
    bank.containers.push(c);
    total += c.balance;
  }
  return { banks: [...banks.values()], total };
}

/** Crea el lugar "Efectivo" (sin banco) con su "Billetera" (RF-09). Devuelve el id del lugar. */
function ensureCash(userId) {
  const existing = db.prepare(`SELECT id FROM banks WHERE user_id = ? AND kind = 'efectivo' ORDER BY id LIMIT 1`).get(userId);
  if (existing) return existing.id;
  const info = db.prepare(`INSERT INTO banks (user_id, name, color, kind) VALUES (?, 'Efectivo', '#3f8f5a', 'efectivo')`).run(userId);
  db.prepare(`INSERT INTO containers (user_id, bank_id, kind, name, purpose) VALUES (?, ?, 'cuenta', 'Billetera', 'Dinero en mano')`).run(userId, info.lastInsertRowid);
  return info.lastInsertRowid;
}

function containerById(userId, id) {
  return db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(userId, id);
}

/** Saldo actual de una cuenta o bolsillo (o null si no existe). */
function containerBalance(userId, id) {
  const c = containerBalances(userId).find((x) => String(x.id) === String(id));
  return c ? c.balance : null;
}

module.exports = { containerBalances, bankTotals, containerById, containerBalance, ensureCash };
