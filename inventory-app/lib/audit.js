// Lightweight audit trail helper.
const db = require('../db/database');

function auditLog(req, action, entity, entityId, detail) {
  try {
    db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)`)
      .run(req.user ? req.user.id : null, action, entity || null, entityId || null,
           detail ? JSON.stringify(detail) : null);
  } catch (e) {
    console.error('auditLog failed:', e.message);
  }
}

module.exports = { auditLog };
