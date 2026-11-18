'use strict';
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { parseAmount, formatMoney } = require('../utils/money');
const { todayISO, formatDate } = require('../utils/dates');
const { ensurePeriod } = require('../services/periods');
const { log } = require('../services/audit');
const { containerBalances } = require('../services/balances');
const { listCards, cardById } = require('../services/cards');
const { parseSplits, saveSplits, splitsFor } = require('../services/splits');
const attachments = require('../services/attachments');
const { categoryProgress } = require('../services/limits');
const { scanDataUrl } = require('../services/receiptScan');

const router = express.Router();

function formOptions(userId, user) {
  return {
    cards: listCards(userId),
    limits: user ? categoryProgress(user) : {},
    containers: containerBalances(userId), // incluye bank_name y el saldo actual de cada cuenta o bolsillo
    categories: db.prepare('SELECT * FROM categories WHERE user_id = ? AND archived = 0 ORDER BY kind, name').all(userId),
    sources: db.prepare('SELECT * FROM income_sources WHERE user_id = ? AND archived = 0 ORDER BY name').all(userId),
  };
}

// Listado de movimientos con filtros
router.get('/movimientos', (req, res) => {
  const { kind, container_id, category_id, from, to, q } = req.query;
  const where = ['t.user_id = ?'];
  const params = [req.user.id];
  if (kind && ['ingreso', 'gasto', 'transferencia'].includes(kind)) { where.push('t.kind = ?'); params.push(kind); }
  if (container_id && /^tarjeta:\d+$/.test(container_id)) { where.push('t.card_id = ?'); params.push(container_id.split(':')[1]); }
  else if (container_id) { where.push('(t.container_from_id = ? OR t.container_to_id = ?)'); params.push(container_id, container_id); }
  if (category_id) { where.push('t.category_id = ?'); params.push(category_id); }
  if (from) { where.push('t.date >= ?'); params.push(from); }
  if (to) { where.push('t.date <= ?'); params.push(to); }
  if (q) { where.push('(t.description LIKE ? OR t.notes LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

  const movements = db.prepare(`
    SELECT t.*, COALESCE(cf.name, cc.name) AS from_name, ct.name AS to_name, c.name AS category_name, c.color AS category_color,
      s.name AS source_name, COALESCE(b.name, CASE WHEN cc.id IS NOT NULL THEN 'Tarjeta' END) AS from_bank, b2.name AS to_bank,
      (SELECT COUNT(*) FROM transaction_splits sp WHERE sp.transaction_id = t.id) AS split_count,
      (SELECT COUNT(*) FROM attachments a WHERE a.transaction_id = t.id) AS attachment_count
    FROM transactions t
    LEFT JOIN credit_cards cc ON cc.id = t.card_id
    LEFT JOIN containers cf ON cf.id = t.container_from_id
    LEFT JOIN containers ct ON ct.id = t.container_to_id
    LEFT JOIN banks b ON b.id = cf.bank_id
    LEFT JOIN banks b2 ON b2.id = ct.bank_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN income_sources s ON s.id = t.income_source_id
    WHERE ${where.join(' AND ')}
    ORDER BY t.date DESC, t.id DESC LIMIT 300
  `).all(...params);

  res.render('transactions/index', {
    title: 'Movimientos', movements, ...formOptions(req.user.id, req.user),
    filters: req.query, formatMoney,
  });
});

/**
 * Lee y valida el formulario de movimiento. "De dónde salió" puede ser una cuenta/bolsillo (id) o una tarjeta ("tarjeta:ID").
 * Devuelve { data } listo para guardar o { error }.
 */
function readMovement(req, fallbackKind, editing = null) {
  const body = req.body;
  const kind = ['ingreso', 'gasto', 'transferencia'].includes(body.kind) ? body.kind : fallbackKind || 'gasto';
  const amount = parseAmount(body.amount);
  if (amount <= 0) return { error: 'El valor debe ser mayor que cero.' };
  const fromRaw = String(body.container_from_id || '');
  let card = null, from = null;
  if (/^tarjeta:\d+$/.test(fromRaw)) card = cardById(req.user.id, fromRaw.split(':')[1]);
  else if (fromRaw) from = db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, fromRaw);
  const to = body.container_to_id ? db.prepare('SELECT * FROM containers WHERE user_id = ? AND id = ?').get(req.user.id, body.container_to_id) : null;
  if (kind === 'gasto' && !from && !card) return { error: 'Elige de qué cuenta, bolsillo o tarjeta salió el dinero.' };
  if (kind === 'transferencia' && card) return { error: 'Para pagar una tarjeta usa el botón "Registrar pago" en Tarjetas.' };
  if (kind === 'transferencia' && !from) return { error: 'Elige de qué cuenta o bolsillo sale el dinero.' };
  if ((kind === 'ingreso' || kind === 'transferencia') && !to) return { error: 'Elige a qué cuenta o bolsillo entra el dinero.' };
  if (kind === 'transferencia' && from.id === to.id) return { error: 'El origen y el destino deben ser distintos.' };
  if (kind === 'transferencia') {
    // Al editar, el propio movimiento ya descontó su valor del origen
    const own = editing && editing.kind === 'transferencia' && editing.container_from_id === from.id ? editing.amount : 0;
    const available = containerBalances(req.user.id).find((c) => c.id === from.id).balance + own;
    if (amount > available) return { error: `En "${from.name}" solo hay ${formatMoney(Math.max(0, available), req.user.currency)}; no alcanza para mover ${formatMoney(amount, req.user.currency)}.` };
  }

  let parts = [];
  if (kind === 'gasto') {
    const sp = parseSplits(body, req.user.id, amount, req.user.currency);
    if (sp.error) return { error: sp.error };
    parts = sp.parts;
  }
  const category = parts.length ? [...parts].sort((a, b) => b.amount - a.amount)[0].category_id : (body.category_id || null);
  return {
    data: {
      kind, amount, date: body.date || todayISO(),
      description: String(body.description || '').trim(),
      category_id: kind === 'transferencia' ? null : category,
      income_source_id: kind === 'ingreso' ? (body.income_source_id || null) : null,
      container_from_id: kind === 'ingreso' || card ? null : from.id,
      container_to_id: kind === 'gasto' ? null : to.id,
      card_id: kind === 'gasto' && card ? card.id : null,
      expense_type: kind === 'gasto' ? (['fijo', 'variable', 'extra'].includes(body.expense_type) ? body.expense_type : 'variable') : 'variable',
      notes: String(body.notes || '').trim(),
      parts,
      receipt: body.receipt_data,
    },
  };
}

// Formulario de nuevo movimiento (gasto, ingreso o transferencia)
router.get('/movimientos/nuevo', (req, res) => {
  res.render('transactions/form', {
    title: 'Registrar movimiento', tx: null, splits: [], files: [], ...formOptions(req.user.id, req.user),
    preset: req.query, formatMoney,
  });
});

router.post('/movimientos', (req, res) => {
  const { data, error } = readMovement(req);
  if (error) { setFlash(req, 'error', error); return res.redirect('/movimientos/nuevo'); }
  const period = ensurePeriod(req.user, data.date);
  const label = data.kind === 'ingreso' ? 'Ingreso' : data.kind === 'gasto' ? 'Gasto' : 'Movimiento';
  const id = db.tx(() => {
    const info = db.prepare(`INSERT INTO transactions
      (user_id, kind, amount, date, description, category_id, income_source_id, container_from_id, container_to_id, card_id, expense_type, period_id, origin, notes, email_link)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`)
      .run(req.user.id, data.kind, data.amount, data.date, data.description || label,
        data.category_id, data.income_source_id, data.container_from_id, data.container_to_id, data.card_id,
        data.expense_type, period.id, data.notes, String(req.body.email_link || '').trim());
    if (data.parts.length) saveSplits(info.lastInsertRowid, data.parts);
    return info.lastInsertRowid;
  });
  const saved = data.receipt ? attachments.saveDataUrl(req.user.id, id, data.receipt) : null;
  log(req.user.id, 'transaction', id, `crear ${data.kind}`, `${formatMoney(data.amount, req.user.currency)} · ${data.description}`);
  setFlash(req, 'success', `${label} registrado: ${formatMoney(data.amount, req.user.currency)}${saved ? ' (con foto del recibo)' : ''}.`);
  res.redirect(req.body.back && String(req.body.back).startsWith('/') ? req.body.back : '/movimientos');
});

// Editar movimiento
router.get('/movimientos/:id/editar', (req, res) => {
  const tx = db.prepare('SELECT * FROM transactions WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!tx) return res.redirect('/movimientos');
  res.render('transactions/form', {
    title: 'Editar movimiento', tx, splits: splitsFor(tx.id), files: attachments.forTransaction(req.user.id, tx.id),
    ...formOptions(req.user.id, req.user), preset: {}, formatMoney,
  });
});

router.post('/movimientos/:id', (req, res) => {
  const tx = db.prepare('SELECT * FROM transactions WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!tx) return res.redirect('/movimientos');
  if (tx.card_id && tx.kind === 'transferencia') {
    // Pago de tarjeta: solo se cambian valor, fecha y notas
    const amount = parseAmount(req.body.amount);
    if (amount <= 0) { setFlash(req, 'error', 'El valor debe ser mayor que cero.'); return res.redirect(`/movimientos/${tx.id}/editar`); }
    const p = ensurePeriod(req.user, req.body.date || tx.date);
    db.prepare(`UPDATE transactions SET amount = ?, date = ?, period_id = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(amount, req.body.date || tx.date, p.id, String(req.body.notes || '').trim(), tx.id);
    setFlash(req, 'success', 'Pago de tarjeta actualizado.');
    return res.redirect(`/tarjetas/${tx.card_id}`);
  }
  const { data, error } = readMovement(req, tx.kind, tx);
  if (error) { setFlash(req, 'error', error); return res.redirect(`/movimientos/${tx.id}/editar`); }
  const period = ensurePeriod(req.user, data.date);
  db.tx(() => {
    db.prepare(`UPDATE transactions SET kind = ?, amount = ?, date = ?, description = ?, category_id = ?, income_source_id = ?,
      container_from_id = ?, container_to_id = ?, card_id = ?, expense_type = ?, period_id = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?`)
      .run(data.kind, data.amount, data.date, data.description, data.category_id, data.income_source_id,
        data.container_from_id, data.container_to_id, data.card_id, data.expense_type, period.id, data.notes, tx.id);
    saveSplits(tx.id, data.parts);
  });
  if (data.receipt) attachments.saveDataUrl(req.user.id, tx.id, data.receipt);
  log(req.user.id, 'transaction', tx.id, 'editar', `Ahora: ${formatMoney(data.amount, req.user.currency)} · ${data.description}`);
  setFlash(req, 'success', 'Movimiento actualizado.');
  res.redirect('/movimientos');
});

router.post('/movimientos/:id/eliminar', (req, res) => {
  const tx = db.prepare('SELECT * FROM transactions WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!tx) return res.redirect('/movimientos');
  attachments.removeForTransaction(req.user.id, tx.id);
  db.prepare('DELETE FROM transactions WHERE id = ?').run(tx.id);
  if (tx.fixed_instance_id) {
    db.prepare(`UPDATE fixed_instances SET status = 'pendiente', paid_date = NULL, transaction_id = NULL WHERE id = ?`).run(tx.fixed_instance_id);
  }
  log(req.user.id, 'transaction', tx.id, 'eliminar', `${tx.description} · ${formatMoney(tx.amount, req.user.currency)}`);
  setFlash(req, 'success', 'Movimiento eliminado y saldos corregidos.');
  res.redirect(req.body.back && String(req.body.back).startsWith('/') ? req.body.back : '/movimientos');
});

// Escanear un recibo o comprobante: devuelve los datos sugeridos (no guarda nada)
router.post('/escanear', async (req, res) => {
  try {
    res.json(await scanDataUrl(req.user.id, req.body.image));
  } catch (e) {
    console.error('Escanear:', e.message);
    res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : 'No pudimos leer la imagen. Intenta con otra foto.' });
  }
});

// Fotos de recibos (solo la dueña o el dueño del movimiento puede verlas)
router.get('/adjuntos/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (!a) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(a.mime).sendFile(attachments.filePath(a));
});
router.post('/adjuntos/:id/eliminar', (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE user_id = ? AND id = ?').get(req.user.id, req.params.id);
  if (a) attachments.remove(a);
  setFlash(req, 'success', 'Foto eliminada.');
  res.redirect(a ? `/movimientos/${a.transaction_id}/editar` : '/movimientos');
});

module.exports = router;
