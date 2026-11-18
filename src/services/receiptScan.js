'use strict';
/**
 * Escanear recibos y comprobantes: lee el texto de la foto (OCR en español, en el propio servidor,
 * sin enviar la imagen a terceros) y lo convierte en una propuesta de movimiento con las cuentas,
 * tarjetas y categorías de la persona.
 */
const os = require('os');
const path = require('path');
const { db } = require('../db');
const { parseReceiptText } = require('./receiptParser');
const { containerBalances } = require('./balances');
const { listCards } = require('./cards');

const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/spa/package.json')), '4.0.0_best_int');
let workerPromise = null;
let idleTimer = null;
let queue = Promise.resolve();

function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    workerPromise = createWorker('spa', 1, { langPath: LANG_PATH, cachePath: path.join(os.tmpdir(), 'erijuli-ocr'), gzip: true })
      .catch((e) => { workerPromise = null; throw e; });
  }
  // Libera memoria si nadie escanea en 10 minutos
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const w = workerPromise; workerPromise = null;
    if (w) { try { (await w).terminate(); } catch { /* ya cerrado */ } }
  }, 10 * 60 * 1000);
  idleTimer.unref();
  return workerPromise;
}

/** OCR de una imagen (Buffer). Las lecturas se hacen de una en una. */
function ocr(buffer) {
  const run = queue.then(async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(buffer);
    return { text: data.text || '', confidence: Math.round(data.confidence || 0) };
  });
  queue = run.catch(() => {});
  return run;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Relaciona lo leído con los datos de la persona (cuentas, tarjetas, categorías, fuentes y su historial). */
function suggest(userId, parsed) {
  const s = {
    kind: parsed.kind,
    amount: parsed.amount || null,
    date: parsed.date || null,
    description: parsed.description || '',
    category_id: null, container_from_id: null, container_to_id: null, income_source_id: null,
    notes: [parsed.reference ? `Ref. ${parsed.reference}` : '', parsed.isTransfer && parsed.counterpart && parsed.note ? `Para ${parsed.counterpart}` : ''].filter(Boolean).join(' · '),
  };
  const matched = {};
  const categories = db.prepare('SELECT * FROM categories WHERE user_id = ? AND archived = 0').all(userId);
  const containers = containerBalances(userId);
  const cards = listCards(userId);

  // 1. Historial: si ya registró algo parecido, usar la misma categoría y cuenta
  const key = norm(parsed.merchant || parsed.counterpart || '').split(' ').slice(0, 2).join(' ');
  if (key.length >= 3) {
    const prev = db.prepare(`SELECT category_id, container_from_id, container_to_id, card_id, income_source_id FROM transactions
      WHERE user_id = ? AND kind = ? AND lower(description) LIKE ? ORDER BY date DESC, id DESC LIMIT 1`)
      .get(userId, s.kind, `%${key}%`);
    if (prev) {
      if (prev.category_id) { s.category_id = prev.category_id; matched.category = 'historial'; }
      if (s.kind === 'gasto') {
        if (prev.card_id) { s.container_from_id = `tarjeta:${prev.card_id}`; matched.account = 'historial'; }
        else if (prev.container_from_id) { s.container_from_id = prev.container_from_id; matched.account = 'historial'; }
      } else if (prev.container_to_id) { s.container_to_id = prev.container_to_id; matched.account = 'historial'; }
      if (prev.income_source_id) s.income_source_id = prev.income_source_id;
    }
    // Reglas aprendidas en la bandeja de Gmail
    if (!s.category_id) {
      const rule = db.prepare(`SELECT * FROM email_rules WHERE user_id = ? AND ? LIKE '%' || lower(merchant_pattern) || '%' ORDER BY id DESC`).get(userId, norm(parsed.merchant || parsed.description));
      if (rule) {
        if (rule.category_id) { s.category_id = rule.category_id; matched.category = 'regla'; }
        if (!s.container_from_id && rule.container_from_id && s.kind === 'gasto') s.container_from_id = rule.container_from_id;
      }
    }
  }

  // 2. Categoría por tipo de comercio
  if (!s.category_id && parsed.categoryHint) {
    const target = norm(parsed.categoryHint);
    const cat = categories.find((c) => c.kind === s.kind && norm(c.name) === target) || categories.find((c) => c.kind === s.kind && norm(c.name).includes(target.slice(0, 5)));
    if (cat) { s.category_id = cat.id; matched.category = 'comercio'; }
  }

  // 3. Cuenta: tarjeta por los últimos 4 dígitos, o el banco / billetera que aparece en el comprobante
  if (s.kind === 'gasto' && !s.container_from_id) {
    const card = parsed.last4 && cards.find((c) => c.last4 && c.last4 === parsed.last4);
    if (card && (parsed.usedCard || (!parsed.isTransfer && !parsed.debit))) { s.container_from_id = `tarjeta:${card.id}`; matched.account = 'tarjeta'; }
  }
  const field = s.kind === 'gasto' ? 'container_from_id' : 'container_to_id';
  if (!s[field] && parsed.bank) {
    const b = norm(parsed.bank);
    const inBank = containers.filter((c) => norm(c.bank_name).includes(b) || norm(c.name).includes(b));
    const pick = inBank.find((c) => c.kind === 'cuenta') || inBank[0];
    if (pick) { s[field] = pick.id; matched.account = 'banco'; }
  }

  // 4. Fuente del ingreso por el nombre de quien envía
  if (s.kind === 'ingreso' && !s.income_source_id && parsed.counterpart) {
    const who = norm(parsed.counterpart);
    const src = db.prepare('SELECT * FROM income_sources WHERE user_id = ? AND archived = 0').all(userId)
      .find((x) => { const n = norm(x.name).replace(/^pago\s+/, ''); return n.length >= 3 && (who.includes(n) || n.includes(who.split(' ')[0])); });
    if (src) { s.income_source_id = src.id; matched.source = true; }
  }

  return { suggestion: s, matched };
}

/** Escanea una imagen en data URL y devuelve la propuesta. */
async function scanDataUrl(userId, dataUrl) {
  const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('La imagen no es válida. Usa una foto o captura en JPG o PNG.'), { status: 400 });
  const buffer = Buffer.from(m[1], 'base64');
  if (buffer.length > 9 * 1024 * 1024) throw Object.assign(new Error('La imagen es muy pesada.'), { status: 413 });
  const t = Date.now();
  const { text, confidence } = await ocr(buffer);
  const parsed = parseReceiptText(text);
  const { suggestion, matched } = suggest(userId, parsed);
  return { ok: true, text, confidence, ms: Date.now() - t, parsed, suggestion, matched,
    empty: !parsed.amount && text.replace(/\s/g, '').length < 15 };
}

module.exports = { scanDataUrl, suggest, ocr };
