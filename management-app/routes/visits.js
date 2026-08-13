// Guest-visit lifecycle — the single source of truth for a party's journey through
// the restaurant: waiting → seated → in_service → paying → done (+ canceled). The
// Management "Service" section views/manages every stage; the Staff app (Front Desk
// + Servers) drives it through a shared service key. Each transition is logged to
// visit_events for movement history and server-performance reporting, and the
// floor plan's table status is kept in sync so both views agree.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations, SECRET } = require('../lib/auth');
const jwt = require('jsonwebtoken');

const router = express.Router();

const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';
const STAGES = ['waiting', 'seated', 'in_service', 'paying', 'done', 'canceled'];
const ACTIVE_STAGES = ['waiting', 'seated', 'in_service', 'paying'];
const CHECK_INTERVALS = [5, 10, 20];
const DEFAULT_CHECK = 10;

// Stage → floor-plan table status, so the map reflects the visit lifecycle.
const STAGE_TABLE_STATUS = { seated: 'waiting_to_order', in_service: 'served', paying: 'waiting_to_pay' };

// Auth: a valid Management JWT, OR the Staff-app service key.
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
// View/act: the service key (Staff app) or a manager. Per-user server/host scoping
// happens in the Staff app UI (Phase 4); the API trusts the service key.
const requireView = (req, res, next) => (req.service || isManage(req) ? next() : res.status(403).json({ error: 'You do not have access to the service lists.' }));

const nowISO = () => new Date().toISOString();
const addMin = (min, from) => new Date((from ? new Date(from).getTime() : Date.now()) + min * 60000).toISOString();
const minsUntil = (iso) => (iso ? Math.round((new Date(iso).getTime() - Date.now()) / 60000) : null);
const minsSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)) : null);
const clampInterval = (v) => (CHECK_INTERVALS.includes(parseInt(v, 10)) ? parseInt(v, 10) : null);

// Who is acting — a Management user (JWT) or, for service calls, whoever the Staff
// app names in the body (so a server's claim/check is attributed correctly).
function actorOf(req) {
  if (req.user) return { id: req.user.id, name: req.user.name, role: req.user.role };
  return {
    id: req.body.actor_id ? parseInt(req.body.actor_id, 10) : null,
    name: (req.body.actor_name || 'Front Desk').toString().slice(0, 60),
    role: (req.body.actor_role || 'service').toString().slice(0, 30),
  };
}
function logEvent(visit, event, fromStage, toStage, actor, detail) {
  db.prepare(`INSERT INTO visit_events (visit_id, location_id, event, from_stage, to_stage, actor_id, actor_name, actor_role, detail)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(visit.id, visit.location_id, event, fromStage || null, toStage || null,
    actor.id, actor.name, actor.role, detail ? JSON.stringify(detail) : null);
}
// Keep the floor-plan table in step with the visit's stage.
function syncTable(tableId, stage, visit) {
  if (!tableId) return;
  if (stage === 'done' || stage === 'canceled') {
    db.prepare(`UPDATE restaurant_tables SET status='available', guest_name=NULL, party_size=NULL, seated_at=NULL, est_free_at=NULL WHERE id=?`).run(tableId);
    return;
  }
  const status = STAGE_TABLE_STATUS[stage];
  if (!status) return;
  const est = visit && visit.next_check_at ? visit.next_check_at : null;
  db.prepare(`UPDATE restaurant_tables SET status=?, guest_name=?, party_size=?, seated_at=COALESCE(seated_at, ?), est_free_at=? WHERE id=?`)
    .run(status, visit ? visit.guest_name : null, visit ? visit.party_size : null, visit ? visit.seated_at : null, est, tableId);
}
// Is a table currently held by another active visit?
const tableHeldBy = (tableId, exceptVisitId) =>
  db.prepare(`SELECT id FROM service_visits WHERE table_id=? AND stage IN ('seated','in_service','paying') AND id<>? LIMIT 1`).get(tableId, exceptVisitId || 0);

const getVisit = (id) => db.prepare(`SELECT * FROM service_visits WHERE id=?`).get(id);

function mapVisit(v) {
  const t = v.table_id ? db.prepare(`SELECT label, seats FROM restaurant_tables WHERE id=?`).get(v.table_id) : null;
  return {
    id: v.id, location_id: v.location_id, source: v.source, guest_name: v.guest_name, party_size: v.party_size,
    phone: v.phone || null, notes: v.notes || null, stage: v.stage,
    table_id: v.table_id || null, table_label: t ? t.label : null,
    server_id: v.server_id || null, server_name: v.server_name || null,
    check_interval_min: v.check_interval_min || null,
    minutes_to_check: v.stage === 'in_service' ? minsUntil(v.next_check_at) : null,
    check_due: v.stage === 'in_service' && v.next_check_at ? new Date(v.next_check_at).getTime() <= Date.now() : false,
    last_checked_min_ago: minsSince(v.last_checked_at), check_count: v.check_count,
    waited_min: v.stage === 'waiting' ? minsSince(v.created_at) : null,
    seated_min_ago: minsSince(v.seated_at), quoted_minutes: v.quoted_minutes || null,
    help_flag: !!v.help_flag, bus_flag: !!v.bus_flag, tip_amount: v.tip_amount != null ? v.tip_amount : null,
    waitlist_ref: v.waitlist_ref || null,
    created_at: v.created_at, seated_at: v.seated_at || null, service_started_at: v.service_started_at || null,
    paying_at: v.paying_at || null, done_at: v.done_at || null,
  };
}

// Resolve the requested location + enforce scope. Returns { locId } or sends an error.
function scopeLocation(req, res) {
  const scopeAll = req.service ? false : seesAllLocations(req.user.role);
  let locId = req.query.location_id ? parseInt(req.query.location_id, 10) : (req.body.location_id ? parseInt(req.body.location_id, 10) : null);
  if (req.service && !locId) { res.status(400).json({ error: 'location_id is required.' }); return null; }
  if (!scopeAll && !req.service && !locId) locId = req.user.location_id;   // default location-scoped users to their own store
  if (locId && !ownsLocation(req, locId)) { res.status(403).json({ error: 'Not your location.' }); return null; }
  return { locId: locId || null };   // null (all-location) only for all-scope managers
}

// ── The lists: every active visit, grouped by stage, scoped to the viewer ─────
router.get('/', requireView, (req, res) => {
  const s = scopeLocation(req, res); if (!s) return;
  const includeDone = req.query.include === 'done';
  const stages = includeDone ? [...ACTIVE_STAGES, 'done'] : ACTIVE_STAGES;
  const params = [];
  let where = `stage IN (${stages.map(() => '?').join(',')})`; params.push(...stages);
  if (s.locId) { where += ` AND location_id=?`; params.push(s.locId); }
  if (includeDone) where = `(${where}) AND (stage<>'done' OR done_at >= datetime('now','-1 day'))`;
  const rows = db.prepare(`SELECT * FROM service_visits WHERE ${where} ORDER BY
    CASE stage WHEN 'waiting' THEN 0 WHEN 'seated' THEN 1 WHEN 'in_service' THEN 2 WHEN 'paying' THEN 3 ELSE 4 END,
    COALESCE(seated_at, created_at)`).all(...params);
  const visits = rows.map(mapVisit);
  const byStage = {}; STAGES.forEach(st => byStage[st] = []);
  visits.forEach(v => byStage[v.stage].push(v));
  const loc = s.locId ? db.prepare(`SELECT id, name FROM locations WHERE id=?`).get(s.locId) : null;
  // Servers on staff at this location, for the assignment picker.
  const servers = s.locId
    ? db.prepare(`SELECT id, name, employee_code FROM users WHERE location_id=? AND role='server' AND is_active=1 ORDER BY name`).all(s.locId)
    : [];
  // Flag-driven lists (independent of stage): raised hands + tables to bus.
  const fw = s.locId ? ' AND location_id=?' : ''; const fp = s.locId ? [s.locId] : [];
  const needs_help = db.prepare(`SELECT * FROM service_visits WHERE help_flag=1${fw} ORDER BY help_at`).all(...fp).map(mapVisit);
  const to_bus = db.prepare(`SELECT * FROM service_visits WHERE bus_flag=1${fw} ORDER BY bus_at`).all(...fp).map(mapVisit);
  res.json({
    location: loc ? { id: loc.id, name: loc.name } : null,
    can_manage: !!isManage(req), all_locations: !s.locId,
    stages: STAGES, check_intervals: CHECK_INTERVALS, servers,
    lists: byStage, needs_help, to_bus,
    summary: {
      waiting: byStage.waiting.length, seated: byStage.seated.length, in_service: byStage.in_service.length,
      paying: byStage.paying.length, checks_due: byStage.in_service.filter(v => v.check_due).length,
      help: needs_help.length, to_bus: to_bus.length,
    },
  });
});

// ── Create a visit — from the waitlist (waiting) or a walk-in seated directly ──
router.post('/', requireView, (req, res) => {
  const s = scopeLocation(req, res); if (!s) return;
  const locId = s.locId || (req.body.location_id ? parseInt(req.body.location_id, 10) : null);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const guest = (req.body.guest_name || '').toString().slice(0, 60) || null;
  const size = Math.max(1, parseInt(req.body.party_size, 10) || 1);
  const source = req.body.source === 'waitlist' ? 'waitlist' : 'walkin';
  const tableId = req.body.table_id ? parseInt(req.body.table_id, 10) : null;
  const actor = actorOf(req);
  const now = nowISO();

  if (tableId) {
    // Walk-in seated immediately.
    const t = db.prepare(`SELECT * FROM restaurant_tables WHERE id=?`).get(tableId);
    if (!t || String(t.location_id) !== String(locId)) return res.status(400).json({ error: 'Table is not at this location.' });
    if (tableHeldBy(tableId)) return res.status(409).json({ error: `Table ${t.label} is already occupied.` });
    const interval = clampInterval(req.body.check_interval_min);
    const info = db.prepare(`INSERT INTO service_visits (location_id, source, guest_name, party_size, phone, notes, stage, table_id, check_interval_min, seated_at, created_at)
      VALUES (?,?,?,?,?,?,'seated',?,?,?,?)`).run(locId, source, guest, size, req.body.phone || null, req.body.notes || null, tableId, interval, now, now);
    const v = getVisit(info.lastInsertRowid);
    syncTable(tableId, 'seated', v);
    logEvent(v, 'created', null, 'waiting', actor, { source });
    logEvent(v, 'seated', 'waiting', 'seated', actor, { table_id: tableId, table: t.label });
    return res.json({ success: true, id: v.id, visit: mapVisit(v) });
  }
  const quoted = req.body.quoted_minutes ? parseInt(req.body.quoted_minutes, 10) : null;
  const info = db.prepare(`INSERT INTO service_visits (location_id, source, guest_name, party_size, phone, notes, stage, waitlist_ref, quoted_minutes, created_at)
    VALUES (?,?,?,?,?,?,'waiting',?,?,?)`).run(locId, source, guest, size, req.body.phone || null, req.body.notes || null, req.body.waitlist_ref || null, quoted, now);
  const v = getVisit(info.lastInsertRowid);
  logEvent(v, 'created', null, 'waiting', actor, { source });
  res.json({ success: true, id: v.id, visit: mapVisit(v) });
});

// Load a visit + enforce location scope; returns the row or sends an error.
function loadOwned(req, res) {
  const v = getVisit(req.params.id);
  if (!v) { res.status(404).json({ error: 'Visit not found.' }); return null; }
  if (!ownsLocation(req, v.location_id)) { res.status(403).json({ error: 'Not your location.' }); return null; }
  return v;
}

// ── Seat a waiting party at a table ──────────────────────────────────────────
router.put('/:id/seat', requireView, (req, res) => {
  const v = loadOwned(req, res); if (!v) return;
  if (!['waiting', 'seated'].includes(v.stage)) return res.status(409).json({ error: `Cannot seat a visit that is ${v.stage}.` });
  const tableId = parseInt(req.body.table_id, 10);
  const t = db.prepare(`SELECT * FROM restaurant_tables WHERE id=?`).get(tableId);
  if (!t || String(t.location_id) !== String(v.location_id)) return res.status(400).json({ error: 'Table is not at this location.' });
  if (tableHeldBy(tableId, v.id)) return res.status(409).json({ error: `Table ${t.label} is already occupied.` });
  const interval = req.body.check_interval_min !== undefined ? clampInterval(req.body.check_interval_min) : v.check_interval_min;
  const now = nowISO();
  db.prepare(`UPDATE service_visits SET stage='seated', table_id=?, check_interval_min=?, seated_at=COALESCE(seated_at, ?) WHERE id=?`).run(tableId, interval, now, v.id);
  const nv = getVisit(v.id);
  syncTable(tableId, 'seated', nv);
  logEvent(nv, 'seated', v.stage, 'seated', actorOf(req), { table_id: tableId, table: t.label });
  res.json({ success: true, visit: mapVisit(nv) });
});

// ── A server picks up a seated table (self-claim) or a manager assigns one ────
function toInService(req, res, event) {
  const v = loadOwned(req, res); if (!v) return;
  if (!['seated', 'in_service'].includes(v.stage)) return res.status(409).json({ error: `Cannot assign a server to a ${v.stage} visit.` });
  const serverId = req.body.server_id ? parseInt(req.body.server_id, 10) : (req.user && req.user.role === 'server' ? req.user.id : null);
  let serverName = (req.body.server_name || '').toString().slice(0, 60) || (req.user && req.user.role === 'server' ? req.user.name : null);
  if (serverId && !serverName) { const u = db.prepare(`SELECT name FROM users WHERE id=?`).get(serverId); serverName = u ? u.name : null; }
  if (!serverId && !serverName) return res.status(400).json({ error: 'A server is required.' });
  const interval = v.check_interval_min || DEFAULT_CHECK;
  const now = nowISO();
  db.prepare(`UPDATE service_visits SET stage='in_service', server_id=?, server_name=?, check_interval_min=COALESCE(check_interval_min,?), service_started_at=COALESCE(service_started_at, ?), next_check_at=? WHERE id=?`)
    .run(serverId, serverName, interval, now, addMin(interval), v.id);
  const nv = getVisit(v.id);
  syncTable(nv.table_id, 'in_service', nv);
  logEvent(nv, event, v.stage, 'in_service', actorOf(req), { server_id: serverId, server: serverName });
  res.json({ success: true, visit: mapVisit(nv) });
}
router.put('/:id/claim', requireView, (req, res) => toInService(req, res, 'claimed'));
router.put('/:id/assign', requireView, (req, res) => toInService(req, res, 'assigned'));

// ── Log a check (resets the timer) ───────────────────────────────────────────
router.put('/:id/check', requireView, (req, res) => {
  const v = loadOwned(req, res); if (!v) return;
  if (v.stage !== 'in_service') return res.status(409).json({ error: 'Only tables in service are checked.' });
  const interval = v.check_interval_min || DEFAULT_CHECK;
  const now = nowISO();
  db.prepare(`UPDATE service_visits SET last_checked_at=?, next_check_at=?, check_count=check_count+1 WHERE id=?`).run(now, addMin(interval), v.id);
  const nv = getVisit(v.id);
  syncTable(nv.table_id, 'in_service', nv);
  logEvent(nv, 'checked', 'in_service', 'in_service', actorOf(req), { note: (req.body.note || '').toString().slice(0, 200) || null });
  res.json({ success: true, visit: mapVisit(nv) });
});

// ── Change the check window (5/10/20 min) ────────────────────────────────────
router.put('/:id/interval', requireView, (req, res) => {
  const v = loadOwned(req, res); if (!v) return;
  const interval = clampInterval(req.body.check_interval_min);
  if (interval === null) return res.status(400).json({ error: 'Check interval must be 5, 10 or 20 minutes.' });
  const next = v.stage === 'in_service' ? addMin(interval, v.last_checked_at || v.service_started_at) : v.next_check_at;
  db.prepare(`UPDATE service_visits SET check_interval_min=?, next_check_at=? WHERE id=?`).run(interval, next, v.id);
  const nv = getVisit(v.id);
  logEvent(nv, 'interval', v.stage, v.stage, actorOf(req), { check_interval_min: interval });
  res.json({ success: true, visit: mapVisit(nv) });
});

// ── Move to paying ───────────────────────────────────────────────────────────
router.put('/:id/pay', requireView, (req, res) => {
  const v = loadOwned(req, res); if (!v) return;
  if (!['in_service', 'seated'].includes(v.stage)) return res.status(409).json({ error: `Cannot move a ${v.stage} visit to paying.` });
  db.prepare(`UPDATE service_visits SET stage='paying', paying_at=?, next_check_at=NULL WHERE id=?`).run(nowISO(), v.id);
  const nv = getVisit(v.id);
  syncTable(nv.table_id, 'paying', nv);
  logEvent(nv, 'paying', v.stage, 'paying', actorOf(req), null);
  res.json({ success: true, visit: mapVisit(nv) });
});

// ── Done — one tap when guests leave; frees the table. Optional tip recorded. ─
router.put('/:id/done', requireView, (req, res) => {
  const v = loadOwned(req, res); if (!v) return;
  if (v.stage === 'done' || v.stage === 'canceled') return res.status(409).json({ error: `Visit is already ${v.stage}.` });
  const tableId = v.table_id;
  const raw = req.body.tip_amount;
  const tip = raw != null && raw !== '' && Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : null;
  db.prepare(`UPDATE service_visits SET stage='done', done_at=?, next_check_at=NULL, tip_amount=COALESCE(?, tip_amount) WHERE id=?`).run(nowISO(), tip, v.id);
  const nv = getVisit(v.id);
  syncTable(tableId, 'done', nv);
  logEvent(nv, 'done', v.stage, 'done', actorOf(req), tip != null ? { tip_amount: tip } : null);
  res.json({ success: true, visit: mapVisit(nv) });
});

// ── Server flags: raise a hand for a manager, or ping a busser to clear a table ─
router.put('/:id/help', requireView, (req, res) => {
  const v = loadOwned(req, res); if (!v) return;
  const on = req.body.on === undefined ? !v.help_flag : !!req.body.on;
  db.prepare(`UPDATE service_visits SET help_flag=?, help_at=? WHERE id=?`).run(on ? 1 : 0, on ? nowISO() : null, v.id);
  const nv = getVisit(v.id);
  logEvent(nv, on ? 'help_raised' : 'help_cleared', v.stage, v.stage, actorOf(req), null);
  res.json({ success: true, visit: mapVisit(nv) });
});
router.put('/:id/bus', requireView, (req, res) => {
  const v = loadOwned(req, res); if (!v) return;
  const on = req.body.on === undefined ? !v.bus_flag : !!req.body.on;
  db.prepare(`UPDATE service_visits SET bus_flag=?, bus_at=? WHERE id=?`).run(on ? 1 : 0, on ? nowISO() : null, v.id);
  const nv = getVisit(v.id);
  logEvent(nv, on ? 'bus_requested' : 'bus_cleared', v.stage, v.stage, actorOf(req), null);
  res.json({ success: true, visit: mapVisit(nv) });
});

// ── Cancel — the party left before finishing (frees any table) ───────────────
router.put('/:id/cancel', requireView, (req, res) => {
  const v = loadOwned(req, res); if (!v) return;
  if (v.stage === 'done' || v.stage === 'canceled') return res.status(409).json({ error: `Visit is already ${v.stage}.` });
  const tableId = v.table_id;
  db.prepare(`UPDATE service_visits SET stage='canceled', canceled_at=?, next_check_at=NULL WHERE id=?`).run(nowISO(), v.id);
  const nv = getVisit(v.id);
  syncTable(tableId, 'canceled', nv);
  logEvent(nv, 'canceled', v.stage, 'canceled', actorOf(req), { reason: (req.body.reason || '').toString().slice(0, 200) || null });
  res.json({ success: true, visit: mapVisit(nv) });
});

// ── Transfer to another table ────────────────────────────────────────────────
router.put('/:id/transfer', requireView, (req, res) => {
  const v = loadOwned(req, res); if (!v) return;
  if (!['seated', 'in_service', 'paying'].includes(v.stage)) return res.status(409).json({ error: `Cannot move a ${v.stage} visit.` });
  const tableId = parseInt(req.body.table_id, 10);
  const t = db.prepare(`SELECT * FROM restaurant_tables WHERE id=?`).get(tableId);
  if (!t || String(t.location_id) !== String(v.location_id)) return res.status(400).json({ error: 'Table is not at this location.' });
  if (tableHeldBy(tableId, v.id)) return res.status(409).json({ error: `Table ${t.label} is already occupied.` });
  const from = v.table_id;
  db.prepare(`UPDATE service_visits SET table_id=? WHERE id=?`).run(tableId, v.id);
  const nv = getVisit(v.id);
  if (from) db.prepare(`UPDATE restaurant_tables SET status='available', guest_name=NULL, party_size=NULL, seated_at=NULL, est_free_at=NULL WHERE id=?`).run(from);
  syncTable(tableId, nv.stage, nv);
  logEvent(nv, 'transferred', v.stage, v.stage, actorOf(req), { from_table: from, to_table: tableId, to: t.label });
  res.json({ success: true, visit: mapVisit(nv) });
});

// ── One visit + its full movement history ────────────────────────────────────
router.get('/:id', requireView, (req, res) => {
  const v = loadOwned(req, res); if (!v) return;
  const events = db.prepare(`SELECT event, from_stage, to_stage, actor_name, actor_role, detail, created_at FROM visit_events WHERE visit_id=? ORDER BY id`).all(v.id)
    .map(e => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));
  res.json({ visit: mapVisit(v), events });
});

// ── Server performance — tables served + timings, scoped to the viewer ───────
router.get('/reports/servers', requireView, (req, res) => {
  const s = scopeLocation(req, res); if (!s) return;
  const params = []; let where = `stage IN ('in_service','paying','done') AND server_id IS NOT NULL`;
  if (s.locId) { where += ` AND location_id=?`; params.push(s.locId); }
  if (req.query.since) { where += ` AND COALESCE(service_started_at, seated_at, created_at) >= ?`; params.push(req.query.since); }
  const rows = db.prepare(`SELECT server_id, server_name,
      COUNT(*) tables_served,
      SUM(party_size) guests_served,
      SUM(check_count) checks_done,
      SUM(COALESCE(tip_amount,0)) tips_total,
      AVG(CASE WHEN done_at IS NOT NULL AND service_started_at IS NOT NULL
        THEN (julianday(done_at)-julianday(service_started_at))*1440 END) avg_service_min
    FROM service_visits WHERE ${where} GROUP BY server_id, server_name ORDER BY tables_served DESC`).all(...params);
  res.json({ servers: rows.map(r => ({ ...r, tips_total: Math.round((r.tips_total || 0) * 100) / 100, avg_service_min: r.avg_service_min != null ? Math.round(r.avg_service_min) : null })) });
});

// ── One server's own tally today: covers (guests) + tips ─────────────────────
router.get('/me/tally', requireView, (req, res) => {
  const s = scopeLocation(req, res); if (!s) return;
  const serverId = req.query.server_id ? parseInt(req.query.server_id, 10) : (req.user ? req.user.id : null);
  if (!serverId) return res.status(400).json({ error: 'server_id is required.' });
  const params = [serverId]; let where = `server_id=? AND stage IN ('in_service','paying','done')`;
  if (s.locId) { where += ` AND location_id=?`; params.push(s.locId); }
  const r = db.prepare(`SELECT COUNT(*) tables, SUM(party_size) covers, SUM(COALESCE(tip_amount,0)) tips,
    SUM(CASE WHEN stage IN ('in_service','paying') THEN 1 ELSE 0 END) open_tables FROM service_visits WHERE ${where}`).get(...params);
  res.json({ tables: r.tables || 0, covers: r.covers || 0, tips: Math.round((r.tips || 0) * 100) / 100, open_tables: r.open_tables || 0 });
});

module.exports = router;
