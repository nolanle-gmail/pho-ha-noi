// Locations module — location records, operating hours, staff, and equipment
// (with vendor + maintenance tracking). Owner/admin manage everything; managers
// view/manage their own location's hours & equipment.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations } = require('../lib/auth');
const { auditLog } = require('../lib/audit');

const router = express.Router();
router.use(verifyToken);

const isAdmin = (req) => seesAllLocations(req.user.role);
function ownsLocation(req, locId) {
  return isAdmin(req) || String(req.user.location_id) === String(locId);
}
function locationOf(equipmentId) {
  const e = db.prepare(`SELECT location_id FROM equipment WHERE id=?`).get(equipmentId);
  return e ? e.location_id : null;
}

// ── Directory ────────────────────────────────────────────────────────────────
router.get('/', requireRole(...ROLES.MANAGE), (req, res) => {
  const where = isAdmin(req) ? '' : 'WHERE l.id=?';
  const args = isAdmin(req) ? [] : [req.user.location_id];
  const rows = db.prepare(`
    SELECT l.*,
      (SELECT name FROM users WHERE role='manager' AND location_id=l.id AND is_active=1 LIMIT 1) AS manager_name,
      (SELECT COUNT(*) FROM users WHERE location_id=l.id AND is_active=1) AS staff_count,
      (SELECT COUNT(*) FROM equipment WHERE location_id=l.id) AS equipment_count,
      (SELECT COUNT(*) FROM equipment WHERE location_id=l.id AND status<>'operational') AS equipment_issues
    FROM locations l ${where} ORDER BY l.name
  `).all(...args);
  res.json(rows);
});

// ── Detail (info + hours + manager) ──────────────────────────────────────────
router.get('/:id', requireRole(...ROLES.MANAGE), (req, res) => {
  if (!ownsLocation(req, req.params.id)) return res.status(403).json({ error: 'Not your location.' });
  const loc = db.prepare(`SELECT * FROM locations WHERE id=?`).get(req.params.id);
  if (!loc) return res.status(404).json({ error: 'Location not found' });
  const hours = db.prepare(`SELECT day_of_week, open_time, close_time, is_closed FROM location_hours WHERE location_id=? ORDER BY day_of_week`).all(loc.id);
  const manager = db.prepare(`SELECT name, email FROM users WHERE role='manager' AND location_id=? AND is_active=1 LIMIT 1`).get(loc.id);
  res.json({ ...loc, hours, manager });
});

// Staff at a location.
router.get('/:id/staff', requireRole(...ROLES.MANAGE), (req, res) => {
  if (!ownsLocation(req, req.params.id)) return res.status(403).json({ error: 'Not your location.' });
  res.json(db.prepare(`SELECT id, name, email, employee_code, role, is_active FROM users WHERE location_id=?
    ORDER BY CASE role WHEN 'manager' THEN 0 WHEN 'support' THEN 1 ELSE 2 END, name`).all(req.params.id));
});

// ── Activity trail for this location — merges the Management audit trail with
// the Staff-app (front-of-house) activity, filterable by day / week / month.
// Owner / Admin / General Manager see any location; a manager only their own.
const WAITLIST_URL = (process.env.WAITLIST_URL || 'http://localhost:4002').replace(/\/$/, '');
const ACTIVITY_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';
const activitySince = (range) => { const days = { day: 1, week: 7, month: 30 }[range]; return days ? new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19) : null; };

router.get('/:id/activity', requireRole('owner', 'admin', 'general_manager', 'manager'), async (req, res) => {
  const locId = parseInt(req.params.id, 10);
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const range = ['day', 'week', 'month', 'all'].includes(req.query.range) ? req.query.range : 'day';
  const since = activitySince(range);
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 500);

  // This app's own audit trail for the location.
  const conds = ['location_id=?'], args = [locId];
  if (since) { conds.push('created_at >= ?'); args.push(since); }
  const mgmt = db.prepare(`SELECT id, user_id, user_name, user_role, method, path, status, ip, detail, location_id, created_at
    FROM activity_log WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`).all(...args)
    .map(r => { let d = null; try { d = r.detail ? JSON.parse(r.detail) : null; } catch { d = null; } return { ...r, detail: d, source: 'management' }; });

  // The Staff app's front-of-house activity for the same location + range.
  let front = [];
  try {
    const url = `${WAITLIST_URL}/api/activity-feed?location_id=${locId}&range=${range}&limit=${limit}`;
    const r = await fetch(url, { headers: { 'X-Service-Key': ACTIVITY_KEY } });
    if (r.ok) front = await r.json();
  } catch { /* Staff app unreachable — show Management activity only */ }

  const merged = [...mgmt, ...front].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
  res.json(merged);
});

// ── Create / edit location (owner/admin) ─────────────────────────────────────
const LOC_FIELDS = ['name', 'address', 'city', 'state', 'zip', 'phone', 'email', 'timezone', 'opening_date'];
router.post('/', requireRole(...ROLES.ADMIN), (req, res) => {
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Location name is required.' });
  const status = ['active', 'draft', 'closed'].includes(req.body.status) ? req.body.status : 'active';
  const r = db.prepare(`INSERT INTO locations (name,address,city,state,zip,phone,email,timezone,opening_date,seats,status,is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    name, req.body.address || null, req.body.city || null, req.body.state || null, req.body.zip || null,
    req.body.phone || null, req.body.email || null, req.body.timezone || 'America/Los_Angeles',
    req.body.opening_date || null, parseInt(req.body.seats) || 0, status, status === 'active' ? 1 : 0);
  // Default operating hours: 10:00–22:00 every day.
  const ih = db.prepare(`INSERT INTO location_hours (location_id,day_of_week,open_time,close_time,is_closed) VALUES (?,?,?,?,0)`);
  for (let d = 0; d < 7; d++) ih.run(r.lastInsertRowid, d, '10:00', '22:00');
  auditLog(req, 'location_create', 'location', r.lastInsertRowid, { name });
  res.json({ success: true, id: r.lastInsertRowid });
});

router.put('/:id', requireRole(...ROLES.ADMIN), (req, res) => {
  const loc = db.prepare(`SELECT * FROM locations WHERE id=?`).get(req.params.id);
  if (!loc) return res.status(404).json({ error: 'Location not found' });
  const fields = [], vals = [];
  LOC_FIELDS.forEach(k => { if (req.body[k] !== undefined) { fields.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (req.body.seats !== undefined) { fields.push('seats=?'); vals.push(parseInt(req.body.seats) || 0); }
  if (req.body.status !== undefined && ['active', 'draft', 'closed'].includes(req.body.status)) {
    fields.push('status=?'); vals.push(req.body.status);
    fields.push('is_active=?'); vals.push(req.body.status === 'active' ? 1 : 0);
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(loc.id);
  db.prepare(`UPDATE locations SET ${fields.join(',')} WHERE id=?`).run(...vals);
  auditLog(req, 'location_update', 'location', loc.id, { name: loc.name });
  res.json({ success: true });
});

// Operating hours — manager may set their own location's.
router.put('/:id/hours', requireRole(...ROLES.MANAGE), (req, res) => {
  if (!ownsLocation(req, req.params.id)) return res.status(403).json({ error: 'Not your location.' });
  const hours = Array.isArray(req.body.hours) ? req.body.hours : [];
  db.prepare(`DELETE FROM location_hours WHERE location_id=?`).run(req.params.id);
  const ins = db.prepare(`INSERT INTO location_hours (location_id,day_of_week,open_time,close_time,is_closed) VALUES (?,?,?,?,?)`);
  hours.forEach(h => ins.run(req.params.id, parseInt(h.day_of_week), h.open_time || null, h.close_time || null, h.is_closed ? 1 : 0));
  res.json({ success: true });
});

// ── Equipment ────────────────────────────────────────────────────────────────
router.get('/:id/equipment', requireRole(...ROLES.MANAGE), (req, res) => {
  if (!ownsLocation(req, req.params.id)) return res.status(403).json({ error: 'Not your location.' });
  res.json(db.prepare(`SELECT * FROM equipment WHERE location_id=? ORDER BY category, name`).all(req.params.id));
});

const EQ_FIELDS = ['name', 'category', 'model', 'serial', 'vendor', 'vendor_phone', 'purchase_date', 'warranty_expiry', 'maintenance_freq', 'last_service', 'next_service', 'notes'];
router.post('/:id/equipment', requireRole(...ROLES.MANAGE), (req, res) => {
  if (!ownsLocation(req, req.params.id)) return res.status(403).json({ error: 'Not your location.' });
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Equipment name is required.' });
  const cols = ['location_id', ...EQ_FIELDS, 'status'];
  const status = ['operational', 'needs_service', 'out_of_order'].includes(req.body.status) ? req.body.status : 'operational';
  const vals = [req.params.id, ...EQ_FIELDS.map(k => req.body[k] || null), status];
  const r = db.prepare(`INSERT INTO equipment (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  auditLog(req, 'equipment_create', 'equipment', r.lastInsertRowid, { name, location_id: Number(req.params.id) });
  res.json({ success: true, id: r.lastInsertRowid });
});

router.put('/equipment/:eid', requireRole(...ROLES.MANAGE), (req, res) => {
  const locId = locationOf(req.params.eid);
  if (locId == null) return res.status(404).json({ error: 'Equipment not found' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const fields = [], vals = [];
  EQ_FIELDS.forEach(k => { if (req.body[k] !== undefined) { fields.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (req.body.status !== undefined && ['operational', 'needs_service', 'out_of_order'].includes(req.body.status)) {
    fields.push('status=?'); vals.push(req.body.status);
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.eid);
  db.prepare(`UPDATE equipment SET ${fields.join(',')} WHERE id=?`).run(...vals);
  res.json({ success: true });
});

router.delete('/equipment/:eid', requireRole(...ROLES.MANAGE), (req, res) => {
  const locId = locationOf(req.params.eid);
  if (locId == null) return res.status(404).json({ error: 'Equipment not found' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`DELETE FROM equipment WHERE id=?`).run(req.params.eid);
  res.json({ success: true });
});

module.exports = router;
