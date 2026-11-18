'use strict';

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const { AsyncLocalStorage } = require('node:async_hooks');
const DEFAULT_TZ = 'America/Bogota';
// Zona horaria de la persona que hace la petición (RN-06). La fija requireAuth.
const tzStore = new AsyncLocalStorage();

function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
}

function currentTimeZone() {
  const tz = tzStore.getStore();
  return tz && validTimeZone(tz) ? tz : DEFAULT_TZ;
}

function todayISO() {
  // "Hoy" según la zona horaria del usuario (Bogotá por defecto)
  return new Date().toLocaleDateString('en-CA', { timeZone: currentTimeZone() });
}

function parseISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(iso, days) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

function lastDayOfMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function formatDate(iso, opts = {}) {
  if (!iso) return '';
  const d = parseISO(iso);
  return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: opts.year === false ? undefined : 'numeric' });
}

function monthLabel(year, monthIndex) {
  return `${MESES[monthIndex]} ${year}`;
}

/**
 * Calcula el periodo (mensual o quincenal) que contiene una fecha.
 * Quincena configurable: dia1 (por defecto 1) y dia2 (por defecto 16).
 */
function periodFor(user, iso) {
  const d = parseISO(iso);
  const year = d.getFullYear();
  const month = d.getMonth();
  const last = lastDayOfMonth(year, month);

  if (user.period_type === 'quincenal') {
    const d1 = Math.min(Math.max(1, user.quincena_dia1 || 1), last);
    const d2 = Math.min(Math.max(2, user.quincena_dia2 || 16), last);
    if (d.getDate() >= d2) {
      return {
        label: `Quincena 2 · ${monthLabel(year, month)}`,
        start_date: `${year}-${String(month + 1).padStart(2, '0')}-${String(d2).padStart(2, '0')}`,
        end_date: `${year}-${String(month + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
      };
    }
    return {
      label: `Quincena 1 · ${monthLabel(year, month)}`,
      start_date: `${year}-${String(month + 1).padStart(2, '0')}-${String(d1).padStart(2, '0')}`,
      end_date: `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.max(d1, d2 - 1)).padStart(2, '0')}`,
    };
  }

  return {
    label: monthLabel(year, month),
    start_date: `${year}-${String(month + 1).padStart(2, '0')}-01`,
    end_date: `${year}-${String(month + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
  };
}

function currentPeriodRange(user, iso = todayISO()) {
  return periodFor(user, iso);
}

/** Periodo siguiente al rango dado (para cerrar y abrir el siguiente). */
function nextPeriodRange(user, startDate) {
  const end = parseISO(periodFor(user, startDate).end_date);
  return periodFor(user, toISO(new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1)));
}

function periodMatches(period, iso) {
  return iso >= period.start_date && iso <= period.end_date;
}

module.exports = {
  tzStore, currentTimeZone, validTimeZone, DEFAULT_TZ, todayISO, parseISO, toISO, addDays, formatDate, periodFor, currentPeriodRange, nextPeriodRange, periodMatches, monthLabel, MESES };
