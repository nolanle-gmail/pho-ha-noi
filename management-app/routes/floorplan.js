// Floor plan — the single source of truth for a location's areas, tables (with
// map positions + wall outline) and live seating status. The Management "Floor
// Plan" tab edits it; the Waitlist Front Desk reads/seats through it via a shared
// service key. Layout editing is manager+; viewing and seating are open to
// managers and to the service key (the Waitlist server scopes it to a location).
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations, SECRET } = require('../lib/auth');
const jwt = require('jsonwebtoken');
const { auditLog } = require('../lib/audit');

const router = express.Router();

const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';
const STATUSES = ['available', 'waiting_to_order', 'served', 'waiting_to_pay', 'cleaning'];
const DINE_MIN = 75; // typical time from seating to free

// Auth: a valid manager JWT, OR the Waitlist service key (view + seat only).
function auth(req, res, next) {
  const key = req.headers['x-service-key'];
  if (key && key === SERVICE_KEY) { req.service = true; return next(); }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try { req.user = jwt.verify(token, SECRET); next(); } catch { return res.status(401).json({ error: 'Invalid or expired session' }); }
}
router.use(auth);

const isManage = (req) => req.user && ROLES.MANAGE.includes(req.user.role);
const ownsLocation = (req, locId) => req.service || seesAllLocations(req.user.role) || String(req.user.location_id) === String(locId);
const reqLoc = (req, fromQuery) => {
  const asked = fromQuery ? req.query.location_id : req.body.location_id;
  if (asked) return asked; // ownsLocation() then enforces access
  if (req.service || seesAllLocations(req.user && req.user.role)) return null;
  return req.user.location_id;
};
const requireEdit = (req, res, next) => (isManage(req) ? next() : res.status(403).json({ error: 'Only a manager can change the floor plan.' }));
const requireView = (req, res, next) => (req.service || isManage(req) ? next() : res.status(403).json({ error: 'You do not have access to the floor plan.' }));
const clampPos = (v, fb) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(2, Math.min(98, n)) : Math.round(fb); };
const DEFAULT_OUTLINE = [{ x: 3, y: 4 }, { x: 97, y: 4 }, { x: 97, y: 96 }, { x: 3, y: 96 }];
const roomOutline = (raw) => { try { const p = JSON.parse(raw); if (Array.isArray(p) && p.length >= 3) return p.map(v => ({ x: Math.max(0, Math.min(100, +v.x)), y: Math.max(0, Math.min(100, +v.y)) })); } catch { /* */ } return DEFAULT_OUTLINE; };
const minutesToFree = (est) => est ? Math.max(0, Math.round((new Date(est).getTime() - Date.now()) / 60000)) : null;
// Estimated time-until-free when a table enters a status.
function estFor(status, seatedAtISO) {
  const now = Date.now();
  if (status === 'waiting_to_pay') return new Date(now + 15 * 60000).toISOString();
  if (status === 'cleaning') return new Date(now + 8 * 60000).toISOString();
  if (status === 'waiting_to_order' || status === 'served') return new Date((seatedAtISO ? new Date(seatedAtISO).getTime() : now) + DINE_MIN * 60000).toISOString();
  return null;
}

// ── Read: areas + tables + live status + room outline ────────────────────────
router.get('/', requireView, (req, res) => {
  const locId = parseInt(reqLoc(req, true), 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const loc = db.prepare(`SELECT id, name, room_outline FROM locations WHERE id=?`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const areas = db.prepare(`SELECT id, name, sort_order FROM floor_areas WHERE location_id=? ORDER BY sort_order, name`).all(locId);
  const tables = db.prepare(`SELECT id, area_id, label, seats, is_active, sort_order, pos_x, pos_y, shape, status, guest_name, party_size, seated_at, est_free_at
    FROM restaurant_tables WHERE location_id=? ORDER BY sort_order, id`).all(locId);
  // Active guest visit per table → surface the server + check timer on the map.
  const visitByTable = {};
  try {
    db.prepare(`SELECT table_id, server_name, stage, next_check_at FROM service_visits
      WHERE location_id=? AND table_id IS NOT NULL AND stage IN ('seated','in_service','paying')`).all(locId)
      .forEach(v => { visitByTable[v.table_id] = v; });
  } catch { /* service_visits not present yet */ }
  const mapT = (t) => {
    const v = visitByTable[t.id];
    const toCheck = v && v.stage === 'in_service' && v.next_check_at ? Math.round((new Date(v.next_check_at).getTime() - Date.now()) / 60000) : null;
    return {
      id: t.id, area_id: t.area_id, label: t.label, seats: t.seats, is_active: t.is_active, sort_order: t.sort_order,
      pos_x: t.pos_x, pos_y: t.pos_y, shape: t.shape,
      status: t.status || 'available', occupied: (t.status && t.status !== 'available'),
      guest_name: t.guest_name || null, party_size: t.party_size || null, seated_at: t.seated_at || null,
      minutes_to_free: minutesToFree(t.est_free_at),
      server_name: v ? (v.server_name || null) : null, stage: v ? v.stage : null,
      minutes_to_check: toCheck, check_due: toCheck != null && toCheck <= 0,
    };
  };
  const all = tables.map(mapT);
  const byArea = areas.map(a => ({ id: a.id, name: a.name, sort_order: a.sort_order, tables: all.filter(t => t.area_id === a.id) }));
  const noArea = all.filter(t => !t.area_id);
  if (noArea.length) byArea.push({ id: null, name: 'Other', tables: noArea });
  const active = all.filter(t => t.is_active);
  res.json({
    location: { id: loc.id, name: loc.name }, can_edit: !!isManage(req), room_outline: roomOutline(loc.room_outline),
    areas: byArea, statuses: STATUSES,
    summary: { tables: active.length, available: active.filter(t => !t.occupied).length, occupied: active.filter(t => t.occupied).length },
  });
});

// Seating and status changes go through the guest-visit lifecycle (the single
// source of truth); the table's own status is only ever a projection of that,
// so a Front-Desk seat flows straight into the Service lists for a server.
const nowISO = () => new Date().toISOString();
const STAGE_STATUS = { seated: 'waiting_to_order', in_service: 'served', paying: 'waiting_to_pay' };
const STATUS_STAGE = { waiting_to_order: 'seated', served: 'in_service', waiting_to_pay: 'paying' };
const actorName = (req) => req.user ? req.user.name : ((req.body && req.body.actor_name) || 'Front Desk');
const actorRole = (req) => req.user ? req.user.role : ((req.body && req.body.actor_role) || 'service');
const activeVisitFor = (tableId) => db.prepare(`SELECT * FROM service_visits WHERE table_id=? AND stage IN ('seated','in_service','paying') ORDER BY id DESC LIMIT 1`).get(tableId);
function logVisitEvent(visitId, locId, event, from, to, req) {
  try { db.prepare(`INSERT INTO visit_events (visit_id, location_id, event, from_stage, to_stage, actor_name, actor_role) VALUES (?,?,?,?,?,?,?)`).run(visitId, locId, event, from || null, to || null, actorName(req), actorRole(req)); } catch { /* events optional */ }
}
function syncTableFromStage(t, stage, v) {
  if (stage === 'done' || stage === 'canceled') { db.prepare(`UPDATE restaurant_tables SET status='available', guest_name=NULL, party_size=NULL, seated_at=NULL, est_free_at=NULL WHERE id=?`).run(t.id); return; }
  const status = STAGE_STATUS[stage]; if (!status) return;
  db.prepare(`UPDATE restaurant_tables SET status=?, guest_name=?, party_size=?, seated_at=COALESCE(seated_at,?), est_free_at=? WHERE id=?`)
    .run(status, v.guest_name, v.party_size, v.seated_at, estFor(status, v.seated_at), t.id);
}

// ── Seat a guest at a table → creates a 'seated' visit and occupies the table ─
router.put('/tables/:id/seat', requireView, (req, res) => {
  const t = db.prepare(`SELECT * FROM restaurant_tables WHERE id=?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Table not found.' });
  if (!ownsLocation(req, t.location_id)) return res.status(403).json({ error: 'Not your location.' });
  if (req.service && req.body.location_id && String(t.location_id) !== String(req.body.location_id)) return res.status(403).json({ error: 'Table is not at this location.' });
  if ((t.status && t.status !== 'available') || activeVisitFor(t.id)) return res.status(409).json({ error: `Table ${t.label} is already occupied.` });
  const guest = (req.body.guest_name || '').toString().slice(0, 60) || null;
  const size = req.body.party_size ? Math.max(1, parseInt(req.body.party_size, 10)) : null;
  const source = req.body.source === 'waitlist' ? 'waitlist' : 'walkin';
  const now = nowISO();
  const info = db.prepare(`INSERT INTO service_visits (location_id, source, guest_name, party_size, stage, table_id, waitlist_ref, seated_at, created_at)
    VALUES (?,?,?,?, 'seated', ?, ?, ?, ?)`).run(t.location_id, source, guest, size, t.id, req.body.waitlist_ref || null, now, now);
  const v = db.prepare(`SELECT * FROM service_visits WHERE id=?`).get(info.lastInsertRowid);
  logVisitEvent(v.id, t.location_id, 'created', null, 'waiting', req);
  logVisitEvent(v.id, t.location_id, 'seated', 'waiting', 'seated', req);
  syncTableFromStage(t, 'seated', v);
  auditLog(req, 'table_seat', 'table', t.id, { location_id: t.location_id, label: t.label, guest, visit_id: v.id });
  res.json({ success: true, status: 'waiting_to_order', visit_id: v.id });
});

// ── Advance / change a table's status (available clears it) → drives the visit ─
router.put('/tables/:id/status', requireView, (req, res) => {
  const t = db.prepare(`SELECT * FROM restaurant_tables WHERE id=?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Table not found.' });
  if (!ownsLocation(req, t.location_id)) return res.status(403).json({ error: 'Not your location.' });
  const status = req.body.status;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  const v = activeVisitFor(t.id);
  const now = nowISO();
  if (status === 'available' || status === 'cleaning') {
    if (v) { db.prepare(`UPDATE service_visits SET stage='done', done_at=?, next_check_at=NULL WHERE id=?`).run(now, v.id); logVisitEvent(v.id, t.location_id, 'done', v.stage, 'done', req); }
    if (status === 'available') db.prepare(`UPDATE restaurant_tables SET status='available', guest_name=NULL, party_size=NULL, seated_at=NULL, est_free_at=NULL WHERE id=?`).run(t.id);
    else db.prepare(`UPDATE restaurant_tables SET status='cleaning', est_free_at=? WHERE id=?`).run(estFor('cleaning', t.seated_at), t.id);
  } else if (v && STATUS_STAGE[status]) {
    const stage = STATUS_STAGE[status];
    const sets = ['stage=?'], args = [stage];
    if (stage === 'in_service') { sets.push('service_started_at=COALESCE(service_started_at,?)', 'next_check_at=?'); args.push(now, new Date(Date.now() + (v.check_interval_min || 10) * 60000).toISOString()); }
    if (stage === 'paying') { sets.push('paying_at=?', 'next_check_at=NULL'); args.push(now); }
    db.prepare(`UPDATE service_visits SET ${sets.join(',')} WHERE id=?`).run(...args, v.id);
    logVisitEvent(v.id, t.location_id, stage, v.stage, stage, req);
    syncTableFromStage(t, stage, db.prepare(`SELECT * FROM service_visits WHERE id=?`).get(v.id));
  } else {
    // Legacy table with no active visit — set the projection directly.
    db.prepare(`UPDATE restaurant_tables SET status=?, est_free_at=? WHERE id=?`).run(status, estFor(status, t.seated_at), t.id);
  }
  auditLog(req, 'table_status', 'table', t.id, { location_id: t.location_id, label: t.label, status });
  res.json({ success: true, status });
});

// ── Layout editing (manager+; not the service key) ───────────────────────────
router.put('/room', requireEdit, (req, res) => {
  const locId = parseInt(reqLoc(req, false), 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const pts = req.body.outline;
  if (!Array.isArray(pts) || pts.length < 3 || pts.length > 40) return res.status(400).json({ error: 'An outline needs 3–40 points.' });
  const clean = pts.map(p => ({ x: Math.max(0, Math.min(100, Math.round(+p.x))), y: Math.max(0, Math.min(100, Math.round(+p.y))) }));
  db.prepare(`UPDATE locations SET room_outline=? WHERE id=?`).run(JSON.stringify(clean), locId);
  res.json({ success: true, outline: clean });
});
router.post('/areas', requireEdit, (req, res) => {
  const locId = parseInt(reqLoc(req, false), 10);
  const name = (req.body.name || '').toString().trim();
  if (!locId || !name) return res.status(400).json({ error: 'location and name are required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const sort = db.prepare(`SELECT COALESCE(MAX(sort_order)+1,0) s FROM floor_areas WHERE location_id=?`).get(locId).s;
  const id = db.prepare(`INSERT INTO floor_areas (location_id, name, sort_order) VALUES (?,?,?)`).run(locId, name, sort).lastInsertRowid;
  auditLog(req, 'area_add', 'floor_area', id, { location_id: locId, name });
  res.json({ success: true, id });
});
router.put('/areas/:id', requireEdit, (req, res) => {
  const a = db.prepare(`SELECT * FROM floor_areas WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Area not found.' });
  if (!ownsLocation(req, a.location_id)) return res.status(403).json({ error: 'Not your location.' });
  const name = (req.body.name || a.name).toString().trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  db.prepare(`UPDATE floor_areas SET name=? WHERE id=?`).run(name, a.id);
  res.json({ success: true });
});
router.delete('/areas/:id', requireEdit, (req, res) => {
  const a = db.prepare(`SELECT * FROM floor_areas WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Area not found.' });
  if (!ownsLocation(req, a.location_id)) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`DELETE FROM restaurant_tables WHERE area_id=?`).run(a.id);
  db.prepare(`DELETE FROM floor_areas WHERE id=?`).run(a.id);
  auditLog(req, 'area_remove', 'floor_area', a.id, { location_id: a.location_id, name: a.name });
  res.json({ success: true });
});
router.post('/tables', requireEdit, (req, res) => {
  const locId = parseInt(reqLoc(req, false), 10);
  const label = (req.body.label || '').toString().trim().slice(0, 20);
  const seats = Math.max(1, Math.min(50, parseInt(req.body.seats, 10) || 2));
  const areaId = req.body.area_id ? parseInt(req.body.area_id, 10) : null;
  if (!locId || !label) return res.status(400).json({ error: 'location and table label are required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  if (areaId) { const a = db.prepare(`SELECT location_id FROM floor_areas WHERE id=?`).get(areaId); if (!a || String(a.location_id) !== String(locId)) return res.status(400).json({ error: 'Area is not at this location.' }); }
  const sort = db.prepare(`SELECT COALESCE(MAX(sort_order)+1,0) s FROM restaurant_tables WHERE location_id=?`).get(locId).s;
  const shape = req.body.shape === 'square' ? 'square' : 'round';
  const id = db.prepare(`INSERT INTO restaurant_tables (location_id, area_id, label, seats, sort_order, pos_x, pos_y, shape) VALUES (?,?,?,?,?,?,?,?)`)
    .run(locId, areaId, label, seats, sort, clampPos(req.body.pos_x, 50 + (Math.random() * 8 - 4)), clampPos(req.body.pos_y, 50 + (Math.random() * 8 - 4)), shape).lastInsertRowid;
  auditLog(req, 'table_add', 'table', id, { location_id: locId, label });
  res.json({ success: true, id });
});
router.put('/tables/:id', requireEdit, (req, res) => {
  const t = db.prepare(`SELECT * FROM restaurant_tables WHERE id=?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Table not found.' });
  if (!ownsLocation(req, t.location_id)) return res.status(403).json({ error: 'Not your location.' });
  const label = req.body.label !== undefined ? (req.body.label || '').toString().trim().slice(0, 20) : t.label;
  if (!label) return res.status(400).json({ error: 'Label is required.' });
  const seats = req.body.seats !== undefined ? Math.max(1, Math.min(50, parseInt(req.body.seats, 10) || t.seats)) : t.seats;
  const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : t.is_active;
  const shape = req.body.shape !== undefined ? (req.body.shape === 'square' ? 'square' : 'round') : t.shape;
  const px = req.body.pos_x !== undefined ? clampPos(req.body.pos_x, t.pos_x) : t.pos_x;
  const py = req.body.pos_y !== undefined ? clampPos(req.body.pos_y, t.pos_y) : t.pos_y;
  let areaId = t.area_id;
  if (req.body.area_id !== undefined) {
    areaId = req.body.area_id ? parseInt(req.body.area_id, 10) : null;
    if (areaId) { const a = db.prepare(`SELECT location_id FROM floor_areas WHERE id=?`).get(areaId); if (!a || String(a.location_id) !== String(t.location_id)) return res.status(400).json({ error: 'Area is not at this location.' }); }
  }
  db.prepare(`UPDATE restaurant_tables SET label=?, seats=?, is_active=?, area_id=?, pos_x=?, pos_y=?, shape=? WHERE id=?`).run(label, seats, isActive, areaId, px, py, shape, t.id);
  res.json({ success: true });
});
router.delete('/tables/:id', requireEdit, (req, res) => {
  const t = db.prepare(`SELECT * FROM restaurant_tables WHERE id=?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Table not found.' });
  if (!ownsLocation(req, t.location_id)) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`DELETE FROM restaurant_tables WHERE id=?`).run(t.id);
  auditLog(req, 'table_remove', 'table', t.id, { location_id: t.location_id, label: t.label });
  res.json({ success: true });
});

module.exports = router;
