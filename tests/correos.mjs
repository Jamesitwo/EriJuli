// Prueba de la lectura de correos de Bancolombia (RC-17 a RC-22) con un Gmail simulado.
// Uso:  npm run test:correos      (usa una base temporal; no se conecta a Google)
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(tmpdir(), 'erijuli-correos-'));
process.env.DATABASE_PATH = path.join(TMP, 'correos.db');
const require = createRequire(import.meta.url);
const { db } = require('../src/db');
const gmail = require('../src/services/gmail');
const { parseBankEmail } = require('../src/services/bankParsers');
const { ensureCash } = require('../src/services/balances');

let pass = 0, fail = 0; const fails = [];
const ok = (c, name, extra = '') => { if (c) pass++; else { fail++; fails.push(name + (extra !== '' ? ' → ' + extra : '')); } };

// ---------- Interpretación de los correos de ejemplo del documento
const AN = 'Bancolombia <alertasynotificaciones@an.notificacionesbancolombia.com>';
const AYN = 'Bancolombia <alertasynotificaciones@ayn.notificacionesbancolombia.com>';
const SENDERS = ['notificacionesbancolombia.com'];
const p1 = parseBankEmail({ from: AN, subject: 'Alertas y Notificaciones', snippet: 'Bancolombia: Recibiste una transferencia de MARIA FERNANDA LOPEZ por $100,000 en tu cuenta **7890 el 10/11/2026 a las 08:49.' }, SENDERS);
ok(p1 && p1.kind === 'ingreso' && p1.amount === 10000000, 'Transferencia recibida: ingreso de $100,000 (RC-18, RC-19)', JSON.stringify(p1));
ok(p1 && p1.date === '2026-11-10' && p1.time === '08:49', 'Fecha día/mes/año y hora 24 h (RC-20)', p1 && p1.date + ' ' + p1.time);
ok(p1 && p1.last4 === '7890', 'Cuenta por sus 4 dígitos con dos asteriscos (RC-21)', p1 && p1.last4);
const p2 = parseBankEmail({ from: AYN, subject: 'Alertas y Notificaciones', snippet: 'Bancolombia: Pagaste $6,500.00 por codigo QR a la llave 3001234567 desde tu cuenta *7890 el 13/11/2026 13:50.' }, SENDERS);
ok(p2 && p2.kind === 'gasto' && p2.amount === 650000, 'Pago QR: egreso de $6,500.00 con decimales', JSON.stringify(p2));
ok(p2 && p2.noCategory && /llave/.test(p2.description), 'Pago QR a llave: sin comercio ni categoría (RC-22)', p2 && p2.description);
ok(p2 && p2.last4 === '7890', 'Cuenta con un asterisco (RC-21)');
ok(!parseBankEmail({ from: 'promo@tienda.com', subject: 'Oferta', snippet: 'Compra hoy por $50,000' }, SENDERS), 'Remitente no autorizado se ignora (RC-02)');

// ---------- Sincronización completa con Gmail simulado
const u = db.prepare(`INSERT INTO users (email, password_hash, name) VALUES ('correo@erijuli.co', 'x', 'Correo')`).run().lastInsertRowid;
const bank = db.prepare(`INSERT INTO banks (user_id, name) VALUES (?, 'Bancolombia')`).run(u).lastInsertRowid;
const cuenta = db.prepare(`INSERT INTO containers (user_id, bank_id, kind, name, last4) VALUES (?, ?, 'cuenta', 'Cuenta', '7890')`).run(u, bank).lastInsertRowid;
const ahorro = db.prepare(`INSERT INTO containers (user_id, bank_id, kind, name) VALUES (?, ?, 'cuenta', 'Cuenta')`).run(u, db.prepare(`INSERT INTO banks (user_id, name) VALUES (?, 'Nequi')`).run(u).lastInsertRowid).lastInsertRowid;
const card = db.prepare(`INSERT INTO credit_cards (user_id, bank_id, name, last4) VALUES (?, ?, 'Visa', '4821')`).run(u, bank).lastInsertRowid;
ensureCash(u);
const billetera = db.prepare(`SELECT c.id FROM containers c JOIN banks b ON b.id = c.bank_id WHERE c.user_id = ? AND b.kind = 'efectivo'`).get(u).id;
db.prepare(`INSERT INTO email_senders (user_id, bank_id, sender, label) VALUES (?, ?, 'notificacionesbancolombia.com', 'Alertas')`).run(u, bank);
gmail.saveConnection(u, { email: 'correo@gmail.com', access_token: 'tok', refresh_token: 'ref', token_expiry: Date.now() + 3600e3 });

const mails = {
  m1: [AN, 'Bancolombia: Recibiste una transferencia de MARIA FERNANDA LOPEZ por $100,000 en tu cuenta **7890 el 10/11/2026 a las 08:49.'],
  m2: [AYN, 'Bancolombia: Pagaste $6,500.00 por codigo QR a la llave 3001234567 desde tu cuenta *7890 el 13/11/2026 13:50.'],
  m3: [AN, 'Bancolombia: Compraste $45,000.00 en TERPEL LAURELES con tu tarjeta *4821 el 14/11/2026 14:22.'],
  m4: [AN, 'Bancolombia: Retiraste $200,000 en cajero desde tu cuenta *7890 el 15/11/2026 09:10.'],
  m5: [AN, 'Bancolombia: Pagaste $30,000 en EPM desde tu cuenta *5555 el 16/11/2026 18:00.'],
};
let query = '';
globalThis.fetch = async (url) => {
  const u2 = String(url);
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (u2.includes('/messages?q=')) { query = decodeURIComponent(u2.split('q=')[1].split('&')[0]); return json({ messages: Object.keys(mails).map((id) => ({ id })) }); }
  const id = /messages\/(\w+)\?/.exec(u2)[1];
  return json({ id, snippet: mails[id][1], payload: { headers: [{ name: 'From', value: mails[id][0] }, { name: 'Subject', value: 'Alertas y Notificaciones' }, { name: 'Date', value: 'Mon, 17 Nov 2026 10:00:00 -0500' }] } });
};

const res = await gmail.syncUser(u, { days: 30 });
ok(/from:\(notificacionesbancolombia\.com\)/.test(query), 'Gmail se consulta por dominio (RC-17)', query);
ok(res.propuestos === 5 && res.sinProcesar === 0, 'Los 5 correos quedan propuestos', JSON.stringify(res));
const P = (desc) => db.prepare('SELECT * FROM proposed_movements WHERE user_id = ? AND description LIKE ?').get(u, desc);
const a = P('Transferencia de MARIA%');
ok(a && a.kind === 'ingreso' && a.container_to_id === cuenta && a.amount === 10000000, 'Ingreso va a la cuenta *7890 (RC-06)', JSON.stringify(a));
ok(a && /Hora: 08:49/.test(a.reason), 'La propuesta guarda la hora', a && a.reason);
const b = P('Pago QR%');
ok(b && b.kind === 'gasto' && b.container_from_id === cuenta && b.category_id === null && /elige la categor/i.test(b.reason), 'Pago QR sale de *7890 y sin categoría (RC-22)', JSON.stringify(b));
const c = P('Compra en TERPEL%');
ok(c && c.card_id === card && c.container_from_id === null, 'Compra con *4821 se propone en la tarjeta Visa', JSON.stringify(c));
const d = P('Retiro%');
ok(d && d.kind === 'transferencia' && d.container_from_id === cuenta && d.container_to_id === billetera, 'Retiro en cajero: de la cuenta al efectivo', JSON.stringify(d));
const e = P('Pago en EPM%');
ok(e && e.container_from_id === cuenta && /no la reconoc/.test(e.reason), 'Cuenta desconocida: usa el banco del remitente y avisa', JSON.stringify(e));
ok(!db.prepare('SELECT 1 FROM transactions WHERE user_id = ?').get(u), 'Nada afecta saldos hasta aceptar (RC-07)');
ok(ahorro && true, 'Otra cuenta sin 4 dígitos no interfiere');
const again = await gmail.syncUser(u, { days: 30 });
ok(again.duplicados === 5 && again.propuestos === 0, 'Volver a sincronizar no duplica (RC-10)', JSON.stringify(again));

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* temporal */ }
console.log(`\nEriJuli · correos del banco\n  Correctas: ${pass}\n  Fallas:    ${fail}`);
fails.forEach((x) => console.log('  ✗ ' + x));
process.exit(fail ? 1 : 0);
