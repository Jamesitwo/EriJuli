'use strict';
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { parseAmount, formatMoney } = require('../utils/money');
const { todayISO } = require('../utils/dates');
const { ensurePeriod } = require('../services/periods');
const { containerBalances } = require('../services/balances');
const { listCards, cardById, cardStatus } = require('../services/cards');
const { log } = require('../services/audit');

const router = express.Router();
const day = (v, d) => Math.min(Math.max(1, Number(v) || d), 31);

router.get('/tarjetas', (req, res) => {
  res.render('cards/index', {
    title: 'Tarjetas de crédito',
    cards: listCards(req.user.id),
    banks: db.prepare('SELECT * FROM banks WHERE user_id = ? ORDER BY name').all(req.user.id),
    formatMoney,
  });
});

router.post('/tarjetas', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) { setFlash(req, 'error', 'Ponle un nombre a la tarjeta.'); return res.redirect('/tarjetas'); }
  const bank = req.body.bank_id ? db.prepare('SELECT id FROM banks WHERE user_id = ? AND id = ?').get(req.user.id, req.body.bank_id) : null;
  const info = db.prepare(`INSERT INTO credit_cards (user_id, bank_id, name, last4, credit_limit, initial_debt, cut_day, due_day, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, bank ? bank.id : null, name,
    String(req.body.last4 || '').replace(/\D/g, '').slice(-4), Math.max(0, parseAmount(req.body.credit_limit)),
    Math.max(0, parseAmount(req.body.initial_debt)), day(req.body.cut_day, 30), day(req.body.due_day, 15), req.body.color || '#14231c');
  log(req.user.id, 'credit_card', info.lastInsertRowid, 'crear', name);
  setFlash(req, 'success', `Tarjeta "${name}" creada. Ya puedes registrar compras con ella.`);
  res.redirect(`/tarjetas/${info.lastInsertRowid}`);
});

router.get('/tarjetas/:id', (req, res) => {
  const card = cardById(req.user.id, req.params.id);
  if (!card) return res.redirect('/tarjetas');
  const movements = db.prepare(`SELECT t.*, c.name AS category_name, cf.name AS from_name FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN containers cf ON cf.id = t.container_from_id
    WHERE t.user_id = ? AND t.card_id = ? ORDER BY t.date DESC, t.id DESC LIMIT 200`).all(req.user.id, card.id);
  res.render('cards/detail', {
    title: card.name, card, status: cardStatus(card), movements,
    containers: containerBalances(req.user.id),
    banks: db.prepare('SELECT * FROM banks WHERE user_id = ? ORDER BY name').all(req.user.id),
    formatMoney,
  });
});

router.post('/tarjetas/:id/editar', (req, res) => {
  const card = cardById(req.user.id, req.params.id);
  if (!card) return res.redirect('/tarjetas');
  const bank = req.body.bank_id ? db.prepare('SELECT id FROM banks WHERE user_id = ? AND id = ?').get(req.user.id, req.body.bank_id) : null;
  db.prepare(`UPDATE credit_cards SET name = ?, bank_id = ?, last4 = ?, credit_limit = ?, initial_debt = ?, cut_day = ?, due_day = ?, color = ?, archived = ? WHERE id = ?`)
    .run(String(req.body.name || card.name).trim(), bank ? bank.id : null, String(req.body.last4 || '').replace(/\D/g, '').slice(-4),
      Math.max(0, parseAmount(req.body.credit_limit)), Math.max(0, parseAmount(req.body.initial_debt)),
      day(req.body.cut_day, card.cut_day), day(req.body.due_day, card.due_day), req.body.color || card.color, req.body.archived ? 1 : 0, card.id);
  log(req.user.id, 'credit_card', card.id, 'editar', req.body.name || card.name);
  setFlash(req, 'success', 'Tarjeta actualizada.');
  res.redirect(`/tarjetas/${card.id}`);
});

router.post('/tarjetas/:id/pagar', (req, res) => {
  const card = cardById(req.user.id, req.params.id);
  if (!card) return res.redirect('/tarjetas');
  const amount = parseAmount(req.body.amount);
  const from = db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, req.body.container_from_id);
  if (amount <= 0 || !from) { setFlash(req, 'error', 'Indica el valor y de qué cuenta o bolsillo sale el pago.'); return res.redirect(`/tarjetas/${card.id}`); }
  const available = containerBalances(req.user.id).find((c) => c.id === from.id).balance;
  if (amount > available) { setFlash(req, 'error', `En "${from.name}" solo hay ${formatMoney(Math.max(0, available), req.user.currency)}. Elige otra cuenta o paga un valor menor.`); return res.redirect(`/tarjetas/${card.id}`); }
  const date = req.body.date || todayISO();
  const period = ensurePeriod(req.user, date);
  db.prepare(`INSERT INTO transactions (user_id, kind, amount, date, description, container_from_id, container_to_id, card_id, period_id, origin, notes)
    VALUES (?, 'transferencia', ?, ?, ?, ?, NULL, ?, ?, 'manual', ?)`)
    .run(req.user.id, amount, date, `Pago tarjeta ${card.name}`, from.id, card.id, period.id, String(req.body.notes || '').trim());
  log(req.user.id, 'credit_card', card.id, 'pago', formatMoney(amount, req.user.currency));
  setFlash(req, 'success', `Pago de ${formatMoney(amount, req.user.currency)} registrado. Salió de ${from.name}.`);
  res.redirect(`/tarjetas/${card.id}`);
});

router.post('/tarjetas/:id/eliminar', (req, res) => {
  const card = cardById(req.user.id, req.params.id);
  if (!card) return res.redirect('/tarjetas');
  const used = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE card_id = ?').get(card.id).n;
  if (used) {
    db.prepare('UPDATE credit_cards SET archived = 1 WHERE id = ?').run(card.id);
    setFlash(req, 'success', `Tarjeta archivada (tiene ${used} movimientos, que se conservan).`);
  } else {
    db.prepare('DELETE FROM credit_cards WHERE id = ?').run(card.id);
    setFlash(req, 'success', 'Tarjeta eliminada.');
  }
  log(req.user.id, 'credit_card', card.id, 'eliminar', card.name);
  res.redirect('/tarjetas');
});

module.exports = router;
