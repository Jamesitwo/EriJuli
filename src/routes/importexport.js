'use strict';
const express = require('express');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { parseAmount, formatMoney } = require('../utils/money');
const { todayISO, periodFor } = require('../utils/dates');
const { ensurePeriod } = require('../services/periods');
const { log } = require('../services/audit');

const router = express.Router();

// ---------- CSV helpers ----------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const clean = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',' || ch === ';') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function csvEscape(v) {
  const s = String(v === null || v === undefined ? '' : v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(headers, rows) {
  return '\uFEFF' + [headers.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\r\n');
}

// ---------- Página ----------
router.get('/importar-exportar', (req, res) => {
  res.render('importexport/index', { title: 'Importar y exportar', isAdmin: isServerAdmin(req.user) });
});

router.get('/plantilla-movimientos.csv', (req, res) => {
  const csv = toCSV(
    ['tipo', 'fecha', 'descripcion', 'valor', 'categoria', 'fuente', 'cuenta_origen', 'cuenta_destino', 'notas'],
    [
      ['gasto', '2026-11-01', 'Compra del mercado', '120000', 'Alimentación', '', 'Cuenta', '', ''],
      ['ingreso', '2026-11-05', 'Pago quincena', '1500000', '', 'Pago James', '', 'Cuenta', ''],
      ['transferencia', '2026-11-06', 'Ahorro moto', '200000', '', '', 'Cuenta', 'Moto', ''],
    ]
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_movimientos.csv"');
  res.send(csv);
});

// ---------- Exportar ----------
router.get('/exportar/movimientos.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT t.kind, t.date, t.description, t.amount, c.name AS category, s.name AS source,
      cf.name AS from_name, ct.name AS to_name, t.expense_type, t.notes, t.origin
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN income_sources s ON s.id = t.income_source_id
    LEFT JOIN containers cf ON cf.id = t.container_from_id
    LEFT JOIN containers ct ON ct.id = t.container_to_id
    WHERE t.user_id = ? ORDER BY t.date
  `).all(req.user.id)
    .map((r) => [r.kind, r.date, r.description, (r.amount / 100).toFixed(2), r.category || '', r.source || '', r.from_name || '', r.to_name || '', r.expense_type, r.notes || '', r.origin]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="movimientos.csv"');
  res.send(toCSV(['tipo', 'fecha', 'descripcion', 'valor', 'categoria', 'fuente', 'cuenta_origen', 'cuenta_destino', 'tipo_gasto', 'notas', 'origen'], rows));
});

router.get('/exportar/bolsillos.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT b.name AS bank, c.kind, c.name, c.purpose, c.initial_balance
    FROM containers c JOIN banks b ON b.id = c.bank_id WHERE c.user_id = ? ORDER BY b.name, c.kind DESC, c.name
  `).all(req.user.id).map((r) => [r.bank, r.kind, r.name, r.purpose, (r.initial_balance / 100).toFixed(2)]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bolsillos.csv"');
  res.send(toCSV(['banco', 'tipo', 'nombre', 'proposito', 'saldo_inicial'], rows));
});

// Todos mis datos en Excel (RN-05): una hoja por tipo de dato, solo los de esta persona
router.get('/exportar/todo.xlsx', (req, res) => {
  const { exportXlsx } = require('../services/account');
  const buf = exportXlsx(req.user.id);
  log(req.user.id, 'export', null, 'exportar todo', 'Excel con todos los datos');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="erijuli_mis_datos_${todayISO()}.xlsx"`);
  res.send(buf);
});

/** El respaldo .db trae los datos de TODAS las personas: solo para quien administra el servidor. */
function isServerAdmin(user) {
  const admin = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (admin) return user.email === admin;
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 1;
}

// Respaldo completo de la base de datos (RN-08)
router.get('/exportar/respaldo.db', (req, res) => {
  if (!isServerAdmin(req.user)) {
    setFlash(req, 'error', 'El respaldo de la base de datos incluye a todas las personas de la app; solo lo descarga quien la administra (ADMIN_EMAIL). Usa "Todos mis datos en Excel".');
    return res.redirect('/importar-exportar');
  }
  const { createBackup } = require('../services/backup');
  const file = createBackup();
  if (!file) {
    setFlash(req, 'error', 'No se pudo generar el respaldo.');
    return res.redirect('/importar-exportar');
  }
  res.download(file, 'respaldo_finanzas.db');
});

// ---------- Importar ----------
router.post('/importar', (req, res) => {
  const text = String(req.body.csv_text || '');
  if (!text.trim()) {
    setFlash(req, 'error', 'Pega el contenido del CSV o sube un archivo .csv.');
    return res.redirect('/importar-exportar');
  }
  const rows = parseCSV(text);
  if (rows.length < 2) {
    setFlash(req, 'error', 'El CSV necesita encabezados y al menos una fila.');
    return res.redirect('/importar-exportar');
  }
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (names) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i > -1) return i;
    }
    return -1;
  };
  const i = {
    tipo: idx(['tipo', 'kind']), fecha: idx(['fecha', 'date']), descripcion: idx(['descripcion', 'description']),
    valor: idx(['valor', 'amount', 'monto']), categoria: idx(['categoria', 'category']), fuente: idx(['fuente', 'source']),
    origen: idx(['cuenta_origen', 'from']), destino: idx(['cuenta_destino', 'to']), notas: idx(['notas', 'notes']),
    extra: idx(['extra', 'dinero_extra']),
  };
  if (i.fecha === -1 || i.valor === -1) {
    setFlash(req, 'error', 'El CSV debe tener al menos las columnas "fecha" y "valor". Descarga la plantilla para ver el formato.');
    return res.redirect('/importar-exportar');
  }

  const findContainer = (name) => {
    if (!name) return null;
    const clean = String(name).trim();
    // Permite "Banco · Cuenta" o "Banco/Cuenta" para desempatar nombres repetidos
    const parts = clean.split(/\s*[·\/]\s*/);
    if (parts.length === 2) {
      const byBank = db.prepare(`SELECT c.* FROM containers c JOIN banks b ON b.id = c.bank_id
        WHERE c.user_id = ? AND lower(b.name) = lower(?) AND lower(c.name) = lower(?)`).get(req.user.id, parts[0], parts[1]);
      if (byBank) return byBank;
    }
    return db.prepare(`SELECT c.* FROM containers c WHERE c.user_id = ? AND lower(c.name) = lower(?)`).get(req.user.id, clean) || null;
  };
  const findCategory = (name, kind) => {
    if (!name) return null;
    return db.prepare(`SELECT * FROM categories WHERE user_id = ? AND lower(name) = lower(?)`).get(req.user.id, String(name).trim()) || null;
  };
  const findSource = (name) => {
    if (!name) return null;
    return db.prepare(`SELECT * FROM income_sources WHERE user_id = ? AND lower(name) = lower(?)`).get(req.user.id, String(name).trim()) || null;
  };

  const insertTx = db.prepare(`INSERT INTO transactions
    (user_id, kind, amount, date, description, category_id, income_source_id, container_from_id, container_to_id, expense_type, period_id, origin, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?)`);

  let imported = 0, skipped = 0;
  const problems = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    try {
      const kind = String(row[i.tipo] || 'gasto').trim().toLowerCase();
      const txKind = kind.startsWith('ingreso') ? 'ingreso' : kind.startsWith('transfer') ? 'transferencia' : 'gasto';
      const date = String(row[i.fecha] || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped++; problems.push(`Fila ${r + 1}: fecha inválida (usa AAAA-MM-DD).`); continue; }
      const amount = parseAmount(row[i.valor]);
      if (amount <= 0) { skipped++; problems.push(`Fila ${r + 1}: valor inválido.`); continue; }

      const from = i.origen > -1 ? findContainer(row[i.origen]) : null;
      const to = i.destino > -1 ? findContainer(row[i.destino]) : null;
      if ((txKind === 'gasto' || txKind === 'transferencia') && !from) { skipped++; problems.push(`Fila ${r + 1}: cuenta_origen no encontrada ("${row[i.origen] || ''}").`); continue; }
      if ((txKind === 'ingreso' || txKind === 'transferencia') && !to) { skipped++; problems.push(`Fila ${r + 1}: cuenta_destino no encontrada ("${row[i.destino] || ''}").`); continue; }

      const period = ensurePeriod(req.user, date);
      const isExtra = i.extra > -1 && String(row[i.extra] || '').trim();
      insertTx.run(req.user.id, txKind, amount, date,
        String(row[i.descripcion] || '').trim() || 'Importado',
        i.categoria > -1 ? (findCategory(row[i.categoria], txKind) || {}).id || null : null,
        (txKind === 'ingreso' && !isExtra && i.fuente > -1) ? (findSource(row[i.fuente]) || {}).id || null : null,
        txKind === 'ingreso' ? null : (from && from.id),
        txKind === 'gasto' ? null : (to && to.id),
        'variable', period.id, String(i.notas > -1 ? row[i.notas] : '').trim());
      imported++;
    } catch (e) {
      skipped++;
      problems.push(`Fila ${r + 1}: ${e.message}`);
    }
  }

  log(req.user.id, 'import', null, 'importar CSV', `${imported} movimientos importados, ${skipped} omitidos`);
  if (problems.length) {
    req.session.flash = { type: 'warning', text: `Se importaron ${imported} movimientos. ${skipped} omitidos: ${problems.slice(0, 5).join(' | ')}${problems.length > 5 ? ' …' : ''}` };
  } else {
    setFlash(req, 'success', `¡Listo! Se importaron ${imported} movimientos.`);
  }
  res.redirect('/movimientos');
});

module.exports = router;
