'use strict';
/**
 * Intérpretes de correos de banco (RC-03..RC-06).
 * Cada banco tiene su plantilla; se empieza con un patrón general compatible con
 * los avisos típicos de Bancolombia y se pueden agregar más plantillas fácilmente.
 *
 * Solo se extraen datos puntuales (valor, fecha, comercio, medio de pago, últimos 4):
 * nunca se guarda el cuerpo completo del correo (RC-14).
 */

// ---------- utilidades ----------
function extractAmount(text) {
  // "$1.234.567", "$ 120.000,50", "1.234.567 pesos", "por valor de 85000"
  const patterns = [
    /\$\s?([\d]{1,3}(?:\.\d{3})+(?:,\d{1,2})?)/,
    /\$\s?([\d]+(?:,\d{1,2})?)/,
    /([\d]{1,3}(?:\.\d{3})+(?:,\d{1,2})?)\s*(?:pesos|COP)/i,
    /(?:valor|monto|por)\s*(?:de)?\s*:?\s*([\d]{1,3}(?:\.\d{3})+(?:,\d{1,2})?)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const { parseAmount } = require('../utils/money');
      const cents = parseAmount(m[1]);
      if (cents > 0) return cents;
    }
  }
  return 0;
}

function extractDate(text) {
  let m = text.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return m[0];
  const meses = { enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06', julio: '07', agosto: '08', septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12' };
  m = text.match(/(\d{1,2})\s+de\s+([a-záéíóú]+)(?:\s+de\s+(\d{4}))?/i);
  if (m && meses[m[2].toLowerCase()]) {
    const year = m[3] || new Date().getFullYear();
    return `${year}-${meses[m[2].toLowerCase()]}-${String(m[1]).padStart(2, '0')}`;
  }
  return null;
}

function extractLast4(text) {
  const m = text.match(/(?:terminada en|terminado en|últimos|ultimos|final)\s*(?:en|:)?\s*(\d{4})\b/i);
  return m ? m[1] : '';
}

function extractMerchant(text) {
  const patterns = [
    /\b(?:comercio|establecimiento|en)\b\s*:?\s*([A-Za-zÁÉÍÓÚáéíóúÑñ0-9 .&'-]{3,40})/i,
    /\bcompra (?:exitosa |realizada |en )+([A-Za-zÁÉÍÓÚáéíóúÑñ0-9 .&'-]{3,40})/i,
    /\b(?:de|desde)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ][A-Za-zÁÉÍÓÚáéíóúÑñ0-9 .&'-]{2,40})\s+(?:el|con|el d[íi]a|the|on)\b/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      let s = m[1].trim().replace(/\s+/g, ' ');
      // Corta en palabras vacías y fechas para dejar solo el nombre
      s = s.split(/\s+(?:el|la|de|con|por|del|al|y|e|the|on|at|desde)\s+/i)[0];
      s = s.replace(/\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b.*$/, '').trim();
      s = s.replace(/\s+\d+.*$/, '').trim();
      if (s.length >= 3) return s;
    }
  }
  return '';
}

// ---------- plantillas por banco ----------
const { findAmount, findDate } = require('./receiptParser');
const { currentTimeZone } = require('../utils/dates');
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// RC-18: el verbo de la frase dice si entró o salió dinero
const INCOME_VERBS = /recibiste|te\s+(?:envio|enviaron|consigno|consignaron|transfirio|transfirieron|abonaron)|abono\s+(?:a|en)\s+tu|consignacion|transferencia\s+recibida|deposito|reembolso|reintegro|devolucion/;
const EXPENSE_VERBS = /pagaste|compraste|\bcompra\b|\bpago\b|retiraste|\bretiro\b|transferiste|enviaste|transferencia\s+(?:enviada|realizada)|debito|\bcargo\b|cuota\s+de\s+manejo|avance|descuento\s+de/;

/** RC-21: últimos 4 dígitos con uno o dos asteriscos delante (o "terminada en"). */
function last4Of(text) {
  const m = /\*{1,2}\s?(\d{4})\b/.exec(text) || /(?:terminad[ao]|termina|finalizad[ao])\s+en\s+(\d{4})\b/i.exec(text) || /(?:cuenta|tarjeta|producto)\s+(?:no\.?\s*)?x+(\d{4})\b/i.exec(text);
  return m ? m[1] : '';
}

/** Contraparte: quién envió (ingresos) o dónde se pagó (gastos). */
function counterpartOf(text, kind) {
  const clean = (v) => v.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
  if (kind === 'ingreso') {
    const m = /\b(?:de|desde)\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ.&' -]{2,60}?)\s+(?:en|a|el|por|con|desde|,|\.|$)/.exec(text);
    if (m && !/^(tu|su|la|el|una|un|cuenta|bancolombia)\b/i.test(m[1])) return clean(m[1]);
    return '';
  }
  const m = /\b(?:en|a)\s+([A-Z0-9][A-Z0-9ÁÉÍÓÚÑ .&'*-]{2,50}?)(?:\s+(?:desde|con|el|por|en\s+tu|\d{1,2}:\d{2}|\d{1,2}\/\d{1,2})|[,.](?:\s|$)|\s*$)/.exec(text);
  if (m && !/^(la llave|tu|su|la|el)\b/i.test(m[1])) return clean(m[1]);
  return '';
}

function classify(text) {
  const t = norm(text);
  const income = INCOME_VERBS.test(t), expense = EXPENSE_VERBS.test(t);
  // "Recibiste" gana si aparece al comienzo de la frase; si no, cuenta el primero que aparezca
  let kind = null;
  if (income && !expense) kind = 'ingreso';
  else if (expense && !income) kind = 'gasto';
  else if (income && expense) kind = t.search(INCOME_VERBS) < t.search(EXPENSE_VERBS) ? 'ingreso' : 'gasto';
  if (!kind) return null;

  // RC-22: pago por QR a una llave → sin comercio ni categoría
  const llave = /\bllave\s+([0-9A-Za-z@._-]{4,})/.exec(text);
  if (kind === 'gasto' && llave) {
    const k = llave[1];
    return { kind, description: `Pago QR a llave …${k.slice(-4)}`, noCategory: true };
  }
  const who = counterpartOf(text, kind);
  if (kind === 'ingreso') return { kind, description: who ? `Transferencia de ${who}` : 'Ingreso' };
  if (/cuota\s+de\s+manejo/.test(t)) return { kind, description: 'Cuota de manejo' };
  if (/retir/.test(t)) return { kind, description: 'Retiro en cajero', cash: true };
  if (/transferiste|enviaste|transferencia\s+(?:enviada|realizada)/.test(t)) return { kind, description: who ? `Transferencia a ${who}` : 'Transferencia enviada' };
  const verb = /compra|compraste/.test(t) ? 'Compra' : 'Pago';
  return { kind, description: who ? `${verb} en ${who}` : verb };
}

const BANK_PATTERNS = [
  {
    id: 'bancolombia',
    name: 'Bancolombia',
    // RC-17: el remitente cambia de subdominio (an., ayn.), por eso se reconoce el dominio
    senderPattern: /notificacionesbancolombia\.com|bancolombia/i,
    classify,
  },
];

/**
 * Interpreta un correo y devuelve un movimiento propuesto o null.
 * Solo se usan el asunto y el extracto: la publicidad y los consejos del resto del correo se ignoran.
 * @param {Object} email {from, subject, snippet, date}
 */
function parseBankEmail(email, knownSenders = []) {
  const text = `${email.subject || ''}. ${email.snippet || ''}`.replace(/\s+/g, ' ').trim();
  if (text.length < 5) return null;
  const from = String(email.from || '').toLowerCase();

  let template = BANK_PATTERNS.find((t) => t.senderPattern.test(from));
  if (!template && knownSenders.length) {
    const ok = knownSenders.some((s) => from.includes(String(s).toLowerCase().replace(/^@/, '')));
    if (!ok) return null; // RC-02: solo remitentes autorizados
  }
  const result = (template ? template.classify : classify)(text);
  if (!result) return null;

  // RC-19: "$100,000" y "$6,500.00" (coma de miles) y también "$100.000" o "$6.500,00"
  const amount = findAmount([text]);
  if (!amount || amount <= 0) return null;

  // RC-20: día/mes/año y hora de 24 horas
  const date = findDate(text, new Date().toLocaleDateString('en-CA', { timeZone: currentTimeZone() }))
    || extractDate(text) || (email.date ? new Date(email.date).toLocaleDateString('en-CA', { timeZone: currentTimeZone() }) : null);
  const time = (/\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text) || [])[0] || '';

  return {
    kind: result.kind,
    description: result.description,
    noCategory: Boolean(result.noCategory),
    cash: Boolean(result.cash),
    amount,
    date,
    time,
    last4: last4Of(text) || extractLast4(text),
    bank: template ? template.name : '',
  };
}

module.exports = { parseBankEmail, BANK_PATTERNS, extractAmount, extractDate, extractMerchant, extractLast4, last4Of, classify };
