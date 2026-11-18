'use strict';
/**
 * Bandeja de revisión de movimientos propuestos (desde Gmail o creados a mano).
 * Nada afecta saldos hasta que se acepte, edite o descarte (RC-07).
 * La lectura automática de Gmail se activa cuando se configuren GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET (ver src/services/gmail.js).
 */
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { parseAmount, formatMoney } = require('../utils/money');
const { todayISO, formatDate } = require('../utils/dates');
const { ensurePeriod } = require('../services/periods');
const { log } = require('../services/audit');
const { gmailStatus, listSenders } = require('../services/gmail');

const router = express.Router();

router.get('/bandeja', (req, res) => {
  const items = db.prepare(`
    SELECT p.*, c.name AS category_name, s.name AS source_name, cf.name AS from_name, ct.name AS to_name
    FROM proposed_movements p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN income_sources s ON s.id = p.income_source_id
    LEFT JOIN containers cf ON cf.id = p.container_from_id
    LEFT JOIN containers ct ON ct.id = p.container_to_id
    WHERE p.user_id = ? AND p.status IN ('propuesto','sin_procesar')
    ORDER BY p.date DESC
  `).all(req.user.id);

  const rules = db.prepare('SELECT * FROM email_rules WHERE user_id = ? ORDER BY id DESC').all(req.user.id);

  res.render('inbox/index', {
    title: 'Bandeja de revisión', items, rules, formatMoney,
    gmail: gmailStatus(req.user.id),
    senders: listSenders(req.user.id),
    banks: db.prepare('SELECT * FROM banks WHERE user_id = ? ORDER BY name').all(req.user.id),
    containers: db.prepare(`SELECT c.*, b.name AS bank_name FROM containers c JOIN banks b ON b.id = c.bank_id
      WHERE c.user_id = ? AND c.archived = 0 ORDER BY b.name, c.kind DESC, c.name`).all(req.user.id),
    categories: db.prepare('SELECT * FROM categories WHERE user_id = ? AND archived = 0 ORDER BY kind, name').all(req.user.id),
    sources: db.prepare('SELECT * FROM income_sources WHERE user_id = ? AND archived = 0 ORDER BY name').all(req.user.id),
    cards: db.prepare('SELECT * FROM credit_cards WHERE user_id = ? AND archived = 0 ORDER BY name').all(req.user.id),
  });
});

// Aceptar propuesta: crea el movimiento real y lo marca como aceptado
router.post('/bandeja/:id/aceptar', (req, res) => {
  const p = db.prepare('SELECT * FROM proposed_movements WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!p) return res.redirect('/bandeja');
  const amount = parseAmount(req.body.amount) || p.amount;
  const kind = ['ingreso', 'gasto', 'transferencia'].includes(req.body.kind) ? req.body.kind : p.kind;
  const date = req.body.date || p.date || todayISO();
  let fromId = req.body.container_from_id || p.container_from_id;
  const toId = req.body.container_to_id || p.container_to_id;
  // Compra con tarjeta de crédito: "tarjeta:ID" (o la tarjeta que reconoció el correo)
  let card = null;
  const cardRef = String(req.body.container_from_id || (p.card_id && !req.body.container_from_id ? 'tarjeta:' + p.card_id : ''));
  if (cardRef.startsWith('tarjeta:') && kind !== 'ingreso') {
    card = db.prepare('SELECT * FROM credit_cards WHERE user_id = ? AND id = ?').get(req.user.id, cardRef.slice(8)) || null;
    fromId = null;
  } else if (cardRef.startsWith('tarjeta:')) fromId = null;
  if (card && kind !== 'gasto') { setFlash(req, 'error', 'Con una tarjeta de crédito solo se registran compras (gastos).'); return res.redirect('/bandeja'); }

  const from = fromId ? db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, fromId) : null;
  const to = toId ? db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, toId) : null;
  if ((kind === 'gasto' && !from && !card) || (kind === 'transferencia' && !from)) { setFlash(req, 'error', 'Elige de qué cuenta o bolsillo salió el dinero.'); return res.redirect('/bandeja'); }
  if ((kind === 'ingreso' || kind === 'transferencia') && !to) { setFlash(req, 'error', 'Elige a qué cuenta o bolsillo entra el dinero.'); return res.redirect('/bandeja'); }

  const period = ensurePeriod(req.user, date);
  const info = db.prepare(`INSERT INTO transactions
    (user_id, kind, amount, date, description, category_id, income_source_id, container_from_id, container_to_id, card_id, expense_type, period_id, origin, email_link, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'variable', ?, 'email', ?, ?)`)
    .run(req.user.id, kind, amount, date,
      String(req.body.description || p.description || 'Movimiento desde correo').trim(),
      req.body.category_id || p.category_id || null,
      kind === 'ingreso' ? (req.body.income_source_id || p.income_source_id || null) : null,
      kind === 'ingreso' || card ? null : from.id, kind === 'gasto' ? null : to.id, card ? card.id : null,
      period.id, p.email_link || '', String(req.body.notes || '').trim());

  db.prepare(`UPDATE proposed_movements SET status = 'aceptado', transaction_id = ?, category_id = ?, container_from_id = ?, container_to_id = ?, card_id = ? WHERE id = ?`)
    .run(info.lastInsertRowid, req.body.category_id || p.category_id || null, kind === 'ingreso' || card ? null : from.id, kind === 'gasto' ? null : to.id, card ? card.id : null, p.id);

  // Aprendizaje (RC-09): si el correo trae comercio/remitente, guarda la regla para la próxima
  const merchant = (p.description || '').trim();
  if (merchant && req.body.learn_rule) {
    db.prepare(`INSERT INTO email_rules (user_id, merchant_pattern, kind, category_id, income_source_id, container_from_id, container_to_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, merchant.slice(0, 80), kind, req.body.category_id || null, req.body.income_source_id || null,
        kind === 'ingreso' || card ? null : from.id, kind === 'gasto' ? null : to.id);
  }

  log(req.user.id, 'transaction', info.lastInsertRowid, 'aceptar propuesta', `${p.description} · ${formatMoney(amount, req.user.currency)}`);
  setFlash(req, 'success', `Movimiento aceptado: ${formatMoney(amount, req.user.currency)}.`);
  res.redirect('/bandeja');
});

router.post('/bandeja/:id/descartar', (req, res) => {
  const p = db.prepare('SELECT * FROM proposed_movements WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!p) return res.redirect('/bandeja');
  db.prepare(`UPDATE proposed_movements SET status = 'descartado' WHERE id = ?`).run(p.id);
  log(req.user.id, 'proposed_movement', p.id, 'descartar', p.description);
  setFlash(req, 'success', 'Propuesta descartada. No afectó tus saldos.');
  res.redirect('/bandeja');
});

// Registrar a mano un correo que no se pudo interpretar (RC-12)
router.post('/bandeja', (req, res) => {
  const amount = parseAmount(req.body.amount);
  const date = req.body.date || todayISO();
  if (amount <= 0) { setFlash(req, 'error', 'El valor debe ser mayor que cero.'); return res.redirect('/bandeja'); }
  const status = req.body.status === 'sin_procesar' ? 'sin_procesar' : 'propuesto';
  const info = db.prepare(`INSERT INTO proposed_movements (user_id, status, kind, amount, date, description, category_id, income_source_id, container_from_id, container_to_id, email_sender, email_subject, email_link, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, status, ['ingreso', 'gasto', 'transferencia'].includes(req.body.kind) ? req.body.kind : 'gasto',
      amount, date, String(req.body.description || '').trim(), req.body.category_id || null, req.body.income_source_id || null,
      req.body.container_from_id || null, req.body.container_to_id || null,
      String(req.body.email_sender || '').trim(), String(req.body.email_subject || '').trim(),
      String(req.body.email_link || '').trim(), String(req.body.reason || '').trim());
  log(req.user.id, 'proposed_movement', info.lastInsertRowid, 'crear propuesta', req.body.description || '');
  setFlash(req, 'success', 'Movimiento propuesto agregado a la bandeja.');
  res.redirect('/bandeja');
});

module.exports = router;
