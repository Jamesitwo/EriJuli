'use strict';
/**
 * Respaldos automáticos de la base de datos (RN-08).
 * Cada día se genera una copia consistente con VACUUM INTO en la carpeta de respaldos
 * y se conservan los últimos 7. También hay descarga manual desde la app.
 */
const fs = require('fs');
const path = require('path');
const { db, DB_PATH } = require('../db');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const KEEP = 7;

function createBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const target = path.join(BACKUP_DIR, `respaldo-${stamp}.db`);
    if (fs.existsSync(target)) fs.unlinkSync(target);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    pruneOld();
    return target;
  } catch (e) {
    console.error('No se pudo crear el respaldo:', e.message);
    return null;
  }
}

function pruneOld() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('respaldo-') && f.endsWith('.db'))
    .sort();
  while (files.length > KEEP) {
    const old = files.shift();
    try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (e) { /* ignorar */ }
  }
}

function scheduleBackups() {
  createBackup();
  const DAY = 24 * 60 * 60 * 1000;
  setInterval(createBackup, DAY).unref();
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('respaldo-') && f.endsWith('.db'))
      .sort()
      .reverse()
      .map((f) => ({ name: f, date: f.replace('respaldo-', '').replace('.db', '') }));
  } catch (e) {
    return [];
  }
}

module.exports = { createBackup, scheduleBackups, listBackups, BACKUP_DIR };
