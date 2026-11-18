'use strict';
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { parseAmount, formatMoney } = require('../utils/money');
const { todayISO, formatDate } = require('../utils/dates');
const { ensurePeriod } = require('../services/periods');
const { log } = require('../services/audit');

const router = express.Router();

router.get('/prestamos', (req, res) => {
  const loans = db.prepare('SELECT * FROM loans WHERE user_id = ? ORDER BY status, date DESC').all(req.user.id).map((l) => {
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM loan_payments WHERE loan_id = ?').get(l.id).total;
    return { ...l, paid, balance: l.amount - paid };
  });
  const payments = db.prepare(`
    SELECT lp.*, l.person, l.direction FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
    WHERE lp.user_id = ? ORDER BY lp.date DESC, lp.id DESC LIMIT 30
  `).all(req.user.id);

  res.render('loans/index', {
    title: 'Préstamos', loans, payments, formatMoney,
    containers: db.prepare(`SELECT c.*, b.name AS bank_name FROM containers c JOIN banks b ON b.id = c.bank_id
      WHERE c.user_id = ? AND c.archived = 0 ORDER BY b.name, c.name`).all(req.user.id),
  });
});

router.post('/prestamos', (req, res) => {
  const person = String(req.body.person || '').trim();
  const amount = parseAmount(req.body.amount);
  if (!person || amount <= 0) { setFlash(req, 'error', 'Necesitas la persona y un valor mayor que cero.'); return res.redirect('/prestamos'); }
  const direction = req.body.direction === 'debo' ? 'debo' : 'me_deben';
  const info = db.prepare(`INSERT INTO loans (user_id, direction, person, amount, date, due_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, direction, person, amount, req.body.date || todayISO(), req.body.due_date || null, String(req.body.notes || '').trim());
  log(req.user.id, 'loan', info.lastInsertRowid, 'crear', `${direction === 'debo' ? 'Debo a' : 'Me debe'} ${person}: ${formatMoney(amount, req.user.currency)}`);
  setFlash(req, 'success', `Préstamo registrado: ${direction === 'debo' ? 'le debes a' : 'te debe'} ${person} ${formatMoney(amount, req.user.currency)}.`);
  res.redirect('/prestamos');
});

// Registrar abono (pago o cobro). Opcionalmente mueve el dinero de/para una cuenta o bolsillo.
router.post('/prestamos/:id/abonos', (req, res) => {
  const l = db.prepare('SELECT * FROM loans WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!l) return res.redirect('/prestamos');
  const amount = parseAmount(req.body.amount);
  const date = req.body.date || todayISO();
  if (amount <= 0) { setFlash(req, 'error', 'El abono debe ser mayor que cero.'); return res.redirect('/prestamos'); }

  let txId = null;
  const container = req.body.container_id ? db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, req.body.container_id) : null;
  if (container) {
    const period = ensurePeriod(req.user, date);
    // me_deben: me pagan → ingreso. debo: yo pago → gasto.
    const kind = l.direction === 'me_deben' ? 'ingreso' : 'gasto';
    const info = db.prepare(`INSERT INTO transactions (user_id, kind, amount, date, description, container_from_id, container_to_id, expense_type, period_id, origin, notes, loan_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`)
      .run(req.user.id, kind, amount, date,
        kind === 'ingreso' ? `Abono de ${l.person}` : `Pago a ${l.person}`,
        kind === 'gasto' ? container.id : null, kind === 'ingreso' ? container.id : null,
        'variable', period.id, 'préstamo', l.id);
    txId = info.lastInsertRowid;
  }

  const info2 = db.prepare(`INSERT INTO loan_payments (user_id, loan_id, amount, date, notes, transaction_id)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, l.id, amount, date, String(req.body.notes || '').trim(), txId);

  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM loan_payments WHERE loan_id = ?').get(l.id).total;
  if (paid >= l.amount) db.prepare(`UPDATE loans SET status = 'saldado' WHERE id = ?`).run(l.id);

  log(req.user.id, 'loan_payment', info2.lastInsertRowid, 'abono', `${l.person} · ${formatMoney(amount, req.user.currency)}`);
  setFlash(req, 'success', `Abono de ${formatMoney(amount, req.user.currency)} registrado${container ? ` y aplicado a ${container.name}` : ''}.`);
  res.redirect('/prestamos');
});

router.post('/prestamos/:id/editar', (req, res) => {
  const l = db.prepare('SELECT * FROM loans WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!l) return res.redirect('/prestamos');
  db.prepare(`UPDATE loans SET person = ?, amount = ?, date = ?, due_date = ?, notes = ?, status = ? WHERE id = ?`)
    .run(String(req.body.person || l.person).trim(), parseAmount(req.body.amount) || l.amount,
      req.body.date || l.date, req.body.due_date || null, String(req.body.notes || '').trim(),
      req.body.status === 'saldado' ? 'saldado' : 'abierto', l.id);
  log(req.user.id, 'loan', l.id, 'editar', req.body.person || l.person);
  setFlash(req, 'success', 'Préstamo actualizado.');
  res.redirect('/prestamos');
});

router.post('/prestamos/:id/eliminar', (req, res) => {
  const l = db.prepare('SELECT * FROM loans WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!l) return res.redirect('/prestamos');
  db.prepare('DELETE FROM loan_payments WHERE loan_id = ?').run(l.id);
  db.prepare('DELETE FROM transactions WHERE loan_id = ?').run(l.id);
  db.prepare('DELETE FROM loans WHERE id = ?').run(l.id);
  log(req.user.id, 'loan', l.id, 'eliminar', l.person);
  setFlash(req, 'success', 'Préstamo eliminado.');
  res.redirect('/prestamos');
});

module.exports = router;
