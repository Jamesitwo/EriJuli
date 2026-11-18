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
const BANK_PATTERNS = [
  {
    id: 'bancolombia',
    name: 'Bancolombia',
    senderPattern: /bancolombia|alertasbancolombia|notificacionesbancolombia/i,
    // Devuelve {kind, description} si el correo es un movimiento, o null
    classify(text) {
      const t = text.toLowerCase();
      if (/(compra|pago|retiro|débito|debito|cargo|descuento|transferencia (?:enviada|realizada)|extracto débito)/.test(t)) {
        const merchant = extractMerchant(text);
        return { kind: 'gasto', description: merchant ? `Compra ${merchant}` : 'Movimiento Bancolombia' };
      }
      if (/(transferencia recibida|abono|consignación|consignacion|depósito|deposito|crédito|credito|reembolso|reintegro)/.test(t)) {
        const merchant = extractMerchant(text);
        return { kind: 'ingreso', description: merchant ? `Ingreso de ${merchant}` : 'Ingreso Bancolombia' };
      }
      return null;
    },
  },
];

function genericClassify(text) {
  const t = text.toLowerCase();
  if (/(compra|pago|retiro|débito|debito|cargo)/.test(t)) {
    const merchant = extractMerchant(text);
    return { kind: 'gasto', description: merchant ? `Compra ${merchant}` : 'Movimiento detectado' };
  }
  if (/(transferencia recibida|abono|consignación|consignacion|depósito|deposito|reembolso)/.test(t)) {
    return { kind: 'ingreso', description: 'Ingreso detectado' };
  }
  return null;
}

/**
 * Interpreta un correo y devuelve un movimiento propuesto o null.
 * @param {Object} email {from, subject, snippet, date}
 */
function parseBankEmail(email, knownSenders = []) {
  const text = `${email.subject || ''} ${email.snippet || ''}`.trim();
  if (!text) return null;

  // Busca la plantilla del banco por el remitente (o por remitentes autorizados)
  let template = BANK_PATTERNS.find((t) => t.senderPattern.test(email.from || ''));
  if (!template && knownSenders.length) {
    const sender = knownSenders.find((s) => (email.from || '').toLowerCase().includes(s.toLowerCase()));
    if (!sender) return null; // RC-02: solo remitentes autorizados
    template = BANK_PATTERNS[0]; // plantilla por defecto para bancos sin plantilla propia
  }
  const result = template ? template.classify(text) : genericClassify(text);
  if (!result) return null;

  const amount = extractAmount(text);
  if (amount <= 0) return null;

  return {
    kind: result.kind,
    description: result.description,
    amount,
    date: extractDate(text) || (email.date ? email.date.slice(0, 10) : null),
    last4: extractLast4(text),
    bank: template ? template.name : '',
  };
}

module.exports = { parseBankEmail, BANK_PATTERNS, extractAmount, extractDate, extractMerchant, extractLast4 };
