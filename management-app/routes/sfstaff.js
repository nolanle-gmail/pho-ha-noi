// Staff-facing Service Flow — a floor staffer (server / runner / busser) views the live
// board for their store and taps "Served" / "Done" on their phone. Dual-auth like the
// alerts route: the Staff app calls with the service key + ?as=<staff email>, or a normal
// Management JWT. Location-scoped: floor staff only see/act on their own store — or, for a
// trial recipient, the store they were assigned the Service Flow alerts for.
const express = require('express');
const db = require('../db/database');
const { verifyToken } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const toastSync = require('../lib/toastSync');

const router = express.Router();
const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

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

const SEES_ALL = ['owner', 'admin', 'hr', 'general_manager', 'regional_manager'];
// Every store a staffer can work: their home store plus any additional stores (staff_locations).
function staffStores(user) {
  const set = new Set();
  if (user.location_id) set.add(Number(user.location_id));
  try { db.prepare(`SELECT location_id FROM staff_locations WHERE user_id=?`).all(user.id).forEach(r => set.add(Number(r.location_id))); } catch { /* table may be absent */ }
  return [...set];
}
// The staffer's stores that currently have Service Flow turned ON (rows: {id, name}).
function myOnStores(user) {
  const s = staffStores(user);
  if (!s.length) return [];
  const ph = s.map(() => '?').join(',');
  try {
    return db.prepare(`SELECT tl.location_id AS id, l.name FROM toast_locations tl JOIN locations l ON l.id=tl.location_id
      WHERE tl.service_flow_on=1 AND tl.active=1 AND tl.location_id IN (${ph}) ORDER BY l.name`).all(...s);
  } catch { return []; }
}
// The store whose board this person should see. An all-location role may pass one. A floor
// staffer sees whichever of THEIR stores (home or additional) is ON — honoring an explicit
// pick if it's one of theirs — so someone who covers several stores lands on the live one, not
// their off home store. A pure trial alert recipient (no store on their profile) sees the store
// they were assigned.
function boardLoc(user, q) {
  if (SEES_ALL.includes(user.role)) return q || null;
  const stores = staffStores(user);
  if (stores.length) {
    if (q && stores.includes(Number(q))) return Number(q);   // honor their pick
    const on = myOnStores(user);
    if (on.length) return on[0].id;                           // prefer a live store
    return stores[0];                                         // else home (shows "not live")
  }
  const trial = db.prepare(`SELECT location_id FROM toast_locations WHERE flow_alert_user_id=? AND active=1`).get(user.id);
  return trial ? trial.location_id : (user.location_id || null);
}

router.get('/board', (req, res) => {
  const loc = boardLoc(req.user, parseInt(req.query.location_id, 10) || null);
  const cfg = loc && db.prepare(`SELECT service_flow_on, service_alerts_live FROM toast_locations WHERE location_id=? AND active=1`).get(loc);
  // The staffer's own ON stores — so the app can offer a picker when they cover more than one.
  const stores = SEES_ALL.includes(req.user.role) ? [] : myOnStores(req.user);
  if (!loc || !cfg || !cfg.service_flow_on) return res.json({ enabled: false, tables: [], counts: { total: 0 }, stores });
  const flow = toastSync.computeServiceFlow(loc);
  res.json({ enabled: true, location_id: loc, alerts_live: !!cfg.service_alerts_live, stores, ...flow });
});

const flowLoc = (guid) => (db.prepare(`SELECT location_id FROM toast_orders WHERE guid=?`).get(guid) || {}).location_id;
// A floor staffer may act on any table at any store they belong to; all-location roles anywhere.
const canAct = (user, loc) => SEES_ALL.includes(user.role) || staffStores(user).map(String).includes(String(loc));
const upServed = db.prepare(`INSERT INTO toast_flow_state (order_guid, location_id, served_at, served_by, updated_at)
  VALUES (@g,@l,@a,@b,datetime('now')) ON CONFLICT(order_guid) DO UPDATE SET served_at=@a, served_by=@b, updated_at=datetime('now')`);
const upBussed = db.prepare(`INSERT INTO toast_flow_state (order_guid, location_id, bussed_at, bussed_by, updated_at)
  VALUES (@g,@l,@a,@b,datetime('now')) ON CONFLICT(order_guid) DO UPDATE SET bussed_at=@a, bussed_by=@b, updated_at=datetime('now')`);

router.post('/:guid/served', (req, res) => {
  const loc = flowLoc(req.params.guid);
  if (!loc) return res.status(404).json({ error: 'Order not found.' });
  if (!canAct(req.user, loc)) return res.status(403).json({ error: 'Not your store.' });
  const clear = req.body && req.body.clear;
  upServed.run({ g: req.params.guid, l: loc, a: clear ? null : new Date().toISOString(), b: clear ? null : req.user.id });
  auditLog(req, 'flow_served', 'toast', req.params.guid, { via: 'staff', clear: !!clear });
  res.json({ success: true, served: !clear });
});
router.post('/:guid/done', (req, res) => {
  const loc = flowLoc(req.params.guid);
  if (!loc) return res.status(404).json({ error: 'Order not found.' });
  if (!canAct(req.user, loc)) return res.status(403).json({ error: 'Not your store.' });
  upBussed.run({ g: req.params.guid, l: loc, a: new Date().toISOString(), b: req.user.id });
  auditLog(req, 'flow_bussed', 'toast', req.params.guid, { via: 'staff' });
  res.json({ success: true, done: true });
});

module.exports = router;
