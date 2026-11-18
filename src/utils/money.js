'use strict';

/**
 * Manejo de dinero: todo se guarda en centavos (enteros) para evitar errores de redondeo.
 * Entrada del usuario en formato colombiano: "1.234.567,89" o "1234567.89".
 */
function parseAmount(input) {
  if (input === null || input === undefined) return 0;
  let s = String(input).trim().replace(/[$\s]/g, '').replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  const negative = s.startsWith('-');
  s = s.replace(/-/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let decimalSep = null;
  if (lastComma > -1 && lastDot > -1) decimalSep = lastComma > lastDot ? ',' : '.';
  else if (lastComma > -1) decimalSep = (s.length - lastComma - 1) <= 2 ? ',' : null;
  else if (lastDot > -1) decimalSep = (s.length - lastDot - 1) <= 2 && !/^\d{1,3}(\.\d{3})+$/.test(s) ? '.' : null;

  if (decimalSep === ',') s = s.replace(/\./g, '').replace(',', '.');
  else if (decimalSep === '.') s = s.replace(/,/g, '');
  else s = s.replace(/[.,]/g, '');

  const value = parseFloat(s);
  if (isNaN(value)) return 0;
  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}

function formatMoney(cents, currency = 'COP') {
  const value = (cents || 0) / 100;
  const noDecimals = currency === 'COP' || currency === 'CLP' || currency === 'JPY';
  const formatted = new Intl.NumberFormat('es-CO', {
    minimumFractionDigits: noDecimals ? 0 : 2,
    maximumFractionDigits: noDecimals ? 0 : 2,
  }).format(value);
  const symbols = { COP: '$', USD: 'US$', EUR: '€', MXN: 'MX$', ARS: 'AR$', PEN: 'S/', CLP: 'CLP$' };
  return `${symbols[currency] || currency + ' '}${formatted}`;
}

module.exports = { parseAmount, formatMoney };
