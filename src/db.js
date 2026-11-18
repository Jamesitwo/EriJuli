'use strict';
/**
 * Capa de acceso a datos usando node:sqlite (incluido en Node.js 24+, sin dependencias nativas).
 * Expone una interfaz similar a better-sqlite3 para facilitar un cambio futuro.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// En Railway, si hay un Volume montado y no se definió DATABASE_PATH, la base vive en el Volume
const DB_PATH = process.env.DATABASE_PATH
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'app.db') : path.join(__dirname, '..', 'data', 'app.db'));
if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATABASE_PATH) {
  console.warn('⚠️  Railway sin Volume: la base de datos se borrará en cada despliegue. Monta un Volume en /data.');
}
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new DatabaseSync(DB_PATH);

const db = {
  exec: (sql) => sqlite.exec(sql),
  pragma: (sql) => sqlite.exec(`PRAGMA ${sql}`),
  /** Ejecuta fn dentro de una transacción (todo o nada). */
  tx: (fn) => {
    sqlite.exec('BEGIN');
    try { const r = fn(); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
  prepare: (sql) => {
    const stmt = sqlite.prepare(sql);
    return {
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
      run: (...args) => stmt.run(...args),
    };
  },
};

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Migraciones: tablas y columnas nuevas, sin tocar los datos existentes
require('./migrations').migrate(db);

// Categorías iniciales que aún tienen el gris por defecto: les asigna su color de la paleta EriJuli
{
  const defaults = { 'Alimentación': '#e07b24', 'Transporte': '#2b56c4', 'Servicios': '#0a7a8a', 'Salud': '#b3361b',
    'Entretenimiento': '#c2457a', 'Educación': '#6d4fb3', 'Hogar': '#7a5000', 'Otros gastos': '#5a6560',
    'Salario': '#0f5c45', 'Ventas': '#3f8f5a', 'Otros ingresos': '#e9a92c' };
  const upd = db.prepare("UPDATE categories SET color = ? WHERE name = ? AND color = '#64748b'");
  for (const [name, color] of Object.entries(defaults)) upd.run(color, name);
}

// Sesiones almacenadas en SQLite (no se pierden al reiniciar)
const session = require('express-session');
class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired INTEGER NOT NULL
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions (expired)');
  }
  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expired < Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const maxAge = (sess && sess.cookie && sess.cookie.maxAge) || 30 * 24 * 3600 * 1000;
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), Date.now() + maxAge);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb(null); }
    catch (e) { cb(e); }
  }
  touch(sid, sess, cb) {
    try {
      const maxAge = (sess && sess.cookie && sess.cookie.maxAge) || 30 * 24 * 3600 * 1000;
      this.db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?').run(Date.now() + maxAge, sid);
      cb(null);
    } catch (e) { cb(e); }
  }
}

module.exports = { db, DB_PATH, SQLiteSessionStore };
