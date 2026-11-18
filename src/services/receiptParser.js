'use strict';
/**
 * Interpreta el texto de un recibo, factura o comprobante de transferencia (Colombia).
 * Recibe el texto que sale del OCR y devuelve una propuesta de movimiento:
 *   { kind, amount, date, description, merchant, counterpart, reference, bank, last4, categoryHint, found }
 * No toca la base de datos: ver receiptScan.js para relacionarlo con las cuentas y categorías de la persona.
 */

const MESES = { ene: 1, enero: 1, feb: 2, febrero: 2, mar: 3, marzo: 3, abr: 4, abril: 4, may: 5, mayo: 5, jun: 6, junio: 6,
  jul: 7, julio: 7, ago: 8, agosto: 8, sep: 9, sept: 9, set: 9, septiembre: 9, setiembre: 9, oct: 10, octubre: 10,
  nov: 11, noviembre: 11, dic: 12, diciembre: 12 };

const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Palabras clave del valor, de la más confiable a la menos
const AMOUNT_KEYS = [
  [/total\s+a\s+pagar|valor\s+total|total\s+pagado|neto\s+a\s+pagar/, 10],
  [/valor\s+(enviado|transferido|de\s+la\s+transferencia|pagado|recibido|del\s+pago|de\s+la\s+compra)/, 10],
  [/cuanto\??|monto\s+(enviado|transferido|pagado)/, 9],
  [/^\s*total\b|\btotal\s*[:$]/, 8],
  [/enviaste|pagaste|transferiste|recibiste|te\s+enviaron|te\s+transfirieron/, 7],
  [/^\s*(valor|monto|importe)\b/, 6],
];
// Líneas cuyo número NO es el valor del movimiento
const NOT_AMOUNT = /subtotal|sub\s*total|iva|impuesto|propina\s+sugerida|cambio|vueltas|efectivo\s+recibido|^\s*efectivo|costo\s+de\s+la\s+transferencia|comision|cuota\s+de\s+manejo|base\s+gravable|descuento|ahorro|saldo|nit|telefono|tel\.|cel\.|celular|cedula|c\.c|cc\s|documento|cuenta\s+no|numero|n[°º]|referencia|comprobante|factura|aprobacion|autorizacion|cus\b|codigo|resolucion|caja\s+\d|terminal/;

const MONEY_RE = /(?:\$|cop|col\$)?\s*(\d{1,3}(?:[.\s,]\d{3})+|\d{4,9})(?:[.,](\d{1,2}))?(?!\d)/gi;

function moneyValues(line) {
  const out = [];
  const text = String(line);
  let m;
  MONEY_RE.lastIndex = 0;
  while ((m = MONEY_RE.exec(text))) {
    const lead = m[0].length - m[0].trimStart().length;
    const raw = m[0].trimStart();
    const start = m.index + lead;
    const before = text.slice(Math.max(0, start - 1), start);
    const after = text.slice(start + raw.length, start + raw.length + 3);
    if (/[a-z]/i.test(after.trim().charAt(0)) && !/^\s/.test(after)) continue;          // 1100ML, 500MG
    if (/[a-z*#-]/i.test(before) && !raw.trim().startsWith('$')) continue;               // M12345678, *4821, NIT-
    const hasSign = /\$|cop/i.test(raw);
    const grouped = /\d[.\s,]\d{3}/.test(m[1]);
    if (!hasSign && !grouped) continue;                                                     // números sueltos (referencias, horas)
    const intPart = Number(m[1].replace(/[.\s,]/g, ''));
    if (!intPart || intPart > 500000000) continue;
    out.push(intPart * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0));
  }
  return out;
}

function findAmount(lines) {
  let best = null;
  lines.forEach((line, i) => {
    const s = strip(line);
    for (const [re, score] of AMOUNT_KEYS) {
      if (!re.test(s)) continue;
      if (/subtotal|sub\s*total/.test(s)) break;
      // el valor puede estar en la misma línea o en las 2 siguientes
      const candidates = [line, lines[i + 1] || '', lines[i + 2] || ''];
      for (let k = 0; k < candidates.length; k++) {
        if (k > 0 && NOT_AMOUNT.test(strip(candidates[k])) && !/^\s*\$/.test(candidates[k])) break;
        if (k > 0 && /[a-z]{4,}/i.test(candidates[k].replace(/\$|cop/gi, '')) && !moneyValues(candidates[k]).length) continue;
        const vals = moneyValues(candidates[k]);
        if (vals.length) {
          const v = Math.max(...vals);
          const sc = score - k;
          if (!best || sc > best.score || (sc === best.score && v > best.value)) best = { value: v, score: sc };
          break;
        }
      }
      break;
    }
  });
  if (best) return best.value;
  // Sin palabra clave: el valor más alto que no sea subtotal, impuestos, cambio, etc.
  let max = 0;
  for (const line of lines) {
    if (NOT_AMOUNT.test(strip(line))) continue;
    for (const v of moneyValues(line)) if (v > max) max = v;
  }
  return max || null;
}

function validDate(y, m, d, today) {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getMonth() !== m - 1) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // No aceptar fechas futuras (más de 1 día) ni de hace más de 2 años
  const t = new Date(today + 'T00:00:00');
  if (dt - t > 86400000 || t - dt > 2 * 366 * 86400000) return null;
  return iso;
}

function findDate(text, today) {
  const s = strip(text);
  const found = [];
  let m;
  const months = Object.keys(MESES).sort((a, b) => b.length - a.length).join('|');
  const reNamed = new RegExp(`\\b(\\d{1,2})[ \\t]*(?:de[ \\t]+)?(${months})\\.?[ \\t,]*(?:de[ \\t]+|del[ \\t]+)?(\\d{4}|\\d{2})\\b`, 'g');
  while ((m = reNamed.exec(s))) { const mo = MESES[m[2]]; if (mo) found.push(validDate(+m[3], mo, +m[1], today)); }
  const reIso = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
  while ((m = reIso.exec(s))) found.push(validDate(+m[1], +m[2], +m[3], today));
  const reDmy = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g;
  while ((m = reDmy.exec(s))) found.push(validDate(+m[3], +m[2], +m[1], today));
  return found.find(Boolean) || null;
}

const INCOME = /recibiste|te\s+(envio|enviaron|transfirio|transfirieron|consigno|llego|llegaron)|has\s+recibido|abono\s+a\s+tu|consignacion\s+recibida|recibido\s+de|recibiste\s+plata|ingreso\s+de|transferencia\s+recibida|pago\s+recibido/;
const PAID_TO = /\b(?:pagaste\s+(?:en|a)|pago\s+(?:en|a)|compra\s+en|comercio|establecimiento)\b\s*:?/;
const TRANSFER = /envio\s+exitoso|transferencia\s+exitosa|transferencia|enviaste|enviado\s+a|envio\s+de\s+plata|producto\s+destino|cuenta\s+destino|destinatario|bre-?b|llave/;

const BANKS = [
  ['Nequi', /nequi/], ['Daviplata', /daviplata/], ['Bancolombia', /bancolombia/], ['Davivienda', /davivienda/],
  ['BBVA', /\bbbva\b/], ['Banco de Bogotá', /banco\s+de\s+bogota/], ['Banco de Occidente', /occidente/], ['Banco Popular', /banco\s+popular/],
  ['Caja Social', /caja\s+social/], ['AV Villas', /av\s*villas/], ['Scotiabank Colpatria', /colpatria|scotiabank/], ['Itaú', /\bitau\b/],
  ['Nu', /\bnu\s*(bank|colombia)?\b|nubank/], ['Lulo', /lulo\s*bank|\blulo\b/], ['Banco Falabella', /falabella/], ['Banco Agrario', /agrario/],
  ['Movii', /movii/], ['Dale', /\bdale!?\b/], ['Rappipay', /rappi\s*pay/], ['Efectivo', /\befectivo\b/],
];

const CATEGORY_HINTS = [
  ['Alimentación', /\bexito\b|carulla|jumbo|olimpica|\bd1\b|\bara\b|isimo|makro|pricesmart|surtimax|supermercado|minimercado|mercado|panaderia|restaurante|comidas|pizza|burger|hamburguesa|frisby|kfc|mcdonald|crepes|juan\s+valdez|tostao|oma\b|cafe|rappi|domicilio|asadero|carniceria|fruver|ifood/],
  ['Salud', /drogueria|farmacia|farmatodo|cruz\s+verde|la\s+rebaja|pasteur|copidrogas|colsubsidio\s+drog|clinica|hospital|eps|ips|laboratorio|odontolog|optica|medic/],
  ['Transporte', /terpel|primax|biomax|texaco|esso|mobil|zeus|gasolina|combustible|estacion\s+de\s+servicio|eds\b|peaje|parqueadero|parking|uber|didi|cabify|indrive|taxi|metro\s+de|civica|transmilenio|sitp|soat|tecnomecanica|lavadero|motos|repuestos/],
  ['Servicios', /\bepm\b|empresas\s+publicas|claro|movistar|\btigo\b|\bwom\b|\bune\b|internet|energia|acueducto|gas\s+natural|vanti|codensa|enel|celsia|aseo|administracion/],
  ['Entretenimiento', /cine|cinemark|procinal|cinecolombia|netflix|spotify|disney|hbo|prime\s+video|youtube|xbox|playstation|steam|bar\b|discoteca|teatro|concierto|tuboleta/],
  ['Hogar', /arriendo|homecenter|easy\b|ferreteria|ikea|tugo|muebles|jamar|alkosto|ktronix|falabella|home\s+sentry|lavanderia/],
  ['Educación', /universidad|colegio|libreria|panamericana|curso|matricula|udemy|platzi|coursera|institucion\s+educativa/],
];

const NOISE_LINE = /^(compra\s+aprobada|pago\s+exitoso|transaccion\s+(exitosa|aprobada)|aprobad[ao]|exitos[ao]|factura|nit|fecha|hora|no\.|n[°º]|tel|cel|direccion|dir\.|resolucion|regimen|iva|gracias|bienvenid|comprobante|recibo|ticket|caja|cajero|vendedor|cliente|documento|c\.c|cc|www|http|@)/;

function titleCase(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim()
    .replace(/(^|\s)(\p{L})/gu, (m, sp, ch) => sp + ch.toUpperCase())
    .replace(/\b(S\.?a\.?s?|Ltda|S\.?a)\.?$/i, '').replace(/\s+(De|Del|La|Las|Los|Y|E)\s+/g, (m) => m.toLowerCase()).trim();
}

function valueAfter(lines, re) {
  for (let i = 0; i < lines.length; i++) {
    const s = strip(lines[i]);
    const m = re.exec(s);
    if (!m) continue;
    const rest = lines[i].slice(lines[i].length - (s.length - m.index - m[0].length)).replace(/^[\s:.\-–]+/, '').trim();
    if (rest && /[a-z]/i.test(rest) && !moneyValues(rest).length) return rest;
    for (let k = 1; k <= 2; k++) {
      const next = (lines[i + k] || '').trim();
      if (next && /[a-z]{2,}/i.test(next) && !moneyValues(next).length) return next;
    }
  }
  return null;
}

function cleanName(s) {
  return String(s || '').replace(/[*•·|]+/g, ' ').replace(/\b(ahorros|corriente|cuenta|nequi|daviplata)\b.*$/i, '').replace(/[-–]\s*$/, '').replace(/\s+/g, ' ').trim();
}

function parseReceiptText(text, today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' })) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const all = strip(lines.join('\n'));
  const found = {};

  const amount = findAmount(lines); if (amount) found.amount = true;
  const date = findDate(lines.join('\n'), today); if (date) found.date = true;

  const isIncome = INCOME.test(all);
  const paidTo = !isIncome ? valueAfter(lines, PAID_TO) : null;
  const isTransfer = !isIncome && !paidTo && TRANSFER.test(all);
  const kind = isIncome ? 'ingreso' : 'gasto';

  // Contraparte (a quién le enviaste / quién te envió)
  let counterpart = null;
  if (isIncome) counterpart = valueAfter(lines, /\b(de|remitente|enviado\s+por|origen|quien\s+envia)\b\s*:?/);
  else if (isTransfer) counterpart = valueAfter(lines, /(?:le\s+)?(?:enviaste|transferiste)(?:\s+plata)?\s+a\b|\b(?:para|destinatario|producto\s+destino|cuenta\s+destino|enviado\s+a|beneficiario|a\s+nombre\s+de)\b\s*:?/);
  counterpart = counterpart ? cleanName(counterpart) : null;
  if (counterpart && counterpart.length < 3) counterpart = null;

  // Comercio: primera línea "de encabezado" con letras
  let merchant = paidTo ? titleCase(cleanName(paidTo)) : null;
  if (!merchant && !isIncome && !isTransfer) {
    for (const l of lines.slice(0, 6)) {
      const s = strip(l);
      if (NOISE_LINE.test(s) || moneyValues(l).length || !/[a-z]{3,}/i.test(l)) continue;
      if ((l.match(/[a-záéíóúñ]/gi) || []).length < 4) continue;
      merchant = titleCase(l.replace(/\bs\.?\s?a\.?\s?s?\.?$/i, ''));
      break;
    }
  }
  const note = valueAfter(lines, /\b(descripcion|concepto|mensaje|motivo|detalle)\b\s*:?/);

  // Referencia del comprobante
  let reference = null;
  const refRe = /(referencia|comprobante|no\.?\s+de\s+aprobacion|aprobacion|autorizacion|cus|factura(?:\s+electronica)?(?:\s+de\s+venta)?)\s*(?:no\.?|n[°º]|#)?\s*[:.]?\s*([a-z0-9-]{4,})/i;
  for (let i = 0; i < lines.length; i++) {
    const m = refRe.exec(lines[i]);
    if (m && /\d/.test(m[2])) { reference = m[2].toUpperCase(); break; }
    if (/^(referencia|comprobante|aprobacion|cus)\b/i.test(strip(lines[i])) && lines[i + 1] && /^[A-Z0-9-]{4,}$/i.test(lines[i + 1].trim())) { reference = lines[i + 1].trim().toUpperCase(); break; }
  }

  if (!reference) { const fm = /\bno\.?\s*((?:fev|fe|pos)?\s*\d{5,})/i.exec(lines.join('\n')); if (fm) reference = fm[1].replace(/\s+/g, ' ').toUpperCase(); }

  const bank = (BANKS.find(([, re]) => re.test(all)) || [])[0] || null;
  const last4m = /(?:\*{1,4}|x{2,4}|terminad[ao]\s+en|termina\s+en|\.{3})\s*(\d{4})\b/i.exec(lines.join(' '));
  const last4 = last4m ? last4m[1] : null;
  const usedCard = /credito|tarjeta\s+de\s+credito|visa|mastercard|amex|american\s+express|diners/.test(all) && !/debito/.test(all);
  const hintText = isTransfer ? strip(note || '') : all;
  const categoryHint = !isIncome && hintText ? ((CATEGORY_HINTS.find(([, re]) => re.test(hintText)) || [])[0] || null) : null;

  let description;
  if (isIncome) description = counterpart ? `Ingreso de ${titleCase(counterpart)}` : 'Ingreso';
  else if (isTransfer) description = note ? note.charAt(0).toUpperCase() + note.slice(1) : counterpart ? `Transferencia a ${titleCase(counterpart)}` : 'Transferencia';
  else description = merchant || 'Compra';
  if (description) found.description = true;

  return {
    kind, isTransfer, amount, date, description,
    merchant: merchant || (counterpart ? titleCase(counterpart) : null),
    counterpart: counterpart ? titleCase(counterpart) : null,
    note: note ? note.trim() : null,
    reference, bank, last4, usedCard, debit: /debito/.test(all), categoryHint, found,
  };
}

module.exports = { parseReceiptText, moneyValues, findAmount, findDate };
