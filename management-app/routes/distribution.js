// Central-Kitchen distribution — the CK acts as the raw-food warehouse for every
// store. A store reorders a raw item "from the Central Kitchen first": we fill what
// CK has on hand and auto-route the shortfall to an external vendor PO (split order).
// The CK portion moves through a ship → receive lifecycle that decrements CK stock
// and lands it in the store's inventory. See routes/inventory.js for the vendor and
// transfer flows this reuses.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const { receiveLot, consumeFIFO } = require('../lib/lots');

const router = express.Router();
router.use(verifyToken);

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
function ckLoc() { return db.prepare(`SELECT * FROM locations WHERE type='central_kitchen' LIMIT 1`).get(); }
// CK-side actions are for whoever runs the kitchen: anyone who sees all locations,
// or a person whose home location IS the Central Kitchen.
function isCKStaff(req) {
  if (seesAllLocations(req.user.role)) return true;
  const ck = ckLoc();
  return !!ck && String(req.user.location_id) === String(ck.id);
}
// The store a request targets: owners/admins may name one; everyone else is pinned.
function storeScope(req, fromQuery) {
  if (seesAllLocations(req.user.role)) return (fromQuery ? req.query.location_id : req.body.location_id) || null;
  return req.user.location_id;
}
// How much of an item the CK can currently offer (on-hand, distributable, active).
function ckAvailable(itemName) {
  const ck = ckLoc();
  if (!ck) return 0;
  const row = db.prepare(`SELECT quantity FROM inventory
    WHERE location_id=? AND item_name=? AND is_active=1 AND distributable=1`).get(ck.id, itemName);
  return row ? Math.max(0, row.quantity) : 0;
}

// ── CK raw-stock warehouse (CK staff) ────────────────────────────────────────
// The Central Kitchen's own raw inventory, with how much is already promised to
// open store orders (reserved) so the kitchen can see true free-to-promise stock.
router.get('/ck-stock', requireRole(...ROLES.OPS), (req, res) => {
  const ck = ckLoc();
  if (!ck) return res.status(404).json({ error: 'No Central Kitchen is configured.' });
  if (!isCKStaff(req)) return res.status(403).json({ error: 'Central Kitchen staff only.' });
  const rows = db.prepare(`SELECT id, item_name, category, unit, quantity, min_quantity, par_level, unit_cost, distributable
    FROM inventory WHERE location_id=? AND is_active=1 ORDER BY item_name`).all(ck.id);
  const reservedBy = db.prepare(`SELECT item_name, COALESCE(SUM(ck_qty),0) AS reserved
    FROM distribution_orders WHERE status IN ('requested','approved') GROUP BY item_name`).all();
  const reserved = Object.fromEntries(reservedBy.map(r => [r.item_name, r.reserved]));
  res.json({
    location: { id: ck.id, name: ck.name },
    items: rows.map(r => {
      const rsv = r3(reserved[r.item_name] || 0);
      return { ...r, reserved: rsv, free: r3(Math.max(0, r.quantity - rsv)), low: r.quantity < (r.min_quantity || 0) };
    }),
  });
});

// Curate a CK item: offer/withhold it from stores, or set its reorder thresholds.
router.put('/ck-stock/:id', requireRole(...ROLES.OPS), (req, res) => {
  const ck = ckLoc();
  if (!ck || !isCKStaff(req)) return res.status(403).json({ error: 'Central Kitchen staff only.' });
  const item = db.prepare(`SELECT * FROM inventory WHERE id=? AND location_id=?`).get(req.params.id, ck.id);
  if (!item) return res.status(404).json({ error: 'Item not found at the Central Kitchen.' });
  const sets = [], vals = [];
  if (req.body.distributable !== undefined) { sets.push('distributable=?'); vals.push(req.body.distributable ? 1 : 0); }
  if (req.body.min_quantity !== undefined) { sets.push('min_quantity=?'); vals.push(Math.max(0, parseFloat(req.body.min_quantity) || 0)); }
  if (req.body.par_level !== undefined) { sets.push('par_level=?'); vals.push(req.body.par_level === null || req.body.par_level === '' ? null : Math.max(0, parseFloat(req.body.par_level) || 0)); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  vals.push(item.id);
  db.prepare(`UPDATE inventory SET ${sets.join(',')}, last_updated=datetime('now') WHERE id=?`).run(...vals);
  auditLog(req, 'ck_stock_update', 'inventory', item.id, { item: item.item_name });
  res.json({ success: true });
});

// ── Store side: what can I reorder, and from where? ──────────────────────────
// Every below-par item at the store, annotated with the CK's current availability
// so the reorder screen can show the CK-first / vendor split before ordering.
router.get('/availability', requireRole(...ROLES.OPS), (req, res) => {
  const locId = storeScope(req, true);
  if (!locId) return res.json({ items: [] });
  const rows = db.prepare(`SELECT id, item_name, category, unit, quantity, min_quantity, par_level, unit_cost
    FROM inventory WHERE location_id=? AND is_active=1 AND quantity < min_quantity ORDER BY category, item_name`).all(locId);
  const items = rows.map(r => {
    const buildTo = (r.par_level && r.par_level > r.min_quantity) ? r.par_level : r.min_quantity;
    const need = Math.max(0, Math.ceil(buildTo - r.quantity));
    const ckAvail = ckAvailable(r.item_name);
    const ckQty = Math.min(need, ckAvail);
    return { ...r, build_to: buildTo, need, ck_available: r3(ckAvail),
      from_ck: r3(ckQty), from_vendor: r3(Math.max(0, need - ckQty)) };
  }).filter(r => r.need > 0);
  res.json({ items });
});

// Quick lookup for the store order screen: which raw items the CK can supply right
// now (item_name → available qty). Any OPS user (store managers included) may read it,
// so the order modal can default the source to the Central Kitchen when it has stock.
router.get('/ck-catalog', requireRole(...ROLES.OPS), (req, res) => {
  const ck = ckLoc();
  const items = {};
  if (ck) {
    for (const r of db.prepare(`SELECT item_name, quantity FROM inventory
      WHERE location_id=? AND is_active=1 AND distributable=1 AND quantity > 0`).all(ck.id)) {
      items[r.item_name] = r3(r.quantity);
    }
  }
  res.json({ items });
});

// Create one or more distribution orders. Each item is split CK-first: ck_qty from
// the kitchen, the remainder auto-drafted as a vendor PO — unless the manager
// overrides source to 'vendor' (skip CK entirely).
router.post('/order', requireRole(...ROLES.OPS), (req, res) => {
  const locId = storeScope(req, false);
  if (!locId) return res.status(400).json({ error: 'A store location is required.' });
  const ck = ckLoc();
  if (!ck) return res.status(404).json({ error: 'No Central Kitchen is configured.' });
  if (String(locId) === String(ck.id)) return res.status(400).json({ error: 'The Central Kitchen restocks itself from vendors, not from itself.' });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'No items to order.' });
  const vendorOnly = req.body.source === 'vendor';

  const insDist = db.prepare(`INSERT INTO distribution_orders
    (to_location_id, item_id, item_name, unit, requested_qty, ck_qty, vendor_qty, status, vendor_order_id, requested_by, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insPO = db.prepare(`INSERT INTO supply_orders (item_id, item_name, location_id, quantity, vendor, vendor_id, notes, status, ordered_by)
    VALUES (?,?,?,?,?,?,?,'pending',?)`);

  let created = 0;
  db.exec('BEGIN');
  try {
    for (const it of items) {
      const qty = Math.max(0, parseFloat(it.quantity) || 0);
      if (qty <= 0) continue;
      const inv = db.prepare(`SELECT id, item_name, unit FROM inventory WHERE id=? AND location_id=?`).get(it.item_id, locId);
      if (!inv) continue;
      const ckQty = vendorOnly ? 0 : r3(Math.min(qty, ckAvailable(inv.item_name)));
      const vendorQty = r3(qty - ckQty);
      let vendorOrderId = null;
      if (vendorQty > 0) {
        const vendorId = it.vendor_id ? parseInt(it.vendor_id, 10) : null;
        const vendorName = vendorId ? (db.prepare(`SELECT name FROM vendors WHERE id=?`).get(vendorId) || {}).name : null;
        vendorOrderId = insPO.run(inv.id, inv.item_name, locId, vendorQty, vendorName || null, vendorId,
          ckQty > 0 ? 'Central Kitchen shortfall (auto)' : 'Ordered from vendor', req.user.id).lastInsertRowid;
      }
      // Nothing for the kitchen to ship ⇒ the order is settled by the vendor PO alone.
      const status = ckQty > 0 ? 'requested' : 'received';
      insDist.run(locId, inv.id, inv.item_name, inv.unit || it.unit || 'units', qty, ckQty, vendorQty,
        status, vendorOrderId, req.user.id, it.notes || null);
      created++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'Could not place the order.' }); }
  if (!created) return res.status(400).json({ error: 'No valid items to order.' });
  auditLog(req, 'distribution_order', 'location', locId, { count: created, source: vendorOnly ? 'vendor' : 'ck-first' });
  res.json({ success: true, created });
});

// ── Order lists ──────────────────────────────────────────────────────────────
// scope=ck → the kitchen's incoming queue (all stores); scope=store → my orders.
router.get('/orders', requireRole(...ROLES.OPS), (req, res) => {
  const scope = req.query.scope === 'ck' ? 'ck' : 'store';
  let where, args;
  if (scope === 'ck') {
    if (!isCKStaff(req)) return res.status(403).json({ error: 'Central Kitchen staff only.' });
    where = ''; args = [];
  } else {
    const locId = storeScope(req, true);
    if (!locId) return res.json({ orders: [] });
    where = 'WHERE d.to_location_id=?'; args = [locId];
  }
  const rows = db.prepare(`
    SELECT d.*, l.name AS store_name, u.name AS requested_by_name, so.status AS vendor_status, so.vendor AS vendor_name
    FROM distribution_orders d
    JOIN locations l ON l.id = d.to_location_id
    LEFT JOIN users u ON u.id = d.requested_by
    LEFT JOIN supply_orders so ON so.id = d.vendor_order_id
    ${where} ORDER BY d.created_at DESC LIMIT 200`).all(...args);
  res.json({ orders: rows });
});

// Advance a CK order: requested → shipped (decrement CK stock, in transit) →
// received (land it in the store). Cancel is allowed before shipping.
router.put('/orders/:id', requireRole(...ROLES.OPS), (req, res) => {
  const ck = ckLoc();
  const d = db.prepare(`SELECT * FROM distribution_orders WHERE id=?`).get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Order not found.' });
  const status = req.body.status;
  const isStoreOwner = String(req.user.location_id) === String(d.to_location_id);
  // Shipping and cancelling are the kitchen's calls; receiving can be done by the
  // kitchen or by the store that placed the order.
  const canReceive = isCKStaff(req) || (isStoreOwner);
  if ((status === 'shipped' || status === 'cancelled') && !isCKStaff(req)) return res.status(403).json({ error: 'Central Kitchen staff only.' });
  if (status === 'received' && !canReceive) return res.status(403).json({ error: 'Not your order.' });

  if (status === 'shipped') {
    if (d.status !== 'requested' && d.status !== 'approved') return res.status(400).json({ error: `Can't ship an order that is ${d.status}.` });
    const src = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND item_name=?`).get(ck.id, d.item_name);
    if (!src || src.quantity < d.ck_qty) return res.status(400).json({ error: `Central Kitchen is short on ${d.item_name} (needs ${r3(d.ck_qty)}, has ${r3(src ? src.quantity : 0)}). Restock or adjust the order.` });
    db.prepare(`UPDATE inventory SET quantity=quantity-?, last_updated=datetime('now') WHERE id=?`).run(d.ck_qty, src.id);
    consumeFIFO(src.id, d.ck_qty);
    db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, to_location_id, quantity, type, user_id, notes)
      VALUES (?,?,?,?,'transfer_sent',?,?)`).run(src.id, ck.id, d.to_location_id, d.ck_qty, req.user.id, 'CK distribution');
    db.prepare(`UPDATE distribution_orders SET status='shipped', approved_by=?, updated_at=datetime('now') WHERE id=?`).run(req.user.id, d.id);
    auditLog(req, 'distribution_ship', 'distribution_order', d.id, { item: d.item_name, qty: d.ck_qty, to: d.to_location_id });
    return res.json({ success: true });
  }
  if (status === 'received') {
    if (d.status !== 'shipped') return res.status(400).json({ error: `Only a shipped order can be received (this is ${d.status}).` });
    const dest = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND item_name=?`).get(d.to_location_id, d.item_name);
    let destId;
    if (dest) { db.prepare(`UPDATE inventory SET quantity=quantity+?, last_updated=datetime('now') WHERE id=?`).run(d.ck_qty, dest.id); destId = dest.id; }
    else destId = db.prepare(`INSERT INTO inventory (location_id, item_name, unit, quantity, min_quantity) VALUES (?,?,?,?,0)`)
      .run(d.to_location_id, d.item_name, d.unit || 'units', d.ck_qty).lastInsertRowid;
    receiveLot({ item_id: destId, location_id: d.to_location_id, quantity: d.ck_qty, unit_cost: dest ? dest.unit_cost || 0 : 0, user_id: req.user.id });
    db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes)
      VALUES (?,?,?,'in',?,?)`).run(destId, d.to_location_id, d.ck_qty, req.user.id, 'CK distribution received');
    db.prepare(`UPDATE distribution_orders SET status='received', updated_at=datetime('now') WHERE id=?`).run(d.id);
    auditLog(req, 'distribution_receive', 'distribution_order', d.id, { item: d.item_name, qty: d.ck_qty });
    return res.json({ success: true });
  }
  if (status === 'cancelled') {
    if (d.status === 'received' || d.status === 'shipped') return res.status(400).json({ error: `Can't cancel an order that is ${d.status}.` });
    db.prepare(`UPDATE distribution_orders SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(d.id);
    auditLog(req, 'distribution_cancel', 'distribution_order', d.id, { item: d.item_name });
    return res.json({ success: true });
  }
  return res.status(400).json({ error: 'Unsupported status change.' });
});

module.exports = router;
