// Public Service Flow kiosk (/sflow) — no login. Anyone opens the link, enters their employee
// code, and works the live board (mark tables Served / Bussed). A staffer who covers several
// stores that have Service Flow ON picks which one. Trust model = the link + the employee code,
// exactly like the scanner / clock kiosks. Every Served / Done is attributed to that staffer,
// and they may only act on a store they're assigned to.
const express = require('express');
const db = require('../db/database');
const { auditLog } = require('../lib/audit');
const { seesAllLocations } = require('../lib/auth');
const { normSlug } = require('../lib/slug');
const toastSync = require('../lib/toastSync');

const router = express.Router();

// Resolve a per-location kiosk slug (e.g. /sflow/fountainvalley) to a location, matching the
// slug column or the name, punctuation- and case-insensitively — same as the scanner/clock kiosks.
const locDisplay = (name) => String(name || '').replace(/\s*[—–-]\s*/, ' ');
const locBySlug = (slug) => db.prepare(`SELECT id, name, slug FROM locations WHERE is_active=1`).all()
  .find(l => normSlug(l.slug || '') === normSlug(slug) || normSlug(l.name) === normSlug(slug)) || null;

// Light per-IP abuse guard (same shape as the other kiosks).
const rate = new Map();
router.use((req, res, next) => {
  const ip = req.ip || 'x', now = Date.now(), e = rate.get(ip);
  if (!e || now - e.t > 60000) { rate.set(ip, { n: 1, t: now }); return next(); }
  if (e.n >= 120) return res.status(429).json({ ok: false, error: 'Too many attempts — please wait a moment.' });
  e.n++; next();
});

const auditReq = (staff, body) => ({ user: { id: staff.id }, body });
const validCode = (c) => /^[A-Za-z0-9-]{4,20}$/.test(String(c || '').trim());
function staffByCode(code) {
  const c = String(code || '').trim();
  if (!validCode(c)) return null;
  return db.prepare(`SELECT id, name, role, location_id FROM users WHERE employee_code=? AND is_active=1`).get(c) || null;
}
// Every store this person can work: home + additional (staff_locations); all-location roles get
// every Toast-mapped store.
function staffStoreIds(staff) {
  if (seesAllLocations(staff.role)) return db.prepare(`SELECT location_id FROM toast_locations WHERE active=1`).all().map(r => r.location_id);
  const set = new Set();
  if (staff.location_id) set.add(Number(staff.location_id));
  try { db.prepare(`SELECT location_id FROM staff_locations WHERE user_id=?`).all(staff.id).forEach(r => set.add(Number(r.location_id))); } catch { /* table absent */ }
  return [...set];
}
// Among those, the ones with Service Flow currently ON (rows: {id, name}).
function onStores(staff) {
  const ids = staffStoreIds(staff);
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  try {
    return db.prepare(`SELECT tl.location_id AS id, l.name FROM toast_locations tl JOIN locations l ON l.id=tl.location_id
      WHERE tl.service_flow_on=1 AND tl.active=1 AND tl.location_id IN (${ph}) ORDER BY l.name`).all(...ids);
  } catch { return []; }
}
const authorizedAt = (staff, locId) => seesAllLocations(staff.role) || String(staff.location_id) === String(locId)
  || !!db.prepare(`SELECT 1 FROM staff_locations WHERE user_id=? AND location_id=?`).get(staff.id, locId);
const locName = (id) => (db.prepare(`SELECT name FROM locations WHERE id=?`).get(id) || {}).name || '';

// Identify: employee code → your name. A per-location link (?slug) PINS the store — we just
// confirm the staffer is assigned there and whether it's on. The bare link returns their own
// stores (with Service Flow on) so the page can offer a picker.
router.post('/identify', (req, res) => {
  const staff = staffByCode(req.body && req.body.code);
  if (!staff) return res.json({ ok: false, error: 'Employee code not found. Please check it, or ask your manager.' });
  const slug = req.body && req.body.slug;
  if (slug) {
    const loc = locBySlug(slug);
    if (!loc) return res.json({ ok: false, error: 'This Service Flow link points to an unknown location.' });
    if (!authorizedAt(staff, loc.id)) return res.json({ ok: false, error: `You’re not assigned to ${locDisplay(loc.name)}, so you can’t manage its Service Flow.` });
    const cfg = db.prepare(`SELECT service_flow_on FROM toast_locations WHERE location_id=? AND active=1`).get(loc.id);
    return res.json({ ok: true, name: staff.name, pinned: { id: loc.id, name: loc.name, on: !!(cfg && cfg.service_flow_on) } });
  }
  res.json({ ok: true, name: staff.name, stores: onStores(staff) });
});

// Board for a store — pinned by ?slug (per-location link) or chosen by ?location_id (bare link).
// The code is re-checked on every call — the kiosk keeps no session.
router.get('/board', (req, res) => {
  const staff = staffByCode(req.query.code);
  if (!staff) return res.status(401).json({ ok: false, error: 'Employee code not found.' });
  const pinned = req.query.slug ? locBySlug(req.query.slug) : null;
  const stores = req.query.slug ? [] : onStores(staff);
  const loc = pinned ? pinned.id : (parseInt(req.query.location_id, 10) || (stores[0] || {}).id || null);
  if (!loc || !authorizedAt(staff, loc)) return res.json({ ok: true, enabled: false, stores, tables: [], counts: { total: 0 }, location_name: loc ? locName(loc) : null });
  const cfg = db.prepare(`SELECT service_flow_on FROM toast_locations WHERE location_id=? AND active=1`).get(loc);
  if (!cfg || !cfg.service_flow_on) return res.json({ ok: true, enabled: false, location_id: loc, location_name: locName(loc), stores, tables: [], counts: { total: 0 } });
  const flow = toastSync.computeServiceFlow(loc);
  res.json({ ok: true, enabled: true, location_id: loc, location_name: locName(loc), stores, ...flow });
});

const flowLoc = (guid) => (db.prepare(`SELECT location_id FROM toast_orders WHERE guid=?`).get(guid) || {}).location_id;
const upServed = db.prepare(`INSERT INTO toast_flow_state (order_guid, location_id, served_at, served_by, updated_at)
  VALUES (@g,@l,@a,@b,datetime('now')) ON CONFLICT(order_guid) DO UPDATE SET served_at=@a, served_by=@b, updated_at=datetime('now')`);
const upBussed = db.prepare(`INSERT INTO toast_flow_state (order_guid, location_id, bussed_at, bussed_by, updated_at)
  VALUES (@g,@l,@a,@b,datetime('now')) ON CONFLICT(order_guid) DO UPDATE SET bussed_at=@a, bussed_by=@b, updated_at=datetime('now')`);

router.post('/served/:guid', (req, res) => {
  const staff = staffByCode(req.body && req.body.code);
  if (!staff) return res.status(401).json({ error: 'Employee code not found.' });
  const loc = flowLoc(req.params.guid);
  if (!loc) return res.status(404).json({ error: 'Order not found.' });
  if (!authorizedAt(staff, loc)) return res.status(403).json({ error: 'You’re not assigned to this store.' });
  const clear = req.body && req.body.clear;
  upServed.run({ g: req.params.guid, l: loc, a: clear ? null : new Date().toISOString(), b: clear ? null : staff.id });
  auditLog(auditReq(staff, req.body), 'flow_served', 'toast', req.params.guid, { via: 'sf_kiosk', clear: !!clear });
  res.json({ success: true, served: !clear });
});
router.post('/done/:guid', (req, res) => {
  const staff = staffByCode(req.body && req.body.code);
  if (!staff) return res.status(401).json({ error: 'Employee code not found.' });
  const loc = flowLoc(req.params.guid);
  if (!loc) return res.status(404).json({ error: 'Order not found.' });
  if (!authorizedAt(staff, loc)) return res.status(403).json({ error: 'You’re not assigned to this store.' });
  upBussed.run({ g: req.params.guid, l: loc, a: new Date().toISOString(), b: staff.id });
  auditLog(auditReq(staff, req.body), 'flow_bussed', 'toast', req.params.guid, { via: 'sf_kiosk' });
  res.json({ success: true, done: true });
});
// Guest left before ordering: clear a "Seated" party and free its table.
router.post('/seated-left/:vid', (req, res) => {
  const staff = staffByCode(req.body && req.body.code);
  if (!staff) return res.status(401).json({ error: 'Employee code not found.' });
  const { clearSeatedVisit, seatedVisitLocation } = require('../lib/seated');
  const loc = seatedVisitLocation(req.params.vid);
  if (!loc) return res.status(404).json({ error: 'That seating was already cleared.' });
  if (!authorizedAt(staff, loc)) return res.status(403).json({ error: 'You’re not assigned to this store.' });
  const r = clearSeatedVisit(req.params.vid, { name: staff.name, role: staff.role });
  if (!r.ok) return res.status(r.code || 400).json({ error: r.error });
  auditLog(auditReq(staff, req.body), 'flow_seated_left', 'visit', req.params.vid, { via: 'sf_kiosk', table: r.table_name });
  res.json({ success: true });
});

module.exports = router;
