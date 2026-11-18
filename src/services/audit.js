'use strict';
const { db } = require('../db');

function log(userId, entity, entityId, action, details = '', origin = 'manual') {
  db.prepare(`INSERT INTO audit_log (user_id, entity, entity_id, action, details, origin)
    VALUES (?, ?, ?, ?, ?, ?)`).run(userId, entity, entityId, action, typeof details === 'string' ? details : JSON.stringify(details), origin);
}

function history(userId, limit = 100) {
  return db.prepare('SELECT * FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
}

module.exports = { log, history };
