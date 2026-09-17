// Toast POS integration — admin endpoints (owner / admin only). Phase 0: configure
// the location↔Toast-restaurant mapping and verify connectivity. All Toast access is
// read-only; credentials live in env / Fly secrets (see lib/toast.js), never here.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const toast = require('../lib/toast');

const router = express.Router();
router.use(verifyToken);
router.use(requireRole(ROLES.ADMIN));   // owner / admin only — this is financial config

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
router.get('/status', (req, res) => {
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
router.post('/ping', async (req, res) => {
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
router.get('/mappings', (req, res) => res.json(mappingsWithLoc()));

// Map (or re-map) one of our locations to a Toast restaurant GUID. Best-effort:
// also caches the restaurant name from Toast when reachable.
router.post('/map', async (req, res) => {
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

// Remove a mapping.
router.delete('/map/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM toast_locations WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Mapping not found.' });
  db.prepare(`DELETE FROM toast_locations WHERE id=?`).run(row.id);
  auditLog(req, 'toast_unmap', 'location', row.location_id, { toast_guid: row.toast_guid });
  res.json({ success: true });
});

module.exports = router;
