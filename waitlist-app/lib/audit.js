// Lightweight audit trail helper for the waitlist app.
const db = require('../db/database');

function auditLog(req, locationId, action, entityId, detail) {
  try {
    db.prepare(`INSERT INTO audit_log (user_id, location_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)`)
      .run(req.user ? req.user.id : null, locationId || null, action, 'waitlist', entityId || null,
           detail ? JSON.stringify(detail) : null);
  } catch (e) {
    console.error('auditLog failed:', e.message);
  }
}

module.exports = { auditLog };
