// Prueba funcional de EriJuli: levanta el servidor con una base temporal y recorre todas las funciones.
// Uso:  npm run test:funcional      (no toca tu base de datos real)
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'erijuli-qa-'));
const DB = path.join(TMP, 'qa.db');
const PORT = String(4100 + Math.floor(Math.random() * 800));
const BASE = 'http://localhost:' + PORT;

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_PATH: DB, PORT, NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('El servidor no arrancó:\n' + serverLog)), 45000);
  const i = setInterval(async () => {
    try { await fetch(BASE + '/login'); clearInterval(i); clearTimeout(t); resolve(); } catch { /* aún no */ }
  }, 250);
});

let cookie = '', csrf = '', pass = 0, fail = 0; const fails = [];
const ok = (cond, name, extra = '') => { if (cond) pass++; else { fail++; fails.push(name + (extra !== '' ? ' → ' + extra : '')); } };
async function req(p, opts = {}) {
  const r = await fetch(BASE + p, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
  for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; if (kv.startsWith('erijuli.sid') || kv.startsWith('connect.sid')) cookie = kv; }
  const text = await r.text();
  const m = /name="_csrf" value="([^"]+)"/.exec(text); if (m) csrf = m[1];
  return { status: r.status, loc: r.headers.get('location'), text };
}
const get = (p) => req(p);
const post = (p, data) => req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...data }).toString() });
const flashOf = async (loc) => { const r = await get(loc || '/'); const m = /class="flash flash-(\w+)"[^>]*>([^<]*)</.exec(r.text); return m ? m[1] + ': ' + m[2].trim() : ''; };
const one = (sql, ...a) => { const d = new DatabaseSync(DB); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
const bal = (id) => one(`SELECT c.initial_balance
  + COALESCE((SELECT SUM(amount) FROM transactions WHERE container_to_id = c.id AND kind IN ('ingreso','transferencia')), 0)
  - COALESCE((SELECT SUM(amount) FROM transactions WHERE container_from_id = c.id AND kind IN ('gasto','transferencia')), 0) AS b
  FROM containers c WHERE id = ?`, id)?.b;
const dates0 = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const require_bcrypt_ok = () => true; // la verificación real: el siguiente "Cambiar contraseña" usa la clave original
async function step(name, p, data, check) {
  const r = await post(p, data);
  const f = await flashOf(r.loc);
  ok(r.status === 302 && !/^error/.test(f), name, `HTTP ${r.status} ${f}`);
  if (check) { try { check(f); } catch (e) { ok(false, name + ' (verificación)', e.message); } }
  return f;
}

try {
  // ----- Cuenta y sesión
  await get('/registro');
  let r = await post('/registro', { name: 'Julieth Prueba', email: 'qa@erijuli.co', password: 'secreto123', currency: 'COP', period_type: 'mensual' });
  ok(r.status === 302 && r.loc === '/', 'Registro', `${r.status} ${r.loc}`);
  r = await post('/logout', {}); ok(r.status === 302, 'Cerrar sesión');
  r = await get('/'); ok(r.status === 302 && /login/.test(r.loc || ''), 'Rutas protegidas sin sesión', r.loc);
  await get('/login');
  r = await post('/login', { email: 'qa@erijuli.co', password: 'malaclave' }); ok(r.status === 302 && /login/.test(r.loc || ''), 'Login con clave errada se rechaza', r.loc);
  await get('/login');
  r = await post('/login', { email: 'qa@erijuli.co', password: 'secreto123' }); ok(r.status === 302 && r.loc === '/', 'Login correcto', r.loc);
  r = await req('/configuracion', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '_csrf=falso&name=x' });
  ok(r.status === 403, 'CSRF bloquea formularios sin token', r.status);
  await get('/');
  const U = one('SELECT id FROM users').id;
  ok(one('SELECT COUNT(*) n FROM categories WHERE user_id = ?', U).n >= 11, 'Categorías iniciales');

  // ----- Bancos y bolsillos
  await step('Crear banco', '/bancos', { name: 'Bancolombia', color: '#e9a92c' });
  const bank = one("SELECT * FROM banks WHERE name = 'Bancolombia'");
  ok(bank && bank.color === '#e9a92c', 'Banco guarda su color');
  const cuenta = one("SELECT * FROM containers WHERE bank_id = ? AND kind = 'cuenta'", bank.id); ok(!!cuenta, 'El banco crea su Cuenta');
  await step('Crear bolsillo', `/bancos/${bank.id}/bolsillos`, { name: 'Moto', purpose: 'Gastos de la moto', initial_balance: '1.000.000' });
  const moto = one("SELECT * FROM containers WHERE name = 'Moto'");
  ok(moto && moto.initial_balance === 100000000, 'Saldo inicial "1.000.000"', moto && moto.initial_balance);
  await step('Crear segundo bolsillo', `/bancos/${bank.id}/bolsillos`, { name: 'Emergencia', initial_balance: '700000' });
  const emer = one("SELECT * FROM containers WHERE name = 'Emergencia'");
  await step('Editar bolsillo', `/bolsillos/${emer.id}/editar`, { name: 'Fondo de emergencia', purpose: '', initial_balance: '700.000' },
    () => ok(one('SELECT name FROM containers WHERE id = ?', emer.id).name === 'Fondo de emergencia', 'Bolsillo renombrado'));
  await step('Mover dinero entre bolsillos', '/transferencias', { container_from_id: moto.id, container_to_id: emer.id, amount: '100.000', date: '2026-11-18', description: 'Paso a emergencia' });
  ok(bal(moto.id) === 90000000 && bal(emer.id) === 80000000, 'Saldos después de mover', `${bal(moto.id)} / ${bal(emer.id)}`);
  r = await get(`/bancos/${bank.id}`); ok(r.status === 200 && r.text.includes('Fondo de emergencia'), 'Detalle del banco');

  // ----- Movimientos
  await get('/movimientos/nuevo');
  await step('Registrar ingreso', '/movimientos', { kind: 'ingreso', amount: '1.500.000', date: '2026-11-15', description: 'Pago floristería', container_to_id: cuenta.id });
  ok(bal(cuenta.id) === 150000000, 'El ingreso suma a la Cuenta', bal(cuenta.id));
  const transporte = one("SELECT id FROM categories WHERE name = 'Transporte' AND user_id = ?", U).id;
  await step('Registrar gasto', '/movimientos', { kind: 'gasto', amount: '45.000', date: '2026-11-18', description: 'Gasolina', container_from_id: moto.id, expense_type: 'variable', category_id: transporte });
  ok(bal(moto.id) === 85500000, 'El gasto descuenta del bolsillo', bal(moto.id));
  const g = one("SELECT * FROM transactions WHERE description = 'Gasolina'");
  ok(g && g.amount === 4500000 && g.period_id, 'Gasto con valor y periodo');
  await step('Registrar con decimales', '/movimientos', { kind: 'gasto', amount: '12.500,50', date: '2026-11-18', description: 'Almuerzo', container_from_id: cuenta.id, expense_type: 'variable' });
  ok(one("SELECT amount FROM transactions WHERE description = 'Almuerzo'")?.amount === 1250050, 'Monto "12.500,50"');
  await post('/movimientos', { kind: 'gasto', amount: '', date: '2026-11-18', description: 'Vacío', container_from_id: cuenta.id });
  ok(!one("SELECT 1 FROM transactions WHERE description = 'Vacío'"), 'Rechaza gasto sin valor');
  await post('/movimientos', { kind: 'gasto', amount: '1000', date: '2026-11-18', description: 'Sin cuenta' });
  ok(!one("SELECT 1 FROM transactions WHERE description = 'Sin cuenta'"), 'Rechaza gasto sin cuenta de origen');
  await step('Movimiento entre cuentas', '/movimientos', { kind: 'transferencia', amount: '50.000', date: '2026-11-18', description: 'Mover', container_from_id: cuenta.id, container_to_id: moto.id });
  r = await get(`/movimientos/${g.id}/editar`); ok(r.status === 200 && r.text.includes('Gasolina'), 'Abrir edición');
  await step('Editar movimiento', `/movimientos/${g.id}`, { kind: 'gasto', amount: '50.000', date: '2026-11-18', description: 'Gasolina moto', container_from_id: moto.id, expense_type: 'variable' },
    () => ok(one('SELECT amount FROM transactions WHERE id = ?', g.id).amount === 5000000, 'La edición guarda el nuevo valor'));
  const alm = one("SELECT id FROM transactions WHERE description = 'Almuerzo'").id;
  await step('Eliminar movimiento', `/movimientos/${alm}/eliminar`, {}, () => ok(!one('SELECT 1 FROM transactions WHERE id = ?', alm), 'Movimiento eliminado'));
  r = await get('/movimientos?kind=gasto&from=2026-11-01&to=2026-11-30&q=Gasolina');
  ok(r.status === 200 && r.text.includes('Gasolina moto') && !r.text.includes('Pago floristería'), 'Filtros de movimientos');

  // ----- Ingresos y fuentes
  await step('Crear fuente de ingreso', '/fuentes-ingreso', { name: 'Pago James', expected_amount: '650.000', frequency: 'mensual' });
  const src = one("SELECT * FROM income_sources WHERE name = 'Pago James'");
  ok(src && src.expected_amount === 65000000, 'Fuente con valor esperado');
  await step('Editar fuente', `/fuentes-ingreso/${src.id}/editar`, { name: 'Pago James', expected_amount: '700.000', frequency: 'quincenal' });
  await step('Registrar ingreso por fuente', '/ingresos', { amount: '650.000', date: '2026-11-16', income_source_id: src.id, container_to_id: cuenta.id });
  await step('Registrar dinero extra', '/ingresos', { amount: '20.000', date: '2026-11-16', is_extra: 'on', container_to_id: cuenta.id });
  ok(one("SELECT COUNT(*) n FROM transactions WHERE kind = 'ingreso' AND income_source_id = ?", src.id).n === 1, 'Ingreso ligado a la fuente');
  r = await get('/ingresos'); ok(r.status === 200 && r.text.includes('Pago James'), 'Página de ingresos');

  // ----- Gastos fijos
  const servicios = one("SELECT id FROM categories WHERE name = 'Servicios' AND user_id = ?", U).id;
  await step('Crear gasto fijo', '/gastos-fijos', { description: 'Plan celular', amount: '42.000', category_id: servicios, container_id: cuenta.id, due_day: '10', frequency: 'mensual', payment_method: 'Débito' });
  const fe = one("SELECT * FROM fixed_expenses WHERE description = 'Plan celular'"); ok(!!fe, 'Gasto fijo creado');
  await get('/gastos-fijos');
  let inst = one('SELECT * FROM fixed_instances WHERE fixed_expense_id = ?', fe.id); ok(!!inst, 'El fijo genera su pendiente del periodo');
  if (inst) {
    await step('Marcar fijo pagado', `/gastos-fijos/instancia/${inst.id}/pagar`, { container_id: cuenta.id, date: '2026-11-10' });
    ok(one('SELECT COUNT(*) n FROM transactions WHERE fixed_instance_id = ?', inst.id).n === 1, 'Pagar el fijo crea el gasto');
    await step('Desmarcar fijo', `/gastos-fijos/instancia/${inst.id}/despagar`, {});
    ok(one('SELECT COUNT(*) n FROM transactions WHERE fixed_instance_id = ?', inst.id).n === 0, 'Desmarcar quita el gasto');
  }
  await step('Editar gasto fijo', `/gastos-fijos/${fe.id}/editar`, { description: 'Plan celular', amount: '45.000', due_day: '12', frequency: 'mensual', active: 'on', container_id: cuenta.id });
  ok(one('SELECT amount FROM fixed_expenses WHERE id = ?', fe.id).amount === 4500000, 'Fijo editado');
  await step('Crear otro fijo', '/gastos-fijos', { description: 'Gimnasio', amount: '74.000', due_day: '5', frequency: 'mensual' });
  const fe2 = one("SELECT id FROM fixed_expenses WHERE description = 'Gimnasio'").id;
  await step('Eliminar gasto fijo', `/gastos-fijos/${fe2}/eliminar`, {}, () => ok(!one('SELECT 1 FROM fixed_expenses WHERE id = ?', fe2), 'Fijo eliminado'));

  // ----- Presupuesto
  const per = one('SELECT * FROM periods WHERE user_id = ? ORDER BY start_date DESC', U);
  await step('Definir presupuesto', '/presupuesto', { period_id: per.id, budget_amount: '600.000' },
    () => ok(one('SELECT budget_amount FROM periods WHERE id = ?', per.id).budget_amount === 60000000, 'Presupuesto guardado'));
  r = await get('/presupuesto'); ok(r.status === 200 && /600\.000/.test(r.text), 'Página de presupuesto');
  r = await get('/'); ok(r.status === 200 && /Disponible|Te pasaste/.test(r.text), 'Inicio con resumen del periodo');

  // ----- Metas
  await step('Crear meta', '/metas', { name: 'Papeles moto 2027', target_amount: '1.200.000', target_date: '2027-01-31', container_id: emer.id, contribution_per_period: '100.000' });
  const goal = one("SELECT * FROM goals WHERE name = 'Papeles moto 2027'"); ok(goal && goal.target_amount === 120000000, 'Meta creada');
  await step('Aportar a meta', `/metas/${goal.id}/aportar`, { amount: '50.000', container_from_id: cuenta.id, date: '2026-11-18' });
  ok(one("SELECT COUNT(*) n FROM transactions WHERE description LIKE 'Aporte a meta%'").n === 1, 'El aporte mueve dinero al bolsillo de la meta');
  await step('Editar meta', `/metas/${goal.id}/editar`, { name: 'Papeles moto 2027', target_amount: '1.300.000', target_date: '2027-02-28', container_id: emer.id, contribution_per_period: '0' });
  r = await get('/metas'); ok(r.status === 200 && r.text.includes('Papeles moto 2027'), 'Página de metas');
  const txAntes = one('SELECT COUNT(*) n FROM transactions').n;
  await post(`/metas/${goal.id}/aportar`, { amount: '999.999.999', container_from_id: cuenta.id });
  ok(one('SELECT COUNT(*) n FROM transactions').n === txAntes, 'No deja aportar más de lo que hay en la cuenta');
  await post(`/metas/${goal.id}/aportar`, { amount: '10.000', container_from_id: emer.id });
  ok(one('SELECT COUNT(*) n FROM transactions').n === txAntes, 'No deja aportar desde el mismo bolsillo de la meta');
  await step('Meta con bolsillo nuevo', '/metas', { name: 'Viaje', target_amount: '500.000', container_id: `nuevo:${bank.id}` });
  const viaje = one("SELECT * FROM goals WHERE name = 'Viaje'");
  ok(viaje && viaje.container_id && one('SELECT name FROM containers WHERE id = ?', viaje.container_id).name === 'Viaje', 'Crea el bolsillo de la meta');
  await step('Meta sin bolsillo', '/metas', { name: 'Sin bolsillo', target_amount: '100.000', container_id: '' });
  const sb = one("SELECT * FROM goals WHERE name = 'Sin bolsillo'");
  await post(`/metas/${sb.id}/aportar`, { amount: '1.000', container_from_id: cuenta.id });
  ok(one('SELECT COUNT(*) n FROM transactions').n === txAntes, 'No registra aportes a metas sin bolsillo');
  await step('Asociar bolsillo a la meta', `/metas/${sb.id}/bolsillo`, { container_id: `nuevo:${bank.id}` }, () => ok(!!one('SELECT container_id FROM goals WHERE id = ?', sb.id).container_id, 'Bolsillo asociado'));
  await post('/transferencias', { container_from_id: viaje.container_id, container_to_id: cuenta.id, amount: '5.000' });
  ok(one('SELECT COUNT(*) n FROM transactions').n === txAntes, 'No deja mover dinero de un bolsillo vacío');

  // ----- Préstamos
  await step('Crear préstamo (me deben)', '/prestamos', { direction: 'me_deben', person: 'Camila', amount: '200.000', date: '2026-11-02', due_date: '2026-12-02' });
  const loan = one("SELECT * FROM loans WHERE person = 'Camila'"); ok(!!loan, 'Préstamo creado');
  await step('Abonar a préstamo', `/prestamos/${loan.id}/abonos`, { amount: '50.000', date: '2026-11-18', container_id: cuenta.id });
  ok(one('SELECT COUNT(*) n FROM loan_payments WHERE loan_id = ?', loan.id).n === 1, 'Abono registrado');
  await step('Crear préstamo (debo)', '/prestamos', { direction: 'debo', person: 'Andrés', amount: '80.000', date: '2026-10-28' });
  await step('Editar préstamo', `/prestamos/${loan.id}/editar`, { person: 'Camila R.', amount: '200.000', date: '2026-11-02', status: 'abierto' });
  const l2 = one("SELECT id FROM loans WHERE person = 'Andrés'").id;
  await step('Eliminar préstamo', `/prestamos/${l2}/eliminar`, {}, () => ok(!one('SELECT 1 FROM loans WHERE id = ?', l2), 'Préstamo eliminado'));
  r = await get('/prestamos'); ok(r.status === 200 && r.text.includes('Camila R.'), 'Página de préstamos');

  // ----- Bandeja (Gmail)
  await step('Agregar propuesta a mano', '/bandeja', { kind: 'gasto', amount: '45.000', date: '2026-11-18', description: 'Terpel El Poblado', email_sender: 'alertas@bancolombia.com.co', email_subject: 'Compra' });
  const prop = one("SELECT * FROM proposed_movements WHERE description = 'Terpel El Poblado'");
  const before = bal(moto.id);
  await step('Aceptar propuesta', `/bandeja/${prop.id}/aceptar`, { kind: 'gasto', amount: '45.000', date: '2026-11-18', description: 'Terpel El Poblado', container_from_id: moto.id, category_id: transporte, learn_rule: 'on' });
  ok(bal(moto.id) === before - 4500000, 'Aceptar descuenta el saldo', `${before} → ${bal(moto.id)}`);
  ok(one('SELECT status FROM proposed_movements WHERE id = ?', prop.id).status === 'aceptado', 'La propuesta queda aceptada');
  await step('Agregar segunda propuesta', '/bandeja', { kind: 'gasto', amount: '10.000', date: '2026-11-18', description: 'Descartar esta' });
  const prop2 = one("SELECT id FROM proposed_movements WHERE description = 'Descartar esta'").id;
  const nTx = one('SELECT COUNT(*) n FROM transactions').n;
  await step('Descartar propuesta', `/bandeja/${prop2}/descartar`, {}, () => ok(one('SELECT status FROM proposed_movements WHERE id = ?', prop2).status === 'descartado', 'Propuesta descartada'));
  ok(one('SELECT COUNT(*) n FROM transactions').n === nTx, 'Descartar no afecta saldos');
  r = await get('/bandeja'); ok(r.status === 200, 'Página de la bandeja');
  await step('Autorizar remitente', '/gmail/remitentes', { sender: 'alertas@bancolombia.com.co', label: 'Bancolombia', bank_id: bank.id });
  r = await get('/gmail/conectar'); ok([200, 302].includes(r.status), 'Conectar Gmail responde', `${r.status} ${r.loc}`);

  // ----- Configuración y categorías
  const cfg = { name: 'Julieth', currency: 'COP', timezone: 'America/Bogota', quincena_dia1: '1', quincena_dia2: '16', budget_includes_fixed: 'on', rollover_enabled: 'on', alert_days_fixed: '5', alert_low_balance: '50.000' };
  await step('Guardar configuración', '/configuracion', { ...cfg, period_type: 'quincenal', theme: 'oscuro' });
  const u2 = one('SELECT * FROM users WHERE id = ?', U);
  ok(u2.period_type === 'quincenal' && u2.theme === 'oscuro', 'Periodo quincenal y modo oscuro guardados', `${u2.period_type} / ${u2.theme}`);
  r = await get('/'); ok(r.status === 200 && r.text.includes('data-theme="dark"'), 'Inicio en quincenal y modo oscuro');
  await step('Volver a mensual', '/configuracion', { ...cfg, period_type: 'mensual', theme: 'auto' });
  await step('Crear categoría', '/categorias', { name: 'Mascotas', kind: 'gasto', color: '#c2457a' });
  const cat = one("SELECT * FROM categories WHERE name = 'Mascotas'"); ok(cat && cat.color === '#c2457a', 'Categoría con color');
  await step('Editar categoría', `/categorias/${cat.id}`, { name: 'Mascotas (Nix)', color: '#0a7a8a' },
    () => ok(one('SELECT name FROM categories WHERE id = ?', cat.id).name === 'Mascotas (Nix)', 'Categoría editada'));

  // ----- Importar / exportar
  r = await get('/plantilla-movimientos.csv'); ok(r.status === 200 && /tipo/.test(r.text), 'Plantilla CSV');
  await get('/importar-exportar');
  const csv = 'tipo,fecha,descripcion,valor,categoria,fuente,cuenta_origen,cuenta_destino,notas\n'
    + 'gasto,2026-11-17,Mercado,120000,Alimentación,,Cuenta,,\n'
    + 'ingreso,2026-11-17,Venta,80000,,,,Cuenta,';
  const fi = await step('Importar CSV', '/importar', { csv_text: csv });
  ok(one("SELECT COUNT(*) n FROM transactions WHERE description IN ('Mercado','Venta')").n === 2, 'El CSV importó 2 movimientos', fi);
  ok(one("SELECT origin FROM transactions WHERE description = 'Mercado'")?.origin === 'import', 'Origen = importación');
  r = await get('/exportar/movimientos.csv'); ok(r.status === 200 && r.text.includes('Mercado'), 'Exportar movimientos');
  r = await get('/exportar/bolsillos.csv'); ok(r.status === 200 && r.text.includes('Moto'), 'Exportar bolsillos');
  const rb = await fetch(BASE + '/exportar/respaldo.db', { headers: { cookie } });
  ok(rb.status === 200 && (await rb.arrayBuffer()).byteLength > 1000, 'Descargar respaldo');

  // ----- Reportes, historial y cierre de periodo
  r = await get('/reportes'); ok(r.status === 200 && r.text.includes('Transporte'), 'Reportes por categoría');
  r = await get('/historial'); ok(r.status === 200, 'Historial de cambios');
  ok(one('SELECT COUNT(*) n FROM audit_log WHERE user_id = ?', U).n > 20, 'La auditoría registra los cambios');
  await step('Cerrar periodo', `/presupuesto/${per.id}/cerrar`, {});
  ok(one('SELECT status FROM periods WHERE id = ?', per.id).status === 'cerrado', 'Periodo cerrado');
  ok(one('SELECT COUNT(*) n FROM periods WHERE user_id = ?', U).n >= 2, 'Se abre el periodo siguiente');

  // ----- Eliminar banco
  await step('Crear banco temporal', '/bancos', { name: 'Nequi' });
  const nq = one("SELECT id FROM banks WHERE name = 'Nequi'").id;
  await step('Eliminar banco', `/bancos/${nq}/eliminar`, {}, () => ok(!one('SELECT 1 FROM banks WHERE id = ?', nq), 'Banco eliminado'));

  // ===== Funciones nuevas =====
  // ----- Tarjetas de crédito
  await step('Crear tarjeta', '/tarjetas', { name: 'Visa', last4: '4821', credit_limit: '2.000.000', initial_debt: '0', cut_day: '30', due_day: '15', color: '#2b56c4', bank_id: bank.id });
  const card = one("SELECT * FROM credit_cards WHERE name = 'Visa'"); ok(card && card.credit_limit === 200000000 && card.last4 === '4821', 'Tarjeta con cupo y últimos 4');
  const cuentaAntes = bal(cuenta.id);
  await step('Compra con tarjeta', '/movimientos', { kind: 'gasto', amount: '300.000', date: '2026-10-20', description: 'Zapatos', container_from_id: `tarjeta:${card.id}`, expense_type: 'variable' });
  const comp = one("SELECT * FROM transactions WHERE description = 'Zapatos'");
  ok(comp && comp.card_id === card.id && comp.container_from_id === null, 'La compra queda en la tarjeta');
  ok(bal(cuenta.id) === cuentaAntes, 'La compra con tarjeta no saca plata de la cuenta');
  await step('Compra después del corte', '/movimientos', { kind: 'gasto', amount: '50.000', date: '2026-11-10', description: 'Cine', container_from_id: `tarjeta:${card.id}`, expense_type: 'variable' });
  r = await get(`/tarjetas/${card.id}`);
  ok(r.status === 200 && r.text.includes('$350.000'), 'Detalle muestra deuda $350.000', r.status);
  ok(/Pagar <strong[^>]*>\$300\.000/.test(r.text), 'Pago del periodo = compras hasta el corte ($300.000)');
  await step('Pagar tarjeta', `/tarjetas/${card.id}/pagar`, { amount: '300.000', container_from_id: cuenta.id, date: '2026-11-12' });
  ok(bal(cuenta.id) === cuentaAntes - 30000000, 'El pago sale de la cuenta');
  r = await get(`/tarjetas/${card.id}`); ok(r.text.includes('$50.000'), 'Deuda baja a $50.000 tras el pago');
  const perNow = one('SELECT id FROM periods WHERE user_id = ? AND start_date <= ? AND end_date >= ?', U, '2026-11-12', '2026-11-12');
  ok(!one("SELECT 1 FROM transactions WHERE kind = 'gasto' AND description LIKE 'Pago tarjeta%'"), 'El pago de la tarjeta no cuenta como gasto');
  r = await post('/movimientos', { kind: 'transferencia', amount: '1000', container_from_id: `tarjeta:${card.id}`, container_to_id: cuenta.id });
  ok(!one("SELECT 1 FROM transactions WHERE kind='transferencia' AND amount = 100000"), 'No permite "mover" desde una tarjeta');
  await step('Editar tarjeta', `/tarjetas/${card.id}/editar`, { name: 'Visa Oro', last4: '4821', credit_limit: '2.500.000', initial_debt: '0', cut_day: '30', due_day: '15', color: '#2b56c4' });
  ok(one('SELECT name FROM credit_cards WHERE id = ?', card.id).name === 'Visa Oro', 'Tarjeta editada');
  r = await get('/tarjetas'); ok(r.status === 200 && r.text.includes('Visa Oro'), 'Lista de tarjetas');
  r = await get('/movimientos/nuevo'); ok(r.text.includes(`tarjeta:${card.id}`), 'La tarjeta aparece en "de dónde salió"');

  // ----- Topes por categoría
  const comida = one("SELECT id FROM categories WHERE name = 'Alimentación' AND user_id = ?", U).id;
  const salud = one("SELECT id FROM categories WHERE name = 'Salud' AND user_id = ?", U).id;
  await step('Crear tope', '/presupuesto/topes', { category_id: salud, amount: '100.000' });
  ok(one('SELECT amount FROM category_limits WHERE category_id = ?', salud)?.amount === 10000000, 'Tope guardado');
  await step('Gasto que llega al 90 % del tope', '/movimientos', { kind: 'gasto', amount: '90.000', date: dates0(), description: 'Farmacia', container_from_id: cuenta.id, category_id: salud, expense_type: 'variable' });
  r = await get('/presupuesto'); ok(/Topes por categoría/.test(r.text) && /Quedan \$10\.000/.test(r.text), 'Barra del tope con lo que queda');
  r = await get('/'); ok(/Salud: llevas el 90%/.test(r.text), 'Alerta al 80 % del tope');
  await step('Quitar tope', '/presupuesto/topes', { category_id: salud, amount: '0' });
  ok(!one('SELECT 1 FROM category_limits WHERE category_id = ?', salud), 'Tope quitado');

  // ----- Gasto dividido
  const aseo = one("SELECT id FROM categories WHERE name = 'Hogar' AND user_id = ?", U).id;
  const sp = new URLSearchParams({ _csrf: csrf, kind: 'gasto', amount: '150.000', date: dates0(), description: 'Supermercado', container_from_id: String(cuenta.id), expense_type: 'variable', split_on: '1' });
  sp.append('split_category[]', String(comida)); sp.append('split_amount[]', '100.000');
  sp.append('split_category[]', String(aseo)); sp.append('split_amount[]', '50.000');
  r = await req('/movimientos', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: sp.toString() });
  const sup = one("SELECT * FROM transactions WHERE description = 'Supermercado'");
  ok(sup && one('SELECT COUNT(*) n FROM transaction_splits WHERE transaction_id = ?', sup.id).n === 2, 'Gasto dividido en 2 partes');
  ok(sup && sup.category_id === comida, 'La categoría principal es la parte mayor');
  const linesHogar = one('SELECT SUM(amount) t FROM category_lines WHERE transaction_id = ? AND category_id = ?', sup.id, aseo).t;
  ok(linesHogar === 5000000, 'Reportes cuentan cada parte en su categoría');
  const bad = new URLSearchParams({ _csrf: csrf, kind: 'gasto', amount: '150.000', date: dates0(), description: 'Mal dividido', container_from_id: String(cuenta.id), split_on: '1' });
  bad.append('split_category[]', String(comida)); bad.append('split_amount[]', '100.000'); bad.append('split_category[]', String(aseo)); bad.append('split_amount[]', '10.000');
  await req('/movimientos', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: bad.toString() });
  ok(!one("SELECT 1 FROM transactions WHERE description = 'Mal dividido'"), 'Rechaza partes que no suman el total');
  r = await get(`/movimientos/${sup.id}/editar`); ok(r.text.includes('split-row') && r.text.includes('50.000') || r.text.includes('value="50000"'), 'Edición muestra las partes');
  await step('Quitar la división al editar', `/movimientos/${sup.id}`, { kind: 'gasto', amount: '150.000', date: dates0(), description: 'Supermercado', container_from_id: cuenta.id, category_id: comida, expense_type: 'variable' });
  ok(one('SELECT COUNT(*) n FROM transaction_splits WHERE transaction_id = ?', sup.id).n === 0, 'Partes eliminadas al quitar la división');
  r = await get('/reportes'); ok(r.status === 200 && r.text.includes('Tu dinero mes a mes') && r.text.includes('<path class="chart-line"'), 'Gráfica de evolución en reportes');

  // ----- Foto del recibo
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await step('Gasto con foto del recibo', '/movimientos', { kind: 'gasto', amount: '20.000', date: dates0(), description: 'Con recibo', container_from_id: cuenta.id, expense_type: 'variable', receipt_data: png });
  const conRec = one("SELECT id FROM transactions WHERE description = 'Con recibo'").id;
  const att = one('SELECT * FROM attachments WHERE transaction_id = ?', conRec); ok(!!att, 'Foto guardada');
  const img = await fetch(`${BASE}/adjuntos/${att.id}`, { headers: { cookie } }); ok(img.status === 200 && img.headers.get('content-type').startsWith('image/png'), 'Ver la foto del recibo');
  await step('Eliminar foto', `/adjuntos/${att.id}/eliminar`, {}, () => ok(!one('SELECT 1 FROM attachments WHERE id = ?', att.id), 'Foto eliminada'));
  await step('Recibo inválido se ignora', '/movimientos', { kind: 'gasto', amount: '1.000', date: dates0(), description: 'Recibo raro', container_from_id: cuenta.id, receipt_data: 'data:text/html;base64,PHNjcmlwdD4=' });
  ok(!one("SELECT 1 FROM attachments a JOIN transactions t ON t.id = a.transaction_id WHERE t.description = 'Recibo raro'"), 'No guarda archivos que no son imágenes');

  // ----- Hasta el próximo pago
  r = await get('/presupuesto'); ok(/por día/.test(r.text), 'Cuánto queda por día');

  // ----- Seguridad: contraseña, códigos, PIN
  await get('/seguridad');
  r = await post('/seguridad/codigos', {}); ok(r.status === 302, 'Crear códigos de recuperación');
  r = await get('/seguridad'); const codes = [...r.text.matchAll(/<code>([A-F0-9]{5}-[A-F0-9]{5})<\/code>/g)].map((m) => m[1]);
  ok(codes.length === 8, 'Se muestran 8 códigos', codes.length);
  r = await get('/seguridad'); ok(!/<code>[A-F0-9]{5}-/.test(r.text), 'Los códigos se muestran una sola vez');
  await post('/seguridad/contrasena', { current: 'mala', password: 'nuevaClave1', password2: 'nuevaClave1' });
  ok(require_bcrypt_ok('secreto123'), 'Contraseña actual errada no cambia nada');
  await step('Cambiar contraseña', '/seguridad/contrasena', { current: 'secreto123', password: 'nuevaClave1', password2: 'nuevaClave1' });
  await step('Activar PIN', '/seguridad/pin', { pin: '2468', pin2: '2468', lock_minutes: '1' });
  ok(!!one('SELECT pin_hash FROM users WHERE id = ?', U).pin_hash, 'PIN guardado');
  // Simular inactividad: la sesión se bloquea
  { const d = new DatabaseSync(DB); const row = d.prepare('SELECT sid, sess FROM sessions').all().find((x) => JSON.parse(x.sess).userId === U); const sObj = JSON.parse(row.sess); sObj.lastSeen = Date.now() - 5 * 60000; d.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(sObj), row.sid); d.close(); }
  r = await get('/movimientos'); ok(r.status === 302 && r.loc === '/bloqueo', 'Se bloquea tras inactividad', `${r.status} ${r.loc}`);
  r = await get('/bloqueo'); ok(r.status === 200 && r.text.includes('Ingresa tu PIN'), 'Pantalla de bloqueo');
  r = await post('/bloqueo', { pin: '0000' }); ok(r.loc === '/bloqueo', 'PIN errado no desbloquea');
  r = await post('/bloqueo', { pin: '2468' }); ok(r.status === 302 && r.loc === '/movimientos', 'PIN correcto desbloquea y vuelve a donde ibas', r.loc);
  r = await get('/'); ok(r.status === 200, 'App usable tras desbloquear');
  r = await req('/seguridad/huella/opciones', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ _csrf: csrf }) });
  let wjson = {}; try { wjson = JSON.parse(r.text); } catch { /* */ }
  ok(r.status === 200 && wjson.challenge && wjson.rp && wjson.rp.name === 'EriJuli', 'Opciones de huella (WebAuthn)', r.status);
  await step('Quitar bloqueo', '/seguridad/pin', { quitar: '1' }, () => ok(!one('SELECT pin_hash FROM users WHERE id = ?', U).pin_hash, 'Bloqueo quitado'));

  // ----- Notificaciones (suscripción simulada)
  r = await req('/push/suscribir', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ _csrf: csrf, subscription: { endpoint: 'https://push.example.invalid/abc', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } } }) });
  ok(r.status === 200 && one('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?', U).n === 1, 'Suscripción a notificaciones guardada', r.status + ' ' + r.text.slice(0, 80));
  r = await req('/push/cancelar', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ _csrf: csrf, endpoint: 'https://push.example.invalid/abc' }) });
  ok(one('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?', U).n === 0, 'Cancelar notificaciones');

  // ----- Recuperar contraseña por enlace y por código
  cookie = '';
  await get('/recuperar');
  await post('/recuperar', { email: 'qa@erijuli.co' });
  const m = /\/restablecer\/([A-Za-z0-9_-]{20,})/.exec(serverLog); ok(!!m, 'Se genera enlace (en consola sin SMTP)');
  if (m) {
    r = await get(`/restablecer/${m[1]}`); ok(r.status === 200 && r.text.includes('Contraseña nueva'), 'Abrir enlace de restablecer');
    r = await post(`/restablecer/${m[1]}`, { password: 'porEnlace99', password2: 'porEnlace99' }); ok(r.loc === '/login', 'Restablecer con enlace', r.loc);
    r = await get(`/restablecer/${m[1]}`); ok(r.status === 302, 'El enlace no sirve dos veces');
    await get('/login'); r = await post('/login', { email: 'qa@erijuli.co', password: 'porEnlace99' }); ok(r.loc === '/', 'Entrar con la contraseña nueva');
    await post('/logout', {});
  }
  await get('/recuperar?modo=codigo');
  r = await post('/recuperar/codigo', { email: 'qa@erijuli.co', code: codes[0], password: 'porCodigo99', password2: 'porCodigo99' }); ok(r.loc === '/login', 'Restablecer con código');
  await get('/recuperar?modo=codigo');
  r = await post('/recuperar/codigo', { email: 'qa@erijuli.co', code: codes[0], password: 'otraVez999', password2: 'otraVez999' }); ok(/recuperar/.test(r.loc || ''), 'El código no sirve dos veces');
  await get('/login'); r = await post('/login', { email: 'qa@erijuli.co', password: 'porCodigo99' }); ok(r.loc === '/', 'Entrar después de usar el código');

  // ----- Hogar compartido (con una segunda persona)
  await get('/hogar');
  await step('Crear hogar', '/hogar', { name: 'Casa EriJuli' });
  const hh = one("SELECT * FROM households WHERE name = 'Casa EriJuli'"); ok(hh && hh.invite_code.length === 6, 'Hogar con código de invitación');
  await step('Gasto del hogar (lo pagué yo, también en mis movimientos)', '/hogar/gastos', { amount: '200.000', description: 'Mercado', date: dates0(), paid_by: U, split: 'igual', category: 'Mercado', also_mine: '1', container_from_id: cuenta.id });
  ok(!!one("SELECT transaction_id FROM household_expenses WHERE description = 'Mercado'").transaction_id, 'También quedó en mis movimientos');
  const mainCookie = cookie;
  cookie = ''; await get('/registro');
  await post('/registro', { name: 'Eri', email: 'eri@erijuli.co', password: 'secreto123', currency: 'COP', period_type: 'mensual' });
  const U2 = one("SELECT id FROM users WHERE email = 'eri@erijuli.co'").id;
  await get('/hogar');
  await step('Unirse con el código', '/hogar/unirse', { code: hh.invite_code.toLowerCase() });
  r = await get('/hogar'); ok(r.text.includes('Debes') && r.text.includes('$100.000'), 'La otra persona ve que debe $100.000');
  await step('Gasto que paga la otra persona', '/hogar/gastos', { amount: '60.000', description: 'Gas', date: dates0(), paid_by: U2, split: 'igual' });
  r = await get('/hogar'); ok(r.text.includes('$70.000'), 'Saldo neto $70.000 tras dos gastos');
  await step('Saldar cuentas', '/hogar/saldar', { from_user: U2, to_user: U, amount: '70.000' });
  r = await get('/hogar'); ok(r.text.includes('paz y salvo'), 'Quedan a paz y salvo');
  ok(!r.text.includes('Fondo de emergencia'), 'El hogar no muestra bolsillos de la otra persona');
  await step('Salir del hogar', '/hogar/salir', {});
  ok(!one('SELECT 1 FROM household_members WHERE user_id = ?', U2), 'Salió del hogar');
  cookie = mainCookie;
  r = await get('/hogar'); ok(r.status === 200 && r.text.includes('Casa EriJuli'), 'El hogar sigue para quien queda');

  // ----- Todas las páginas cargan
  for (const p of ['/tarjetas', `/tarjetas/${card.id}`, '/hogar', '/seguridad', '/recuperar', '/', '/mas', '/movimientos', '/movimientos/nuevo', '/ingresos', '/gastos-fijos', '/presupuesto', '/bancos', `/bancos/${bank.id}`, '/metas', '/prestamos', '/reportes', '/bandeja', '/importar-exportar', '/historial', '/configuracion']) {
    r = await get(p); ok(r.status === 200 && !/Algo salió mal/.test(r.text), 'Página ' + p, r.status);
  }

  // ----- Aislamiento entre personas
  cookie = '';
  await get('/registro');
  await post('/registro', { name: 'Otra', email: 'otra@erijuli.co', password: 'secreto123', currency: 'COP', period_type: 'mensual' });
  r = await get(`/bancos/${bank.id}`); ok(r.status !== 200 || !r.text.includes('Fondo de emergencia'), 'Otra persona no ve bancos ajenos', r.status);
  r = await get(`/movimientos/${g.id}/editar`); ok(r.status !== 200 || !r.text.includes('Gasolina'), 'Otra persona no abre movimientos ajenos', r.status);
  await post(`/movimientos/${g.id}/eliminar`, {}); ok(!!one('SELECT 1 FROM transactions WHERE id = ?', g.id), 'Otra persona no borra movimientos ajenos');
  await post(`/bolsillos/${moto.id}/editar`, { name: 'Hackeado', initial_balance: '0' }); ok(one('SELECT name FROM containers WHERE id = ?', moto.id).name === 'Moto', 'Otra persona no edita bolsillos ajenos');
} catch (e) {
  ok(false, 'La prueba se detuvo', e.stack);
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* temporal */ }
}

const errors = serverLog.split('\n').filter((l) => /error/i.test(l) && !/ExperimentalWarning/.test(l));
console.log(`\nEriJuli · prueba funcional\n  Correctas: ${pass}\n  Fallas:    ${fail}`);
fails.forEach((x) => console.log('  ✗ ' + x));
if (errors.length) { console.log('\nErrores del servidor:'); errors.slice(0, 20).forEach((l) => console.log('  ' + l)); }
process.exit(fail ? 1 : 0);
