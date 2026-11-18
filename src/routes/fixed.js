'use strict';
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { parseAmount, formatMoney } = require('../utils/money');
const { todayISO, formatDate } = require('../utils/dates');
const { ensurePeriod, listPeriods, periodById, periodPendingFixed, generateFixedInstances } = require('../services/periods');
const { log } = require('../services/audit');

const router = express.Router();

router.get('/gastos-fijos', (req, res) => {
  const user = req.user;
  const period = ensurePeriod(user);
  const selected = req.query.periodo ? periodById(user, Number(req.query.periodo)) || period : period;

  const instances = db.prepare(`
    SELECT fi.*, c.name AS category_name, ct.name AS container_name
    FROM fixed_instances fi
    LEFT JOIN categories c ON c.id = (SELECT category_id FROM fixed_expenses fe WHERE fe.id = fi.fixed_expense_id)
    LEFT JOIN containers ct ON ct.id = (SELECT container_id FROM fixed_expenses fe WHERE fe.id = fi.fixed_expense_id)
    WHERE fi.user_id = ? AND fi.period_id = ? ORDER BY fi.status, fi.due_date
  `).all(user.id, selected.id);

  const templates = db.prepare(`
    SELECT fe.*, c.name AS category_name, ct.name AS container_name
    FROM fixed_expenses fe
    LEFT JOIN categories c ON c.id = fe.category_id
    LEFT JOIN containers ct ON ct.id = fe.container_id
    WHERE fe.user_id = ? ORDER BY fe.active DESC, fe.due_day
  `).all(user.id);

  const pending = periodPendingFixed(selected.id);
  const paid = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM fixed_instances WHERE period_id = ? AND status = 'pagado'`).get(selected.id).total;

  res.render('expenses/fixed', {
    title: 'Gastos fijos', period, selected, instances, templates, pending, paid,
    periods: listPeriods(user, 12),
    categories: db.prepare(`SELECT * FROM categories WHERE user_id = ? AND kind = 'gasto' AND archived = 0 ORDER BY name`).all(user.id),
    containers: db.prepare(`SELECT c.*, b.name AS bank_name FROM containers c JOIN banks b ON b.id = c.bank_id
      WHERE c.user_id = ? AND c.archived = 0 ORDER BY b.name, c.name`).all(user.id),
    formatMoney,
  });
});

router.post('/gastos-fijos', (req, res) => {
  const description = String(req.body.description || '').trim();
  const amount = parseAmount(req.body.amount);
  if (!description || amount <= 0) { setFlash(req, 'error', 'Necesitas descripción y un valor mayor que cero.'); return res.redirect('/gastos-fijos'); }
  const info = db.prepare(`INSERT INTO fixed_expenses (user_id, description, amount, category_id, container_id, due_day, frequency, payment_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, description, amount, req.body.category_id || null, req.body.container_id || null,
      Math.min(Math.max(1, Number(req.body.due_day) || 1), 28), req.body.frequency === 'quincenal' ? 'quincenal' : 'mensual',
      String(req.body.payment_method || '').trim());
  log(req.user.id, 'fixed_expense', info.lastInsertRowid, 'crear', `${description} · ${formatMoney(amount, req.user.currency)}`);
  const period = ensurePeriod(req.user);
  generateFixedInstances(req.user, period);
  setFlash(req, 'success', `Gasto fijo "${description}" creado. Aparecerá como pendiente cada periodo.`);
  res.redirect('/gastos-fijos');
});

router.post('/gastos-fijos/:id/editar', (req, res) => {
  const f = db.prepare('SELECT * FROM fixed_expenses WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!f) return res.redirect('/gastos-fijos');
  db.prepare(`UPDATE fixed_expenses SET description = ?, amount = ?, category_id = ?, container_id = ?, due_day = ?, frequency = ?, payment_method = ?, active = ? WHERE id = ?`)
    .run(String(req.body.description || f.description).trim(), parseAmount(req.body.amount) || f.amount,
      req.body.category_id || null, req.body.container_id || null,
      Math.min(Math.max(1, Number(req.body.due_day) || f.due_day), 28),
      req.body.frequency === 'quincenal' ? 'quincenal' : 'mensual',
      String(req.body.payment_method || '').trim(), req.body.active ? 1 : 0, f.id);
  log(req.user.id, 'fixed_expense', f.id, 'editar', req.body.description || f.description);
  setFlash(req, 'success', 'Gasto fijo actualizado.');
  res.redirect('/gastos-fijos');
});

router.post('/gastos-fijos/:id/eliminar', (req, res) => {
  const f = db.prepare('SELECT * FROM fixed_expenses WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!f) return res.redirect('/gastos-fijos');
  db.prepare('DELETE FROM fixed_expenses WHERE id = ?').run(f.id);
  db.prepare('DELETE FROM fixed_instances WHERE fixed_expense_id = ?').run(f.id);
  log(req.user.id, 'fixed_expense', f.id, 'eliminar', f.description);
  setFlash(req, 'success', 'Gasto fijo eliminado.');
  res.redirect('/gastos-fijos');
});

// Marcar un gasto fijo como pagado: descuenta del contenedor elegido y queda con trazabilidad
router.post('/gastos-fijos/instancia/:id/pagar', (req, res) => {
  const inst = db.prepare('SELECT * FROM fixed_instances WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!inst) return res.redirect('/gastos-fijos');
  if (inst.status === 'pagado') { setFlash(req, 'error', 'Ese gasto ya estaba pagado.'); return res.redirect('/gastos-fijos'); }

  const fe = db.prepare('SELECT * FROM fixed_expenses WHERE id = ?').get(inst.fixed_expense_id);
  const containerId = req.body.container_id || (fe && fe.container_id);
  const container = db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, containerId);
  if (!container) { setFlash(req, 'error', 'Elige de qué cuenta o bolsillo salió el dinero.'); return res.redirect('/gastos-fijos'); }

  const date = req.body.date || todayISO();
  const period = ensurePeriod(req.user, date);
  const info = db.prepare(`INSERT INTO transactions (user_id, kind, amount, date, description, category_id, container_from_id, expense_type, fixed_instance_id, period_id, origin, notes)
    VALUES (?, 'gasto', ?, ?, ?, ?, ?, 'fijo', ?, ?, 'manual', ?)`)
    .run(req.user.id, inst.amount, date, inst.description, (fe && fe.category_id) || null, container.id, inst.id, period.id,
      String(req.body.notes || inst.payment_method || '').trim());

  db.prepare(`UPDATE fixed_instances SET status = 'pagado', paid_date = ?, transaction_id = ? WHERE id = ?`).run(date, info.lastInsertRowid, inst.id);
  log(req.user.id, 'fixed_instance', inst.id, 'pagar', `${inst.description} · ${formatMoney(inst.amount, req.user.currency)} desde ${container.name}`);
  setFlash(req, 'success', `"${inst.description}" marcado como pagado.`);
  res.redirect(req.body.back || '/gastos-fijos');
});

// Deshacer el pago (vuelve a pendiente y elimina el movimiento asociado)
router.post('/gastos-fijos/instancia/:id/despagar', (req, res) => {
  const inst = db.prepare('SELECT * FROM fixed_instances WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!inst) return res.redirect('/gastos-fijos');
  if (inst.transaction_id) db.prepare('DELETE FROM transactions WHERE id = ?').run(inst.transaction_id);
  db.prepare(`UPDATE fixed_instances SET status = 'pendiente', paid_date = NULL, transaction_id = NULL WHERE id = ?`).run(inst.id);
  log(req.user.id, 'fixed_instance', inst.id, 'deshacer pago', inst.description);
  setFlash(req, 'success', 'El pago se deshizo y el gasto fijo volvió a estar pendiente.');
  res.redirect('/gastos-fijos');
});

module.exports = router;
