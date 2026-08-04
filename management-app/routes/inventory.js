const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const { receiveLot, consumeFIFO } = require('../lib/lots');

const router = express.Router();
router.use(verifyToken);

// Resolve the location a request targets: owners may pass one; everyone else is
// pinned to their own.
function scopeLoc(req, fromQuery) {
  if (req.user.role === 'owner') return (fromQuery ? req.query.location_id : req.body.location_id) || null;
  return req.user.location_id;
}

// ── Meta: locations & categories (for pickers) ─────────────────────────────
router.get('/locations', (req, res) => {
  res.json(db.prepare(`SELECT * FROM locations WHERE is_active=1 AND type='restaurant' ORDER BY name`).all());
});
router.get('/categories', (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT category FROM inventory WHERE category IS NOT NULL ORDER BY category`).all();
  res.json(rows.map(r => r.category));
});

// ── Dashboard summary ──────────────────────────────────────────────────────
router.get('/dashboard', requireRole(...ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  const cond = locId ? 'WHERE location_id=?' : '';
  const args = locId ? [locId] : [];
  const active = cond ? cond + ' AND is_active=1' : 'WHERE is_active=1';
  const value = db.prepare(`SELECT ROUND(COALESCE(SUM(quantity*unit_cost),0),2) v FROM inventory ${active}`).get(...args).v;
  const items = db.prepare(`SELECT COUNT(*) c FROM inventory ${active}`).get(...args).c;
  const low = db.prepare(`SELECT COUNT(*) c FROM inventory ${active} AND quantity < min_quantity`).get(...args).c;
  const expArgs = locId ? [locId] : [];
  const expCond = locId ? 'AND location_id=?' : '';
  const expiring = db.prepare(`SELECT COUNT(*) c FROM inventory_lots WHERE quantity>0 AND expiry_date IS NOT NULL AND date(expiry_date) <= date('now','+7 days') ${expCond}`).get(...expArgs).c;
  const openOrders = db.prepare(`SELECT COUNT(*) c FROM supply_orders ${cond ? cond + ' AND' : 'WHERE'} status IN ('pending','approved','shipped')`).get(...args).c;
  res.json({ total_value: value, item_count: items, low_stock: low, expiring_7d: expiring, open_orders: openOrders });
});

// ── Activity / audit log — who did what (orders, transfers, reorders, receives) ─
router.get('/audit', requireRole(...ROLES.OPS), (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.created_at, u.name AS user_name, u.role AS user_role
    FROM audit_log a LEFT JOIN users u ON a.user_id=u.id
    ORDER BY a.created_at DESC, a.id DESC LIMIT 200
  `).all();
  res.json(rows.map(r => { let d = null; try { d = r.detail ? JSON.parse(r.detail) : null; } catch { d = null; } return { ...r, detail: d }; }));
});

// ── Inventory levels ───────────────────────────────────────────────────────
router.get('/', requireRole(...ROLES.ALL), (req, res) => {
  const locId = scopeLoc(req, true);
  if (!locId) {
    return res.json(db.prepare(`SELECT i.*, l.name as location_name FROM inventory i JOIN locations l ON i.location_id=l.id WHERE i.is_active=1 ORDER BY l.name, i.category, i.item_name`).all());
  }
  res.json(db.prepare(`SELECT * FROM inventory WHERE location_id=? AND is_active=1 ORDER BY category, item_name`).all(locId));
});

// Warehouse view — one row per item, quantities across all locations.
router.get('/warehouse', requireRole(...ROLES.OPS), (req, res) => {
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

// ── Create a new item ──────────────────────────────────────────────────────
router.post('/', requireRole(...ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, false);
  if (!locId) return res.status(400).json({ error: 'A location is required.' });
  const name = (req.body.item_name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Item name is required.' });
  const dup = db.prepare(`SELECT id FROM inventory WHERE item_name=? AND location_id=?`).get(name, locId);
  if (dup) return res.status(409).json({ error: 'That item already exists at this location.' });
  const qty = Math.max(0, parseFloat(req.body.quantity) || 0);
  const cost = Math.max(0, parseFloat(req.body.unit_cost) || 0);
  const r = db.prepare(`
    INSERT INTO inventory (location_id, item_name, category, unit, quantity, min_quantity, par_level, unit_cost, sku, description, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(locId, name, req.body.category || 'Other', req.body.unit || 'units', qty,
         Math.max(0, parseFloat(req.body.min_quantity) || 0),
         req.body.par_level == null || req.body.par_level === '' ? null : Math.max(0, parseFloat(req.body.par_level) || 0),
         cost, (req.body.sku || '').toString().trim() || null,
         (req.body.description || '').toString().slice(0, 500) || null,
         (req.body.notes || '').toString().slice(0, 500) || null);
  if (qty > 0) {
    receiveLot({ item_id: r.lastInsertRowid, location_id: locId, quantity: qty, unit_cost: cost, user_id: req.user.id });
    db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'in',?,?)`)
      .run(r.lastInsertRowid, locId, qty, req.user.id, 'Opening stock');
  }
  auditLog(req, 'item_create', 'inventory', r.lastInsertRowid, { name, location_id: Number(locId) });
  res.json({ success: true, id: r.lastInsertRowid });
});

// ── Waste / spoilage ───────────────────────────────────────────────────────
router.post('/waste', requireRole(...ROLES.OPS), (req, res) => {
  const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.body.item_id);
  if (!item) return res.status(404).json({ error: 'Inventory item not found' });
  if (req.user.role !== 'owner' && item.location_id !== req.user.location_id) return res.status(403).json({ error: 'You can only log waste for your location.' });
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

router.get('/waste', requireRole(...ROLES.OPS), (req, res) => {
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
router.post('/count', requireRole(...ROLES.OPS), (req, res) => {
  const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.body.item_id);
  if (!item) return res.status(404).json({ error: 'Inventory item not found' });
  if (req.user.role !== 'owner' && item.location_id !== req.user.location_id) return res.status(403).json({ error: 'You can only count items at your location.' });
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

router.get('/counts', requireRole(...ROLES.OPS), (req, res) => {
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
router.get('/vendors', requireRole(...ROLES.OPS), (req, res) => {
  res.json(db.prepare(`SELECT * FROM vendors WHERE is_active=1 ORDER BY name`).all());
});
router.post('/vendors', requireRole(...ROLES.MANAGE), (req, res) => {
  const { name, contact_name, phone, email, lead_time_days, notes } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Vendor name required' });
  const r = db.prepare(`INSERT INTO vendors (name, contact_name, phone, email, lead_time_days, notes) VALUES (?,?,?,?,?,?)`)
    .run(String(name).slice(0, 120), contact_name || null, phone || null, email || null, parseInt(lead_time_days) || 0, notes || null);
  auditLog(req, 'vendor_create', 'vendor', r.lastInsertRowid, { name });
  res.json({ success: true, id: r.lastInsertRowid });
});
router.put('/vendors/:id', requireRole(...ROLES.MANAGE), (req, res) => {
  const v = db.prepare(`SELECT * FROM vendors WHERE id=?`).get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Vendor not found' });
  const fields = [], vals = [];
  ['name', 'contact_name', 'phone', 'email', 'notes'].forEach(k => { if (req.body[k] !== undefined) { fields.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (req.body.lead_time_days !== undefined) { fields.push('lead_time_days=?'); vals.push(parseInt(req.body.lead_time_days) || 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE vendors SET ${fields.join(',')} WHERE id=?`).run(...vals);
  res.json({ success: true });
});
router.delete('/vendors/:id', requireRole(...ROLES.MANAGE), (req, res) => {
  db.prepare(`UPDATE vendors SET is_active=0 WHERE id=?`).run(req.params.id);
  res.json({ success: true });
});

// ── Supply orders (purchase orders) ────────────────────────────────────────
router.get('/supply-orders', requireRole(...ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  const cond = locId ? 'WHERE so.location_id=?' : '';
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

router.post('/order', requireRole(...ROLES.ALL), (req, res) => {
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

router.get('/reorder-suggestions', requireRole(...ROLES.OPS), (req, res) => {
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

router.post('/reorder/create', requireRole(...ROLES.OPS), (req, res) => {
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

router.put('/order/:id', requireRole(...ROLES.MANAGE), (req, res) => {
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
router.get('/transfer-requests', requireRole(...ROLES.OPS), (req, res) => {
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

router.post('/transfer-request', requireRole(...ROLES.ALL), (req, res) => {
  const { item_name, quantity, from_location_id, to_location_id, notes } = req.body;
  if (!item_name || !quantity || !from_location_id || !to_location_id) return res.status(400).json({ error: 'item_name, quantity, from_location_id, to_location_id required' });
  if (from_location_id == to_location_id) return res.status(400).json({ error: 'Source and destination must differ' });
  db.prepare(`INSERT INTO transfer_requests (item_name, quantity, from_location_id, to_location_id, requested_by, notes) VALUES (?,?,?,?,?,?)`)
    .run(item_name, quantity, from_location_id, to_location_id, req.user.id, notes || null);
  res.json({ success: true });
});

router.put('/transfer-request/:id', requireRole(...ROLES.OPS), (req, res) => {
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

router.post('/transfer', requireRole(...ROLES.OPS), (req, res) => {
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
router.get('/transactions', requireRole(...ROLES.OPS), (req, res) => {
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
router.post('/receive', requireRole(...ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, false);
  let item;
  if (req.body.item_id) item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.body.item_id);
  else if (req.body.sku) item = db.prepare(`SELECT * FROM inventory WHERE sku=? ${locId ? 'AND location_id=?' : ''}`).get(...(locId ? [String(req.body.sku).trim(), locId] : [String(req.body.sku).trim()]));
  if (!item) return res.status(404).json({ error: 'No item matches that SKU.' });
  if (req.user.role !== 'owner' && item.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
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

router.put('/:id', requireRole(...ROLES.OPS), (req, res) => {
  const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (req.user.role !== 'owner' && item.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
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
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(item.id);
  db.prepare(`UPDATE inventory SET ${fields.join(',')} WHERE id=?`).run(...vals);
  auditLog(req, 'item_update', 'inventory', item.id, { item: item.item_name, changes: req.body });
  res.json({ success: true });
});

// Remove an item (soft-delete to preserve transaction/lot history).
router.delete('/:id', requireRole(...ROLES.OPS), (req, res) => {
  const item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (req.user.role !== 'owner' && item.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`UPDATE inventory SET is_active=0, last_updated=datetime('now') WHERE id=?`).run(item.id);
  auditLog(req, 'item_delete', 'inventory', item.id, { item: item.item_name });
  res.json({ success: true });
});

// ── Lots & expiry ──────────────────────────────────────────────────────────
router.get('/lots', requireRole(...ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  const conds = ['lo.quantity > 0'], args = [];
  if (locId) { conds.push('lo.location_id=?'); args.push(locId); }
  if (req.query.item_id) { conds.push('lo.item_id=?'); args.push(req.query.item_id); }
  res.json(db.prepare(`
    SELECT lo.*, i.item_name, i.unit, l.name AS location_name
    FROM inventory_lots lo JOIN inventory i ON lo.item_id=i.id LEFT JOIN locations l ON lo.location_id=l.id
    WHERE ${conds.join(' AND ')} ORDER BY (lo.expiry_date IS NULL), lo.expiry_date ASC, lo.received_at ASC LIMIT 300
  `).all(...args));
});

router.get('/expiring', requireRole(...ROLES.OPS), (req, res) => {
  const locId = scopeLoc(req, true);
  const days = Math.max(0, parseInt(req.query.days) || 7);
  const conds = ['lo.quantity > 0', 'lo.expiry_date IS NOT NULL', `date(lo.expiry_date) <= date('now', '+' || ? || ' days')`];
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

router.post('/lots/:id/discard', requireRole(...ROLES.OPS), (req, res) => {
  const lot = db.prepare(`SELECT * FROM inventory_lots WHERE id=?`).get(req.params.id);
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  if (req.user.role !== 'owner' && lot.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
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
router.get('/valuation', requireRole(...ROLES.MANAGE), (req, res) => {
  const locId = scopeLoc(req, true);
  const end = req.query.end || new Date().toISOString().slice(0, 10);
  const start = req.query.start || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const cond = locId ? 'WHERE location_id=?' : '';
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
