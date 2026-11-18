'use strict';
// Gastos divididos en varias categorías
const { db } = require('../db');
const { parseAmount, formatMoney } = require('../utils/money');

const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);

/** Lee las partes del formulario. Devuelve { parts } o { error }. Menos de 2 partes = no dividido. */
function parseSplits(body, userId, total, currency) {
  if (!body.split_on) return { parts: [] };
  const cats = arr(body['split_category[]'] !== undefined ? body['split_category[]'] : body.split_category);
  const amts = arr(body['split_amount[]'] !== undefined ? body['split_amount[]'] : body.split_amount);
  const parts = [];
  for (let i = 0; i < Math.max(cats.length, amts.length); i++) {
    const amount = parseAmount(amts[i]);
    if (amount <= 0) continue;
    const cat = cats[i] ? db.prepare("SELECT id FROM categories WHERE user_id = ? AND id = ? AND kind = 'gasto'").get(userId, cats[i]) : null;
    parts.push({ category_id: cat ? cat.id : null, amount });
  }
  if (parts.length < 2) return { parts: [] };
  const sum = parts.reduce((s, p) => s + p.amount, 0);
  if (sum !== total) return { error: `Las partes suman ${formatMoney(sum, currency)} pero el gasto es de ${formatMoney(total, currency)}.` };
  return { parts };
}

function saveSplits(transactionId, parts) {
  db.prepare('DELETE FROM transaction_splits WHERE transaction_id = ?').run(transactionId);
  const ins = db.prepare('INSERT INTO transaction_splits (transaction_id, category_id, amount) VALUES (?, ?, ?)');
  for (const p of parts) ins.run(transactionId, p.category_id, p.amount);
}

function splitsFor(transactionId) {
  return db.prepare(`SELECT s.*, c.name AS category_name, c.color AS category_color FROM transaction_splits s
    LEFT JOIN categories c ON c.id = s.category_id WHERE s.transaction_id = ? ORDER BY s.amount DESC`).all(transactionId);
}

module.exports = { parseSplits, saveSplits, splitsFor };
