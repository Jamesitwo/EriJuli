'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { setFlash } = require('../middleware');
const { ensurePeriod } = require('../services/periods');
const { log } = require('../services/audit');
const { ensureCash } = require('../services/balances');

const router = express.Router();

router.get('/registro', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('auth/register', { title: 'Crear cuenta' });
});

router.post('/registro', (req, res) => {
  const { name, email, password, currency, period_type } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !password || String(password).length < 8) {
    setFlash(req, 'error', 'Necesitas un correo y una contraseña de al menos 8 caracteres.');
    return res.redirect('/registro');
  }
  if (!req.body.acepto_privacidad) {
    setFlash(req, 'error', 'Para crear la cuenta debes aceptar la política de privacidad.');
    return res.redirect('/registro');
  }
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (exists) {
    setFlash(req, 'error', 'Ya existe una cuenta con ese correo.');
    return res.redirect('/registro');
  }
  const hash = bcrypt.hashSync(String(password), 10);
  const info = db.prepare(`INSERT INTO users (email, password_hash, name, currency, period_type, privacy_accepted_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))`)
    .run(cleanEmail, hash, String(name || '').trim(), currency === 'USD' ? 'USD' : 'COP', period_type === 'quincenal' ? 'quincenal' : 'mensual');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

  // Datos iniciales: categorías y banco por defecto
  const cats = [
    // Colores de la paleta EriJuli
    ['Alimentación', 'gasto', '#e07b24'], ['Transporte', 'gasto', '#2b56c4'], ['Servicios', 'gasto', '#0a7a8a'], ['Salud', 'gasto', '#b3361b'],
    ['Entretenimiento', 'gasto', '#c2457a'], ['Educación', 'gasto', '#6d4fb3'], ['Hogar', 'gasto', '#7a5000'], ['Otros gastos', 'gasto', '#5a6560'],
    ['Salario', 'ingreso', '#0f5c45'], ['Ventas', 'ingreso', '#3f8f5a'], ['Otros ingresos', 'ingreso', '#e9a92c'],
  ];
  const insCat = db.prepare('INSERT INTO categories (user_id, name, kind, color) VALUES (?, ?, ?, ?)');
  for (const [n, k, c] of cats) insCat.run(user.id, n, k, c);
  const bank = db.prepare('INSERT INTO banks (user_id, name, color) VALUES (?, ?, ?)').run(user.id, 'Banco principal', '#0f5c45');
  db.prepare(`INSERT INTO containers (user_id, bank_id, kind, name, purpose) VALUES (?, ?, 'cuenta', 'Cuenta', '')`).run(user.id, bank.lastInsertRowid);
  ensureCash(user.id); // Efectivo propio, sin banco (RF-09)

  req.session.userId = user.id;
  req.session.lastSeen = Date.now();
  ensurePeriod(user);
  log(user.id, 'user', user.id, 'registro', 'Cuenta creada');
  setFlash(req, 'success', `¡Bienvenido${user.name ? ' ' + user.name : ''}! Configura tus bancos y bolsillos para empezar.`);
  res.redirect('/');
});

// Política de privacidad (RN-04): pública, se ve con o sin sesión
router.get('/privacidad', (req, res) => {
  const user = req.session.userId ? db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) : null;
  if (user && !req.session.locked) { res.locals.user = user; res.locals.currentPath = '/privacidad'; }
  res.render('legal/privacy', { title: 'Política de privacidad' });
});

router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('auth/login', { title: 'Iniciar sesión' });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    setFlash(req, 'error', 'Correo o contraseña incorrectos.');
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  req.session.locked = false;
  req.session.lastSeen = Date.now();
  ensurePeriod(user);
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
