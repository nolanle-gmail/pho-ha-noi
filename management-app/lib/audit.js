// Lightweight audit trail helper.
const db = require('../db/database');

function auditLog(req, action, entity, entityId, detail) {
  try {
    // Auto-capture an optional free-text reason/note from the request body so the audit
    // trail records WHY an action was taken (alongside the who / when / what). Any Add /
    // Edit / Order form that sends `reason` gets it merged into the logged detail.
    const raw = req && req.body ? req.body.reason : null;
    const reason = typeof raw === 'string' ? raw.trim().slice(0, 300) : '';
    const d = reason ? Object.assign({}, detail, { reason }) : detail;
    db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)`)
      .run(req.user ? req.user.id : null, action, entity || null, entityId || null,
           d ? JSON.stringify(d) : null);
  } catch (e) {
    console.error('auditLog failed:', e.message);
  }
}

module.exports = { auditLog };
