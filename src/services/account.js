'use strict';
/**
 * Datos de la cuenta (RN-05): exportar todo a Excel y eliminar la cuenta con todo lo guardado.
 */
const fs = require('fs');
const path = require('path');
const { db, DB_PATH } = require('../db');
const { containerBalances } = require('./balances');
const { buildXlsx } = require('./xlsx');

const money = (c) => (c === null || c === undefined ? null : Math.round(Number(c)) / 100);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const KIND = { ingreso: 'Ingreso', gasto: 'Gasto', transferencia: 'Movimiento entre cuentas' };

/** Todas las hojas con los datos de la persona (nunca contraseñas, PIN ni tokens). */
function exportSheets(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const place = (bank, name) => (bank ? `${bank} · ${name}` : name || '');
  const balances = new Map(containerBalances(userId).map((c) => [c.id, c.balance]));

  const sheets = [];
  sheets.push({
    name: 'Resumen', columns: ['Dato', 'Valor'], rows: [
      ['Nombre', u.name || ''], ['Correo', u.email], ['Moneda', u.currency], ['Zona horaria', u.timezone],
      ['Tipo de presupuesto', u.period_type], ['Cuenta creada', u.created_at],
      ['Política de privacidad aceptada', u.privacy_accepted_at || ''],
      ['Exportado', new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'],
      ['Nota', 'Los valores están en la moneda de la cuenta (no en centavos).'],
    ],
  });

  sheets.push({
    name: 'Movimientos',
    columns: ['ID', 'Fecha', 'Tipo', 'Descripción', 'Valor', 'Categoría', 'Fuente de ingreso', 'Salió de', 'Entró a', 'Tarjeta', 'Tipo de gasto', 'Origen', 'Notas', 'Creado'],
    money: [4],
    rows: all(`SELECT t.*, c.name AS cat, s.name AS src, cf.name AS fname, bf.name AS fbank, ct.name AS tname, bt.name AS tbank, k.name AS card
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN income_sources s ON s.id = t.income_source_id
      LEFT JOIN containers cf ON cf.id = t.container_from_id LEFT JOIN banks bf ON bf.id = cf.bank_id
      LEFT JOIN containers ct ON ct.id = t.container_to_id LEFT JOIN banks bt ON bt.id = ct.bank_id
      LEFT JOIN credit_cards k ON k.id = t.card_id
      WHERE t.user_id = ? ORDER BY t.date, t.id`, userId)
      .map((t) => [t.id, t.date, KIND[t.kind] || t.kind, t.description, money(t.amount), t.cat || '', t.src || '',
        t.fname ? place(t.fbank, t.fname) : '', t.tname ? place(t.tbank, t.tname) : '', t.card || '', t.expense_type || '', t.origin || '', t.notes || '', t.created_at]),
  });

  sheets.push({
    name: 'Divisiones', columns: ['ID movimiento', 'Fecha', 'Movimiento', 'Categoría', 'Valor'], money: [4],
    rows: all(`SELECT sp.*, t.date, t.description, c.name AS cat FROM transaction_splits sp
      JOIN transactions t ON t.id = sp.transaction_id LEFT JOIN categories c ON c.id = sp.category_id
      WHERE t.user_id = ? ORDER BY t.date`, userId).map((r) => [r.transaction_id, r.date, r.description, r.cat || '', money(r.amount)]),
  });

  sheets.push({
    name: 'Bancos y bolsillos',
    columns: ['Lugar', 'Tipo de lugar', 'Nombre', 'Tipo', 'Propósito', 'Últimos 4', 'Saldo inicial', 'Saldo actual', 'Archivado'],
    money: [6, 7],
    rows: all(`SELECT c.*, b.name AS bank, b.kind AS bkind FROM containers c JOIN banks b ON b.id = c.bank_id
      WHERE c.user_id = ? ORDER BY b.kind, b.name, c.kind DESC, c.name`, userId)
      .map((c) => [c.bank, c.bkind === 'efectivo' ? 'Efectivo' : 'Banco', c.name, c.kind === 'cuenta' ? 'Cuenta' : 'Bolsillo', c.purpose || '',
        c.last4 || '', money(c.initial_balance), balances.has(c.id) ? money(balances.get(c.id)) : null, c.archived ? 'Sí' : 'No']),
  });

  sheets.push({
    name: 'Tarjetas', columns: ['Nombre', 'Banco', 'Últimos 4', 'Cupo', 'Deuda inicial', 'Día de corte', 'Día de pago', 'Archivada'], money: [3, 4],
    rows: all(`SELECT k.*, b.name AS bank FROM credit_cards k LEFT JOIN banks b ON b.id = k.bank_id WHERE k.user_id = ? ORDER BY k.name`, userId)
      .map((k) => [k.name, k.bank || '', k.last4 || '', money(k.credit_limit), money(k.initial_debt), k.cut_day, k.due_day, k.archived ? 'Sí' : 'No']),
  });

  sheets.push({
    name: 'Categorías', columns: ['Nombre', 'Tipo', 'Color', 'Tope mensual', 'Archivada'], money: [3],
    rows: all(`SELECT c.*, l.amount AS lim FROM categories c LEFT JOIN category_limits l ON l.category_id = c.id AND l.user_id = c.user_id
      WHERE c.user_id = ? ORDER BY c.kind, c.name`, userId)
      .map((c) => [c.name, c.kind, c.color, c.lim ? money(c.lim) : null, c.archived ? 'Sí' : 'No']),
  });

  sheets.push({
    name: 'Fuentes de ingreso', columns: ['Nombre', 'Valor esperado', 'Frecuencia', 'Notas', 'Archivada'], money: [1],
    rows: all('SELECT * FROM income_sources WHERE user_id = ? ORDER BY name', userId)
      .map((s) => [s.name, money(s.expected_amount), s.frequency || '', s.notes || '', s.archived ? 'Sí' : 'No']),
  });

  sheets.push({
    name: 'Gastos fijos', columns: ['Descripción', 'Valor', 'Categoría', 'Se paga desde', 'Día', 'Frecuencia', 'Medio de pago', 'Activo'], money: [1],
    rows: all(`SELECT f.*, c.name AS cat, k.name AS cont FROM fixed_expenses f LEFT JOIN categories c ON c.id = f.category_id
      LEFT JOIN containers k ON k.id = f.container_id WHERE f.user_id = ? ORDER BY f.due_day`, userId)
      .map((f) => [f.description, money(f.amount), f.cat || '', f.cont || '', f.due_day, f.frequency || '', f.payment_method || '', f.active ? 'Sí' : 'No']),
  });

  sheets.push({
    name: 'Pagos de gastos fijos', columns: ['Descripción', 'Valor', 'Vence', 'Estado', 'Pagado el'], money: [1],
    rows: all('SELECT * FROM fixed_instances WHERE user_id = ? ORDER BY due_date', userId)
      .map((f) => [f.description, money(f.amount), f.due_date || '', f.status || '', f.paid_date || '']),
  });

  sheets.push({
    name: 'Periodos', columns: ['Periodo', 'Desde', 'Hasta', 'Estado', 'Presupuesto', 'Sobrante traído'], money: [4, 5],
    rows: all('SELECT * FROM periods WHERE user_id = ? ORDER BY start_date', userId)
      .map((p) => [p.label, p.start_date, p.end_date, p.status, money(p.budget_amount), money(p.rollover_amount)]),
  });

  sheets.push({
    name: 'Metas', columns: ['Nombre', 'Meta', 'Fecha objetivo', 'Bolsillo', 'Saldo del bolsillo', 'Aporte por periodo', 'Notas', 'Archivada'], money: [1, 4, 5],
    rows: all(`SELECT g.*, c.name AS cont FROM goals g LEFT JOIN containers c ON c.id = g.container_id WHERE g.user_id = ? ORDER BY g.id`, userId)
      .map((g) => [g.name, money(g.target_amount), g.target_date || '', g.cont || '', g.container_id && balances.has(g.container_id) ? money(balances.get(g.container_id)) : null,
        money(g.contribution_per_period), g.notes || '', g.archived ? 'Sí' : 'No']),
  });

  sheets.push({
    name: 'Préstamos', columns: ['ID', 'Tipo', 'Persona', 'Valor', 'Fecha', 'Vence', 'Estado', 'Notas'], money: [3],
    rows: all('SELECT * FROM loans WHERE user_id = ? ORDER BY date', userId)
      .map((l) => [l.id, l.direction === 'debo' ? 'Debo' : 'Me deben', l.person, money(l.amount), l.date, l.due_date || '', l.status, l.notes || '']),
  });
  sheets.push({
    name: 'Abonos a préstamos', columns: ['ID préstamo', 'Persona', 'Valor', 'Fecha', 'Notas'], money: [2],
    rows: all('SELECT p.*, l.person FROM loan_payments p JOIN loans l ON l.id = p.loan_id WHERE p.user_id = ? ORDER BY p.date', userId)
      .map((p) => [p.loan_id, p.person, money(p.amount), p.date, p.notes || '']),
  });

  sheets.push({
    name: 'Bandeja de correo', columns: ['Estado', 'Tipo', 'Fecha', 'Descripción', 'Valor', 'Remitente', 'Asunto', 'Nota'], money: [4],
    rows: all('SELECT * FROM proposed_movements WHERE user_id = ? ORDER BY date', userId)
      .map((p) => [p.status, KIND[p.kind] || p.kind, p.date, p.description, money(p.amount), p.email_sender || '', p.email_subject || '', p.reason || '']),
  });
  sheets.push({
    name: 'Remitentes y reglas', columns: ['Qué', 'Valor', 'Detalle'],
    rows: [
      ...all('SELECT * FROM email_senders WHERE user_id = ?', userId).map((s) => ['Remitente autorizado', s.sender, s.label || '']),
      ...all('SELECT r.*, c.name AS cat FROM email_rules r LEFT JOIN categories c ON c.id = r.category_id WHERE r.user_id = ?', userId)
        .map((r) => ['Regla aprendida', r.merchant_pattern, `${KIND[r.kind] || r.kind}${r.cat ? ' → ' + r.cat : ''}`]),
    ],
  });

  sheets.push({
    name: 'Hogar (mis gastos)', columns: ['Hogar', 'Fecha', 'Descripción', 'Categoría', 'Valor', 'División'], money: [4],
    rows: all(`SELECT e.*, h.name AS hname FROM household_expenses e JOIN households h ON h.id = e.household_id WHERE e.paid_by = ? ORDER BY e.date`, userId)
      .map((e) => [e.hname, e.date, e.description, e.category || '', money(e.amount), e.split || '']),
  });

  sheets.push({
    name: 'Historial de cambios', columns: ['Fecha', 'Qué', 'Acción', 'Detalle', 'Origen'],
    rows: all('SELECT * FROM audit_log WHERE user_id = ? ORDER BY id', userId)
      .map((a) => [a.created_at, a.entity, a.action, a.details || '', a.origin || '']),
  });
  return sheets;
}

function exportXlsx(userId) { return buildXlsx(exportSheets(userId)); }

/**
 * Elimina la cuenta y todo lo guardado: movimientos, bancos, fotos, conexión con Gmail,
 * huellas, notificaciones y sesiones abiertas. Los hogares que queden vacíos también se borran.
 */
function deleteAccount(userId) {
  const uploadsRoot = process.env.UPLOADS_PATH || path.join(path.dirname(DB_PATH), 'uploads');
  db.tx(() => {
    // Sesiones abiertas en cualquier dispositivo
    for (const s of all('SELECT sid, sess FROM sessions')) {
      try { if (JSON.parse(s.sess).userId === userId) db.prepare('DELETE FROM sessions WHERE sid = ?').run(s.sid); } catch { /* sesión corrupta */ }
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(userId); // ON DELETE CASCADE borra el resto
    db.prepare('DELETE FROM households WHERE id NOT IN (SELECT household_id FROM household_members)').run();
  });
  try { fs.rmSync(path.join(uploadsRoot, String(userId)), { recursive: true, force: true }); } catch { /* sin fotos */ }
}

module.exports = { exportSheets, exportXlsx, deleteAccount };
