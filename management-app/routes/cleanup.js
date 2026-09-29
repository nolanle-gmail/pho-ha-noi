// Busser Cleanup board (/cleanup/<slug>) — a no-login, always-on tablet near the kitchen that
// shows ONLY tables that are ready to bus for one store. A busser taps "On It" to claim a table
// (so others know it's being handled), then "Done" to clear it. No employee code: the tablet is
// pinned to a store by its URL slug, like the clock kiosk, and busses have messy hands. The
// board reads the same live state as Service Flow (a table is ready to bus when it's paid and
// not yet bussed) and marking Done here clears it from every Service Flow board too.
const express = require('express');
const db = require('../db/database');
const { normSlug } = require('../lib/slug');
const toastSync = require('../lib/toastSync');

const router = express.Router();

// Light per-IP abuse guard.
const rate = new Map();
router.use((req, res, next) => {
  const ip = req.ip || 'x', now = Date.now(), e = rate.get(ip);
  if (!e || now - e.t > 60000) { rate.set(ip, { n: 1, t: now }); return next(); }
  if (e.n >= 240) return res.status(429).json({ ok: false, error: 'Too many requests — please wait a moment.' });
  e.n++; next();
});

const locDisplay = (name) => String(name || '').replace(/\s*[—–-]\s*/, ' ');
const locBySlug = (slug) => db.prepare(`SELECT id, name, slug FROM locations WHERE is_active=1`).all()
  .find(l => normSlug(l.slug || '') === normSlug(slug) || normSlug(l.name) === normSlug(slug)) || null;
const flowOn = (locId) => { const c = db.prepare(`SELECT service_flow_on FROM toast_locations WHERE location_id=? AND active=1`).get(locId); return !!(c && c.service_flow_on); };
const flowLoc = (guid) => (db.prepare(`SELECT location_id FROM toast_orders WHERE guid=?`).get(guid) || {}).location_id;

// Locations running Service Flow (for the bare /cleanup picker).
router.get('/locations', (req, res) => {
  const rows = db.prepare(`SELECT l.id, l.name, l.slug FROM toast_locations tl JOIN locations l ON l.id=tl.location_id
    WHERE tl.service_flow_on=1 AND tl.active=1 AND l.is_active=1 ORDER BY l.name`).all();
  res.json({ ok: true, locations: rows.map(r => ({ id: r.id, name: r.name, slug: r.slug })) });
});

// The board: ready-to-bus tables for one store (pinned by slug).
router.get('/board', (req, res) => {
  const loc = locBySlug(req.query.slug);
  if (!loc) return res.status(404).json({ ok: false, error: 'Unknown Cleanup board link.' });
  if (!flowOn(loc.id)) return res.json({ ok: true, enabled: false, location_id: loc.id, location_name: loc.name, tables: [], count: 0 });
  const flow = toastSync.computeServiceFlow(loc.id);
  const tables = flow.tables.filter(t => t.state === 'ready_to_bus').map(t => ({
    order_guid: t.order_guid, table_name: t.table_name, server_name: t.server_name,
    minutes_paid: t.minutes_paid, claimed: !!t.bus_claimed_at, minutes_claimed: t.minutes_claimed,
  }));
  res.json({ ok: true, enabled: true, location_id: loc.id, location_name: loc.name, tables, count: tables.length, updated_at: flow.updated_at });
});

// Claim ("On It") — keep the earliest claim if two bussers tap. Release clears it (mis-tap).
const upClaim = db.prepare(`INSERT INTO toast_flow_state (order_guid, location_id, bus_claimed_at, updated_at)
  VALUES (@g,@l,@a,datetime('now'))
  ON CONFLICT(order_guid) DO UPDATE SET bus_claimed_at=COALESCE(toast_flow_state.bus_claimed_at,@a), updated_at=datetime('now')`);
const upBussed = db.prepare(`INSERT INTO toast_flow_state (order_guid, location_id, bussed_at, bussed_by, updated_at)
  VALUES (@g,@l,@a,NULL,datetime('now'))
  ON CONFLICT(order_guid) DO UPDATE SET bussed_at=@a, updated_at=datetime('now')`);

// Guard: the order must exist and (when a slug is sent) belong to that board's store, and the
// store must be running Service Flow. Returns the location id or sends an error.
function actLoc(req, res) {
  const loc = flowLoc(req.params.guid);
  if (!loc) { res.status(404).json({ error: 'Table not found.' }); return null; }
  if (req.body && req.body.slug) { const l = locBySlug(req.body.slug); if (l && String(l.id) !== String(loc)) { res.status(403).json({ error: 'That table isn’t at this store.' }); return null; } }
  if (!flowOn(loc)) { res.status(400).json({ error: 'This store isn’t running Service Flow right now.' }); return null; }
  return loc;
}

router.post('/claim/:guid', (req, res) => {
  const loc = actLoc(req, res); if (loc == null) return;
  upClaim.run({ g: req.params.guid, l: loc, a: new Date().toISOString() });
  res.json({ success: true, claimed: true });
});
router.post('/release/:guid', (req, res) => {
  const loc = actLoc(req, res); if (loc == null) return;
  db.prepare(`UPDATE toast_flow_state SET bus_claimed_at=NULL, updated_at=datetime('now') WHERE order_guid=?`).run(req.params.guid);
  res.json({ success: true, claimed: false });
});
router.post('/done/:guid', (req, res) => {
  const loc = actLoc(req, res); if (loc == null) return;
  upBussed.run({ g: req.params.guid, l: loc, a: new Date().toISOString() });
  res.json({ success: true, done: true });
});

module.exports = router;
