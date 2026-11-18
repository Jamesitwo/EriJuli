'use strict';
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { parseAmount, formatMoney } = require('../utils/money');
const { todayISO } = require('../utils/dates');
const { bankTotals, containerBalances, ensureCash } = require('../services/balances');
const { log } = require('../services/audit');
const { ensurePeriod } = require('../services/periods');

const router = express.Router();

// Listado de bancos con totales
router.get('/bancos', (req, res) => {
  const { banks, total } = bankTotals(req.user.id);
  const hasCash = !!db.prepare(`SELECT 1 FROM banks WHERE user_id = ? AND kind = 'efectivo'`).get(req.user.id);
  res.render('banks/index', {
    title: 'Bancos y bolsillos', banks, total, hasCash,
    allContainers: containerBalances(req.user.id),
    formatMoney,
  });
});

router.post('/bancos', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) { setFlash(req, 'error', 'Escribe el nombre del banco.'); return res.redirect('/bancos'); }
  if (/^efectivo$/i.test(name)) return res.redirect(`/bancos/${ensureCash(req.user.id)}`);
  const info = db.prepare('INSERT INTO banks (user_id, name, color) VALUES (?, ?, ?)')
    .run(req.user.id, name, req.body.color || '#0f5c45');
  // Todo banco nace con su "Cuenta" (dinero fuera de bolsillos)
  db.prepare(`INSERT INTO containers (user_id, bank_id, kind, name) VALUES (?, ?, 'cuenta', 'Cuenta')`).run(req.user.id, info.lastInsertRowid);
  log(req.user.id, 'bank', info.lastInsertRowid, 'crear', name);
  setFlash(req, 'success', `Banco "${name}" creado con su cuenta principal.`);
  res.redirect('/bancos');
});

// Efectivo: un lugar de dinero propio, sin banco (RF-09)
router.post('/efectivo', (req, res) => {
  const had = db.prepare(`SELECT id FROM banks WHERE user_id = ? AND kind = 'efectivo'`).get(req.user.id);
  const id = ensureCash(req.user.id);
  if (!had) {
    log(req.user.id, 'bank', id, 'crear', 'Efectivo');
    setFlash(req, 'success', 'Listo: ya puedes registrar tu efectivo en "Billetera". Agrega más lugares (ej. Caja en casa) si los necesitas.');
  }
  res.redirect(`/bancos/${id}`);
});

router.post('/bancos/:id/eliminar', (req, res) => {
  const bank = db.prepare('SELECT * FROM banks WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!bank) return res.redirect('/bancos');
  const txCount = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE (container_from_id IN (SELECT id FROM containers WHERE bank_id = ?) OR container_to_id IN (SELECT id FROM containers WHERE bank_id = ?))`).get(bank.id, bank.id).n;
  if (txCount > 0) {
    setFlash(req, 'error', 'No puedes eliminar un banco con movimientos. Archiva sus bolsillos en su lugar.');
    return res.redirect('/bancos');
  }
  db.prepare('DELETE FROM banks WHERE id = ?').run(bank.id);
  log(req.user.id, 'bank', bank.id, 'eliminar', bank.name);
  setFlash(req, 'success', 'Banco eliminado.');
  res.redirect('/bancos');
});

// Detalle de banco: bolsillos y cuenta
router.get('/bancos/:id', (req, res) => {
  const bank = db.prepare('SELECT * FROM banks WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!bank) return res.redirect('/bancos');
  const balances = containerBalances(req.user.id).filter((c) => c.bank_id === bank.id);
  const all = containerBalances(req.user.id);
  res.render('banks/detail', {
    title: bank.name, bank, containers: balances, allContainers: all,
    total: balances.reduce((a, c) => a + c.balance, 0), formatMoney,
  });
});

router.post('/bancos/:id/bolsillos', (req, res) => {
  const bank = db.prepare('SELECT * FROM banks WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!bank) return res.redirect('/bancos');
  const name = String(req.body.name || '').trim();
  if (!name) { setFlash(req, 'error', bank.kind === 'efectivo' ? 'Escribe el nombre del lugar (ej. Caja en casa).' : 'Escribe el nombre del bolsillo.'); return res.redirect(`/bancos/${bank.id}`); }
  const info = db.prepare(`INSERT INTO containers (user_id, bank_id, kind, name, purpose, initial_balance) VALUES (?, ?, 'bolsillo', ?, ?, ?)`)
    .run(req.user.id, bank.id, name, String(req.body.purpose || '').trim(), parseAmount(req.body.initial_balance));
  log(req.user.id, 'container', info.lastInsertRowid, 'crear', name);
  setFlash(req, 'success', bank.kind === 'efectivo' ? `"${name}" agregado a tu efectivo.` : `Bolsillo "${name}" creado.`);
  res.redirect(`/bancos/${bank.id}`);
});

router.post('/bolsillos/:id/editar', (req, res) => {
  const c = db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!c) return res.redirect('/bancos');
  const name = String(req.body.name || '').trim();
  if (!name) { setFlash(req, 'error', 'El nombre no puede estar vacío.'); return res.redirect(`/bancos/${c.bank_id}`); }
  const last4 = String(req.body.last4 || '').replace(/\D/g, '').slice(-4);
  db.prepare('UPDATE containers SET name = ?, purpose = ?, initial_balance = ?, archived = ?, last4 = ? WHERE id = ?')
    .run(name, String(req.body.purpose || '').trim(), parseAmount(req.body.initial_balance), req.body.archived ? 1 : 0, last4, c.id);
  log(req.user.id, 'container', c.id, 'editar', name);
  setFlash(req, 'success', 'Bolsillo actualizado.');
  res.redirect(`/bancos/${c.bank_id}`);
});

// Mover dinero entre cuenta, bolsillos y bancos (deja registro; no cuenta como ingreso ni gasto)
router.post('/transferencias', (req, res) => {
  const { container_from_id, container_to_id, description } = req.body;
  const amount = parseAmount(req.body.amount);
  const from = db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, container_from_id);
  const to = db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, container_to_id);
  const back = req.body.back || '/bancos';
  if (!from || !to || from.id === to.id) {
    setFlash(req, 'error', 'Elige dos bolsillos o cuentas diferentes.');
    return res.redirect(back);
  }
  if (amount <= 0) {
    setFlash(req, 'error', 'El valor debe ser mayor que cero.');
    return res.redirect(back);
  }
  const available = require('../services/balances').containerBalance(req.user.id, from.id);
  if (amount > available) {
    setFlash(req, 'error', `En "${from.name}" solo hay ${formatMoney(Math.max(0, available), req.user.currency)}; no alcanza para mover ${formatMoney(amount, req.user.currency)}.`);
    return res.redirect(back);
  }
  const period = ensurePeriod(req.user, req.body.date || todayISO());
  const info = db.prepare(`INSERT INTO transactions (user_id, kind, amount, date, description, container_from_id, container_to_id, period_id, origin, notes)
    VALUES (?, 'transferencia', ?, ?, ?, ?, ?, ?, 'manual', ?)`)
    .run(req.user.id, amount, req.body.date || todayISO(), String(description || `Movimiento a ${to.name}`).trim(), from.id, to.id, period.id, String(req.body.notes || '').trim());
  log(req.user.id, 'transaction', info.lastInsertRowid, 'transferencia', `${formatMoney(amount, req.user.currency)} de ${from.name} a ${to.name}`);
  setFlash(req, 'success', `Moviste ${formatMoney(amount, req.user.currency)} de ${from.name} a ${to.name}.`);
  res.redirect(back);
});

module.exports = router;
