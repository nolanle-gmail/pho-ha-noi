// Toast POS integration — admin endpoints (owner / admin only). Phase 0: configure
// the location↔Toast-restaurant mapping and verify connectivity. All Toast access is
// read-only; credentials live in env / Fly secrets (see lib/toast.js), never here.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations, roleHasCap } = require('../lib/auth');
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

// City key for matching a Toast restaurant name to one of our locations, ignoring
// punctuation and the shared "Pho Ha Noi" prefix (e.g. "Pho Ha Noi - Cupertino " and
// "Pho Ha Noi — Cupertino" both → "cupertino").
const cityKey = (s) => String(s || '').toLowerCase().replace(/pho ha noi/g, '').replace(/[^a-z0-9]/g, '');

// Every Toast restaurant this API client can access, with its mapping status and a
// suggested app-location match (by name) for the ones not yet mapped.
router.get('/discover', ADMIN, async (req, res) => {
  if (!toast.toastEnabled()) return res.status(400).json({ error: 'Toast is not configured.' });
  try {
    const list = await toast.listRestaurants();
    const locs = db.prepare(`SELECT id, name FROM locations`).all();
    const byGuid = {}; db.prepare(`SELECT location_id, toast_guid FROM toast_locations`).all().forEach(m => (byGuid[m.toast_guid] = m.location_id));
    const takenLoc = new Set(Object.values(byGuid).map(String));
    const restaurants = list.filter(r => !r.deleted).map(r => {
      const guid = r.restaurantGuid, name = (r.restaurantName || '').trim();
      const mappedLoc = byGuid[guid] || null;
      let suggested = null;
      if (!mappedLoc) { const m = locs.find(l => cityKey(l.name) === cityKey(name) && !takenLoc.has(String(l.id))); if (m) suggested = { location_id: m.id, location_name: m.name }; }
      return { guid, name, address: r.locationName || null, mapped: !!mappedLoc,
        location_name: mappedLoc ? (locs.find(l => l.id === mappedLoc) || {}).name : null, suggested };
    }).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ restaurants, total: restaurants.length, mapped: restaurants.filter(r => r.mapped).length, suggestable: restaurants.filter(r => !r.mapped && r.suggested).length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// One-click: map every accessible, not-yet-mapped restaurant that confidently matches
// an app location by name.
router.post('/discover/map', ADMIN, async (req, res) => {
  if (!toast.toastEnabled()) return res.status(400).json({ error: 'Toast is not configured.' });
  try {
    const list = await toast.listRestaurants();
    const locs = db.prepare(`SELECT id, name FROM locations`).all();
    const already = new Set(db.prepare(`SELECT toast_guid FROM toast_locations`).all().map(m => m.toast_guid));
    const takenLoc = new Set(db.prepare(`SELECT location_id FROM toast_locations`).all().map(m => String(m.location_id)));
    const ins = db.prepare(`INSERT INTO toast_locations (location_id, toast_guid, toast_name) VALUES (?,?,?)
      ON CONFLICT(location_id) DO UPDATE SET toast_guid=excluded.toast_guid, toast_name=excluded.toast_name, active=1`);
    const mapped = [];
    for (const r of list) {
      if (r.deleted || already.has(r.restaurantGuid)) continue;
      const name = (r.restaurantName || '').trim();
      const m = locs.find(l => cityKey(l.name) === cityKey(name) && !takenLoc.has(String(l.id)));
      if (!m) continue;
      ins.run(m.id, r.restaurantGuid, name);
      takenLoc.add(String(m.id)); already.add(r.restaurantGuid);
      mapped.push({ location_id: m.id, location_name: m.name, toast_name: name });
    }
    if (mapped.length) auditLog(req, 'toast_discover_map', 'toast', null, { count: mapped.length });
    res.json({ ok: true, mapped, count: mapped.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

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

// Start a historical backfill (default ~6 months) for all mapped locations. Runs in
// the background; poll GET /backfill for progress.
router.post('/backfill', ADMIN, async (req, res) => {
  const r = await toastSync.runBackfill({ days: req.body.days });
  if (!r.started) return res.status(r.reason === 'already_running' ? 409 : 400).json({ error: r.reason === 'already_running' ? 'A backfill is already running.' : 'Toast is not configured.', status: r.status });
  auditLog(req, 'toast_backfill_start', 'toast', null, { days: r.days, total: r.total });
  res.json({ ok: true, ...r });
});
router.get('/backfill', ADMIN, (req, res) => res.json(toastSync.backfillStatus()));
router.post('/backfill/cancel', ADMIN, (req, res) => { toastSync.cancelBackfill(); res.json({ ok: true }); });

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

// Pull Toast config (tables, dining options, service areas, revenue centers).
router.post('/sync/config', ADMIN, async (req, res) => {
  if (!toast.toastEnabled()) return res.status(400).json({ error: 'Toast is not configured.' });
  const location_id = parseInt(req.body.location_id, 10);
  if (!location_id) return res.status(400).json({ error: 'location_id is required.' });
  try { const r = await toastSync.syncConfig(location_id); auditLog(req, 'toast_sync_config', 'location', location_id, r); res.json({ ok: true, ...r }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// Order status derived from the mirror (Toast has no single status field).
function orderStatus(o) { return o.voided ? 'voided' : (o.paid_at ? 'paid' : 'open'); }

// Browse orders for a location + business date, with resolved server / table names.
router.get('/orders', MANAGE, (req, res) => {
  const location_id = parseInt(req.query.location_id, 10);
  if (!location_id) return res.status(400).json({ error: 'location_id is required.' });
  if (!canSeeLoc(req, location_id)) return res.status(403).json({ error: 'Not your location.' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : toastSync.pacificToday();
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const where = ['o.location_id=?', 'o.business_date=?']; const args = [location_id, date];
  if (req.query.status === 'open') where.push('o.paid_at IS NULL AND o.voided=0');
  else if (req.query.status === 'paid') where.push('o.paid_at IS NOT NULL');
  else if (req.query.status === 'voided') where.push('o.voided=1');
  // Aggregate this day's checks / items once (indexed by location+date), then join by
  // order — far cheaper than a correlated subquery per order.
  const rows = db.prepare(`SELECT o.guid, o.opened_at, o.paid_at, o.voided, o.num_guests, o.table_guid, o.server_guid,
      tbl.name AS table_name,
      COALESCE(NULLIF(TRIM(COALESCE(u.name,'')),''), NULLIF(TRIM(COALESCE(e.chosen_name, e.first_name)||' '||COALESCE(e.last_name,'')),'')) AS server_name,
      ck.net, ck.total, ck.tips, COALESCE(sel.items,0) items
    FROM toast_orders o
    LEFT JOIN (SELECT order_guid, ROUND(SUM(amount),2) net, ROUND(SUM(total_amount),2) total, ROUND(SUM(tip_amount),2) tips
      FROM toast_checks WHERE location_id=? AND business_date=? GROUP BY order_guid) ck ON ck.order_guid=o.guid
    LEFT JOIN (SELECT order_guid, COUNT(*) items FROM toast_selections WHERE location_id=? AND business_date=? AND voided=0 GROUP BY order_guid) sel ON sel.order_guid=o.guid
    LEFT JOIN toast_config tbl ON tbl.location_id=o.location_id AND tbl.type='table' AND tbl.guid=o.table_guid
    LEFT JOIN toast_employees e ON e.guid=o.server_guid
    LEFT JOIN users u ON u.id=e.user_id
    WHERE ${where.join(' AND ')} ORDER BY o.opened_at DESC LIMIT ${limit}`).all(location_id, date, location_id, date, ...args);
  res.json({ date, orders: rows.map(o => ({ ...o, status: orderStatus(o) })) });
});

// Full detail for one order (checks, payments/tips, line items, resolved names).
router.get('/orders/:guid', MANAGE, (req, res) => {
  const o = db.prepare(`SELECT o.*, tbl.name AS table_name, dopt.name AS dining_option_name,
      COALESCE(NULLIF(TRIM(COALESCE(u.name,'')),''), NULLIF(TRIM(COALESCE(e.chosen_name, e.first_name)||' '||COALESCE(e.last_name,'')),'')) AS server_name,
      u.id AS server_user_id
    FROM toast_orders o
    LEFT JOIN toast_config tbl ON tbl.location_id=o.location_id AND tbl.type='table' AND tbl.guid=o.table_guid
    LEFT JOIN toast_config dopt ON dopt.location_id=o.location_id AND dopt.type='dining_option' AND dopt.guid=o.dining_option_guid
    LEFT JOIN toast_employees e ON e.guid=o.server_guid
    LEFT JOIN users u ON u.id=e.user_id
    WHERE o.guid=?`).get(req.params.guid);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (!canSeeLoc(req, o.location_id)) return res.status(403).json({ error: 'Not your location.' });
  const checks = db.prepare(`SELECT guid, amount, tax_amount, total_amount, tip_amount, discount_amount, service_charge_amount, payment_status, voided FROM toast_checks WHERE order_guid=?`).all(o.guid);
  const payments = db.prepare(`SELECT amount, tip_amount, type, card_type, refund_amount FROM toast_payments WHERE order_guid=?`).all(o.guid);
  const items = db.prepare(`SELECT item_name, quantity, price, voided FROM toast_selections WHERE order_guid=? ORDER BY voided, item_name`).all(o.guid);
  res.json({ order: { ...o, status: orderStatus(o) }, checks, payments, items });
});

// Live service-flow board for a location: active (open) tables with how long each has
// been open and its state, plus recent dry-run "check on table" alerts and settings.
router.get('/service-flow', MANAGE, (req, res) => {
  const location_id = parseInt(req.query.location_id, 10);
  if (!location_id) return res.status(400).json({ error: 'location_id is required.' });
  if (!canSeeLoc(req, location_id)) return res.status(403).json({ error: 'Not your location.' });
  const cfg = db.prepare(`SELECT service_flow_on, service_alerts_live, flow_served_min, flow_pay_min, flow_food_renudge_min, flow_pay_renudge_min, flow_alert_user_id FROM toast_locations WHERE location_id=?`).get(location_id) || {};
  const alertUser = cfg.flow_alert_user_id ? (db.prepare(`SELECT name FROM users WHERE id=?`).get(cfg.flow_alert_user_id) || {}).name : null;
  const live = !!(cfg.service_alerts_live && cfg.flow_alert_user_id);
  const flow = toastSync.computeServiceFlow(location_id);
  res.json({ ...flow, settings: { flow_on: !!cfg.service_flow_on, alerts_live: live, served_min: cfg.flow_served_min || 10, pay_min: cfg.flow_pay_min || 15,
    food_renudge_min: cfg.flow_food_renudge_min || 5, pay_renudge_min: cfg.flow_pay_renudge_min || 7,
    can_edit_timing: roleHasCap(req.user.role, 'manage'), can_toggle: roleHasCap(req.user.role, 'manage'), alert_user: alertUser } });
});

// Lightweight service-flow status for one location (used by the Locations manage view):
// whether it's connected to Toast, plus the on/off + live-alert state — WITHOUT computing the
// full live board (so opening a location's Details tab stays cheap).
router.get('/service-flow/status', MANAGE, (req, res) => {
  const location_id = parseInt(req.query.location_id, 10);
  if (!location_id) return res.status(400).json({ error: 'location_id is required.' });
  if (!canSeeLoc(req, location_id)) return res.status(403).json({ error: 'Not your location.' });
  const cfg = db.prepare(`SELECT toast_guid, active, service_flow_on, service_alerts_live, flow_alert_user_id FROM toast_locations WHERE location_id=?`).get(location_id);
  const mapped = !!(cfg && cfg.active && cfg.toast_guid);
  const alertUser = cfg && cfg.flow_alert_user_id ? (db.prepare(`SELECT name FROM users WHERE id=?`).get(cfg.flow_alert_user_id) || {}).name : null;
  res.json({
    mapped,
    flow_on: !!(cfg && cfg.service_flow_on),
    alerts_live: !!(cfg && cfg.service_alerts_live && cfg.flow_alert_user_id),
    alert_user: alertUser,
    can_toggle: roleHasCap(req.user.role, 'manage'),   // any manage-cap role can toggle its own store
  });
});

// Turn a location's Service Flow on/off. Unlike /settings (ADMIN, also flips alerts-live &
// thresholds), this flips ONLY service_flow_on and is open to any manage-cap role FOR THEIR OWN
// location (canSeeLoc) — so a store manager can start/stop monitoring their own restaurant.
// Going LIVE (routing alerts to a user) stays admin-only via /settings.
router.post('/service-flow/toggle', MANAGE, (req, res) => {
  const location_id = parseInt(req.body.location_id, 10);
  if (!location_id) return res.status(400).json({ error: 'location_id is required.' });
  if (!canSeeLoc(req, location_id)) return res.status(403).json({ error: 'Not your location.' });
  const cfg = db.prepare(`SELECT toast_guid, active FROM toast_locations WHERE location_id=?`).get(location_id);
  if (!cfg || !cfg.active || !cfg.toast_guid) return res.status(400).json({ error: 'This location isn’t connected to Toast yet.' });
  const on = req.body.flow_on ? 1 : 0;
  db.prepare(`UPDATE toast_locations SET service_flow_on=? WHERE location_id=?`).run(on, location_id);
  auditLog(req, 'toast_flow_toggle', 'location', location_id, { flow_on: on });
  res.json({ ok: true, flow_on: !!on });
});

// Manager-editable alert timing for a store: the food alert threshold + re-alert cadence,
// and the pay alert threshold (counted from served) + its cadence. Own store; owners all.
router.post('/service-flow/timing', MANAGE, (req, res) => {
  const location_id = parseInt(req.body.location_id, 10);
  if (!location_id) return res.status(400).json({ error: 'location_id is required.' });
  if (!canSeeLoc(req, location_id)) return res.status(403).json({ error: 'Not your location.' });
  const clamp = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
  const fields = [], args = [];
  if (req.body.served_min !== undefined) { fields.push('flow_served_min=?'); args.push(clamp(req.body.served_min, 1, 120, 12)); }
  if (req.body.pay_min !== undefined) { fields.push('flow_pay_min=?'); args.push(clamp(req.body.pay_min, 1, 180, 17)); }
  if (req.body.food_renudge_min !== undefined) { fields.push('flow_food_renudge_min=?'); args.push(clamp(req.body.food_renudge_min, 2, 60, 5)); }
  if (req.body.pay_renudge_min !== undefined) { fields.push('flow_pay_renudge_min=?'); args.push(clamp(req.body.pay_renudge_min, 2, 60, 7)); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  args.push(location_id);
  db.prepare(`UPDATE toast_locations SET ${fields.join(',')} WHERE location_id=?`).run(...args);
  auditLog(req, 'toast_flow_timing', 'location', location_id, req.body);
  const c = db.prepare(`SELECT flow_served_min, flow_pay_min, flow_food_renudge_min, flow_pay_renudge_min FROM toast_locations WHERE location_id=?`).get(location_id);
  res.json({ ok: true, settings: { served_min: c.flow_served_min, pay_min: c.flow_pay_min, food_renudge_min: c.flow_food_renudge_min, pay_renudge_min: c.flow_pay_renudge_min } });
});

// Audit trail of staff actions on Service Flow alerts (who / when / what) for review.
router.get('/service-flow/log', MANAGE, (req, res) => {
  const location_id = parseInt(req.query.location_id, 10);
  if (!location_id) return res.status(400).json({ error: 'location_id is required.' });
  if (!canSeeLoc(req, location_id)) return res.status(403).json({ error: 'Not your location.' });
  const limit = Math.min(300, Math.max(10, parseInt(req.query.limit, 10) || 100));
  const events = db.prepare(`
    SELECT e.created_at, e.action, e.flow_kind, e.user_name, e.order_guid,
      (SELECT c.name FROM toast_orders o JOIN toast_config c ON c.location_id=o.location_id AND c.type='table' AND c.guid=o.table_guid WHERE o.guid=e.order_guid) AS table_name
    FROM toast_flow_events e
    WHERE e.location_id=? ORDER BY e.id DESC LIMIT ?`).all(location_id, limit);
  res.json({ events });
});

// Staff mark a table Served (food delivered) or Done (bussed & cleared). Toast has no
// such signal, so these are the only human inputs the board needs; everything else
// (ordered / paid) comes from Toast. Location-scoped like the board.
const flowLoc = (guid) => (db.prepare(`SELECT location_id FROM toast_orders WHERE guid=?`).get(guid) || {}).location_id;
const upFlowServed = db.prepare(`INSERT INTO toast_flow_state (order_guid, location_id, served_at, served_by, updated_at)
  VALUES (@guid,@loc,@at,@by,datetime('now'))
  ON CONFLICT(order_guid) DO UPDATE SET served_at=@at, served_by=@by, updated_at=datetime('now')`);
const upFlowBussed = db.prepare(`INSERT INTO toast_flow_state (order_guid, location_id, bussed_at, bussed_by, updated_at)
  VALUES (@guid,@loc,@at,@by,datetime('now'))
  ON CONFLICT(order_guid) DO UPDATE SET bussed_at=@at, bussed_by=@by, updated_at=datetime('now')`);
router.post('/service-flow/:guid/served', MANAGE, (req, res) => {
  const loc = flowLoc(req.params.guid);
  if (!loc) return res.status(404).json({ error: 'Order not found.' });
  if (!canSeeLoc(req, loc)) return res.status(403).json({ error: 'Not your location.' });
  const clear = req.body && req.body.clear;                 // allow un-marking (mistap)
  upFlowServed.run({ guid: req.params.guid, loc, at: clear ? null : new Date().toISOString(), by: clear ? null : req.user.id });
  auditLog(req, 'flow_served', 'toast', req.params.guid, { clear: !!clear });
  res.json({ success: true, served: !clear });
});
router.post('/service-flow/:guid/done', MANAGE, (req, res) => {
  const loc = flowLoc(req.params.guid);
  if (!loc) return res.status(404).json({ error: 'Order not found.' });
  if (!canSeeLoc(req, loc)) return res.status(403).json({ error: 'Not your location.' });
  upFlowBussed.run({ guid: req.params.guid, loc, at: new Date().toISOString(), by: req.user.id });
  auditLog(req, 'flow_bussed', 'toast', req.params.guid, {});
  res.json({ success: true, done: true });
});
// Guest left before ordering: clear a "Seated" party and free its table.
router.post('/service-flow/seated-left/:vid', MANAGE, (req, res) => {
  const { clearSeatedVisit, seatedVisitLocation } = require('../lib/seated');
  const loc = seatedVisitLocation(req.params.vid);
  if (!loc) return res.status(404).json({ error: 'That seating was already cleared.' });
  if (!canSeeLoc(req, loc)) return res.status(403).json({ error: 'Not your location.' });
  const r = clearSeatedVisit(req.params.vid, { name: req.user.name, role: req.user.role });
  if (!r.ok) return res.status(r.code || 400).json({ error: r.error });
  auditLog(req, 'flow_seated_left', 'visit', req.params.vid, { table: r.table_name });
  res.json({ success: true });
});

// Update service-flow settings for a location (threshold, on/off, live vs dry-run).
router.post('/service-flow/settings', ADMIN, (req, res) => {
  const location_id = parseInt(req.body.location_id, 10);
  if (!location_id) return res.status(400).json({ error: 'location_id is required.' });
  const fields = [], args = [];
  if (req.body.alert_min !== undefined) { const n = parseInt(req.body.alert_min, 10); fields.push('service_alert_min=?'); args.push(Number.isFinite(n) ? Math.min(240, Math.max(5, n)) : 40); }
  if (req.body.flow_on !== undefined) { fields.push('service_flow_on=?'); args.push(req.body.flow_on ? 1 : 0); }
  if (req.body.alerts_live !== undefined) { fields.push('service_alerts_live=?'); args.push(req.body.alerts_live ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  args.push(location_id);
  db.prepare(`UPDATE toast_locations SET ${fields.join(',')} WHERE location_id=?`).run(...args);
  auditLog(req, 'toast_service_settings', 'location', location_id, req.body);
  res.json({ ok: true });
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

// Same day's sales broken down by dining option (Dine In / Take Out / DoorDash …),
// for the dashboard card's click-through detail. Scoped like /sales.
router.get('/sales/dining', MANAGE, (req, res) => {
  const location_id = parseInt(req.query.location_id, 10);
  const business_date = String(req.query.business_date || '');
  if (!location_id || !/^\d{4}-\d{2}-\d{2}$/.test(business_date)) return res.status(400).json({ error: 'location_id and business_date (YYYY-MM-DD) are required.' });
  if (!canSeeLoc(req, location_id)) return res.status(403).json({ error: 'Not your location.' });
  res.json({ location_id, business_date,
    options: toastSync.salesByDiningOption(location_id, business_date, business_date),
    payments: toastSync.salesByPaymentType(location_id, business_date, business_date),
    payment_by_dining: toastSync.salesPaymentByDining(location_id, business_date, business_date) });
});

// Dashboard roll-up: each mapped location's most recently synced business day and
// its sales summary. Scoped to what the caller can see (managers: their own store).
router.get('/sales/overview', MANAGE, (req, res) => {
  const all = seesAllLocations(req.user.role);
  let maps = db.prepare(`SELECT tl.location_id, tl.toast_name, tl.last_synced_at, l.name AS location_name
    FROM toast_locations tl JOIN locations l ON l.id=tl.location_id WHERE tl.active=1`).all();
  if (!all) maps = maps.filter(m => String(m.location_id) === String(req.user.location_id));
  const latest = db.prepare(`SELECT MAX(business_date) d FROM toast_orders WHERE location_id=?`);
  const rows = maps.map(m => {
    const d = (latest.get(m.location_id) || {}).d;
    return { location_id: m.location_id, location_name: m.location_name, toast_name: m.toast_name,
      last_synced_at: m.last_synced_at || null,
      business_date: d || null, summary: d ? toastSync.salesSummary(m.location_id, d) : null };
  });
  // Most recent pull across the shown locations (server local time; treated as UTC).
  const lastPulled = rows.map(r => r.last_synced_at).filter(Boolean).sort().pop() || null;
  res.json({ locations: rows, last_pulled_at: lastPulled });
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

// ── Sales analytics (reads the local mirror only; never calls Toast) ──────────
// Visible to managers and the reports tier; managers are scoped to their own store.
const ANALYTICS = (req, res, next) => (roleHasCap(req.user.role, 'reports') || roleHasCap(req.user.role, 'manage'))
  ? next() : res.status(403).json({ error: 'Not allowed to view sales analytics.' });
const addDaysIso = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function rangeScope(req) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : toastSync.pacificToday();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : addDaysIso(to, -90);
  const all = seesAllLocations(req.user.role);
  const loc = all ? (parseInt(req.query.location_id, 10) || null) : req.user.location_id;   // managers pinned to own store
  return { from, to, loc, all };
}
const locClause = (loc) => (loc ? 'AND location_id=?' : '');
const locArgs = (from, to, loc) => (loc ? [from, to, loc] : [from, to]);

// Headline KPIs for the range.
router.get('/analytics/summary', ANALYTICS, (req, res) => {
  const { from, to, loc } = rangeScope(req); const lc = locClause(loc), a = locArgs(from, to, loc);
  const m = db.prepare(`SELECT ROUND(SUM(amount),2) net, ROUND(SUM(total_amount),2) total, ROUND(SUM(tip_amount),2) tips, ROUND(SUM(tax_amount),2) tax, ROUND(SUM(discount_amount),2) discounts FROM toast_checks WHERE voided=0 AND business_date BETWEEN ? AND ? ${lc}`).get(...a);
  const o = db.prepare(`SELECT COUNT(*) orders, COALESCE(SUM(num_guests),0) guests, COUNT(DISTINCT business_date) days FROM toast_orders WHERE voided=0 AND business_date BETWEEN ? AND ? ${lc}`).get(...a);
  const it = db.prepare(`SELECT ROUND(SUM(quantity),0) qty FROM toast_selections WHERE voided=0 AND business_date BETWEEN ? AND ? ${lc}`).get(...a);
  // Avg open→pay time (minutes) from the precomputed pay_minutes column (populated at
  // sync time). 0–600 min window drops forgotten/employee tabs left open for hours.
  const p = db.prepare(`SELECT COUNT(*) n, ROUND(AVG(pay_minutes),1) avg_min FROM toast_orders WHERE voided=0 AND business_date BETWEEN ? AND ? ${lc} AND pay_minutes BETWEEN 0 AND 600`).get(...a);
  // Split by dining type (Dine In / Take Out / DoorDash …) and by payment tender
  // (Cash / Credit card / Gift card / Other) over the same range + scope.
  const dining = toastSync.salesByDiningOption(loc, from, to);
  const payments = toastSync.salesByPaymentType(loc, from, to);
  const payment_by_dining = toastSync.salesPaymentByDining(loc, from, to);
  const net = m.net || 0, orders = o.orders || 0;
  res.json({ from, to, net, total: m.total || 0, tips: m.tips || 0, tax: m.tax || 0, discounts: m.discounts || 0,
    orders, guests: o.guests || 0, days: o.days || 0, items: it.qty || 0,
    avg_pay_min: p.avg_min || 0, paid_orders: p.n || 0, dining, payments, payment_by_dining,
    avg_check: orders ? Math.round(net / orders * 100) / 100 : 0, avg_per_day: (o.days ? Math.round(net / o.days * 100) / 100 : 0) });
});

// Revenue / orders / guests time series (day, week or month buckets).
router.get('/analytics/trends', ANALYTICS, (req, res) => {
  const { from, to, loc } = rangeScope(req); const lc = locClause(loc), a = locArgs(from, to, loc);
  const g = req.query.granularity;
  const bucket = g === 'month' ? "strftime('%Y-%m', business_date)" : g === 'week' ? "strftime('%Y-%W', business_date)" : 'business_date';
  const money = db.prepare(`SELECT ${bucket} period, MIN(business_date) start, ROUND(SUM(amount),2) net, ROUND(SUM(total_amount),2) total, ROUND(SUM(tip_amount),2) tips FROM toast_checks WHERE voided=0 AND business_date BETWEEN ? AND ? ${lc} GROUP BY period`).all(...a);
  const ord = db.prepare(`SELECT ${bucket} period, COUNT(*) orders, COALESCE(SUM(num_guests),0) guests FROM toast_orders WHERE voided=0 AND business_date BETWEEN ? AND ? ${lc} GROUP BY period`).all(...a);
  const byP = {}; for (const r of money) byP[r.period] = { period: r.period, start: r.start, net: r.net || 0, total: r.total || 0, tips: r.tips || 0, orders: 0, guests: 0 };
  for (const r of ord) { const p = byP[r.period] || (byP[r.period] = { period: r.period, start: r.period, net: 0, total: 0, tips: 0 }); p.orders = r.orders; p.guests = r.guests; }
  res.json({ from, to, granularity: g === 'month' ? 'month' : g === 'week' ? 'week' : 'day', series: Object.values(byP).sort((x, y) => String(x.start).localeCompare(String(y.start))) });
});

// Per-location rollup (admins see all; managers see their own store).
router.get('/analytics/locations', ANALYTICS, (req, res) => {
  const { from, to, all } = rangeScope(req);
  const lc = all ? '' : 'AND o.location_id=?', a = all ? [from, to] : [from, to, req.user.location_id];
  const ord = db.prepare(`SELECT o.location_id, l.name, COUNT(*) orders, COALESCE(SUM(o.num_guests),0) guests
    FROM toast_orders o JOIN locations l ON l.id=o.location_id WHERE o.voided=0 AND o.business_date BETWEEN ? AND ? ${lc} GROUP BY o.location_id`).all(...a);
  const lc2 = all ? '' : 'AND location_id=?';
  const money = db.prepare(`SELECT location_id, ROUND(SUM(amount),2) net, ROUND(SUM(total_amount),2) total, ROUND(SUM(tip_amount),2) tips FROM toast_checks WHERE voided=0 AND business_date BETWEEN ? AND ? ${lc2} GROUP BY location_id`).all(...a);
  const pay = db.prepare(`SELECT location_id, ROUND(AVG(pay_minutes),1) avg_min FROM toast_orders WHERE voided=0 AND business_date BETWEEN ? AND ? ${lc2} AND pay_minutes BETWEEN 0 AND 600 GROUP BY location_id`).all(...a);
  const byLoc = {}; for (const r of money) byLoc[r.location_id] = r;
  const byPay = {}; for (const r of pay) byPay[r.location_id] = r.avg_min;
  const rows = ord.map(o => { const m = byLoc[o.location_id] || {}; const net = m.net || 0; return { location_id: o.location_id, name: o.name, net, total: m.total || 0, tips: m.tips || 0, orders: o.orders, guests: o.guests, avg_check: o.orders ? Math.round(net / o.orders * 100) / 100 : 0, avg_pay_min: byPay[o.location_id] || 0 }; }).sort((x, y) => y.net - x.net);
  res.json({ from, to, locations: rows });
});

// Top-selling items (menu mix) by revenue.
router.get('/analytics/items', ANALYTICS, (req, res) => {
  const { from, to, loc } = rangeScope(req); const lc = locClause(loc), a = locArgs(from, to, loc);
  const limit = Math.min(100, Math.max(5, parseInt(req.query.limit, 10) || 25));
  const items = db.prepare(`SELECT item_name, ROUND(SUM(quantity),0) qty, ROUND(SUM(price),2) revenue, COUNT(DISTINCT check_guid) checks
    FROM toast_selections WHERE voided=0 AND price>0 AND business_date BETWEEN ? AND ? ${lc}
    GROUP BY item_name ORDER BY revenue DESC LIMIT ${limit}`).all(...a);
  res.json({ from, to, items });
});

// Day-of-week and hour-of-day patterns (for staffing / planning).
router.get('/analytics/patterns', ANALYTICS, (req, res) => {
  const { from, to, loc } = rangeScope(req); const lc = locClause(loc), a = locArgs(from, to, loc);
  // Day of week (0=Sun..6=Sat) — revenue from checks, plus distinct-day counts for an average.
  const dowMoney = db.prepare(`SELECT CAST(strftime('%w', business_date) AS INT) dow, ROUND(SUM(amount),2) net FROM toast_checks WHERE voided=0 AND business_date BETWEEN ? AND ? ${lc} GROUP BY dow`).all(...a);
  const dowDays = db.prepare(`SELECT CAST(strftime('%w', business_date) AS INT) dow, COUNT(DISTINCT business_date) days, COUNT(*) orders FROM toast_orders WHERE voided=0 AND business_date BETWEEN ? AND ? ${lc} GROUP BY dow`).all(...a);
  const dm = {}; dowMoney.forEach(r => dm[r.dow] = r.net); const dd = {}; dowDays.forEach(r => dd[r.dow] = r);
  const dow = [0, 1, 2, 3, 4, 5, 6].map(i => ({ dow: i, net: dm[i] || 0, days: (dd[i] || {}).days || 0, orders: (dd[i] || {}).orders || 0, avg: (dd[i] && dd[i].days) ? Math.round((dm[i] || 0) / dd[i].days * 100) / 100 : 0 }));
  // Hour of day (Pacific ≈ UTC−7). substr strips the +0000 suffix SQLite can't parse.
  const hrRows = db.prepare(`SELECT CAST(strftime('%H', substr(opened_at,1,19), '-7 hours') AS INT) hr, COUNT(*) orders FROM toast_orders WHERE voided=0 AND opened_at IS NOT NULL AND business_date BETWEEN ? AND ? ${lc} GROUP BY hr`).all(...a);
  const hm = {}; hrRows.forEach(r => { if (r.hr != null) hm[(r.hr + 24) % 24] = r.orders; });
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: hm[h] || 0 }));
  res.json({ from, to, dow, hours });
});

module.exports = router;
