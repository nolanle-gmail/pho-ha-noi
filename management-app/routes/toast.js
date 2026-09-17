// Toast POS integration — admin endpoints (owner / admin only). Phase 0: configure
// the location↔Toast-restaurant mapping and verify connectivity. All Toast access is
// read-only; credentials live in env / Fly secrets (see lib/toast.js), never here.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const toast = require('../lib/toast');
const toastSync = require('../lib/toastSync');

const router = express.Router();
router.use(verifyToken);
// Config, mapping and sync triggers are owner/admin only (financial config);
// read-only sales endpoints allow managers too, scoped to their own location.
const ADMIN = requireRole(ROLES.ADMIN);
const MANAGE = requireRole(ROLES.MANAGE);
const canSeeLoc = (req, locId) => seesAllLocations(req.user.role) || String(req.user.location_id) === String(locId);

// Pull a human-readable restaurant name out of Toast's restaurant-info response,
// whose shape can vary (general.name / locationName / name).
function restaurantName(info) {
  if (!info || typeof info !== 'object') return null;
  return (info.general && (info.general.name || info.general.locationName))
    || info.name || info.locationName || info.restaurantName || null;
}

const mappingsWithLoc = () => db.prepare(`
  SELECT tl.*, l.name AS location_name
  FROM toast_locations tl JOIN locations l ON l.id = tl.location_id
  ORDER BY l.name`).all();

// Whether Toast is configured, the target host, current mappings, and recent syncs.
router.get('/status', ADMIN, (req, res) => {
  res.json({
    configured: toast.toastEnabled(),
    host: toast.toastHost(),
    mappings: mappingsWithLoc(),
    recent_syncs: db.prepare(`SELECT id, domain, location_id, status, record_count, detail, started_at, finished_at
      FROM toast_sync_log ORDER BY id DESC LIMIT 20`).all(),
  });
});

// Verify connectivity: authenticate and fetch a restaurant's general info. Proves the
// credentials + a restaurant GUID work, WITHOUT importing any operational data.
// Body: { guid } — or omit to ping the first configured mapping.
router.post('/ping', ADMIN, async (req, res) => {
  if (!toast.toastEnabled()) return res.status(400).json({ error: 'Toast is not configured. Set TOAST_CLIENT_ID and TOAST_CLIENT_SECRET as Fly secrets.' });
  const guid = String(req.body.guid || (mappingsWithLoc()[0] || {}).toast_guid || '').trim();
  if (!guid) return res.status(400).json({ error: 'No restaurant GUID given and none mapped yet. Pass { "guid": "…" } or add a mapping first.' });
  const log = db.prepare(`INSERT INTO toast_sync_log (domain, toast_guid, status) VALUES ('ping', ?, 'running')`).run(guid);
  try {
    const info = await toast.getRestaurantInfo(guid);
    const name = restaurantName(info);
    db.prepare(`UPDATE toast_sync_log SET status='ok', record_count=1, detail=?, finished_at=datetime('now') WHERE id=?`)
      .run(name || 'ok', log.lastInsertRowid);
    auditLog(req, 'toast_ping', 'toast', guid, { name });
    res.json({ ok: true, guid, name, timeZone: info && (info.general && info.general.timeZone) });
  } catch (e) {
    db.prepare(`UPDATE toast_sync_log SET status='error', detail=?, finished_at=datetime('now') WHERE id=?`).run(String(e.message).slice(0, 500), log.lastInsertRowid);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// List the current location↔restaurant mappings.
router.get('/mappings', ADMIN, (req, res) => res.json(mappingsWithLoc()));

// Map (or re-map) one of our locations to a Toast restaurant GUID. Best-effort:
// also caches the restaurant name from Toast when reachable.
router.post('/map', ADMIN, async (req, res) => {
  const location_id = parseInt(req.body.location_id, 10);
  const toast_guid = String(req.body.toast_guid || '').trim();
  if (!location_id || !toast_guid) return res.status(400).json({ error: 'location_id and toast_guid are required.' });
  if (!db.prepare(`SELECT 1 FROM locations WHERE id=?`).get(location_id)) return res.status(404).json({ error: 'Unknown location.' });
  // Guard against pointing two locations at the same restaurant.
  const clash = db.prepare(`SELECT tl.id, l.name FROM toast_locations tl JOIN locations l ON l.id=tl.location_id WHERE tl.toast_guid=? AND tl.location_id<>?`).get(toast_guid, location_id);
  if (clash) return res.status(409).json({ error: `That restaurant GUID is already mapped to ${clash.name}.` });
  let toast_name = null;
  if (toast.toastEnabled()) { try { toast_name = restaurantName(await toast.getRestaurantInfo(toast_guid)); } catch { /* keep mapping even if name lookup fails */ } }
  db.prepare(`INSERT INTO toast_locations (location_id, toast_guid, toast_name) VALUES (?,?,?)
    ON CONFLICT(location_id) DO UPDATE SET toast_guid=excluded.toast_guid, toast_name=COALESCE(excluded.toast_name, toast_locations.toast_name), active=1`)
    .run(location_id, toast_guid, toast_name);
  auditLog(req, 'toast_map', 'location', location_id, { toast_guid, toast_name });
  res.json({ success: true, toast_name });
});

// Pull sales orders for a location and business date (YYYY-MM-DD) into the mirror.
// Optional date_from/date_to pulls a range (capped at 31 days). Read-only.
router.post('/sync/orders', ADMIN, async (req, res) => {
  if (!toast.toastEnabled()) return res.status(400).json({ error: 'Toast is not configured.' });
  const location_id = parseInt(req.body.location_id, 10);
  if (!location_id) return res.status(400).json({ error: 'location_id is required.' });
  const from = req.body.date_from || req.body.business_date;
  const to = req.body.date_to || req.body.business_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    return res.status(400).json({ error: 'Provide business_date, or date_from + date_to (YYYY-MM-DD).' });
  }
  const dates = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
    if (dates.length > 31) return res.status(400).json({ error: 'Range is capped at 31 days.' });
  }
  try {
    const results = [];
    for (const bd of dates) {
      const r = await toastSync.syncOrders(location_id, bd);
      results.push({ business_date: bd, ...r, summary: toastSync.salesSummary(location_id, bd) });
    }
    auditLog(req, 'toast_sync_orders', 'location', location_id, { from, to, days: dates.length });
    res.json({ ok: true, days: results });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// Pull the Toast staff roster + job catalog for a location and match to our users.
router.post('/sync/labor', ADMIN, async (req, res) => {
  if (!toast.toastEnabled()) return res.status(400).json({ error: 'Toast is not configured.' });
  const location_id = parseInt(req.body.location_id, 10);
  if (!location_id) return res.status(400).json({ error: 'location_id is required.' });
  try {
    const r = await toastSync.syncLabor(location_id);
    auditLog(req, 'toast_sync_labor', 'location', location_id, r);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// Read the mirrored Toast roster (employees + match status) and job catalog.
router.get('/labor', MANAGE, (req, res) => {
  const location_id = parseInt(req.query.location_id, 10);
  if (!location_id) return res.status(400).json({ error: 'location_id is required.' });
  if (!canSeeLoc(req, location_id)) return res.status(403).json({ error: 'Not your location.' });
  const employees = db.prepare(`SELECT e.guid, e.first_name, e.last_name, e.chosen_name, e.email, e.phone,
      e.deleted, e.match_by, e.user_id, u.name AS user_name, u.role AS user_role
    FROM toast_employees e LEFT JOIN users u ON u.id=e.user_id
    WHERE e.location_id=? ORDER BY e.deleted, e.first_name, e.last_name`).all(location_id);
  const jobs = db.prepare(`SELECT title, tipped, default_wage, wage_frequency, deleted FROM toast_jobs WHERE location_id=? ORDER BY deleted, title`).all(location_id);
  res.json({
    employees, jobs,
    matched: employees.filter(e => e.user_id).length,
    unmatched: employees.filter(e => !e.user_id && !e.deleted).length,
  });
});

// Pull the published Toast menu (prices) for a location into the mirror.
router.post('/sync/menus', ADMIN, async (req, res) => {
  if (!toast.toastEnabled()) return res.status(400).json({ error: 'Toast is not configured.' });
  const location_id = parseInt(req.body.location_id, 10);
  if (!location_id) return res.status(400).json({ error: 'location_id is required.' });
  try {
    const r = await toastSync.syncMenus(location_id);
    auditLog(req, 'toast_sync_menus', 'location', location_id, r);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// Read a location's mirrored menu (price book).
router.get('/menu', MANAGE, (req, res) => {
  const location_id = parseInt(req.query.location_id, 10);
  if (!location_id) return res.status(400).json({ error: 'location_id is required.' });
  if (!canSeeLoc(req, location_id)) return res.status(403).json({ error: 'Not your location.' });
  const items = db.prepare(`SELECT guid, multi_location_id, name, pos_name, menu_name, group_name, price, visible
    FROM toast_menu_items WHERE location_id=? ORDER BY group_name, name`).all(location_id);
  res.json({ items, count: items.length, visible: items.filter(i => i.visible).length });
});

// Cross-location price comparison. Toast's multi-location id does not overlap across
// these stores, so items are matched by name; each location's BASE (lowest) price for
// a name is used, and $0 items are excluded, to cut size/variant noise. Returns items
// whose base price differs across the mapped stores the caller can see.
router.get('/menu/compare', MANAGE, (req, res) => {
  const all = seesAllLocations(req.user.role);
  const scope = all ? '' : 'AND location_id=?';
  const args = all ? [] : [req.user.location_id];
  // Per (name, location) base price.
  const perLoc = db.prepare(`SELECT lower(name) AS k, MAX(name) AS name, location_id, MIN(price) AS price
    FROM toast_menu_items WHERE visible=1 AND price > 0 ${scope} GROUP BY lower(name), location_id`).all(...args);
  const byKey = {}, nameOf = {};
  for (const r of perLoc) { (byKey[r.k] = byKey[r.k] || {})[r.location_id] = r.price; nameOf[r.k] = r.name; }
  const items = Object.keys(byKey).map(k => {
    const prices = byKey[k], vals = Object.values(prices);
    const min = Math.min(...vals), max = Math.max(...vals);
    return { name: nameOf[k], locations: vals.length, min_price: min, max_price: max, spread: Math.round((max - min) * 100) / 100, prices };
  }).filter(it => it.locations >= 2 && it.spread > 0).sort((a, b) => b.spread - a.spread).slice(0, 200);
  res.json({ items, differing: items.length });
});

// Read the mirrored per-day sales summary for one location (no Toast call).
router.get('/sales', MANAGE, (req, res) => {
  const location_id = parseInt(req.query.location_id, 10);
  const business_date = String(req.query.business_date || '');
  if (!location_id || !/^\d{4}-\d{2}-\d{2}$/.test(business_date)) return res.status(400).json({ error: 'location_id and business_date (YYYY-MM-DD) are required.' });
  if (!canSeeLoc(req, location_id)) return res.status(403).json({ error: 'Not your location.' });
  res.json(toastSync.salesSummary(location_id, business_date));
});

// Dashboard roll-up: each mapped location's most recently synced business day and
// its sales summary. Scoped to what the caller can see (managers: their own store).
router.get('/sales/overview', MANAGE, (req, res) => {
  const all = seesAllLocations(req.user.role);
  let maps = db.prepare(`SELECT tl.location_id, tl.toast_name, l.name AS location_name
    FROM toast_locations tl JOIN locations l ON l.id=tl.location_id WHERE tl.active=1`).all();
  if (!all) maps = maps.filter(m => String(m.location_id) === String(req.user.location_id));
  const latest = db.prepare(`SELECT MAX(business_date) d FROM toast_orders WHERE location_id=?`);
  const rows = maps.map(m => {
    const d = (latest.get(m.location_id) || {}).d;
    return { location_id: m.location_id, location_name: m.location_name, toast_name: m.toast_name,
      business_date: d || null, summary: d ? toastSync.salesSummary(m.location_id, d) : null };
  });
  res.json({ locations: rows });
});

// Toggle a location's automatic sync during operating hours.
router.post('/map/:id/autosync', ADMIN, (req, res) => {
  const on = req.body.auto_sync ? 1 : 0;
  const r = db.prepare(`UPDATE toast_locations SET auto_sync=? WHERE id=?`).run(on, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Mapping not found.' });
  auditLog(req, 'toast_autosync', 'toast', req.params.id, { auto_sync: on });
  res.json({ success: true, auto_sync: on });
});

// Remove a mapping.
router.delete('/map/:id', ADMIN, (req, res) => {
  const row = db.prepare(`SELECT * FROM toast_locations WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Mapping not found.' });
  db.prepare(`DELETE FROM toast_locations WHERE id=?`).run(row.id);
  auditLog(req, 'toast_unmap', 'location', row.location_id, { toast_guid: row.toast_guid });
  res.json({ success: true });
});

module.exports = router;
