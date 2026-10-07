// Public per-location barcode-scanner kiosk (/scanner/<slug>) — no login.
// A staffer opens their store's URL (e.g. /scanner/san-jose or /scanner/central-kitchen)
// and identifies with their employee code, exactly like the clock kiosk. The physical
// link + employee code is the trust model. Every write is attributed to that staffer and
// pinned to the slug's location; a staffer may only scan for a location they're assigned
// to (home store, an additional store, or all-location leadership).
const express = require('express');
const db = require('../db/database');
const { normSlug } = require('../lib/slug');
const { auditLog } = require('../lib/audit');
const { receiveLot, consumeFIFO } = require('../lib/lots');
const { seesAllLocations } = require('../lib/auth');
const { lookupProduct, rememberProduct } = require('../lib/productLookup');
const { parseScan, logScan, recentDuplicate, dupMessage } = require('../lib/barcode');
const { resolveVendor } = require('../lib/vendors');
const { shipByBarcode, openOrders } = require('../lib/transfer');
const { hubById, hubQueue, storeLines, shipScanOrder } = require('../lib/shipOrder');
const { resolveScan, receiveExisting, createAndReceive } = require('../lib/receive');
const { isCk, replicateItemFromCk } = require('../lib/ckReplication');
const scanKey = (raw) => { const p = parseScan(raw); return (p.gtin || p.code || '').toString().trim(); };

const router = express.Router();

// Light abuse guard (per IP), same shape as the clock kiosk.
const rate = new Map();
function throttle(req, res, next) {
  const ip = req.ip || 'x', now = Date.now(), e = rate.get(ip);
  if (!e || now - e.t > 60000) { rate.set(ip, { n: 1, t: now }); return next(); }
  if (e.n >= 80) return res.status(429).json({ error: 'Too many attempts — please wait a moment.' });
  e.n++; next();
}

const locDisplay = (name) => String(name || '').replace(/\s*[—–-]\s*/, ' ');
const locBySlug = (slug) => db.prepare(`SELECT id, name, slug, timezone, type FROM locations WHERE is_active=1`).all()
  .find(l => normSlug(l.slug || '') === normSlug(slug) || normSlug(l.name) === normSlug(slug));
const greetingWord = (tz) => { const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Los_Angeles', hour12: false, hour: '2-digit' }).format(new Date())) % 24; return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const validCode = (c) => /^[A-Za-z0-9-]{4,20}$/.test(c);

function authorizedAt(staff, locId) {
  if (String(staff.location_id) === String(locId)) return true;
  if (seesAllLocations(staff.role)) return true;
  return !!db.prepare(`SELECT 1 FROM staff_locations WHERE user_id=? AND location_id=?`).get(staff.id, locId);
}

// Resolve the location (by slug) and staffer (by employee code) for a kiosk request.
function ctx(slug, code) {
  const loc = locBySlug(slug); if (!loc) return { err: 404 };
  const c = String(code || '').trim();
  if (!validCode(c)) return { loc, err: 'format' };
  const staff = db.prepare(`SELECT id, name, role, location_id FROM users WHERE employee_code=? AND is_active=1`).get(c);
  if (!staff) return { loc, err: 'notfound' };
  if (!authorizedAt(staff, loc.id)) return { loc, staff, err: 'forbidden' };
  return { loc, staff };
}
// Turn a ctx error into a JSON response; returns true if it handled one.
function sentErr(res, c) {
  if (c.err === 404) { res.status(404).json({ ok: false, error: 'Unknown location.' }); return true; }
  if (c.err === 'format') { res.json({ ok: false, error: 'That employee code doesn’t look right — please check it and try again.' }); return true; }
  if (c.err === 'notfound') { res.json({ ok: false, error: 'Employee code not found. Please check again, or ask your manager.' }); return true; }
  if (c.err === 'forbidden') { res.json({ ok: false, error: 'You’re not assigned to this location, so you can’t scan here.' }); return true; }
  return false;
}
const findItem = (loc, code) => db.prepare(`SELECT * FROM inventory WHERE location_id=? AND barcode=? AND is_active=1`).get(loc, code);
const auditReq = (staff, body) => ({ user: { id: staff.id }, body });

// Active locations for the bare /scanner picker (public).
router.get('/kiosk-locations', (req, res) => {
  const locs = db.prepare(`SELECT id, name, slug FROM locations WHERE is_active=1 ORDER BY name`).all();
  res.json(locs.map(l => ({ slug: l.slug || normSlug(l.name), display: locDisplay(l.name) })));
});

// Location header for the kiosk page.
router.get('/kiosk/:slug', (req, res) => {
  const loc = locBySlug(req.params.slug);
  if (!loc) return res.status(404).json({ error: 'Unknown location.' });
  res.json({ id: loc.id, name: loc.name, display: locDisplay(loc.name), type: loc.type });
});

// Identify: enter an employee code → greeting (reveals the scanner).
router.post('/kiosk/:slug/identify', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  res.json({ ok: true, name: c.staff.name, greeting: `${greetingWord(c.loc.timezone)}, ${String(c.staff.name || '').split(' ')[0]}` });
});

// Resolve a product from a barcode: group dictionary → Open Food Facts + sister DBs →
// UPCitemdb (all free). Also flags weighed/produce codes. Public.
router.get('/kiosk/:slug/lookup/:code', async (req, res) => {
  const p = await lookupProduct(req.params.code);
  res.json({ found: p.found, name: p.name, brand: p.brand, quantity: p.size, size: p.size, source: p.source, weighed: p.weighed, price: p.price });
});

// Resolve a scanned barcode: is it in stock here, and what does the (global) Glossary know?
router.post('/kiosk/:slug/resolve', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  const info = resolveScan({ locId: c.loc.id, code: req.body && req.body.code });
  const p = info.parsed || {};
  res.json({ ok: true, found: info.in_stock, code: info.code, item: info.item || null,
    in_glossary: info.in_glossary, glossary: info.glossary || null, duplicate_box: info.duplicate_box || null,
    last_box: info.last_box || null, scale_code: info.scale_code || null,
    gtin: p.gtin, is_gs1: p.isGs1, weight_lb: p.weightLb, weight_kg: p.weightKg,
    prod_date: p.prodDate, pack_date: p.packDate, expiry: p.expiry, lot: p.lot, serial: p.serial });
});

// The location's item list (for the "link to existing item" picker).
router.post('/kiosk/:slug/items', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  res.json({ ok: true, items: db.prepare(`SELECT id, item_name, category, unit, quantity FROM inventory WHERE location_id=? AND is_active=1 ORDER BY item_name`).all(c.loc.id) });
});

// The location's vendor list (for the supplier picker on the create form).
router.post('/kiosk/:slug/vendors', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  res.json({ ok: true, vendors: db.prepare(`SELECT id, name FROM vendors WHERE location_id=? AND is_active=1 ORDER BY name`).all(c.loc.id) });
});

// The location's shelves/sections (for the Shelf / Section picker on the create form).
router.post('/kiosk/:slug/sections', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  res.json({ ok: true, sections: db.prepare(`SELECT id, name FROM storage_sections WHERE location_id=? AND is_active=1 ORDER BY sort_order, name`).all(c.loc.id) });
});

// Scan-to-check: how much of a scanned product every location is holding (read-only).
router.post('/kiosk/:slug/stock', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  const p = parseScan(req.body && req.body.code);
  const code = (p.gtin || p.code || '').toString().trim();
  if (!code) return res.json({ ok: true, found: false, code });
  const seed = db.prepare(`SELECT item_name, unit FROM inventory WHERE barcode=? AND is_active=1 ORDER BY id LIMIT 1`).get(code);
  if (!seed) return res.json({ ok: true, found: false, code, gtin: p.gtin });
  const rows = db.prepare(`SELECT l.name location, l.type, i.quantity, i.unit FROM inventory i JOIN locations l ON l.id=i.location_id
    WHERE i.item_name=? AND i.is_active=1 ORDER BY (l.type='central_kitchen') DESC, l.name`).all(seed.item_name);
  const last = db.prepare(`SELECT weight_lb, prod_date, pack_date, expiry, lot, serial FROM scan_events WHERE gtin=? ORDER BY id DESC LIMIT 1`).get(code);
  res.json({ ok: true, found: true, code, gtin: p.gtin, item_name: seed.item_name, unit: seed.unit, last_scan: last || null,
    total: Math.round(rows.reduce((a, r) => a + (r.quantity || 0), 0) * 1000) / 1000, by_location: rows });
});

// Ship-out destinations from this kiosk's location (everything but itself; stores first).
router.post('/kiosk/:slug/targets', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  res.json({ ok: true, targets: db.prepare(`SELECT id, name, type FROM locations WHERE is_active=1 AND id<>? ORDER BY (type='restaurant') DESC, name`).all(c.loc.id) });
});

// Open order lines a destination store is waiting on.
router.post('/kiosk/:slug/orders', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  res.json({ ok: true, orders: openOrders(req.body && req.body.to_location_id) });
});

// ── Shipping from a hub kiosk (CK / Warehouse): the scan-to-fulfil order flow ──
// The kiosk's own location is the hub. Without a store → the order queue; with a to_location_id →
// that store's open order lines (+ the hub's on-hand + barcode for matching).
router.post('/kiosk/:slug/ship-queue', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  const hub = hubById(c.loc.id);
  if (!hub) return res.status(400).json({ ok: false, error: 'Shipping is only available at a Central Kitchen or Warehouse.' });
  const storeId = req.body && req.body.to_location_id;
  if (storeId) {
    const store = db.prepare(`SELECT id, name FROM locations WHERE id=?`).get(storeId);
    if (!store) return res.status(404).json({ ok: false, error: 'Store not found.' });
    return res.json({ ok: true, hub: { id: hub.id, name: hub.name, type: hub.type }, store, lines: storeLines(hub.id, store.id) });
  }
  res.json({ ok: true, hub: { id: hub.id, name: hub.name, type: hub.type }, orders: hubQueue(hub.id) });
});

// Scan an item to fulfil a line of the chosen store's order from this hub kiosk.
router.post('/kiosk/:slug/ship-scan', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  if (!hubById(c.loc.id)) return res.status(400).json({ ok: false, error: 'Shipping is only available at a Central Kitchen or Warehouse.' });
  const r = shipScanOrder({ hubId: c.loc.id, storeId: req.body && req.body.to_location_id, code: req.body && req.body.code, quantity: req.body && req.body.quantity, weight: req.body && req.body.weight, confirm: req.body && req.body.confirm, userId: c.staff.id });
  if (r.not_on_order) return res.json({ ok: false, not_on_order: true, item_name: r.item_name, error: r.error });
  if (r.over) return res.json({ ok: false, ...r });
  if (r.error) return res.status(r.status || 400).json({ ok: false, error: r.error, found: r.found, code: r.code });
  auditLog(auditReq(c.staff, req.body), 'distribution_ship_scan', 'distribution_order', r.line_id, { item: r.item_name, qty: r.shipped, hub: c.loc.name, to: parseInt(req.body.to_location_id, 10), via: 'scanner_kiosk', over: r.over });
  res.json(r);
});

// Scan-to-ship: move the scanned item from this kiosk's location to a destination.
router.post('/kiosk/:slug/transfer', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  const r = shipByBarcode({ fromLoc: c.loc.id, toLoc: req.body && req.body.to_location_id, code: req.body && req.body.code, quantity: req.body && req.body.quantity, userId: c.staff.id, confirm: req.body && req.body.confirm });
  if (!r.ok) {
    if (r.duplicate) return res.json({ ok: true, duplicate: true, message: r.message });
    return res.status(r.status || 400).json({ ok: false, error: r.error, found: r.found, code: r.code });
  }
  auditLog(auditReq(c.staff, req.body), 'transfer', 'inventory', r.src.id, { quantity: parseFloat(req.body.quantity), from: c.loc.id, to: r.to, via: 'scanner_kiosk', order_id: r.order ? r.order.id : null });
  res.json({ ok: true, success: true, item: r.item, to: r.to, order: r.order });
});

// Scan-to-use: consume the scanned item at this kiosk's location (production / prep / to serve).
router.post('/kiosk/:slug/use', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  const loc = c.loc.id, staff = c.staff;
  const p = parseScan(req.body && req.body.code);
  const code = (p.gtin || p.code || '').toString().trim();
  const item = code && findItem(loc, code);
  if (!item) return res.status(404).json({ ok: false, error: 'No item is linked to that barcode here.', found: false, code });
  const catchw = item.is_catch_weight;
  const qty = parseFloat(catchw ? (req.body.weight != null && req.body.weight !== '' ? req.body.weight : p.weightLb) : req.body.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ ok: false, error: catchw ? 'Enter the weight used.' : 'Enter a quantity used.' });
  if (item.quantity < qty) return res.status(400).json({ ok: false, error: `Only ${item.quantity} ${item.unit} on hand.` });
  const reason = (req.body.reason || 'kitchen use').toString().slice(0, 120);
  db.prepare(`UPDATE inventory SET quantity=MAX(0, quantity-?), last_updated=datetime('now') WHERE id=?`).run(qty, item.id);
  consumeFIFO(item.id, qty);
  db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'out',?,?)`).run(item.id, loc, qty, staff.id, `Used: ${reason}`);
  logScan({ itemId: item.id, locationId: loc, action: 'use', parsed: p, quantity: qty, userId: staff.id });
  auditLog(auditReq(staff, req.body), 'stock_used', 'inventory', item.id, { item: item.item_name, qty, reason, via: 'scanner_kiosk' });
  res.json({ ok: true, success: true, item: db.prepare(`SELECT * FROM inventory WHERE id=?`).get(item.id) });
});

// Smart receive of an in-stock item (catch-weight adds weight, else count; serial-dup guard).
router.post('/kiosk/:slug/receive', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  const info = resolveScan({ locId: c.loc.id, code: req.body && req.body.code });
  if (!info.code) return res.status(400).json({ ok: false, error: 'A barcode is required.' });
  if (!info.in_stock) return res.status(404).json({ ok: false, new_item: true, glossary: info.glossary, parsed: info.parsed });
  const r = receiveExisting({ locId: c.loc.id, item: info.item, body: req.body, user: { id: c.staff.id } });
  if (r.duplicate) return res.json({ ok: true, duplicate: true, kind: r.kind, message: r.message });
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  auditLog(auditReq(c.staff, req.body), 'stock_received', 'inventory', info.item.id, { item: info.item.item_name, added: r.added, kind: r.kind, via: 'scanner_kiosk' });
  res.json({ ok: true, success: true, item: r.item, added: r.added, kind: r.kind });
});

// Add stock ('in') or set a cycle count on the item matching a barcode.
router.post('/kiosk/:slug/scan', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  const loc = c.loc.id, staff = c.staff;
  const p = parseScan(req.body && req.body.code);
  const code = (p.gtin || p.code || '').toString().trim();
  const item = code && findItem(loc, code);
  if (!item) return res.status(404).json({ ok: false, error: 'No item is linked to that barcode here.', found: false, code });
  const mode = req.body.mode === 'count' ? 'count' : 'in';
  const qty = parseFloat(req.body.quantity);
  const expiry = req.body.expiry_date || p.expiry || p.packDate || p.prodDate || null;
  const lot = req.body.lot_code || p.lot || null;
  if (mode === 'count') {
    if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ ok: false, error: 'Enter a valid count.' });
    const variance = Math.round((qty - item.quantity) * 1000) / 1000;
    db.prepare(`UPDATE inventory SET quantity=?, last_updated=datetime('now') WHERE id=?`).run(qty, item.id);
    if (variance < 0) consumeFIFO(item.id, -variance);
    db.prepare(`INSERT INTO cycle_counts (item_id, location_id, system_qty, counted_qty, variance, user_id) VALUES (?,?,?,?,?,?)`).run(item.id, loc, item.quantity, qty, variance, staff.id);
    auditLog(auditReq(staff, req.body), 'cycle_count', 'inventory', item.id, { item: item.item_name, counted: qty, variance, via: 'scanner_kiosk' });
    logScan({ itemId: item.id, locationId: loc, action: 'count', parsed: p, quantity: qty, userId: staff.id });
  } else {
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ ok: false, error: 'Enter a quantity to receive.' });
    if (!(req.body && req.body.confirm)) {
      const d = recentDuplicate({ itemId: item.id, gtin: p.gtin, serial: p.serial, actions: ['receive', 'create'], quantity: qty });
      if (d.dup) return res.json({ ok: true, duplicate: true, kind: d.kind, code, message: dupMessage(d, 'receive', item.item_name, p.serial) });
    }
    db.prepare(`UPDATE inventory SET quantity=quantity+?, last_updated=datetime('now') WHERE id=?`).run(qty, item.id);
    receiveLot({ item_id: item.id, location_id: loc, quantity: qty, unit_cost: item.unit_cost, expiry_date: expiry, lot_code: lot, user_id: staff.id });
    db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'in',?,?)`).run(item.id, loc, qty, staff.id, `Scanned in (kiosk)${lot ? ` · lot ${lot}` : ''}${expiry ? ` · exp ${expiry}` : ''}`);
    auditLog(auditReq(staff, req.body), 'stock_received', 'inventory', item.id, { item: item.item_name, qty, lot, expiry, via: 'scanner_kiosk' });
    logScan({ itemId: item.id, locationId: loc, action: 'receive', parsed: p, quantity: qty, userId: staff.id });
  }
  res.json({ ok: true, success: true, item: db.prepare(`SELECT * FROM inventory WHERE id=?`).get(item.id) });
});

// Link a barcode to an existing item at the location.
router.post('/kiosk/:slug/link', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  const loc = c.loc.id;
  const code = scanKey(req.body && req.body.code);
  const item = db.prepare(`SELECT * FROM inventory WHERE id=? AND location_id=?`).get(req.body.item_id, loc);
  if (!code || !item) return res.status(400).json({ ok: false, error: 'A barcode and item are required.' });
  const clash = db.prepare(`SELECT id FROM inventory WHERE location_id=? AND barcode=? AND is_active=1 AND id<>?`).get(loc, code, item.id);
  if (clash) return res.status(409).json({ ok: false, error: 'That barcode is already linked to another item here.' });
  db.prepare(`UPDATE inventory SET barcode=? WHERE id=?`).run(code, item.id);
  rememberProduct(code, item.item_name, c.staff.id);
  logScan({ itemId: item.id, locationId: loc, action: 'link', parsed: parseScan(req.body && req.body.code), userId: c.staff.id });
  auditLog(auditReq(c.staff, req.body), 'barcode_link', 'inventory', item.id, { code, item: item.item_name, via: 'scanner_kiosk' });
  res.json({ ok: true, success: true, item: db.prepare(`SELECT * FROM inventory WHERE id=?`).get(item.id) });
});

// Create a new item from the scan form, write it into the Glossary, receive opening stock.
router.post('/kiosk/:slug/create', throttle, (req, res) => {
  const c = ctx(req.params.slug, req.body && req.body.employee_code);
  if (sentErr(res, c)) return;
  const r = createAndReceive({ locId: c.loc.id, body: req.body, user: { id: c.staff.id } });
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  // A new item scanned at the Central Kitchen seeds a 0-qty stock row at every store (same as the
  // console and the manual Add-Item form); the Warehouse doesn't replicate. Glossary is group-wide.
  let replicated = 0;
  if (isCk(c.loc.id)) { const ckItem = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(r.id); try { replicated = replicateItemFromCk(ckItem); } catch { /* best effort */ } }
  auditLog(auditReq(c.staff, req.body), 'item_create', 'inventory', r.id, { name: r.item.item_name, location_id: c.loc.id, received: r.received, replicated, via: 'scanner_kiosk' });
  res.json({ ok: true, success: true, id: r.id, item: r.item, received: r.received, replicated });
});

module.exports = router;
