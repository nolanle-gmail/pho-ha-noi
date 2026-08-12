// Floor plan — areas (Dining, Bar, Lounge, Patio…) and their numbered tables per
// location. The Front Desk picks a table here when seating a guest; managers and
// the owner configure the plan.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole } = require('../lib/auth');
const { auditLog } = require('../lib/audit');

const router = express.Router();
router.use(verifyToken);
const HOST = ['owner', 'manager', 'frontdesk'];
const EDIT = ['owner', 'manager'];

// Owner may target any location (via query/body); others are pinned to their own.
const loc = (req, fromQuery) => (req.user.role === 'owner' ? (fromQuery ? req.query.location_id : req.body.location_id) : req.user.location_id) || null;
const ownsLoc = (req, locId) => req.user.role === 'owner' || String(req.user.location_id) === String(locId);
const clampPos = (v, fallback) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(2, Math.min(98, n)) : Math.round(fallback); };

// Areas + tables with live occupancy — for the Front Desk table picker.
router.get('/tables', requireRole(...HOST), (req, res) => {
  const l = loc(req, true);
  if (!l) return res.status(400).json({ error: 'A location is required.' });
  if (!ownsLoc(req, l)) return res.status(403).json({ error: 'Not your location.' });
  const areas = db.prepare(`SELECT id, name FROM floor_areas WHERE location_id=? ORDER BY sort_order, name`).all(l);
  const tables = db.prepare(`SELECT id, area_id, label, seats, is_active, pos_x, pos_y, shape FROM restaurant_tables WHERE location_id=? AND is_active=1 ORDER BY sort_order, id`).all(l);
  const occ = {};
  for (const r of db.prepare(`SELECT table_number, guest_name FROM waitlist WHERE location_id=? AND status='seated' AND date(seated_at)=date('now') AND table_number IS NOT NULL AND table_number<>''`).all(l)) occ[String(r.table_number)] = r.guest_name;
  const mapT = (t) => ({ id: t.id, area_id: t.area_id, label: t.label, seats: t.seats, pos_x: t.pos_x, pos_y: t.pos_y, shape: t.shape, occupied: !!occ[t.label], guest: occ[t.label] || null });
  const byArea = areas.map(a => ({ id: a.id, name: a.name, tables: tables.filter(t => t.area_id === a.id).map(mapT) }));
  const noArea = tables.filter(t => !t.area_id).map(mapT);
  if (noArea.length) byArea.push({ id: null, name: 'Other', tables: noArea });
  res.json({ location_id: Number(l), areas: byArea, occupied_count: Object.keys(occ).length, table_count: tables.length });
});

// Full plan for management (includes inactive tables + sort orders).
router.get('/', requireRole(...HOST), (req, res) => {
  const l = loc(req, true);
  if (!l) return res.status(400).json({ error: 'A location is required.' });
  if (!ownsLoc(req, l)) return res.status(403).json({ error: 'Not your location.' });
  const areas = db.prepare(`SELECT id, name, sort_order FROM floor_areas WHERE location_id=? ORDER BY sort_order, name`).all(l);
  const tables = db.prepare(`SELECT id, area_id, label, seats, is_active, sort_order, pos_x, pos_y, shape FROM restaurant_tables WHERE location_id=? ORDER BY sort_order, id`).all(l);
  res.json({ location_id: Number(l), can_edit: EDIT.includes(req.user.role), areas: areas.map(a => ({ ...a, tables: tables.filter(t => t.area_id === a.id) })) });
});

// ── Areas ────────────────────────────────────────────────────────────────────
router.post('/areas', requireRole(...EDIT), (req, res) => {
  const locId = loc(req, false);
  const name = (req.body.name || '').toString().trim();
  if (!locId || !name) return res.status(400).json({ error: 'location and name are required.' });
  if (!ownsLoc(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const sort = db.prepare(`SELECT COALESCE(MAX(sort_order)+1,0) s FROM floor_areas WHERE location_id=?`).get(locId).s;
  const id = db.prepare(`INSERT INTO floor_areas (location_id, name, sort_order) VALUES (?,?,?)`).run(locId, name, sort).lastInsertRowid;
  auditLog(req, locId, 'area_add', id, { name });
  res.json({ success: true, id });
});
router.put('/areas/:id', requireRole(...EDIT), (req, res) => {
  const a = db.prepare(`SELECT * FROM floor_areas WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Area not found.' });
  if (!ownsLoc(req, a.location_id)) return res.status(403).json({ error: 'Not your location.' });
  const name = (req.body.name || a.name).toString().trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  db.prepare(`UPDATE floor_areas SET name=? WHERE id=?`).run(name, a.id);
  res.json({ success: true });
});
router.delete('/areas/:id', requireRole(...EDIT), (req, res) => {
  const a = db.prepare(`SELECT * FROM floor_areas WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Area not found.' });
  if (!ownsLoc(req, a.location_id)) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`DELETE FROM restaurant_tables WHERE area_id=?`).run(a.id);
  db.prepare(`DELETE FROM floor_areas WHERE id=?`).run(a.id);
  auditLog(req, a.location_id, 'area_remove', a.id, { name: a.name });
  res.json({ success: true });
});

// ── Tables ───────────────────────────────────────────────────────────────────
router.post('/tables', requireRole(...EDIT), (req, res) => {
  const locId = loc(req, false);
  const label = (req.body.label || '').toString().trim().slice(0, 20);
  const seats = Math.max(1, Math.min(50, parseInt(req.body.seats, 10) || 2));
  const areaId = req.body.area_id ? parseInt(req.body.area_id, 10) : null;
  if (!locId || !label) return res.status(400).json({ error: 'location and table label are required.' });
  if (!ownsLoc(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  if (areaId) { const a = db.prepare(`SELECT location_id FROM floor_areas WHERE id=?`).get(areaId); if (!a || String(a.location_id) !== String(locId)) return res.status(400).json({ error: 'Area is not at this location.' }); }
  const sort = db.prepare(`SELECT COALESCE(MAX(sort_order)+1,0) s FROM restaurant_tables WHERE location_id=?`).get(locId).s;
  const px = clampPos(req.body.pos_x, 50 + (Math.random() * 8 - 4));
  const py = clampPos(req.body.pos_y, 50 + (Math.random() * 8 - 4));
  const shape = req.body.shape === 'square' ? 'square' : 'round';
  const id = db.prepare(`INSERT INTO restaurant_tables (location_id, area_id, label, seats, sort_order, pos_x, pos_y, shape) VALUES (?,?,?,?,?,?,?,?)`).run(locId, areaId, label, seats, sort, px, py, shape).lastInsertRowid;
  auditLog(req, locId, 'table_add', id, { label, seats });
  res.json({ success: true, id });
});
router.put('/tables/:id', requireRole(...EDIT), (req, res) => {
  const t = db.prepare(`SELECT * FROM restaurant_tables WHERE id=?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Table not found.' });
  if (!ownsLoc(req, t.location_id)) return res.status(403).json({ error: 'Not your location.' });
  const label = req.body.label !== undefined ? (req.body.label || '').toString().trim().slice(0, 20) : t.label;
  if (!label) return res.status(400).json({ error: 'Label is required.' });
  const seats = req.body.seats !== undefined ? Math.max(1, Math.min(50, parseInt(req.body.seats, 10) || t.seats)) : t.seats;
  const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : t.is_active;
  let areaId = t.area_id;
  if (req.body.area_id !== undefined) {
    areaId = req.body.area_id ? parseInt(req.body.area_id, 10) : null;
    if (areaId) { const a = db.prepare(`SELECT location_id FROM floor_areas WHERE id=?`).get(areaId); if (!a || String(a.location_id) !== String(t.location_id)) return res.status(400).json({ error: 'Area is not at this location.' }); }
  }
  const px = req.body.pos_x !== undefined ? clampPos(req.body.pos_x, t.pos_x) : t.pos_x;
  const py = req.body.pos_y !== undefined ? clampPos(req.body.pos_y, t.pos_y) : t.pos_y;
  const shape = req.body.shape !== undefined ? (req.body.shape === 'square' ? 'square' : 'round') : t.shape;
  db.prepare(`UPDATE restaurant_tables SET label=?, seats=?, is_active=?, area_id=?, pos_x=?, pos_y=?, shape=? WHERE id=?`).run(label, seats, isActive, areaId, px, py, shape, t.id);
  res.json({ success: true });
});
router.delete('/tables/:id', requireRole(...EDIT), (req, res) => {
  const t = db.prepare(`SELECT * FROM restaurant_tables WHERE id=?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Table not found.' });
  if (!ownsLoc(req, t.location_id)) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`DELETE FROM restaurant_tables WHERE id=?`).run(t.id);
  auditLog(req, t.location_id, 'table_remove', t.id, { label: t.label });
  res.json({ success: true });
});

module.exports = router;
