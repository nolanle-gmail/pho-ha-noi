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
const { pushToUsers } = require('../lib/push');
const toastSync = require('../lib/toastSync');

const router = express.Router();
const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

// Service Flow alerts write straight back to the board's task state, so tapping
// "Mark Served" / "Mark Bussed" on the alert moves the table on the board at once.
const flowLocOf = (guid) => (db.prepare(`SELECT location_id FROM toast_orders WHERE guid=?`).get(guid) || {}).location_id;
const upServed = db.prepare(`INSERT INTO toast_flow_state (order_guid, location_id, served_at, served_by, updated_at)
  VALUES (@g,@l,@a,@b,datetime('now')) ON CONFLICT(order_guid) DO UPDATE SET served_at=@a, served_by=@b, updated_at=datetime('now')`);
const upBussed = db.prepare(`INSERT INTO toast_flow_state (order_guid, location_id, bussed_at, bussed_by, updated_at)
  VALUES (@g,@l,@a,@b,datetime('now')) ON CONFLICT(order_guid) DO UPDATE SET bussed_at=@a, bussed_by=@b, updated_at=datetime('now')`);
const upPaid = db.prepare(`INSERT INTO toast_flow_state (order_guid, location_id, paid_at, paid_by, updated_at)
  VALUES (@g,@l,@a,@b,datetime('now')) ON CONFLICT(order_guid) DO UPDATE SET paid_at=@a, paid_by=@b, updated_at=datetime('now')`);
// Audit trail of staff actions on Service Flow alerts (who / when / what) for later review.
const _logFlow = db.prepare(`INSERT INTO toast_flow_events (location_id, order_guid, alert_id, flow_kind, action, user_id, user_name) VALUES (?,?,?,?,?,?,?)`);
function logFlowEvent(a, user, action) {
  if (!a.flow_kind) return;
  try { _logFlow.run(a.flow_guid ? flowLocOf(a.flow_guid) : a.location_id, a.flow_guid || null, a.id, a.flow_kind, action, user.id, user.name || null); } catch { /* best-effort */ }
}
// Resolve a Service Flow alert and advance the board to match its kind — shared by the
// modern /flow action AND a plain "Mark done" (/complete) from an older client, so either
// one moves the table: food → Served, pay → Paid (+ busser alert), busser → Bussed/cleared.
function flowResolveFromDone(a, userId) {
  const loc = a.flow_guid ? flowLocOf(a.flow_guid) : null;
  if (loc) {
    const now = new Date().toISOString();
    if (a.flow_kind === 'ready_to_bus') upBussed.run({ g: a.flow_guid, l: loc, a: now, b: userId });
    else if (a.flow_kind === 'lingering') upPaid.run({ g: a.flow_guid, l: loc, a: now, b: userId });
    else upServed.run({ g: a.flow_guid, l: loc, a: now, b: userId });   // food_late (default)
  }
  try { toastSync.clearFlowRenudge(a.flow_guid, a.flow_kind); } catch { /* best-effort */ }
  db.prepare(`UPDATE floor_alerts SET status='resolved', active=0 WHERE id=?`).run(a.id);
  if (a.flow_kind === 'lingering' && a.flow_guid) { try { toastSync.raiseFlowAlert(a.flow_guid, 'ready_to_bus'); } catch { /* best-effort */ } }
}
// The status actions offered once a flow alert is claimed, per escalation type. The
// first action of each is its "resolve" (writes the board where relevant); food/lingering
// also offer "waiting" to re-nudge in ~5 min.
const FLOW_ACTIONS = {
  food_late: ['served', 'waiting'],
  lingering: ['paid', 'notyet'],
  ready_to_bus: ['bussed'],
};
// Which actions just snooze the alert for a re-nudge vs. resolve it.
const FLOW_WAIT_ACTIONS = ['waiting', 'notyet'];

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

const CAN_SEND = ['owner', 'admin', 'hr', 'general_manager', 'regional_manager', 'manager', 'assistant_manager', 'kitchen_manager'];
const SEES_ALL = ['owner', 'admin', 'hr', 'general_manager', 'regional_manager'];
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
  // Real OS push to the alert's audience (same targeting as the in-app pop-up), so
  // it reaches phones even when the app is closed. Never to the sender.
  try {
    let ids = [];
    if (targetType === 'user') ids = [targetUserId];
    else if (targetType === 'role') ids = db.prepare(`SELECT id FROM users WHERE is_active=1 AND role=? AND location_id=?`).all(targetRole, locId).map(x => x.id);
    else ids = db.prepare(`SELECT id FROM users WHERE is_active=1 AND location_id=?`).all(locId).map(x => x.id);
    ids = ids.filter(id => String(id) !== String(req.user.id));
    pushToUsers(ids, {
      title: priority === 'urgent' ? '🔔 Urgent floor alert' : '🔔 Floor alert',
      body: `${body} — from ${req.user.name}`,
      tag: 'alert-' + r.lastInsertRowid,
      url: '/?n=alert',
    });
  } catch { /* OS push is best-effort */ }
  auditLog(req, 'floor_alert', 'floor_alert', r.lastInsertRowid, { target: targetType === 'user' ? `user:${targetUserId}` : targetType === 'role' ? `role:${targetRole}` : 'everyone', priority, body });
  res.json({ success: true, id: r.lastInsertRowid });
});

// Active alerts still open for me that I haven't acknowledged (recent only), so a
// staff member who (re)opens the app immediately sees anything pending.
router.get('/active', (req, res) => {
  const u = req.user;
  // Still-open alerts for me that I haven't marked DONE yet. An alert I've only
  // acknowledged keeps coming back (with mine_ack=1) so I remember to close it.
  const rows = db.prepare(`
    SELECT a.id, a.body, a.priority, a.target_type, a.created_at, s.name AS sender_name,
           a.flow_kind, a.flow_guid, a.status, a.claimed_by, cu.name AS claimed_by_name,
           EXISTS (SELECT 1 FROM floor_alert_acks k WHERE k.alert_id=a.id AND k.user_id=?) AS mine_ack
    FROM floor_alerts a JOIN users s ON s.id = a.sender_id
    LEFT JOIN users cu ON cu.id = a.claimed_by
    WHERE a.active=1 AND a.created_at >= datetime('now','-30 minutes')
      AND ( (a.target_type='user' AND a.target_user_id=?)
         OR (a.target_type='role' AND a.target_role=? AND a.location_id=?)
         OR (a.target_type='all' AND a.location_id=?) )
      AND (a.flow_kind IS NULL OR a.claimed_by IS NULL OR a.claimed_by=?)
      AND NOT EXISTS (SELECT 1 FROM floor_alert_acks k WHERE k.alert_id=a.id AND k.user_id=? AND k.completed_at IS NOT NULL)
    ORDER BY a.created_at DESC`).all(u.id, u.id, u.role, u.location_id, u.location_id, u.id, u.id);
  res.json({ alerts: rows.map(r => ({ ...r, mine_ack: !!r.mine_ack, actions: r.flow_kind ? (FLOW_ACTIONS[r.flow_kind] || []) : null, mine_claim: !!(r.claimed_by && Number(r.claimed_by) === Number(u.id)) })) });
});

// Alerts inbox for a recipient: everything targeting me, split into Active (still needs
// my action) and History (I've marked done, or it's been closed). Powers the Staff-app
// Alerts screen and its unread count. Windowed so it stays bounded.
router.get('/inbox', (req, res) => {
  const p = { uid: req.user.id, role: req.user.role, loc: req.user.location_id };
  const mine = `( (a.target_type='user' AND a.target_user_id=@uid)
     OR (a.target_type='role' AND a.target_role=@role AND a.location_id=@loc)
     OR (a.target_type='all' AND a.location_id=@loc) )`;
  const done = `EXISTS (SELECT 1 FROM floor_alert_acks k WHERE k.alert_id=a.id AND k.user_id=@uid AND k.completed_at IS NOT NULL)`;
  const active = db.prepare(`
    SELECT a.id, a.body, a.priority, a.target_type, a.created_at, s.name AS sender_name,
           a.flow_kind, a.flow_guid, a.status, a.claimed_by, cu.name AS claimed_by_name,
           EXISTS (SELECT 1 FROM floor_alert_acks k WHERE k.alert_id=a.id AND k.user_id=@uid) AS mine_ack
    FROM floor_alerts a JOIN users s ON s.id=a.sender_id
    LEFT JOIN users cu ON cu.id=a.claimed_by
    WHERE a.active=1 AND a.created_at >= datetime('now','-1 day') AND ${mine} AND NOT ${done}
      AND (a.flow_kind IS NULL OR a.claimed_by IS NULL OR a.claimed_by=@uid)
    ORDER BY a.created_at DESC LIMIT 100`).all(p);
  const history = db.prepare(`
    SELECT a.id, a.body, a.priority, a.target_type, a.created_at, s.name AS sender_name, a.flow_kind, a.status,
           (SELECT completed_at FROM floor_alert_acks k WHERE k.alert_id=a.id AND k.user_id=@uid) AS mine_done_at
    FROM floor_alerts a JOIN users s ON s.id=a.sender_id
    WHERE a.created_at >= datetime('now','-7 days') AND ${mine} AND ( ${done} OR a.active=0 )
    ORDER BY a.created_at DESC LIMIT 100`).all(p);
  const decorate = (r) => ({ ...r, mine_ack: !!r.mine_ack, actions: r.flow_kind ? (FLOW_ACTIONS[r.flow_kind] || []) : null, mine_claim: !!(r.claimed_by && Number(r.claimed_by) === Number(p.uid)) });
  res.json({ active: active.map(decorate), history, active_count: active.length });
});

// Acknowledge ("On it") — records me and pings the sender live.
router.post('/:id/ack', (req, res) => {
  const a = db.prepare(`SELECT * FROM floor_alerts WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Alert not found.' });
  db.prepare(`INSERT OR IGNORE INTO floor_alert_acks (alert_id, user_id) VALUES (?,?)`).run(a.id, req.user.id);
  // A Service Flow alert: "On it" also claims it (stops the 3-min re-pop, hides it from
  // other staff) — so an older client's plain "On it" behaves like the new "On It".
  if (a.flow_kind && !a.claimed_by) {
    db.prepare(`UPDATE floor_alerts SET claimed_by=?, claimed_at=datetime('now'), status='claimed' WHERE id=?`).run(req.user.id, a.id);
    try { toastSync.clearFlowRenudge(a.flow_guid, a.flow_kind); } catch { /* best-effort */ }
    logFlowEvent(a, req.user, 'on_it');
  }
  // If this was a break reminder, stamp the audit archive with the acknowledgement.
  try { db.prepare(`UPDATE break_reminders SET acknowledged_at=datetime('now') WHERE alert_id=? AND acknowledged_at IS NULL`).run(a.id); } catch { /* table optional */ }
  try { emitAlertAck({ sender_id: a.sender_id, alert_id: a.id, user_id: req.user.id, user_name: req.user.name }); } catch { /* best-effort */ }
  res.json({ success: true });
});

// Mark done ("Closed") — the recipient confirms they FINISHED the task, not just
// that they're on it. Stamps completion (acknowledging first if they hadn't), and
// closes the whole alert when it targeted a single person (that task is now done).
router.post('/:id/complete', (req, res) => {
  const a = db.prepare(`SELECT * FROM floor_alerts WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Alert not found.' });
  db.prepare(`INSERT OR IGNORE INTO floor_alert_acks (alert_id, user_id) VALUES (?,?)`).run(a.id, req.user.id);
  db.prepare(`UPDATE floor_alert_acks SET completed_at=datetime('now')
              WHERE alert_id=? AND user_id=? AND completed_at IS NULL`).run(a.id, req.user.id);
  // Service Flow alert: "Mark done" resolves it AND advances the board (food → Served,
  // pay → Paid + busser alert, busser → cleared) — the same as tapping the labelled action.
  if (a.flow_kind) { flowResolveFromDone(a, req.user.id); logFlowEvent(a, req.user, a.flow_kind === 'ready_to_bus' ? 'bussed' : a.flow_kind === 'lingering' ? 'paid' : 'served'); }
  else if (a.target_type === 'user') db.prepare(`UPDATE floor_alerts SET active=0 WHERE id=?`).run(a.id);
  try { emitAlertAck({ sender_id: a.sender_id, alert_id: a.id, user_id: req.user.id, user_name: req.user.name, completed: true }); } catch { /* best-effort */ }
  res.json({ success: true });
});

// Claim a Service Flow alert ("On It"). The first staffer to take it locks it to
// themselves; the exclusion in /active + /inbox then drops it off everyone else's list
// (someone already committed). Claiming reveals the alert's status actions.
router.post('/:id/claim', (req, res) => {
  const a = db.prepare(`SELECT * FROM floor_alerts WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Alert not found.' });
  if (!a.flow_kind) return res.status(400).json({ error: 'Not a Service Flow alert.' });
  if (a.claimed_by && Number(a.claimed_by) !== Number(req.user.id)) {
    const who = db.prepare(`SELECT name FROM users WHERE id=?`).get(a.claimed_by);
    return res.status(409).json({ error: `${who ? who.name : 'Someone'} already took this.`, claimed_by_name: who && who.name });
  }
  db.prepare(`UPDATE floor_alerts SET claimed_by=?, claimed_at=datetime('now'), status='claimed' WHERE id=?`).run(req.user.id, a.id);
  db.prepare(`INSERT OR IGNORE INTO floor_alert_acks (alert_id, user_id) VALUES (?,?)`).run(a.id, req.user.id);
  try { toastSync.clearFlowRenudge(a.flow_guid, a.flow_kind); } catch { /* best-effort */ }   // attended → stop the 3-min re-pop
  logFlowEvent(a, req.user, 'on_it');
  try { emitAlertAck({ sender_id: a.sender_id, alert_id: a.id, user_id: req.user.id, user_name: req.user.name, claimed: true }); } catch { /* best-effort */ }
  res.json({ success: true, status: 'claimed', actions: FLOW_ACTIONS[a.flow_kind] || [] });
});

// A claimed flow alert's status action. Resolving actions write the board so the table
// moves at once: 'served' → served, 'paid' → paid (and fires the busser alert right away),
// 'bussed' → cleared. 'waiting' (food) / 'notyet' (pay) snooze it for a kind-specific
// re-nudge (~5 / ~7 min) that recurs until the table advances.
router.post('/:id/flow', (req, res) => {
  const a = db.prepare(`SELECT * FROM floor_alerts WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Alert not found.' });
  if (!a.flow_kind) return res.status(400).json({ error: 'Not a Service Flow alert.' });
  const action = String(req.body.action || '').toLowerCase();
  if (!(FLOW_ACTIONS[a.flow_kind] || []).includes(action)) return res.status(400).json({ error: 'Unknown action for this alert.' });
  if (a.claimed_by && Number(a.claimed_by) !== Number(req.user.id) && !SEES_ALL.includes(req.user.role)) {
    return res.status(409).json({ error: 'Someone else is handling this alert.' });
  }
  if (!a.claimed_by) db.prepare(`UPDATE floor_alerts SET claimed_by=?, claimed_at=datetime('now') WHERE id=?`).run(req.user.id, a.id);
  db.prepare(`INSERT OR IGNORE INTO floor_alert_acks (alert_id, user_id) VALUES (?,?)`).run(a.id, req.user.id);
  const loc = a.flow_guid ? flowLocOf(a.flow_guid) : a.location_id;

  if (FLOW_WAIT_ACTIONS.includes(action)) {
    let mins = 5;
    try { mins = toastSync.markFlowWaiting(a.flow_guid, a.flow_kind); } catch { /* best-effort */ }
    // The staffer checked the table → archive this alert (move to History); the sweep
    // re-alerts the floor on the kind's cadence until the table advances (or Toast pays it).
    db.prepare(`UPDATE floor_alert_acks SET completed_at=datetime('now') WHERE alert_id=? AND user_id=? AND completed_at IS NULL`).run(a.id, req.user.id);
    db.prepare(`UPDATE floor_alerts SET status='waiting', active=0 WHERE id=?`).run(a.id);
    logFlowEvent(a, req.user, action);
    auditLog(req, 'flow_alert_' + action, 'floor_alert', a.id, { guid: a.flow_guid, kind: a.flow_kind });
    return res.json({ success: true, status: 'waiting', renudge_min: mins });
  }
  // Resolve. Write the board where the action maps to a task state, then close it out.
  if (action === 'served' && a.flow_guid && loc) upServed.run({ g: a.flow_guid, l: loc, a: new Date().toISOString(), b: req.user.id });
  if (action === 'bussed' && a.flow_guid && loc) upBussed.run({ g: a.flow_guid, l: loc, a: new Date().toISOString(), b: req.user.id });
  if (action === 'paid' && a.flow_guid && loc) upPaid.run({ g: a.flow_guid, l: loc, a: new Date().toISOString(), b: req.user.id });
  try { toastSync.clearFlowRenudge(a.flow_guid, a.flow_kind); } catch { /* best-effort */ }
  logFlowEvent(a, req.user, action);
  db.prepare(`UPDATE floor_alert_acks SET completed_at=datetime('now') WHERE alert_id=? AND user_id=? AND completed_at IS NULL`).run(a.id, req.user.id);
  db.prepare(`UPDATE floor_alerts SET status='resolved', active=0 WHERE id=?`).run(a.id);
  // Paid → the table is now Ready to Bus: alert the busser right away (not on the next sweep).
  if (action === 'paid' && a.flow_guid) { try { toastSync.raiseFlowAlert(a.flow_guid, 'ready_to_bus'); } catch { /* best-effort */ } }
  auditLog(req, 'flow_alert_' + action, a.flow_guid ? 'toast' : 'floor_alert', a.flow_guid || a.id, { kind: a.flow_kind, via: 'alert' });
  try { emitAlertAck({ sender_id: a.sender_id, alert_id: a.id, user_id: req.user.id, user_name: req.user.name, completed: true }); } catch { /* best-effort */ }
  res.json({ success: true, status: 'resolved', action });
});

// The sender's recent alerts with acknowledgement counts.
router.get('/sent', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM floor_alert_acks k WHERE k.alert_id=a.id) AS ack_count,
           (SELECT COUNT(*) FROM floor_alert_acks k WHERE k.alert_id=a.id AND k.completed_at IS NOT NULL) AS done_count,
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
  const acks = db.prepare(`SELECT u.name, k.ack_at, k.completed_at FROM floor_alert_acks k JOIN users u ON u.id=k.user_id
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
