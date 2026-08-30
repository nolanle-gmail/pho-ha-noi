// Floor alerts — a manager/owner pushes an urgent on-screen ping to working staff
// (e.g. "help table 5 now"). Targets one person, a whole role at the store, or
// everyone on the floor. Delivered live over the messages SSE stream and popped up
// in the Staff app; recipients acknowledge ("On it"). Dual-auth like messages: a
// normal Management JWT, or the Staff-app service key acting "as" a staff email.
const express = require('express');
const db = require('../db/database');
const { verifyToken } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const { emitAlert, emitAlertAck } = require('../lib/events');

const router = express.Router();
const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

// Resolve the acting user from the service key (+ ?as=email) or a JWT.
router.use((req, res, next) => {
  const key = req.headers['x-service-key'] || req.query.key;
  if (key && key === SERVICE_KEY) {
    const email = String(req.query.as || req.headers['x-as-user'] || '').toLowerCase().trim();
    const u = email && db.prepare(`SELECT id, name, role, location_id FROM users WHERE lower(email)=? AND is_active=1`).get(email);
    if (!u) return res.status(401).json({ error: 'Unknown staff member.' });
    req.user = { id: u.id, name: u.name, role: u.role, location_id: u.location_id };
    return next();
  }
  return verifyToken(req, res, next);
});

const CAN_SEND = ['owner', 'admin', 'general_manager', 'regional_manager', 'manager', 'assistant_manager', 'kitchen_manager'];
const SEES_ALL = ['owner', 'admin', 'general_manager', 'regional_manager'];
const canSend = (role) => CAN_SEND.includes(role);
const TARGET_ROLES = ['server', 'host', 'busser', 'support', 'employee', 'chef', 'driver'];

// Who a manager can target at a store: the staff there, plus which roles are present.
router.get('/staff', (req, res) => {
  if (!canSend(req.user.role)) return res.status(403).json({ error: 'Not allowed to send alerts.' });
  const locId = parseInt(req.query.location_id, 10) || req.user.location_id;
  if (!locId) return res.status(400).json({ error: 'A location is required.' });
  const staff = db.prepare(`SELECT id, name, role FROM users
    WHERE location_id=? AND is_active=1 AND id<>? ORDER BY name`).all(locId, req.user.id);
  const roles = [...new Set(staff.map(s => s.role))].filter(r => TARGET_ROLES.includes(r));
  res.json({ location_id: locId, staff, roles });
});

// Send an alert.
router.post('/', (req, res) => {
  if (!canSend(req.user.role)) return res.status(403).json({ error: 'Not allowed to send alerts.' });
  const body = (req.body.body || '').toString().trim().slice(0, 300);
  if (!body) return res.status(400).json({ error: 'An alert message is required.' });
  const priority = req.body.priority === 'normal' ? 'normal' : 'urgent';
  const targetType = ['user', 'role', 'all'].includes(req.body.target_type) ? req.body.target_type : null;
  if (!targetType) return res.status(400).json({ error: 'Choose who to alert.' });

  let targetUserId = null, targetRole = null, locId = parseInt(req.body.location_id, 10) || req.user.location_id;
  if (targetType === 'user') {
    targetUserId = parseInt(req.body.target_user_id, 10);
    const u = targetUserId && db.prepare(`SELECT id, location_id FROM users WHERE id=? AND is_active=1`).get(targetUserId);
    if (!u) return res.status(400).json({ error: 'Pick a staff member to alert.' });
    locId = locId || u.location_id;
  } else if (targetType === 'role') {
    targetRole = TARGET_ROLES.includes(req.body.target_role) ? req.body.target_role : null;
    if (!targetRole) return res.status(400).json({ error: 'Pick a role to alert.' });
  }
  if (!locId) return res.status(400).json({ error: 'A location is required for this alert.' });
  // A manager is scoped to their own store; owner/admin/GM may address any store.
  if (!SEES_ALL.includes(req.user.role) && String(locId) !== String(req.user.location_id)) {
    return res.status(403).json({ error: 'You can only alert your own store.' });
  }

  const r = db.prepare(`INSERT INTO floor_alerts (location_id, sender_id, target_type, target_user_id, target_role, body, priority)
    VALUES (?,?,?,?,?,?,?)`).run(locId, req.user.id, targetType, targetUserId, targetRole, body, priority);
  const alert = {
    id: r.lastInsertRowid, location_id: locId, target_type: targetType, target_user_id: targetUserId,
    target_role: targetRole, body, priority, sender_name: req.user.name, created_at: new Date().toISOString(),
  };
  try { emitAlert(alert); } catch { /* live push is best-effort */ }
  auditLog(req, 'floor_alert', 'floor_alert', r.lastInsertRowid, { target: targetType === 'user' ? `user:${targetUserId}` : targetType === 'role' ? `role:${targetRole}` : 'everyone', priority, body });
  res.json({ success: true, id: r.lastInsertRowid });
});

// Active alerts still open for me that I haven't acknowledged (recent only), so a
// staff member who (re)opens the app immediately sees anything pending.
router.get('/active', (req, res) => {
  const u = req.user;
  const rows = db.prepare(`
    SELECT a.id, a.body, a.priority, a.target_type, a.created_at, s.name AS sender_name
    FROM floor_alerts a JOIN users s ON s.id = a.sender_id
    WHERE a.active=1 AND a.created_at >= datetime('now','-30 minutes')
      AND ( (a.target_type='user' AND a.target_user_id=?)
         OR (a.target_type='role' AND a.target_role=? AND a.location_id=?)
         OR (a.target_type='all' AND a.location_id=?) )
      AND NOT EXISTS (SELECT 1 FROM floor_alert_acks k WHERE k.alert_id=a.id AND k.user_id=?)
    ORDER BY a.created_at DESC`).all(u.id, u.role, u.location_id, u.location_id, u.id);
  res.json({ alerts: rows });
});

// Acknowledge ("On it") — records me and pings the sender live.
router.post('/:id/ack', (req, res) => {
  const a = db.prepare(`SELECT * FROM floor_alerts WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Alert not found.' });
  db.prepare(`INSERT OR IGNORE INTO floor_alert_acks (alert_id, user_id) VALUES (?,?)`).run(a.id, req.user.id);
  try { emitAlertAck({ sender_id: a.sender_id, alert_id: a.id, user_id: req.user.id, user_name: req.user.name }); } catch { /* best-effort */ }
  res.json({ success: true });
});

// The sender's recent alerts with acknowledgement counts.
router.get('/sent', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM floor_alert_acks k WHERE k.alert_id=a.id) AS ack_count,
           tu.name AS target_user_name
    FROM floor_alerts a LEFT JOIN users tu ON tu.id = a.target_user_id
    WHERE a.sender_id=? AND a.created_at >= datetime('now','-1 day')
    ORDER BY a.created_at DESC LIMIT 50`).all(req.user.id);
  res.json({ alerts: rows });
});

// Who acknowledged a given alert (sender only).
router.get('/:id/acks', (req, res) => {
  const a = db.prepare(`SELECT sender_id FROM floor_alerts WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Alert not found.' });
  if (Number(a.sender_id) !== Number(req.user.id) && !SEES_ALL.includes(req.user.role)) {
    return res.status(403).json({ error: 'Not your alert.' });
  }
  const acks = db.prepare(`SELECT u.name, k.ack_at FROM floor_alert_acks k JOIN users u ON u.id=k.user_id
    WHERE k.alert_id=? ORDER BY k.ack_at`).all(req.params.id);
  res.json({ acks });
});

// Close an alert (sender stops it showing to anyone new).
router.post('/:id/close', (req, res) => {
  const a = db.prepare(`SELECT sender_id FROM floor_alerts WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Alert not found.' });
  if (Number(a.sender_id) !== Number(req.user.id) && !SEES_ALL.includes(req.user.role)) {
    return res.status(403).json({ error: 'Not your alert.' });
  }
  db.prepare(`UPDATE floor_alerts SET active=0 WHERE id=?`).run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
