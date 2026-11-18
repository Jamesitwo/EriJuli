'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');

const IS_PROD = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);
const DEFAULT_SECRET = 'cambia-esta-clave-en-produccion';
if (IS_PROD && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === DEFAULT_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.error('❌ Falta SESSION_SECRET (mínimo 32 caracteres). Agrégala en las variables de Railway y vuelve a desplegar.');
  process.exit(1);
}

const { db, DB_PATH, SQLiteSessionStore } = require('./src/db');
const { requireAuth, flash, csrfToken, csrfProtect, errorHandler } = require('./src/middleware');
const { formatMoney } = require('./src/utils/money');
const dates = require('./src/utils/dates');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// Estado del servicio (Railway lo usa para saber si el despliegue quedó bien)
app.get('/salud', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false }); }
});

// Cabeceras de seguridad básicas
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), geolocation=(), microphone=()',
  });
  if (IS_PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.urlencoded({ extended: true, limit: '10mb' })); // 10 MB: fotos de recibos
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    // El service worker y el manifest siempre frescos; el resto (con ?v=) se puede guardar un día
    if (/sw\.js$|manifest\.webmanifest$/.test(file)) res.set('Cache-Control', 'no-cache');
    else res.set('Cache-Control', 'public, max-age=86400');
  },
}));

app.use(session({
  store: new SQLiteSessionStore(db),
  secret: process.env.SESSION_SECRET || DEFAULT_SECRET,
  name: 'erijuli.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD && process.env.FORCE_HTTPS !== 'false',
    maxAge: 30 * 24 * 3600 * 1000,
  },
}));

app.use(flash);
app.use(csrfToken);

// Helpers globales para las vistas
app.use((req, res, next) => {
  res.locals.formatMoney = formatMoney;
  res.locals.dates = dates;
  res.locals.appName = 'EriJuli';
  next();
});

// Rutas públicas (también protegidas contra CSRF)
app.use('/', csrfProtect, require('./src/routes/auth'));
app.use('/', csrfProtect, require('./src/routes/recovery'));

// Respaldo automático diario de la base de datos (RN-08)
require('./src/services/backup').scheduleBackups();

// Notificaciones en el celular: revisa alertas cada hora
require('./src/services/push').scheduleAlerts();

// Rutas protegidas
const protectedRoutes = [
  require('./src/routes/dashboard'),
  require('./src/routes/banks'),
  require('./src/routes/transactions'),
  require('./src/routes/income'),
  require('./src/routes/fixed'),
  require('./src/routes/budget'),
  require('./src/routes/goals'),
  require('./src/routes/loans'),
  require('./src/routes/reports'),
  require('./src/routes/settings'),
  require('./src/routes/importexport'),
  require('./src/routes/history'),
  require('./src/routes/inbox'),
  require('./src/routes/gmail'),
  require('./src/routes/cards'),
  require('./src/routes/household'),
  require('./src/routes/security'),
];
for (const r of protectedRoutes) {
  app.use('/', requireAuth, csrfProtect, r);
}

app.use((req, res) => res.status(404).render('error', { title: 'Página no encontrada', message: 'La ruta que buscas no existe.' }));
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`EriJuli corriendo en el puerto ${PORT}${IS_PROD ? ' (producción)' : ` → http://localhost:${PORT}`}`);
  console.log(`📦 Base de datos: ${DB_PATH}`);
});

// Apagado ordenado (Railway envía SIGTERM al redesplegar)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} recibido: cerrando EriJuli…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
