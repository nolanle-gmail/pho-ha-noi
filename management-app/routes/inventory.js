const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const { receiveLot, consumeFIFO, consumeFIFOCosted, costHistory, setLotCost } = require('../lib/lots');
const { lookupProduct, rememberProduct } = require('../lib/productLookup');
const { parseScan, logScan, recentDuplicate, dupMessage } = require('../lib/barcode');
const { resolveVendor } = require('../lib/vendors');
const { shipByBarcode, openOrders } = require('../lib/transfer');
const { resolveScan, receiveExisting, createAndReceive } = require('../lib/receive');

const router = express.Router();
// Reduce any scanned barcode (plain UPC/EAN or a GS1-128 case label) to its stable key.
const scanKey = (raw) => { const p = parseScan(raw); return (p.gtin || p.code || '').toString().trim(); };
router.use(verifyToken);

// Resolve the location a request targets: owners may pass one; everyone else is
// pinned to their own.
function scopeLoc(req, fromQuery) {
  if (seesAllLocations(req.user.role)) return (fromQuery ? req.query.location_id : req.body.location_id) || null;
  return req.user.location_id;
}

// ── Central Kitchen master catalog (one-way replication) ───────────────────
// The Central Kitchen is the master: items/vendors added there fan out to every
// restaurant location, and edits there propagate to those copies (matched via
// `source_id`). Store-level adds stay local and never push back up to the CK.
// CK master-catalog replication lives in a shared lib so the kiosk replicates identically.
const { ckLocId, restaurantLocs, isCk, replicateItemFromCk } = require('../lib/ckReplication');

function propagateItemEdit(ckId) {
  const ck = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(ckId); if (!ck) return;
  const rows = db.prepare(`SELECT id FROM inventory WHERE source_id=? AND is_active=1`).all(ckId);
  const upd = db.prepare(`UPDATE inventory SET item_name=@item_name, category=@category, unit=@unit, sku=@sku, description=@description, notes=@notes, min_quantity=@min_quantity, par_level=@par_level, unit_cost=@unit_cost, barcode=@barcode WHERE id=@id`);
  for (const r of rows) { try { upd.run({ id: r.id, item_name: ck.item_name, category: ck.category, unit: ck.unit, sku: ck.sku, description: ck.description, notes: ck.notes, min_quantity: ck.min_quantity, par_level: ck.par_level, unit_cost: ck.unit_cost, barcode: ck.barcode }); } catch { /* name clash at a store — skip */ } }
}
function replicateVendorFromCk(ckVendor) {
  const ins = db.prepare(`INSERT INTO vendors (name, contact_name, phone, email, lead_time_days, notes, location_id, source_id) VALUES (?,?,?,?,?,?,?,?)`);
  const exists = db.prepare(`SELECT id FROM vendors WHERE location_id=? AND name=? AND is_active=1`);
  let n = 0;
  for (const loc of restaurantLocs()) {
    if (exists.get(loc, ckVendor.name)) continue;
    try { ins.run(ckVendor.name, ckVendor.contact_name, ckVendor.phone, ckVendor.email, ckVendor.lead_time_days, ckVendor.notes, loc, ckVendor.id); n++; } catch { /* skip */ }
  }
  return n;
}
function propagateVendorEdit(ckId) {
  const ck = db.prepare(`SELECT * FROM vendors WHERE id=?`).get(ckId); if (!ck) return;
  try { db.prepare(`UPDATE vendors SET name=@name, contact_name=@contact_name, phone=@phone, email=@email, lead_time_days=@lead_time_days, notes=@notes WHERE source_id=@ckId AND is_active=1`)
    .run({ ckId, name: ck.name, contact_name: ck.contact_name, phone: ck.phone, email: ck.email, lead_time_days: ck.lead_time_days, notes: ck.notes }); } catch { /* skip */ }
}

// ── Meta: locations & categories (for pickers) ─────────────────────────────
// Inventory location picker. Default = restaurants (stores). ?type=warehouse lists storage
// warehouses; ?type=all lists both (stores + warehouses). Central Kitchen is handled separately.
router.get('/locations', (req, res) => {
  const t = req.query.type;
  const where = t === 'warehouse' ? "type='warehouse'" : t === 'all' ? "type IN ('restaurant','warehouse')" : "type='restaurant'";
  res.json(db.prepare(`SELECT * FROM locations WHERE is_active=1 AND ${where} ORDER BY name`).all());
});
router.get('/categories', (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT category FROM inventory WHERE category IS NOT NULL ORDER BY category`).all();
  res.json(rows.map(r => r.category));
});

// ── Dashboard summary ──────────────────────────────────────────────────────
router.get('/dashboard', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  const cond = locId ? 'WHERE location_id=?' : '';
  const args = locId ? [locId] : [];
  const active = cond ? cond + ' AND is_active=1' : 'WHERE is_active=1';
  const value = db.prepare(`SELECT ROUND(COALESCE(SUM(quantity*unit_cost),0),2) v FROM inventory ${active}`).get(...args).v;
  const items = db.prepare(`SELECT COUNT(*) c FROM inventory ${active}`).get(...args).c;
  const low = db.prepare(`SELECT COUNT(*) c FROM inventory ${active} AND quantity < min_quantity`).get(...args).c;
  const expArgs = locId ? [locId] : [];
  const expCond = locId ? 'AND location_id=?' : '';
  const expiring = db.prepare(`SELECT COUNT(*) c FROM inventory_lots lo JOIN inventory i ON i.id=lo.item_id WHERE i.is_active=1 AND lo.quantity>0 AND lo.expiry_date IS NOT NULL AND date(lo.expiry_date) <= date('now','+7 days') ${expCond ? 'AND lo.location_id=?' : ''}`).get(...expArgs).c;
  const openOrders = db.prepare(`SELECT COUNT(*) c FROM supply_orders so LEFT JOIN inventory i ON i.id=so.item_id WHERE (so.item_id IS NULL OR i.is_active=1) AND so.status IN ('pending','approved','shipped') ${locId ? 'AND so.location_id=?' : ''}`).get(...args).c;
  res.json({ total_value: value, item_count: items, low_stock: low, expiring_7d: expiring, open_orders: openOrders });
});

// ── Activity / audit log — who did what (orders, transfers, reorders, receives) ─
router.get('/audit', requireRole(ROLES.OPS), (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.created_at, u.name AS user_name, u.role AS user_role
    FROM audit_log a LEFT JOIN users u ON a.user_id=u.id
    ORDER BY a.created_at DESC, a.id DESC LIMIT 200
  `).all();
  res.json(rows.map(r => { let d = null; try { d = r.detail ? JSON.parse(r.detail) : null; } catch { d = null; } return { ...r, detail: d }; }));
});

// ── Inventory levels ───────────────────────────────────────────────────────
// The Stock "Unit cost" is derived from the purchase lots: the TOTAL cost of what's on hand —
// sum(remaining qty × that lot's unit cost) across the item's on-hand lots. All-or-nothing: if any
// on-hand lot has no price yet (unit_cost null/0), show 0 until every lot is priced (so a missing
// price never understates the total). Computed live so it always matches Lots & Expiry.
const LOTS_VALUE = `(CASE
    WHEN EXISTS (SELECT 1 FROM inventory_lots lo WHERE lo.item_id=i.id AND lo.quantity>0 AND (lo.unit_cost IS NULL OR lo.unit_cost<=0)) THEN 0
    ELSE COALESCE((SELECT ROUND(SUM(lo.quantity*lo.unit_cost),2) FROM inventory_lots lo WHERE lo.item_id=i.id AND lo.quantity>0),0)
  END) AS lots_value`;
router.get('/', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  if (!locId) {
    return res.json(db.prepare(`SELECT i.*, ${LOTS_VALUE}, l.name as location_name, v.name AS vendor_name, s.name AS section_name FROM inventory i JOIN locations l ON i.location_id=l.id LEFT JOIN vendors v ON v.id=i.vendor_id LEFT JOIN storage_sections s ON s.id=i.section_id WHERE i.is_active=1 ORDER BY l.name, i.category, i.item_name`).all());
  }
  res.json(db.prepare(`SELECT i.*, ${LOTS_VALUE}, v.name AS vendor_name, s.name AS section_name FROM inventory i LEFT JOIN vendors v ON v.id=i.vendor_id LEFT JOIN storage_sections s ON s.id=i.section_id WHERE i.location_id=? AND i.is_active=1 ORDER BY i.category, i.item_name`).all(locId));
});

// Warehouse view — one row per item, quantities across all locations.
router.get('/warehouse', requireRole(ROLES.OPS), (req, res) => {
  const locations = db.prepare(`SELECT * FROM locations WHERE is_active=1 AND type='restaurant' ORDER BY name`).all();
  const items = db.prepare(`
    SELECT i.item_name, i.category, i.unit,
           GROUP_CONCAT(i.location_id || ':' || i.quantity || ':' || i.min_quantity || ':' || i.id) as loc_data
    FROM inventory i WHERE i.is_active=1 GROUP BY i.item_name, i.category, i.unit ORDER BY i.category, i.item_name
  `).all();
  const rows = items.map(i => {
    const byLoc = {};
    (i.loc_data || '').split(',').forEach(seg => {
      const [lid, qty, min, id] = seg.split(':');
      byLoc[lid] = { qty: parseFloat(qty), min: parseFloat(min), id: parseInt(id) };
    });
    return { item_name: i.item_name, category: i.category, unit: i.unit, by_location: byLoc };
  });
  res.json({ locations, items: rows });
});

// ── Storage sections (shelves) ─────────────────────────────────────────────
// A managed, per-location list of shelves/sections (e.g. "Shelf A — meat"). Items point at one
// via inventory.section_id so staff know where to put away / pick stock. Deleting a section only
// nulls its items' section_id — stock is never touched.
// Section (shelf) resolve/validate live in a shared lib so the scan "add item" form resolves a
// typed shelf the same way (lib/receive.js createAndReceive uses it too).
const { validSection, resolveSection } = require('../lib/sections');
router.get('/sections', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  if (!locId) return res.status(400).json({ error: 'A location is required.' });
  res.json(db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM inventory i WHERE i.section_id=s.id AND i.is_active=1) AS item_count
    FROM storage_sections s WHERE s.location_id=? AND s.is_active=1
    ORDER BY s.sort_order, s.name`).all(locId));
});
// Browse-by-shelf: every section at the location plus the items on it, and an unassigned bucket.
router.get('/sections/map', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  if (!locId) return res.status(400).json({ error: 'A location is required.' });
  const sections = db.prepare(`SELECT * FROM storage_sections WHERE location_id=? AND is_active=1 ORDER BY sort_order, name`).all(locId);
  const itemsFor = (sid) => db.prepare(`SELECT id, item_name, quantity, unit, min_quantity, is_catch_weight FROM inventory
      WHERE location_id=? AND is_active=1 AND ${sid == null ? 'section_id IS NULL' : 'section_id=?'} ORDER BY category, item_name`)
    .all(...(sid == null ? [locId] : [locId, sid]));
  res.json({ sections: sections.map(s => ({ ...s, items: itemsFor(s.id) })), unassigned: itemsFor(null) });
});
router.post('/sections', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, false);
  if (!locId) return res.status(400).json({ error: 'A location is required.' });
  const name = (req.body.name || '').toString().trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'A shelf / section name is required.' });
  const dup = db.prepare(`SELECT id, is_active FROM storage_sections WHERE location_id=? AND name=? COLLATE NOCASE`).get(locId, name);
  if (dup) {
    if (!dup.is_active) { db.prepare(`UPDATE storage_sections SET is_active=1, note=? WHERE id=?`).run((req.body.note || '').toString().slice(0, 200) || null, dup.id); return res.json({ success: true, id: dup.id, reactivated: true }); }
    return res.status(409).json({ error: 'A shelf / section with that name already exists here.' });
  }
  const sort = ((db.prepare(`SELECT MAX(sort_order) m FROM storage_sections WHERE location_id=?`).get(locId) || {}).m || 0) + 1;
  const r = db.prepare(`INSERT INTO storage_sections (location_id, name, note, sort_order) VALUES (?,?,?,?)`)
    .run(locId, name, (req.body.note || '').toString().slice(0, 200) || null, sort);
  auditLog(req, 'section_create', 'storage_sections', r.lastInsertRowid, { name, location_id: Number(locId) });
  res.json({ success: true, id: r.lastInsertRowid });
});
router.put('/sections/:id', requireRole(ROLES.OPS), (req, res) => {
  const s = db.prepare(`SELECT * FROM storage_sections WHERE id=?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Section not found' });
  if (!seesAllLocations(req.user.role) && s.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
  const fields = [], vals = [];
  if (req.body.name !== undefined && String(req.body.name).trim()) {
    const nm = String(req.body.name).trim().slice(0, 60);
    const clash = db.prepare(`SELECT id FROM storage_sections WHERE location_id=? AND name=? COLLATE NOCASE AND id<>?`).get(s.location_id, nm, s.id);
    if (clash) return res.status(409).json({ error: 'Another shelf / section already has that name here.' });
    fields.push('name=?'); vals.push(nm);
  }
  if (req.body.note !== undefined) { fields.push('note=?'); vals.push((req.body.note || '').toString().slice(0, 200) || null); }
  if (req.body.sort_order !== undefined) { fields.push('sort_order=?'); vals.push(parseInt(req.body.sort_order, 10) || 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(s.id);
  db.prepare(`UPDATE storage_sections SET ${fields.join(',')} WHERE id=?`).run(...vals);
  auditLog(req, 'section_update', 'storage_sections', s.id, { changes: req.body });
  res.json({ success: true });
});
router.delete('/sections/:id', requireRole(ROLES.OPS), (req, res) => {
  const s = db.prepare(`SELECT * FROM storage_sections WHERE id=?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Section not found' });
  if (!seesAllLocations(req.user.role) && s.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE inventory SET section_id=NULL WHERE section_id=?`).run(s.id);
    db.prepare(`UPDATE storage_sections SET is_active=0 WHERE id=?`).run(s.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
  auditLog(req, 'section_delete', 'storage_sections', s.id, { name: s.name });
  res.json({ success: true });
});

// ── Create a new item ──────────────────────────────────────────────────────
router.post('/', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, false);
  if (!locId) return res.status(400).json({ error: 'A location is required.' });
  const name = (req.body.item_name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Item name is required.' });
  const dup = db.prepare(`SELECT id FROM inventory WHERE item_name=? AND location_id=?`).get(name, locId);
  if (dup) return res.status(409).json({ error: 'That item already exists at this location.' });
  // A barcode can repeat across locations, but not on two items at the SAME location.
  const bcNew = scanKey(req.body.barcode);
  if (bcNew) { const bcClash = db.prepare(`SELECT item_name FROM inventory WHERE location_id=? AND barcode=? AND is_active=1`).get(locId, bcNew); if (bcClash) return res.status(409).json({ error: `That barcode is already on “${bcClash.item_name}” at this location — scan it to receive that item instead.` }); }
  const qty = Math.max(0, parseFloat(req.body.quantity) || 0);
  const cost = Math.max(0, parseFloat(req.body.unit_cost) || 0);
  const vendorId = resolveVendor(locId, req.body);
  const r = db.prepare(`
    INSERT INTO inventory (location_id, item_name, category, unit, quantity, min_quantity, par_level, unit_cost, sku, description, notes, barcode, vendor_id, vendor_code, section_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(locId, name, req.body.category || 'Other', req.body.unit || 'units', qty,
         Math.max(0, parseFloat(req.body.min_quantity) || 0),
         req.body.par_level == null || req.body.par_level === '' ? null : Math.max(0, parseFloat(req.body.par_level) || 0),
         cost, (req.body.sku || '').toString().trim() || null,
         (req.body.description || '').toString().slice(0, 500) || null,
         (req.body.notes || '').toString().slice(0, 500) || null,
         scanKey(req.body.barcode) || null,
         vendorId, (req.body.vendor_code || '').toString().trim() || null,
         resolveSection(locId, req.body));
  if (qty > 0) {
    const pp = parseScan(req.body.barcode);
    const openExpiry = req.body.expiry_date || pp.expiry || pp.packDate || pp.prodDate || null;
    const openLot = req.body.lot_code || pp.lot || null;
    receiveLot({ item_id: r.lastInsertRowid, location_id: locId, quantity: qty, unit_cost: cost, expiry_date: openExpiry, lot_code: openLot, user_id: req.user.id });
    db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'in',?,?)`)
      .run(r.lastInsertRowid, locId, qty, req.user.id, 'Opening stock');
  }
  const bc = scanKey(req.body.barcode);
  if (bc) { rememberProduct(bc, name, req.user.id); logScan({ itemId: r.lastInsertRowid, locationId: locId, action: 'create', parsed: parseScan(req.body.barcode), quantity: qty, userId: req.user.id }); }
  let replicated = 0;
  if (isCk(locId)) { const ckItem = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(r.lastInsertRowid); replicated = replicateItemFromCk(ckItem); }
  auditLog(req, 'item_create', 'inventory', r.lastInsertRowid, { name, location_id: Number(locId), replicated });
  res.json({ success: true, id: r.lastInsertRowid, replicated });
});

// ── Waste / spoilage ───────────────────────────────────────────────────────
router.post('/waste', requireRole(ROLES.OPS), (req, res) => {
  const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.body.item_id);
  if (!item) return res.status(404).json({ error: 'Inventory item not found' });
  if (!seesAllLocations(req.user.role) && item.location_id !== req.user.location_id) return res.status(403).json({ error: 'You can only log waste for your location.' });
  const qty = Math.max(0, parseFloat(req.body.quantity) || 0);
  if (qty <= 0) return res.status(400).json({ error: 'Quantity must be greater than 0.' });
  if (qty > item.quantity) return res.status(400).json({ error: `Only ${item.quantity} ${item.unit} in stock.` });
  const reason = (req.body.reason || '').toString().slice(0, 200) || null;
  db.prepare(`UPDATE inventory SET quantity=quantity-?, last_updated=datetime('now') WHERE id=?`).run(qty, item.id);
  consumeFIFO(item.id, qty);
  db.prepare(`INSERT INTO waste_log (item_id, location_id, quantity, reason, user_id) VALUES (?,?,?,?,?)`).run(item.id, item.location_id, qty, reason, req.user.id);
  db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'out',?,?)`).run(item.id, item.location_id, qty, req.user.id, `Waste${reason ? ': ' + reason : ''}`);
  auditLog(req, 'waste_logged', 'inventory', item.id, { item: item.item_name, quantity: qty, reason });
  res.json({ success: true });
});

router.get('/waste', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  const cond = locId ? 'WHERE w.location_id=?' : '';
  const args = locId ? [locId] : [];
  res.json(db.prepare(`
    SELECT w.*, i.item_name, i.unit, l.name as location_name, u.name as user_name
    FROM waste_log w JOIN inventory i ON w.item_id=i.id
    LEFT JOIN locations l ON w.location_id=l.id LEFT JOIN users u ON w.user_id=u.id
    ${cond} ORDER BY w.created_at DESC LIMIT 100
  `).all(...args));
});

// ── Cycle counts ───────────────────────────────────────────────────────────
router.post('/count', requireRole(ROLES.OPS), (req, res) => {
  const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.body.item_id);
  if (!item) return res.status(404).json({ error: 'Inventory item not found' });
  if (!seesAllLocations(req.user.role) && item.location_id !== req.user.location_id) return res.status(403).json({ error: 'You can only count items at your location.' });
  const counted = parseFloat(req.body.counted_quantity);
  if (!Number.isFinite(counted) || counted < 0) return res.status(400).json({ error: 'Enter a valid counted quantity (>= 0).' });
  const systemQty = item.quantity;
  const variance = Math.round((counted - systemQty) * 1000) / 1000;
  db.prepare(`UPDATE inventory SET quantity=?, last_updated=datetime('now') WHERE id=?`).run(counted, item.id);
  if (variance < 0) consumeFIFO(item.id, -variance);
  db.prepare(`INSERT INTO cycle_counts (item_id, location_id, system_qty, counted_qty, variance, user_id) VALUES (?,?,?,?,?,?)`).run(item.id, item.location_id, systemQty, counted, variance, req.user.id);
  if (variance !== 0) {
    const type = variance > 0 ? 'in' : 'out';
    const col = variance > 0 ? 'to_location_id' : 'from_location_id';
    db.prepare(`INSERT INTO inventory_transactions (item_id, ${col}, quantity, type, user_id, notes) VALUES (?,?,?,?,?,?)`)
      .run(item.id, item.location_id, Math.abs(variance), type, req.user.id, `Cycle count adjustment (${variance > 0 ? '+' : ''}${variance})`);
  }
  auditLog(req, 'cycle_count', 'inventory', item.id, { item: item.item_name, system: systemQty, counted, variance });
  res.json({ success: true, system_qty: systemQty, counted_qty: counted, variance });
});

router.get('/counts', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  const cond = locId ? 'WHERE cc.location_id=?' : '';
  const args = locId ? [locId] : [];
  res.json(db.prepare(`
    SELECT cc.*, i.item_name, i.unit, u.name as user_name
    FROM cycle_counts cc JOIN inventory i ON cc.item_id=i.id LEFT JOIN users u ON cc.user_id=u.id
    ${cond} ORDER BY cc.created_at DESC LIMIT 100
  `).all(...args));
});

// ── Vendors ────────────────────────────────────────────────────────────────
router.get('/vendors', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);   // per-location vendor list (CK has its own master list)
  if (locId) return res.json(db.prepare(`SELECT * FROM vendors WHERE is_active=1 AND location_id=? ORDER BY name`).all(locId));
  res.json(db.prepare(`SELECT * FROM vendors WHERE is_active=1 ORDER BY name`).all());
});
router.post('/vendors', requireRole(ROLES.MANAGE), (req, res) => {
  const { name, contact_name, phone, email, lead_time_days, notes } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Vendor name required' });
  const locId = scopeLoc(req, false);   // owner passes the location; others pinned to their own
  const r = db.prepare(`INSERT INTO vendors (name, contact_name, phone, email, lead_time_days, notes, location_id) VALUES (?,?,?,?,?,?,?)`)
    .run(String(name).slice(0, 120), contact_name || null, phone || null, email || null, parseInt(lead_time_days) || 0, notes || null, locId || null);
  let replicated = 0;
  if (isCk(locId)) { const ckVendor = db.prepare(`SELECT * FROM vendors WHERE id=?`).get(r.lastInsertRowid); replicated = replicateVendorFromCk(ckVendor); }
  auditLog(req, 'vendor_create', 'vendor', r.lastInsertRowid, { name, location_id: locId ? Number(locId) : null, replicated });
  res.json({ success: true, id: r.lastInsertRowid, replicated });
});
router.put('/vendors/:id', requireRole(ROLES.MANAGE), (req, res) => {
  const v = db.prepare(`SELECT * FROM vendors WHERE id=?`).get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Vendor not found' });
  const fields = [], vals = [];
  ['name', 'contact_name', 'phone', 'email', 'notes'].forEach(k => { if (req.body[k] !== undefined) { fields.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (req.body.lead_time_days !== undefined) { fields.push('lead_time_days=?'); vals.push(parseInt(req.body.lead_time_days) || 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE vendors SET ${fields.join(',')} WHERE id=?`).run(...vals);
  if (isCk(v.location_id)) propagateVendorEdit(v.id);   // CK edit → update the store copies
  auditLog(req, 'vendor_update', 'vendor', v.id, { name: v.name, changes: req.body });
  res.json({ success: true });
});
router.delete('/vendors/:id', requireRole(ROLES.MANAGE), (req, res) => {
  const v = db.prepare(`SELECT * FROM vendors WHERE id=?`).get(req.params.id);
  db.prepare(`UPDATE vendors SET is_active=0 WHERE id=?`).run(req.params.id);
  auditLog(req, 'vendor_delete', 'vendor', Number(req.params.id), { name: v && v.name });
  res.json({ success: true });
});

// ── Supply orders (purchase orders) ────────────────────────────────────────
router.get('/supply-orders', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  // Hide orders whose item has been archived (kept in the DB, just out of view).
  const cond = 'WHERE (so.item_id IS NULL OR i.is_active=1)' + (locId ? ' AND so.location_id=?' : '');
  const args = locId ? [locId] : [];
  res.json(db.prepare(`
    SELECT so.*, COALESCE(so.item_name, i.item_name) as item_name, COALESCE(i.unit,'units') as unit,
           COALESCE(v.name, so.vendor) as vendor_name, l.name as location_name, u.name as ordered_by_name
    FROM supply_orders so
    LEFT JOIN inventory i ON so.item_id=i.id
    LEFT JOIN vendors v ON so.vendor_id=v.id
    JOIN locations l ON so.location_id=l.id JOIN users u ON so.ordered_by=u.id
    ${cond} ORDER BY so.created_at DESC
  `).all(...args));
});

router.post('/order', requireRole(ROLES.OPS), (req, res) => {
  const { item_id, item_name: reqItemName, quantity, vendor, vendor_id, shipping_address, tracking_number, expected_date, notes } = req.body;
  if (!quantity) return res.status(400).json({ error: 'quantity required' });
  if (!item_id && !reqItemName) return res.status(400).json({ error: 'item_id or item_name required' });
  const forLocId = scopeLoc(req, false);
  if (!forLocId) return res.status(400).json({ error: 'location_id required' });
  let itemId = item_id, itemName = reqItemName;
  if (item_id) {
    const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(item_id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    itemName = item.item_name;
  } else {
    let existing = db.prepare(`SELECT id FROM inventory WHERE item_name=? AND location_id=?`).get(reqItemName, forLocId);
    if (!existing) {
      const r = db.prepare(`INSERT INTO inventory (location_id, item_name, category, unit, quantity, min_quantity) VALUES (?,?,?,?,?,?)`).run(forLocId, reqItemName, 'Other', 'units', 0, 0);
      itemId = r.lastInsertRowid;
    } else itemId = existing.id;
  }
  let vendorName = vendor || null;
  if (vendor_id) { const v = db.prepare(`SELECT name FROM vendors WHERE id=?`).get(vendor_id); if (v) vendorName = v.name; }
  db.prepare(`
    INSERT INTO supply_orders (item_id, item_name, location_id, quantity, vendor, vendor_id, shipping_address, tracking_number, expected_date, notes, status, ordered_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)
  `).run(itemId, itemName, forLocId, quantity, vendorName, vendor_id || null, shipping_address || null, tracking_number || null, expected_date || null, notes || null, req.user.id);
  auditLog(req, 'order_create', 'supply_order', itemId, { item: itemName, quantity });
  res.json({ success: true });
});

router.get('/reorder-suggestions', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  if (!locId) return res.json([]);
  const rows = db.prepare(`
    SELECT id, item_name, category, unit, quantity, min_quantity, par_level, unit_cost
    FROM inventory WHERE location_id=? AND is_active=1 AND quantity < min_quantity ORDER BY category, item_name
  `).all(locId);
  res.json(rows.map(r => {
    const buildTo = (r.par_level && r.par_level > r.min_quantity) ? r.par_level : r.min_quantity;
    const suggested = Math.max(0, Math.ceil(buildTo - r.quantity));
    return { ...r, build_to: buildTo, suggested_qty: suggested, est_cost: Math.round(suggested * (r.unit_cost || 0) * 100) / 100 };
  }).filter(r => r.suggested_qty > 0));
});

router.post('/reorder/create', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, false);
  if (!locId) return res.status(400).json({ error: 'A location is required.' });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'No items to order.' });
  const vendorId = req.body.vendor_id || null;
  let vendorName = null;
  if (vendorId) { const v = db.prepare(`SELECT name FROM vendors WHERE id=?`).get(vendorId); if (v) vendorName = v.name; }
  const ins = db.prepare(`INSERT INTO supply_orders (item_id, item_name, location_id, quantity, vendor, vendor_id, notes, status, ordered_by) VALUES (?,?,?,?,?,?,?,'pending',?)`);
  let created = 0;
  items.forEach(it => {
    const qty = Math.max(0, parseFloat(it.quantity) || 0);
    if (qty <= 0) return;
    const inv = db.prepare(`SELECT id, item_name FROM inventory WHERE id=? AND location_id=?`).get(it.item_id, locId);
    if (!inv) return;
    ins.run(inv.id, inv.item_name, locId, qty, vendorName, vendorId, 'Auto-reorder (below par)', req.user.id);
    created++;
  });
  if (!created) return res.status(400).json({ error: 'No valid items to order.' });
  auditLog(req, 'reorder_create', 'supply_order', null, { count: created, vendor: vendorName });
  res.json({ success: true, created });
});

router.put('/order/:id', requireRole(ROLES.MANAGE), (req, res) => {
  const { status, tracking_number, shipping_address } = req.body;
  const valid = ['pending', 'approved', 'shipped', 'received', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const fields = ['status=?'], vals = [status];
  if (tracking_number) { fields.push('tracking_number=?'); vals.push(tracking_number); }
  if (shipping_address) { fields.push('shipping_address=?'); vals.push(shipping_address); }
  vals.push(req.params.id);
  db.prepare(`UPDATE supply_orders SET ${fields.join(',')} WHERE id=?`).run(...vals);
  if (status === 'received') {
    const order = db.prepare(`SELECT * FROM supply_orders WHERE id=?`).get(req.params.id);
    if (order && order.item_id) {
      const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(order.item_id);
      db.prepare(`UPDATE inventory SET quantity=quantity+?, last_updated=datetime('now') WHERE id=?`).run(order.quantity, order.item_id);
      receiveLot({ item_id: order.item_id, location_id: order.location_id, quantity: order.quantity, unit_cost: item ? item.unit_cost : 0, user_id: req.user.id });
      db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'in',?,?)`).run(order.item_id, order.location_id, order.quantity, req.user.id, 'PO received');
    }
  }
  const so = db.prepare(`SELECT item_name, quantity FROM supply_orders WHERE id=?`).get(req.params.id);
  auditLog(req, status === 'received' ? 'order_received' : 'order_status', 'supply_order', Number(req.params.id), { status, item: so && so.item_name, quantity: so && so.quantity });
  res.json({ success: true });
});

// ── Transfers ──────────────────────────────────────────────────────────────
router.get('/transfer-requests', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  const cond = locId ? 'WHERE (tr.from_location_id=? OR tr.to_location_id=?)' : '';
  const args = locId ? [locId, locId] : [];
  res.json(db.prepare(`
    SELECT tr.*, lf.name as from_location_name, lt.name as to_location_name,
           u.name as requested_by_name, ua.name as approved_by_name
    FROM transfer_requests tr
    JOIN locations lf ON tr.from_location_id=lf.id JOIN locations lt ON tr.to_location_id=lt.id
    JOIN users u ON tr.requested_by=u.id LEFT JOIN users ua ON tr.approved_by=ua.id
    ${cond} ORDER BY tr.created_at DESC
  `).all(...args));
});

router.post('/transfer-request', requireRole(ROLES.OPS), (req, res) => {
  const { item_name, quantity, from_location_id, to_location_id, notes } = req.body;
  if (!item_name || !quantity || !from_location_id || !to_location_id) return res.status(400).json({ error: 'item_name, quantity, from_location_id, to_location_id required' });
  if (from_location_id == to_location_id) return res.status(400).json({ error: 'Source and destination must differ' });
  const r = db.prepare(`INSERT INTO transfer_requests (item_name, quantity, from_location_id, to_location_id, requested_by, notes) VALUES (?,?,?,?,?,?)`)
    .run(item_name, quantity, from_location_id, to_location_id, req.user.id, notes || null);
  auditLog(req, 'transfer_request_create', 'transfer_request', Number(r.lastInsertRowid), { item: item_name, quantity, from: Number(from_location_id), to: Number(to_location_id) });
  res.json({ success: true });
});

router.put('/transfer-request/:id', requireRole(ROLES.OPS), (req, res) => {
  const { status, tracking_number, notes } = req.body;
  const valid = ['approved', 'in_transit', 'received', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const tr = db.prepare(`SELECT * FROM transfer_requests WHERE id=?`).get(req.params.id);
  if (!tr) return res.status(404).json({ error: 'Transfer request not found' });
  let fromItem = null;
  if (status === 'received') {
    fromItem = db.prepare(`SELECT * FROM inventory WHERE item_name=? AND location_id=?`).get(tr.item_name, tr.from_location_id);
    if (fromItem && fromItem.quantity < tr.quantity) return res.status(409).json({ error: `Insufficient stock: ${fromItem.quantity} ${fromItem.unit} available, ${tr.quantity} requested` });
  }
  const fields = [`status=?`, `updated_at=datetime('now')`], vals = [status];
  if (tracking_number) { fields.push('tracking_number=?'); vals.push(tracking_number); }
  if (notes) { fields.push('notes=?'); vals.push(notes); }
  if (status === 'approved') { fields.push('approved_by=?'); vals.push(req.user.id); }
  vals.push(req.params.id);
  db.prepare(`UPDATE transfer_requests SET ${fields.join(',')} WHERE id=?`).run(...vals);
  if (status === 'received' && fromItem) {
    db.prepare(`UPDATE inventory SET quantity=quantity-? WHERE id=?`).run(tr.quantity, fromItem.id);
    consumeFIFO(fromItem.id, tr.quantity);
    db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, to_location_id, quantity, type, user_id) VALUES (?,?,?,?,'transfer_sent',?)`).run(fromItem.id, tr.from_location_id, tr.to_location_id, tr.quantity, req.user.id);
    const toItem = db.prepare(`SELECT * FROM inventory WHERE item_name=? AND location_id=?`).get(tr.item_name, tr.to_location_id);
    if (toItem) db.prepare(`UPDATE inventory SET quantity=quantity+? WHERE id=?`).run(tr.quantity, toItem.id);
    else db.prepare(`INSERT INTO inventory (location_id, item_name, category, unit, quantity, min_quantity) SELECT ?,item_name,category,unit,?,min_quantity FROM inventory WHERE id=?`).run(tr.to_location_id, tr.quantity, fromItem.id);
  }
  auditLog(req, status === 'received' ? 'transfer_received' : 'transfer_status', 'transfer_request', Number(req.params.id), { status, item: tr.item_name, quantity: tr.quantity });
  res.json({ success: true });
});

router.post('/transfer', requireRole(ROLES.OPS), (req, res) => {
  const { item_id, from_location_id, to_location_id, quantity } = req.body;
  if (!item_id || !from_location_id || !to_location_id || !quantity) return res.status(400).json({ error: 'All fields required' });
  const src = db.prepare(`SELECT * FROM inventory WHERE id=? AND location_id=?`).get(item_id, from_location_id);
  if (!src) return res.status(404).json({ error: 'Source item not found' });
  if (src.quantity < quantity) return res.status(400).json({ error: 'Insufficient stock' });
  db.prepare(`UPDATE inventory SET quantity=quantity-? WHERE id=? AND location_id=?`).run(quantity, item_id, from_location_id);
  consumeFIFO(item_id, quantity);
  const dest = db.prepare(`SELECT * FROM inventory WHERE item_name=? AND location_id=?`).get(src.item_name, to_location_id);
  if (dest) db.prepare(`UPDATE inventory SET quantity=quantity+? WHERE id=?`).run(quantity, dest.id);
  else db.prepare(`INSERT INTO inventory (location_id, item_name, category, unit, quantity, min_quantity) SELECT ?,item_name,category,unit,?,min_quantity FROM inventory WHERE id=?`).run(to_location_id, quantity, item_id);
  db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, to_location_id, quantity, type, user_id) VALUES (?,?,?,?,'transfer_sent',?)`).run(item_id, from_location_id, to_location_id, quantity, req.user.id);
  auditLog(req, 'transfer', 'inventory', item_id, { quantity, from: from_location_id, to: to_location_id });
  res.json({ success: true });
});

// ── Transaction ledger ─────────────────────────────────────────────────────
router.get('/transactions', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  const cond = locId ? 'WHERE (t.from_location_id=? OR t.to_location_id=?)' : '';
  const args = locId ? [locId, locId] : [];
  res.json(db.prepare(`
    SELECT t.*, i.item_name, i.unit, lf.name as from_location_name, lt.name as to_location_name, u.name as user_name
    FROM inventory_transactions t JOIN inventory i ON t.item_id=i.id
    LEFT JOIN locations lf ON t.from_location_id=lf.id LEFT JOIN locations lt ON t.to_location_id=lt.id LEFT JOIN users u ON t.user_id=u.id
    ${cond} ORDER BY t.created_at DESC LIMIT 100
  `).all(...args));
});

// ── Receiving (SKU / barcode) & item attribute edits ───────────────────────
router.post('/receive', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, false);
  let item;
  if (req.body.item_id) item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.body.item_id);
  else if (req.body.sku) item = db.prepare(`SELECT * FROM inventory WHERE sku=? ${locId ? 'AND location_id=?' : ''}`).get(...(locId ? [String(req.body.sku).trim(), locId] : [String(req.body.sku).trim()]));
  if (!item) return res.status(404).json({ error: 'No item matches that SKU.' });
  if (!seesAllLocations(req.user.role) && item.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
  const qty = Math.max(0, parseFloat(req.body.quantity) || 0);
  if (qty <= 0) return res.status(400).json({ error: 'Quantity must be greater than 0.' });
  const expiry = (req.body.expiry_date || '').toString().trim() || null;
  if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return res.status(400).json({ error: 'Expiry date must be YYYY-MM-DD.' });
  const lotCode = (req.body.lot_code || '').toString().trim().slice(0, 60) || null;
  db.prepare(`UPDATE inventory SET quantity=quantity+?, last_updated=datetime('now') WHERE id=?`).run(qty, item.id);
  receiveLot({ item_id: item.id, location_id: item.location_id, quantity: qty, unit_cost: item.unit_cost || 0, expiry_date: expiry, lot_code: lotCode, user_id: req.user.id });
  db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'in',?,?)`)
    .run(item.id, item.location_id, qty, req.user.id, expiry ? `Received, exp ${expiry}` : 'Received');
  auditLog(req, 'stock_received', 'inventory', item.id, { item: item.item_name, quantity: qty, sku: item.sku, expiry_date: expiry, lot_code: lotCode });
  res.json({ success: true, item_name: item.item_name, new_quantity: Math.round((item.quantity + qty) * 1000) / 1000 });
});

router.put('/:id', requireRole(ROLES.OPS), (req, res) => {
  const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (!seesAllLocations(req.user.role) && item.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
  const fields = [], vals = [];
  if (req.body.item_name !== undefined && String(req.body.item_name).trim()) { fields.push('item_name=?'); vals.push(String(req.body.item_name).trim().slice(0, 120)); }
  if (req.body.sku !== undefined) { fields.push('sku=?'); vals.push(req.body.sku || null); }
  if (req.body.category !== undefined) { fields.push('category=?'); vals.push(req.body.category || null); }
  if (req.body.unit !== undefined) { fields.push('unit=?'); vals.push(req.body.unit || 'units'); }
  if (req.body.description !== undefined) { fields.push('description=?'); vals.push((req.body.description || '').toString().slice(0, 500) || null); }
  if (req.body.notes !== undefined) { fields.push('notes=?'); vals.push((req.body.notes || '').toString().slice(0, 500) || null); }
  if (req.body.min_quantity !== undefined) { fields.push('min_quantity=?'); vals.push(parseFloat(req.body.min_quantity) || 0); }
  if (req.body.unit_cost !== undefined) { fields.push('unit_cost=?'); vals.push(parseFloat(req.body.unit_cost) || 0); }
  if (req.body.par_level !== undefined) { fields.push('par_level=?'); vals.push(req.body.par_level === '' || req.body.par_level == null ? null : Math.max(0, parseFloat(req.body.par_level) || 0)); }
  if (req.body.barcode !== undefined) {
    const nb = scanKey(req.body.barcode) || null;
    if (nb) { const bcClash = db.prepare(`SELECT item_name FROM inventory WHERE location_id=? AND barcode=? AND is_active=1 AND id<>?`).get(item.location_id, nb, item.id); if (bcClash) return res.status(409).json({ error: `That barcode is already on “${bcClash.item_name}” at this location.` }); }
    fields.push('barcode=?'); vals.push(nb);
  }
  if (req.body.vendor_code !== undefined) { fields.push('vendor_code=?'); vals.push((req.body.vendor_code || '').toString().trim() || null); }
  if (req.body.vendor_id !== undefined || req.body.vendor_name !== undefined) { fields.push('vendor_id=?'); vals.push(resolveVendor(item.location_id, req.body)); }
  if (req.body.section_id !== undefined || req.body.section_name !== undefined) { fields.push('section_id=?'); vals.push(resolveSection(item.location_id, req.body)); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(item.id);
  db.prepare(`UPDATE inventory SET ${fields.join(',')} WHERE id=?`).run(...vals);
  if (isCk(item.location_id)) propagateItemEdit(item.id);   // CK edit → update the store copies
  auditLog(req, 'item_update', 'inventory', item.id, { item: item.item_name, changes: req.body });
  res.json({ success: true });
});

// Remove an item (soft-delete to preserve transaction/lot history).
router.delete('/:id', requireRole(ROLES.OPS), (req, res) => {
  const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (!seesAllLocations(req.user.role) && item.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`UPDATE inventory SET is_active=0, last_updated=datetime('now') WHERE id=?`).run(item.id);
  auditLog(req, 'item_delete', 'inventory', item.id, { item: item.item_name });
  res.json({ success: true });
});

// ── Barcode scanning (reuse retail UPC/EAN GTINs) ──────────────────────────
// Resolve a scanned barcode to an item at the acting location.
router.get('/barcode/:code', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  if (!locId) return res.status(400).json({ error: 'A location is required.' });
  const p = parseScan(req.params.code);
  const code = (p.gtin || p.code || '').toString().trim();
  const item = code ? db.prepare(`SELECT * FROM inventory WHERE location_id=? AND barcode=? AND is_active=1`).get(locId, code) : null;
  // Surface anything the label itself carries (GS1 case/meat barcodes): net weight, dates, lot.
  res.json({ found: !!item, code, item: item || null,
    gtin: p.gtin, is_gs1: p.isGs1, weight_lb: p.weightLb, weight_kg: p.weightKg,
    prod_date: p.prodDate, pack_date: p.packDate, expiry: p.expiry, lot: p.lot, serial: p.serial });
});

// Link a barcode to an existing item. Rejects if another item at that location owns it.
router.post('/barcode/link', requireRole(ROLES.OPS), (req, res) => {
  const code = scanKey(req.body.code);
  const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.body.item_id);
  if (!code || !item) return res.status(400).json({ error: 'A barcode and item are required.' });
  if (!seesAllLocations(req.user.role) && item.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
  const clash = db.prepare(`SELECT id FROM inventory WHERE location_id=? AND barcode=? AND is_active=1 AND id<>?`).get(item.location_id, code, item.id);
  if (clash) return res.status(409).json({ error: 'That barcode is already linked to another item here.' });
  db.prepare(`UPDATE inventory SET barcode=? WHERE id=?`).run(code, item.id);
  rememberProduct(code, item.item_name, req.user.id);   // teach the group dictionary this name
  logScan({ itemId: item.id, locationId: item.location_id, action: 'link', parsed: parseScan(req.body.code), userId: req.user.id });
  if (isCk(item.location_id)) propagateItemEdit(item.id);   // CK barcode → propagate to the store copies
  auditLog(req, 'barcode_link', 'inventory', item.id, { code, item: item.item_name });
  res.json({ success: true, item: db.prepare(`SELECT * FROM inventory WHERE id=?`).get(item.id) });
});

// Scan-to-ship: destinations a location can transfer to (everything but itself; stores first).
router.get('/ship/targets', requireRole(ROLES.OPS), (req, res) => {
  const from = seesAllLocations(req.user.role) ? (req.query.from_location_id || req.user.location_id) : req.user.location_id;
  res.json(db.prepare(`SELECT id, name, type FROM locations WHERE is_active=1 AND id<>? ORDER BY (type='restaurant') DESC, name`).all(from || 0));
});

// Open order lines a destination store has waiting (store → Central Kitchen requests).
router.get('/ship/orders', requireRole(ROLES.OPS), (req, res) => {
  res.json(openOrders(req.query.to_location_id));
});

// Scan-to-ship: move the scanned item from here to a destination, and fill a matching open
// order line if the destination has one. Decrements here (FIFO) and adds/creates there.
router.post('/barcode/transfer', requireRole(ROLES.OPS), (req, res) => {
  const from = seesAllLocations(req.user.role) ? (req.body.from_location_id || req.user.location_id) : req.user.location_id;
  const r = shipByBarcode({ fromLoc: from, toLoc: req.body.to_location_id, code: req.body.code, quantity: req.body.quantity, userId: req.user.id, confirm: req.body.confirm });
  if (!r.ok) {
    if (r.duplicate) return res.json({ duplicate: true, message: r.message });
    return res.status(r.status || 400).json({ error: r.error, found: r.found, code: r.code });
  }
  auditLog(req, 'transfer', 'inventory', r.src.id, { quantity: parseFloat(req.body.quantity), from: Number(from), to: r.to, via: 'scan', order_id: r.order ? r.order.id : null });
  res.json({ success: true, item: r.item, to: r.to, order: r.order });
});

// Scan-to-check: how much of a scanned product every location is holding (read-only).
router.get('/barcode/stock/:code', requireRole(ROLES.OPS), (req, res) => {
  const p = parseScan(req.params.code);
  const code = (p.gtin || p.code || '').toString().trim();
  if (!code) return res.json({ found: false, code });
  const seed = db.prepare(`SELECT item_name, unit FROM inventory WHERE barcode=? AND is_active=1 ORDER BY id LIMIT 1`).get(code);
  if (!seed) return res.json({ found: false, code, gtin: p.gtin });
  const rows = db.prepare(`SELECT l.name location, l.type, i.quantity, i.min_quantity, i.unit
    FROM inventory i JOIN locations l ON l.id=i.location_id
    WHERE i.item_name=? AND i.is_active=1 ORDER BY (l.type='central_kitchen') DESC, l.name`).all(seed.item_name);
  const total = rows.reduce((a, r) => a + (r.quantity || 0), 0);
  const last = code ? db.prepare(`SELECT weight_lb, prod_date, pack_date, expiry, lot, serial, created_at FROM scan_events WHERE gtin=? ORDER BY id DESC LIMIT 1`).get(code) : null;
  res.json({ found: true, code, gtin: p.gtin, item_name: seed.item_name, unit: seed.unit,
    total: Math.round(total * 1000) / 1000, last_scan: last || null,
    by_location: rows.map(r => ({ location: r.location, type: r.type, quantity: r.quantity, min_quantity: r.min_quantity, unit: r.unit })) });
});

// A scanned item's full scan history — every GS1 payload kept (weight, dates, lot, serial, all AIs).
router.get('/:id/scan-history', requireRole(ROLES.OPS), (req, res) => {
  const rows = db.prepare(`SELECT s.action, s.gtin, s.quantity, s.weight_lb, s.weight_kg, s.prod_date, s.pack_date, s.expiry, s.lot, s.serial, s.ais, s.raw, s.created_at, u.name AS user_name, l.name AS location
    FROM scan_events s LEFT JOIN users u ON u.id=s.user_id LEFT JOIN locations l ON l.id=s.location_id
    WHERE s.item_id=? ORDER BY s.id DESC LIMIT 100`).all(req.params.id)
    .map(r => { let ais = null; try { ais = r.ais ? JSON.parse(r.ais) : null; } catch { ais = null; } return { ...r, ais }; });
  res.json(rows);
});

// Cost / purchase history for an item — every purchase (lot) is one cost layer with its own
// unit cost, so the true cost of each batch is kept as the market price moves. Returns each lot
// (newest first) with received date/qty, remaining qty, weight and unit cost, plus roll-ups:
// on-hand value (remaining × each layer's cost), total purchased, and the weighted-average cost
// of what's still on hand. FIFO drawdown (lib/lots) consumes the oldest layers first.
router.get('/:id/cost-history', requireRole(ROLES.OPS), (req, res) => {
  const item = db.prepare(`SELECT id, item_name, unit, quantity, unit_cost FROM inventory WHERE id=?`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json(costHistory(item));
});

// Scan-to-adjust: add stock ('in') or set a cycle count on the item matching a barcode.
router.post('/barcode/scan', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, false);
  const p = parseScan(req.body.code);
  const code = (p.gtin || p.code || '').toString().trim();
  if (!locId || !code) return res.status(400).json({ error: 'A location and barcode are required.' });
  const item = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND barcode=? AND is_active=1`).get(locId, code);
  if (!item) return res.status(404).json({ error: 'No item is linked to that barcode here.', found: false, code });
  // Expiry & lot: prefer what the operator entered, else what a GS1 label carried.
  const expiry = req.body.expiry_date || p.expiry || p.packDate || p.prodDate || null;
  const lot = req.body.lot_code || p.lot || null;
  const mode = req.body.mode === 'count' ? 'count' : 'in';
  const qty = parseFloat(req.body.quantity);
  if (mode === 'count') {
    if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: 'Enter a valid counted quantity.' });
    const variance = Math.round((qty - item.quantity) * 1000) / 1000;
    db.prepare(`UPDATE inventory SET quantity=?, last_updated=datetime('now') WHERE id=?`).run(qty, item.id);
    if (variance < 0) consumeFIFO(item.id, -variance);
    db.prepare(`INSERT INTO cycle_counts (item_id, location_id, system_qty, counted_qty, variance, user_id) VALUES (?,?,?,?,?,?)`).run(item.id, locId, item.quantity, qty, variance, req.user.id);
    auditLog(req, 'cycle_count', 'inventory', item.id, { item: item.item_name, counted: qty, variance, via: 'scan' });
    logScan({ itemId: item.id, locationId: locId, action: 'count', parsed: p, quantity: qty, userId: req.user.id });
  } else {
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Enter a quantity to receive.' });
    if (!req.body.confirm) {
      const d = recentDuplicate({ itemId: item.id, gtin: p.gtin, serial: p.serial, actions: ['receive', 'create'], quantity: qty });
      if (d.dup) return res.json({ duplicate: true, kind: d.kind, code, message: dupMessage(d, 'receive', item.item_name, p.serial) });
    }
    const paid = (req.body.unit_cost != null && req.body.unit_cost !== '') ? parseFloat(req.body.unit_cost) : NaN;
    const lotCost = Number.isFinite(paid) && paid >= 0 ? Math.round(paid * 1000) / 1000 : item.unit_cost;
    db.prepare(`UPDATE inventory SET quantity=quantity+?, last_updated=datetime('now') WHERE id=?`).run(qty, item.id);
    if (Number.isFinite(paid) && paid >= 0) db.prepare(`UPDATE inventory SET unit_cost=? WHERE id=?`).run(lotCost, item.id);
    receiveLot({ item_id: item.id, location_id: locId, quantity: qty, unit_cost: lotCost, expiry_date: expiry, lot_code: lot, user_id: req.user.id });
    db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'in',?,?)`).run(item.id, locId, qty, req.user.id, `Scanned in${lot ? ` · lot ${lot}` : ''}${expiry ? ` · exp ${expiry}` : ''} · @ $${lotCost}/${item.unit}`);
    auditLog(req, 'stock_received', 'inventory', item.id, { item: item.item_name, qty, lot, expiry, via: 'scan' });
    logScan({ itemId: item.id, locationId: locId, action: 'receive', parsed: p, quantity: qty, userId: req.user.id });
  }
  res.json({ success: true, item: db.prepare(`SELECT * FROM inventory WHERE id=?`).get(item.id) });
});

// ── Scan-to-use (consume for the kitchen / to serve) at the scanned location ───
// Mirrors the staff /invscan/use, scoped to the location in the request (CK / warehouse / store).
router.post('/barcode/use', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, false);
  const p = parseScan(req.body.code);
  const code = (p.gtin || p.code || '').toString().trim();
  if (!locId || !code) return res.status(400).json({ error: 'A location and barcode are required.' });
  const item = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND barcode=? AND is_active=1`).get(locId, code);
  if (!item) return res.status(404).json({ error: 'No item is linked to that barcode here.', found: false, code });
  const catchw = item.is_catch_weight;
  const qty = parseFloat(catchw ? (req.body.weight != null && req.body.weight !== '' ? req.body.weight : p.weightLb) : req.body.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: catchw ? 'Enter the weight used.' : 'Enter a quantity used.' });
  if (item.quantity < qty) return res.status(400).json({ error: `Only ${item.quantity} ${item.unit} on hand.` });
  const reason = (req.body.reason || 'kitchen use').toString().slice(0, 120);
  db.prepare(`UPDATE inventory SET quantity=MAX(0, quantity-?), last_updated=datetime('now') WHERE id=?`).run(qty, item.id);
  const cogs = consumeFIFOCosted(item.id, qty);
  db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'out',?,?)`).run(item.id, locId, qty, req.user.id, `Used: ${reason} · COGS $${cogs.cost}`);
  logScan({ itemId: item.id, locationId: locId, action: 'use', parsed: p, quantity: qty, userId: req.user.id });
  auditLog(req, 'stock_used', 'inventory', item.id, { item: item.item_name, qty, reason, cogs: cogs.cost, via: 'scan' });
  res.json({ success: true, item: db.prepare(`SELECT * FROM inventory WHERE id=?`).get(item.id), cogs: cogs.cost });
});

// ── Smart scan-to-receive (glossary-aware) ─────────────────────────────────
// One call per scan: what is this, is it in stock here, what does the Glossary/label know.
router.get('/barcode/resolve/:code', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  if (!locId) return res.status(400).json({ error: 'Pick a location first.' });
  res.json(resolveScan({ locId, code: req.params.code }));
});

// Receive a scanned item that is already in stock here. If it's new to stock we return
// { new_item:true } plus the glossary/label so the client shows a pre-filled add form.
router.post('/barcode/receive', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, false);
  if (!locId) return res.status(400).json({ error: 'Pick a location first.' });
  const info = resolveScan({ locId, code: req.body.code });
  if (!info.code) return res.status(400).json({ error: 'A barcode is required.' });
  if (!info.in_stock) return res.status(404).json({ new_item: true, ...info });
  const r = receiveExisting({ locId, item: info.item, body: req.body, user: req.user });
  if (r.duplicate) return res.json({ duplicate: true, kind: r.kind, message: r.message });
  if (r.error) return res.status(400).json({ error: r.error });
  auditLog(req, 'stock_received', 'inventory', info.item.id, { item: info.item.item_name, added: r.added, kind: r.kind, unit_cost: r.unit_cost, via: 'scan' });
  res.json({ success: true, item: r.item, added: r.added, kind: r.kind, lot_id: r.lot_id, unit_cost: r.unit_cost });
});

// Create a new stock item from the scan form, write it into the Glossary, and receive opening stock.
router.post('/barcode/create', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, false);
  if (!locId) return res.status(400).json({ error: 'Pick a location first.' });
  const r = createAndReceive({ locId, body: req.body, user: req.user });
  if (r.error) return res.status(400).json({ error: r.error });
  // A new item scanned at the Central Kitchen seeds a 0-qty stock row at every store (linked by
  // source_id) so stores can order it and CK edits propagate — same as the manual Add-Item form.
  // (The Warehouse doesn't replicate: replicateItemFromCk is CK-only.) The shared Glossary covers
  // all locations regardless.
  let replicated = 0;
  if (isCk(locId)) { const ckItem = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(r.id); try { replicated = replicateItemFromCk(ckItem); } catch { /* best effort */ } }
  auditLog(req, 'item_create', 'inventory', r.id, { name: r.item.item_name, location_id: locId, received: r.received, replicated, via: 'scan' });
  res.json({ success: true, id: r.id, item: r.item, received: r.received, replicated });
});

// Resolve a product from a scanned barcode: the group dictionary first, then Open Food
// Facts + its non-food sister DBs + UPCitemdb (all free). Also flags weighed/produce codes.
router.get('/lookup/:code', requireRole(ROLES.OPS), async (req, res) => {
  const p = await lookupProduct(req.params.code, req.user.id);
  res.json({ found: p.found, name: p.name, brand: p.brand, quantity: p.size, size: p.size, source: p.source, weighed: p.weighed, price: p.price });
});

// ── Lots & expiry ──────────────────────────────────────────────────────────
router.get('/lots', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  const conds = ['lo.quantity > 0', 'i.is_active=1'], args = [];
  if (locId) { conds.push('lo.location_id=?'); args.push(locId); }
  if (req.query.item_id) { conds.push('lo.item_id=?'); args.push(req.query.item_id); }
  res.json(db.prepare(`
    SELECT lo.*, i.item_name, i.unit, l.name AS location_name
    FROM inventory_lots lo JOIN inventory i ON lo.item_id=i.id LEFT JOIN locations l ON lo.location_id=l.id
    WHERE ${conds.join(' AND ')} ORDER BY (lo.expiry_date IS NULL), lo.expiry_date ASC, lo.received_at ASC LIMIT 300
  `).all(...args));
});

router.get('/expiring', requireRole(ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  const days = Math.max(0, parseInt(req.query.days) || 7);
  const conds = ['lo.quantity > 0', 'i.is_active=1', 'lo.expiry_date IS NOT NULL', `date(lo.expiry_date) <= date('now', '+' || ? || ' days')`];
  const args = [days];
  if (locId) { conds.push('lo.location_id=?'); args.push(locId); }
  const rows = db.prepare(`
    SELECT lo.*, i.item_name, i.unit, l.name AS location_name,
           CAST(julianday(lo.expiry_date) - julianday(date('now')) AS INTEGER) AS days_left
    FROM inventory_lots lo JOIN inventory i ON lo.item_id=i.id LEFT JOIN locations l ON lo.location_id=l.id
    WHERE ${conds.join(' AND ')} ORDER BY lo.expiry_date ASC LIMIT 300
  `).all(...args);
  const expired = rows.filter(r => r.days_left < 0).length;
  res.json({ days, expired, soon: rows.length - expired, lots: rows });
});

// Correct the unit cost recorded for one purchase (lot) — e.g. the real invoice price came in
// after the scan, or an operator fixed a typo. Updates that cost layer; if it's the item's most
// recent purchase, inventory.unit_cost (the "current price") is refreshed to match. Audited.
router.patch('/lots/:id/cost', requireRole(ROLES.OPS), (req, res) => {
  const lot = db.prepare(`SELECT * FROM inventory_lots WHERE id=?`).get(req.params.id);
  if (!lot) return res.status(404).json({ error: 'Purchase not found' });
  if (!seesAllLocations(req.user.role) && lot.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
  const cost = parseFloat(req.body.unit_cost);
  if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ error: 'Enter a valid unit cost.' });
  const c = setLotCost(lot, cost);
  const item = db.prepare(`SELECT item_name FROM inventory WHERE id=?`).get(lot.item_id);
  auditLog(req, 'lot_cost_edited', 'inventory', lot.item_id, { lot_id: lot.id, item: item && item.item_name, from: lot.unit_cost, to: c });
  res.json({ success: true, lot_id: lot.id, unit_cost: c });
});

router.post('/lots/:id/discard', requireRole(ROLES.OPS), (req, res) => {
  const lot = db.prepare(`SELECT * FROM inventory_lots WHERE id=?`).get(req.params.id);
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  if (!seesAllLocations(req.user.role) && lot.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
  if (lot.quantity <= 0) return res.status(409).json({ error: 'Lot is already empty.' });
  const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(lot.item_id);
  const qty = lot.quantity;
  const reason = (req.body.reason || 'Expired').toString().slice(0, 200);
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE inventory_lots SET quantity=0, depleted_at=datetime('now') WHERE id=?`).run(lot.id);
    db.prepare(`UPDATE inventory SET quantity=MAX(0, quantity-?), last_updated=datetime('now') WHERE id=?`).run(qty, lot.item_id);
    db.prepare(`INSERT INTO waste_log (item_id, location_id, quantity, reason, user_id) VALUES (?,?,?,?,?)`).run(lot.item_id, lot.location_id, qty, reason, req.user.id);
    db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'out',?,?)`).run(lot.item_id, lot.location_id, qty, req.user.id, `Discard lot${lot.lot_code ? ' ' + lot.lot_code : ''}: ${reason}`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  auditLog(req, 'lot_discarded', 'inventory', lot.item_id, { lot_id: lot.id, item: item && item.item_name, quantity: qty, reason });
  res.json({ success: true });
});

// ── Valuation & COGS ───────────────────────────────────────────────────────
router.get('/valuation', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = scopeLoc(req, true);
  const end = req.query.end || new Date().toISOString().slice(0, 10);
  const start = req.query.start || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const cond = locId ? 'WHERE is_active=1 AND location_id=?' : 'WHERE is_active=1';   // exclude removed items
  const args = locId ? [locId] : [];
  const byCategory = db.prepare(`
    SELECT COALESCE(category,'Other') AS category, ROUND(SUM(quantity * unit_cost), 2) AS value
    FROM inventory ${cond} GROUP BY category ORDER BY value DESC
  `).all(...args);
  const totalValue = Math.round(byCategory.reduce((s, c) => s + (c.value || 0), 0) * 100) / 100;
  const outCond = locId ? 'AND t.from_location_id=?' : '';
  const consumed = db.prepare(`
    SELECT ROUND(COALESCE(SUM(t.quantity * i.unit_cost),0), 2) AS cost
    FROM inventory_transactions t JOIN inventory i ON t.item_id=i.id
    WHERE t.type='out' AND date(t.created_at) >= ? AND date(t.created_at) <= ? ${outCond}
  `).get(...[start, end, ...(locId ? [locId] : [])]);
  res.json({ start, end, total_value: totalValue, by_category: byCategory, consumed_cost: consumed.cost || 0 });
});

module.exports = router;
