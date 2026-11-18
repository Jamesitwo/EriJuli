'use strict';
// Hogar compartido: gastos en común, quién le debe a quién y presupuesto del hogar
const crypto = require('crypto');
const { db } = require('../db');

function membership(userId) {
  return db.prepare(`SELECT h.*, m.role FROM household_members m JOIN households h ON h.id = m.household_id WHERE m.user_id = ?`).get(userId);
}
function members(householdId) {
  return db.prepare(`SELECT u.id, u.name, u.email, m.role, m.joined_at FROM household_members m JOIN users u ON u.id = m.user_id
    WHERE m.household_id = ? ORDER BY m.joined_at`).all(householdId).map((u) => ({ ...u, label: (u.name || u.email.split('@')[0]).split(' ')[0] }));
}
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (const b of crypto.randomBytes(6)) c += alphabet[b % alphabet.length];
  return c;
}
function create(userId, name) {
  return db.tx(() => {
    let code; do { code = newCode(); } while (db.prepare('SELECT 1 FROM households WHERE invite_code = ?').get(code));
    const h = db.prepare('INSERT INTO households (name, invite_code, created_by) VALUES (?, ?, ?)').run(name, code, userId);
    db.prepare("INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, 'admin')").run(h.lastInsertRowid, userId);
    return h.lastInsertRowid;
  });
}
function join(userId, code) {
  const h = db.prepare('SELECT * FROM households WHERE invite_code = ?').get(String(code || '').trim().toUpperCase());
  if (!h) return null;
  db.prepare("INSERT OR IGNORE INTO household_members (household_id, user_id, role) VALUES (?, ?, 'miembro')").run(h.id, userId);
  return h;
}

/** Saldo de cada persona: positivo = le deben; negativo = debe. Y las transferencias mínimas para quedar a paz y salvo. */
function balances(householdId) {
  const ms = members(householdId);
  const ids = ms.map((m) => m.id);
  const net = new Map(ids.map((id) => [id, 0]));
  const expenses = db.prepare('SELECT * FROM household_expenses WHERE household_id = ?').all(householdId);
  for (const e of expenses) {
    if (!net.has(e.paid_by)) net.set(e.paid_by, 0);
    const sharers = e.split === 'completo' ? ids.filter((id) => id !== e.paid_by) : ids;
    if (!sharers.length) continue;
    net.set(e.paid_by, net.get(e.paid_by) + e.amount);
    const base = Math.floor(e.amount / sharers.length);
    let rest = e.amount - base * sharers.length;
    for (const id of sharers) { const share = base + (rest > 0 ? 1 : 0); if (rest > 0) rest--; net.set(id, (net.get(id) || 0) - share); }
  }
  for (const s of db.prepare('SELECT * FROM household_settlements WHERE household_id = ?').all(householdId)) {
    net.set(s.from_user, (net.get(s.from_user) || 0) + s.amount);
    net.set(s.to_user, (net.get(s.to_user) || 0) - s.amount);
  }
  // Transferencias sugeridas (de quien debe a quien le deben)
  const debtors = [...net].filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v })).sort((a, b) => b.v - a.v);
  const creditors = [...net].filter(([, v]) => v > 0).map(([id, v]) => ({ id, v })).sort((a, b) => b.v - a.v);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].v, creditors[j].v);
    if (amt > 0) transfers.push({ from: debtors[i].id, to: creditors[j].id, amount: amt });
    debtors[i].v -= amt; creditors[j].v -= amt;
    if (debtors[i].v === 0) i++;
    if (creditors[j].v === 0) j++;
  }
  return { net, transfers };
}

function monthSpend(householdId, ym) {
  return db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM household_expenses WHERE household_id = ? AND substr(date,1,7) = ?`).get(householdId, ym).t;
}

module.exports = { membership, members, create, join, balances, monthSpend, newCode };
