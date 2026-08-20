// Lightweight audit trail helper for the waitlist app.
const db = require('../db/database');
const { emitWaitlist } = require('./events');

function auditLog(req, locationId, action, entityId, detail) {
  try {
    // Store the actor's name/role denormalized; keep user_id only for local users
    // (Management-sourced ids don't reference this app's users table).
    const localId = req.user && req.user.src !== 'mgmt' ? req.user.id : null;
    db.prepare(`INSERT INTO audit_log (user_id, user_name, user_role, location_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?,?,?)`)
      .run(localId, req.user ? req.user.name || null : null, req.user ? req.user.role || null : null,
           locationId || null, action, 'waitlist', entityId || null,
           detail ? JSON.stringify(detail) : null);
  } catch (e) {
    console.error('auditLog failed:', e.message);
  }
  try { emitWaitlist(locationId); } catch { /* live-push bus is best-effort */ }
}

module.exports = { auditLog };
