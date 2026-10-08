// Staff-app barcode scanning — a floor staffer scans a product with their phone and
// receives / counts / links it into THEIR store's inventory. Dual-auth like the other
// staff-facing routes: the Staff app calls with the service key + ?as=<staff email>, or a
// normal Management JWT. Everything is pinned to the acting staffer's own store.
const express = require('express');
const db = require('../db/database');
const { verifyToken } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const { receiveLot, consumeFIFO } = require('../lib/lots');
const { lookupProduct, rememberProduct } = require('../lib/productLookup');
const { parseScan, logScan, recentDuplicate, dupMessage } = require('../lib/barcode');
const { resolveVendor } = require('../lib/vendors');
const { resolveScan, receiveExisting, createAndReceive } = require('../lib/receive');
const { receiveAgainstOrder, receiveAgainstTransfer } = require('../lib/inbound');
const { shipByBarcode, openOrders } = require('../lib/transfer');

const router = express.Router();
const scanKey = (raw) => { const p = parseScan(raw); return (p.gtin || p.code || '').toString().trim(); };
const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

router.use((req, res, next) => {
  const key = req.headers['x-service-key'] || req.query.key;
  if (key && key === SERVICE_KEY) {
    const email = String(req.query.as || req.headers['x-as-user'] || '').toLowerCase().trim();
    const u = email && db.prepare(`SELECT id, name, role, location_id FROM users WHERE lower(email)=? AND is_active=1`).get(email);
    if (!u) return res.status(401).json({ error: 'Unknown staff member.' });
    req.user = { id: u.id, name: u.name, role: u.role, location_id: u.location_id };
    return next();
  }
  return verifyToken(req, res, next);
});

const storeLoc = (req) => req.user.location_id;
const findItem = (loc, code) => db.prepare(`SELECT i.*, s.name AS section_name FROM inventory i LEFT JOIN storage_sections s ON s.id=i.section_id WHERE i.location_id=? AND i.barcode=? AND i.is_active=1`).get(loc, code);

// The store's item list (for the "link to existing item" picker).
router.get('/items/list', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.json([]);
  res.json(db.prepare(`SELECT id, item_name, category, unit, quantity FROM inventory WHERE location_id=? AND is_active=1 ORDER BY item_name`).all(loc));
});

// The store's vendor list (for the supplier picker on the scan create form).
router.get('/vendors/list', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.json([]);
  res.json(db.prepare(`SELECT id, name FROM vendors WHERE location_id=? AND is_active=1 ORDER BY name`).all(loc));
});

// Resolve a product from a barcode: group dictionary → Open Food Facts + sister DBs →
// UPCitemdb (all free). Also flags weighed/produce codes.
router.get('/lookup/:code', async (req, res) => {
  const p = await lookupProduct(req.params.code, req.user.id);
  res.json({ found: p.found, name: p.name, brand: p.brand, quantity: p.size, size: p.size, source: p.source, weighed: p.weighed, price: p.price });
});

// Add stock ('in') or set a cycle count on the item matching a barcode.
router.post('/scan', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.status(400).json({ error: 'No store for this account.' });
  const p = parseScan(req.body.code);
  const code = (p.gtin || p.code || '').toString().trim();
  const item = code && findItem(loc, code);
  if (!item) return res.status(404).json({ error: 'No item is linked to that barcode at your store.', found: false, code });
  const mode = req.body.mode === 'count' ? 'count' : 'in';
  const qty = parseFloat(req.body.quantity);
  const expiry = req.body.expiry_date || p.expiry || p.packDate || p.prodDate || null;
  const lot = req.body.lot_code || p.lot || null;
  if (mode === 'count') {
    if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: 'Enter a valid count.' });
    const variance = Math.round((qty - item.quantity) * 1000) / 1000;
    db.prepare(`UPDATE inventory SET quantity=?, last_updated=datetime('now') WHERE id=?`).run(qty, item.id);
    if (variance < 0) consumeFIFO(item.id, -variance);
    db.prepare(`INSERT INTO cycle_counts (item_id, location_id, system_qty, counted_qty, variance, user_id) VALUES (?,?,?,?,?,?)`).run(item.id, loc, item.quantity, qty, variance, req.user.id);
    auditLog(req, 'cycle_count', 'inventory', item.id, { item: item.item_name, counted: qty, variance, via: 'scan' });
    logScan({ itemId: item.id, locationId: loc, action: 'count', parsed: p, quantity: qty, userId: req.user.id });
  } else {
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Enter a quantity to receive.' });
    if (!req.body.confirm) {
      const d = recentDuplicate({ itemId: item.id, gtin: p.gtin, serial: p.serial, actions: ['receive', 'create'], quantity: qty });
      if (d.dup) return res.json({ duplicate: true, kind: d.kind, code, message: dupMessage(d, 'receive', item.item_name, p.serial) });
    }
    db.prepare(`UPDATE inventory SET quantity=quantity+?, last_updated=datetime('now') WHERE id=?`).run(qty, item.id);
    receiveLot({ item_id: item.id, location_id: loc, quantity: qty, unit_cost: item.unit_cost, expiry_date: expiry, lot_code: lot, user_id: req.user.id });
    db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'in',?,?)`).run(item.id, loc, qty, req.user.id, `Scanned in${lot ? ` · lot ${lot}` : ''}${expiry ? ` · exp ${expiry}` : ''}`);
    auditLog(req, 'stock_received', 'inventory', item.id, { item: item.item_name, qty, lot, expiry, via: 'scan' });
    logScan({ itemId: item.id, locationId: loc, action: 'receive', parsed: p, quantity: qty, userId: req.user.id });
  }
  res.json({ success: true, item: db.prepare(`SELECT * FROM inventory WHERE id=?`).get(item.id) });
});

// Link a barcode to an existing item at the store.
router.post('/link', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.status(400).json({ error: 'No store for this account.' });
  const code = scanKey(req.body.code);
  const item = db.prepare(`SELECT * FROM inventory WHERE id=? AND location_id=?`).get(req.body.item_id, loc);
  if (!code || !item) return res.status(400).json({ error: 'A barcode and item are required.' });
  const clash = db.prepare(`SELECT id FROM inventory WHERE location_id=? AND barcode=? AND is_active=1 AND id<>?`).get(loc, code, item.id);
  if (clash) return res.status(409).json({ error: 'That barcode is already linked to another item.' });
  db.prepare(`UPDATE inventory SET barcode=? WHERE id=?`).run(code, item.id);
  rememberProduct(code, item.item_name, req.user.id);
  logScan({ itemId: item.id, locationId: loc, action: 'link', parsed: parseScan(req.body.code), userId: req.user.id });
  auditLog(req, 'barcode_link', 'inventory', item.id, { code, item: item.item_name, via: 'scan' });
  res.json({ success: true, item: db.prepare(`SELECT * FROM inventory WHERE id=?`).get(item.id) });
});

// Create a new item (linked to the barcode) at the store, optional opening stock.
router.post('/create', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.status(400).json({ error: 'No store for this account.' });
  const name = String(req.body.item_name || '').trim();
  if (!name) return res.status(400).json({ error: 'Item name is required.' });
  const p = parseScan(req.body.barcode);
  const code = (p.gtin || p.code || '').toString().trim() || null;
  if (db.prepare(`SELECT id FROM inventory WHERE item_name=? AND location_id=?`).get(name, loc)) return res.status(409).json({ error: 'That item already exists at your store.' });
  if (code) { const bcClash = db.prepare(`SELECT item_name FROM inventory WHERE location_id=? AND barcode=? AND is_active=1`).get(loc, code); if (bcClash) return res.status(409).json({ error: `That barcode is already on “${bcClash.item_name}” at your store — scan it to receive that item instead.` }); }
  const qty = Math.max(0, parseFloat(req.body.quantity) || 0);
  const cost = Math.max(0, parseFloat(req.body.unit_cost) || 0);
  const minQ = Math.max(0, parseFloat(req.body.min_quantity) || 0);
  const par = req.body.par_level == null || req.body.par_level === '' ? null : Math.max(0, parseFloat(req.body.par_level) || 0);
  const vendorId = resolveVendor(loc, req.body);
  const r = db.prepare(`INSERT INTO inventory (location_id, item_name, category, unit, quantity, min_quantity, par_level, unit_cost, sku, description, barcode, vendor_id, vendor_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(loc, name, req.body.category || 'Other', req.body.unit || 'units', qty, minQ, par, cost,
         (req.body.sku || '').toString().trim() || null, (req.body.description || '').toString().slice(0, 500) || null, code,
         vendorId, (req.body.vendor_code || '').toString().trim() || null);
  if (qty > 0) {
    const expiry = req.body.expiry_date || p.expiry || p.packDate || p.prodDate || null;
    const lot = req.body.lot_code || p.lot || null;
    receiveLot({ item_id: r.lastInsertRowid, location_id: loc, quantity: qty, unit_cost: cost, expiry_date: expiry, lot_code: lot, user_id: req.user.id });
    db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'in',?,?)`).run(r.lastInsertRowid, loc, qty, req.user.id, 'Opening stock (scan)');
  }
  if (code) { rememberProduct(code, name, req.user.id); logScan({ itemId: r.lastInsertRowid, locationId: loc, action: 'create', parsed: p, quantity: qty, userId: req.user.id }); }
  auditLog(req, 'item_create', 'inventory', r.lastInsertRowid, { name, location_id: loc, via: 'scan' });
  res.json({ success: true, id: r.lastInsertRowid });
});

// ── Smart scan-to-receive (glossary-aware), pinned to the staffer's own store ──
// One call per scan: what is this, is it in stock here, what does the Glossary/label know.
router.get('/resolve/:code', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.status(400).json({ error: 'No store for this account.' });
  res.json(resolveScan({ locId: loc, code: req.params.code }));
});

// Receive a scanned item already in stock here; if new, return { new_item:true } + glossary/label.
router.post('/receive', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.status(400).json({ error: 'No store for this account.' });
  const info = resolveScan({ locId: loc, code: req.body.code });
  if (!info.code) return res.status(400).json({ error: 'A barcode is required.' });
  if (!info.in_stock) return res.status(404).json({ new_item: true, ...info });
  const r = receiveExisting({ locId: loc, item: info.item, body: req.body, user: req.user });
  if (r.duplicate) return res.json({ duplicate: true, kind: r.kind, message: r.message });
  if (r.error) return res.status(400).json({ error: r.error });
  auditLog(req, 'stock_received', 'inventory', info.item.id, { item: info.item.item_name, added: r.added, kind: r.kind, via: 'scan' });
  res.json({ success: true, item: r.item, added: r.added, kind: r.kind });
});

// Receive a scanned item against an open shipped order / in-transit transfer to this store.
router.post('/receive-inbound', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.status(400).json({ error: 'No store for this account.' });
  const qty = (req.body.weight != null && req.body.weight !== '') ? req.body.weight : req.body.quantity;
  const args = { qty, code: req.body.code, userId: req.user.id, locId: loc };
  const r = req.body.order_id ? receiveAgainstOrder({ orderId: req.body.order_id, ...args })
    : req.body.transfer_id ? receiveAgainstTransfer({ transferId: req.body.transfer_id, ...args })
    : { error: 'Pick the order or transfer to receive against.', status: 400 };
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  auditLog(req, 'stock_received', 'inventory', null, { item: r.item_name, received: r.received, line: r.line_id, via: 'scan-inbound' });
  res.json(r);
});

// Create a new stock item from the scan form + write it to the Glossary + receive opening stock.
router.post('/receive-create', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.status(400).json({ error: 'No store for this account.' });
  const r = createAndReceive({ locId: loc, body: req.body, user: req.user });
  if (r.error) return res.status(400).json({ error: r.error });
  auditLog(req, 'item_create', 'inventory', r.id, { name: r.item.item_name, location_id: loc, received: r.received, via: 'scan' });
  res.json({ success: true, id: r.id, item: r.item, received: r.received });
});

// ── Scan-to-check (read-only, every location + CK) ─────────────────────────────
// Anyone may SEE how much of a product each location holds; actions stay at their own store.
router.get('/check/:code', (req, res) => {
  const p = parseScan(req.params.code);
  const code = (p.gtin || p.code || '').toString().trim();
  if (!code) return res.json({ found: false, code });
  const seed = db.prepare(`SELECT item_name, unit FROM inventory WHERE barcode=? AND is_active=1 ORDER BY id LIMIT 1`).get(code);
  if (!seed) return res.json({ found: false, code, gtin: p.gtin });
  const rows = db.prepare(`SELECT l.name AS location, l.type, i.location_id, i.quantity, i.min_quantity, i.unit, s.name AS section
    FROM inventory i JOIN locations l ON l.id=i.location_id
    LEFT JOIN storage_sections s ON s.id=i.section_id
    WHERE i.item_name=? AND i.is_active=1 ORDER BY (l.type='central_kitchen') DESC, l.name`).all(seed.item_name);
  const total = rows.reduce((a, r) => a + (r.quantity || 0), 0);
  res.json({ found: true, code, gtin: p.gtin, item_name: seed.item_name, unit: seed.unit, mine: storeLoc(req),
    total: Math.round(total * 1000) / 1000, by_location: rows });
});

// ── Scan-to-ship / transfer (from THIS store only) + fulfill a store→CK order ──
router.get('/ship/targets', (req, res) => {
  const from = storeLoc(req);
  res.json(db.prepare(`SELECT id, name, type FROM locations WHERE is_active=1 AND id<>? ORDER BY (type='restaurant') DESC, name`).all(from || 0));
});
router.get('/ship/orders', (req, res) => res.json(openOrders(req.query.to_location_id)));
router.post('/ship', (req, res) => {
  const from = storeLoc(req); if (!from) return res.status(400).json({ error: 'No store for this account.' });
  const r = shipByBarcode({ fromLoc: from, toLoc: req.body.to_location_id, code: req.body.code, quantity: req.body.quantity, userId: req.user.id, confirm: req.body.confirm });
  if (!r.ok) { if (r.duplicate) return res.json({ duplicate: true, message: r.message }); return res.status(r.status || 400).json({ error: r.error, found: r.found, code: r.code }); }
  auditLog(req, 'transfer', 'inventory', r.src.id, { quantity: parseFloat(req.body.quantity), from: Number(from), to: r.to, via: 'scan', order_id: r.order ? r.order.id : null });
  res.json({ success: true, item: r.item, to: r.to, order: r.order });
});

// ── Scan-to-use (consume for the kitchen / to serve) at THIS store ─────────────
router.post('/use', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.status(400).json({ error: 'No store for this account.' });
  const p = parseScan(req.body.code);
  const code = (p.gtin || p.code || '').toString().trim();
  const item = code && findItem(loc, code);
  if (!item) return res.status(404).json({ error: 'No item is linked to that barcode here.', found: false, code });
  const catchw = item.is_catch_weight;
  const qty = parseFloat(catchw ? (req.body.weight != null && req.body.weight !== '' ? req.body.weight : p.weightLb) : req.body.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: catchw ? 'Enter the weight used.' : 'Enter a quantity used.' });
  if (item.quantity < qty) return res.status(400).json({ error: `Only ${item.quantity} ${item.unit} on hand.` });
  const reason = (req.body.reason || 'kitchen use').toString().slice(0, 120);
  db.prepare(`UPDATE inventory SET quantity=MAX(0, quantity-?), last_updated=datetime('now') WHERE id=?`).run(qty, item.id);
  consumeFIFO(item.id, qty);
  db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'out',?,?)`).run(item.id, loc, qty, req.user.id, `Used: ${reason}`);
  logScan({ itemId: item.id, locationId: loc, action: 'use', parsed: p, quantity: qty, userId: req.user.id });
  auditLog(req, 'stock_used', 'inventory', item.id, { item: item.item_name, qty, reason, via: 'scan' });
  res.json({ success: true, item: db.prepare(`SELECT * FROM inventory WHERE id=?`).get(item.id) });
});

// ── Storage sections (shelves) — scoped to the staffer's own store ─────────────
// Store staff can organize their storage: add/rename/remove shelves and assign items to them.
router.get('/sections', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.json([]);
  res.json(db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM inventory i WHERE i.section_id=s.id AND i.is_active=1) AS item_count
    FROM storage_sections s WHERE s.location_id=? AND s.is_active=1 ORDER BY s.sort_order, s.name`).all(loc));
});
router.get('/sections/map', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.status(400).json({ error: 'No store for this account.' });
  const sections = db.prepare(`SELECT * FROM storage_sections WHERE location_id=? AND is_active=1 ORDER BY sort_order, name`).all(loc);
  const itemsFor = (sid) => db.prepare(`SELECT id, item_name, quantity, unit, min_quantity, is_catch_weight FROM inventory
      WHERE location_id=? AND is_active=1 AND ${sid == null ? 'section_id IS NULL' : 'section_id=?'} ORDER BY category, item_name`)
    .all(...(sid == null ? [loc] : [loc, sid]));
  res.json({ sections: sections.map(s => ({ ...s, items: itemsFor(s.id) })), unassigned: itemsFor(null) });
});
router.post('/sections', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.status(400).json({ error: 'No store for this account.' });
  const name = (req.body.name || '').toString().trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'A shelf / section name is required.' });
  const dup = db.prepare(`SELECT id, is_active FROM storage_sections WHERE location_id=? AND name=? COLLATE NOCASE`).get(loc, name);
  if (dup) {
    if (!dup.is_active) { db.prepare(`UPDATE storage_sections SET is_active=1, note=? WHERE id=?`).run((req.body.note || '').toString().slice(0, 200) || null, dup.id); return res.json({ success: true, id: dup.id, reactivated: true }); }
    return res.status(409).json({ error: 'A shelf / section with that name already exists.' });
  }
  const sort = ((db.prepare(`SELECT MAX(sort_order) m FROM storage_sections WHERE location_id=?`).get(loc) || {}).m || 0) + 1;
  const r = db.prepare(`INSERT INTO storage_sections (location_id, name, note, sort_order) VALUES (?,?,?,?)`)
    .run(loc, name, (req.body.note || '').toString().slice(0, 200) || null, sort);
  auditLog(req, 'section_create', 'storage_sections', r.lastInsertRowid, { name, location_id: loc, via: 'staff' });
  res.json({ success: true, id: r.lastInsertRowid });
});
router.put('/sections/:id', (req, res) => {
  const loc = storeLoc(req);
  const s = db.prepare(`SELECT * FROM storage_sections WHERE id=? AND location_id=?`).get(req.params.id, loc);
  if (!s) return res.status(404).json({ error: 'Section not found at your store.' });
  const fields = [], vals = [];
  if (req.body.name !== undefined && String(req.body.name).trim()) {
    const nm = String(req.body.name).trim().slice(0, 60);
    const clash = db.prepare(`SELECT id FROM storage_sections WHERE location_id=? AND name=? COLLATE NOCASE AND id<>?`).get(loc, nm, s.id);
    if (clash) return res.status(409).json({ error: 'Another shelf / section already has that name.' });
    fields.push('name=?'); vals.push(nm);
  }
  if (req.body.note !== undefined) { fields.push('note=?'); vals.push((req.body.note || '').toString().slice(0, 200) || null); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(s.id);
  db.prepare(`UPDATE storage_sections SET ${fields.join(',')} WHERE id=?`).run(...vals);
  res.json({ success: true });
});
router.delete('/sections/:id', (req, res) => {
  const loc = storeLoc(req);
  const s = db.prepare(`SELECT * FROM storage_sections WHERE id=? AND location_id=?`).get(req.params.id, loc);
  if (!s) return res.status(404).json({ error: 'Section not found at your store.' });
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE inventory SET section_id=NULL WHERE section_id=?`).run(s.id);
    db.prepare(`UPDATE storage_sections SET is_active=0 WHERE id=?`).run(s.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
  auditLog(req, 'section_delete', 'storage_sections', s.id, { name: s.name, via: 'staff' });
  res.json({ success: true });
});
// Assign an item (by id) to a section (or null to clear) — used by the browse-by-shelf view.
router.post('/sections/assign', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.status(400).json({ error: 'No store for this account.' });
  const item = db.prepare(`SELECT * FROM inventory WHERE id=? AND location_id=? AND is_active=1`).get(req.body.item_id, loc);
  if (!item) return res.status(404).json({ error: 'Item not found at your store.' });
  let sid = null;
  if (req.body.section_id != null && req.body.section_id !== '') {
    const s = db.prepare(`SELECT id FROM storage_sections WHERE id=? AND location_id=? AND is_active=1`).get(parseInt(req.body.section_id, 10) || 0, loc);
    if (!s) return res.status(400).json({ error: 'Unknown shelf / section.' });
    sid = s.id;
  }
  db.prepare(`UPDATE inventory SET section_id=? WHERE id=?`).run(sid, item.id);
  res.json({ success: true });
});

// Resolve a scanned barcode to an item (kept last — single-segment catch).
router.get('/:code', (req, res) => {
  const loc = storeLoc(req); if (!loc) return res.status(400).json({ error: 'No store for this account.' });
  const p = parseScan(req.params.code);
  const code = (p.gtin || p.code || '').toString().trim();
  const item = code ? findItem(loc, code) : null;
  res.json({ found: !!item, code, item: item || null,
    gtin: p.gtin, is_gs1: p.isGs1, weight_lb: p.weightLb, weight_kg: p.weightKg,
    prod_date: p.prodDate, pack_date: p.packDate, expiry: p.expiry, lot: p.lot, serial: p.serial });
});

module.exports = router;
