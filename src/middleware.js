'use strict';
const { tzStore } = require('./utils/dates');
const crypto = require('crypto');
const { db } = require('./db');

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    req.session.flash = { type: 'error', text: 'Inicia sesión para continuar.' };
    return res.redirect('/login');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy(() => res.redirect('/login'));
    return;
  }
  req.user = user;
  res.locals.user = user;
  res.locals.currentPath = req.path;
  // A partir de aquí, "hoy" se calcula en la zona horaria del usuario (RN-06)
  tzStore.enterWith(user.timezone || 'America/Bogota');

  // Bloqueo con PIN o huella después de un rato sin usar la app
  const now = Date.now();
  if (user.pin_hash) {
    const idle = now - (req.session.lastSeen || now);
    if (idle > Math.max(1, user.lock_minutes || 5) * 60000) req.session.locked = true;
  } else {
    req.session.locked = false;
  }
  req.session.lastSeen = now;
  const lockFree = req.path.startsWith('/bloqueo') || req.path === '/logout';
  if (req.session.locked && !lockFree) {
    if (req.method === 'GET' && req.accepts('html')) req.session.afterUnlock = req.originalUrl;
    if (req.xhr || (req.headers.accept || '').includes('application/json')) return res.status(423).json({ locked: true });
    return res.redirect('/bloqueo');
  }
  // Contador de la bandeja de Gmail para la navegación
  try {
    res.locals.inboxCount = db.prepare("SELECT COUNT(*) AS n FROM proposed_movements WHERE user_id = ? AND status IN ('propuesto','sin_procesar')").get(user.id).n;
  } catch { res.locals.inboxCount = 0; }
  next();
}

/** Mensajes flash sencillos en sesión. */
function flash(req, res, next) {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.setFlash = (type, text) => { req.session.flash = { type, text }; };
  next();
}

function setFlash(req, type, text) {
  req.session.flash = { type, text };
}

/** CSRF: token por sesión en todos los formularios POST. */
function csrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function csrfProtect(req, res, next) {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const token = req.body && req.body._csrf;
    if (!token || token !== req.session.csrfToken) {
      return res.status(403).render('error', { title: 'Error', message: 'Sesión expirada o formulario inválido. Vuelve a intentarlo.' });
    }
  }
  next();
}

function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status || 500;
  res.status(status).render('error', {
    title: 'Algo salió mal',
    message: process.env.NODE_ENV === 'production'
      ? 'Ocurrió un error inesperado. Intenta de nuevo.'
      : err.message,
  });
}

module.exports = { requireAuth, flash, setFlash, csrfToken, csrfProtect, errorHandler };
