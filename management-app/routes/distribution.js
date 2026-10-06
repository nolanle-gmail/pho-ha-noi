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
const { parseScan, logScan } = require('../lib/barcode');

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
function ckAvailable(itemName) { return hubAvailable(ckLoc() ? ckLoc().id : null, itemName); }

// ── Distribution hubs (Central Kitchen + Warehouse) ──────────────────────────
// A store can order from, and a hub ships, raw stock. Both the Central Kitchen and
// a Warehouse act as fulfilment hubs. Generalises the CK-only helpers above.
const HUB_TYPES = ['central_kitchen', 'warehouse'];
function hubs() { return db.prepare(`SELECT id, name, type FROM locations WHERE type IN ('central_kitchen','warehouse') AND is_active=1 ORDER BY (type='central_kitchen') DESC, name`).all(); }
function hubById(id) { const h = db.prepare(`SELECT id, name, type FROM locations WHERE id=? AND is_active=1`).get(id); return h && HUB_TYPES.includes(h.type) ? h : null; }
// Is this person allowed to run that hub? (leadership, or a staffer based at the hub.)
function isHubStaff(req, hubId) { return seesAllLocations(req.user.role) || String(req.user.location_id) === String(hubId); }
// On-hand, distributable quantity of an item at a given hub.
function hubAvailable(hubId, itemName) {
  if (!hubId) return 0;
  const row = db.prepare(`SELECT quantity FROM inventory WHERE location_id=? AND item_name=? AND is_active=1 AND distributable=1`).get(hubId, itemName);
  return row ? Math.max(0, row.quantity) : 0;
}
// Resolve the hub a request is for: an explicit source_location_id (validated as a hub), else the
// staffer's own hub if they're based at one, else the Central Kitchen (back-compat default).
function resolveHub(req, fromQuery) {
  const asked = fromQuery ? req.query.source_location_id : (req.body && req.body.source_location_id);
  if (asked) return hubById(parseInt(asked, 10));
  const own = hubById(req.user.location_id);
  if (own) return own;
  return ckLoc();
}
// Open order lines for a store from a specific hub, with how much is still to ship.
function hubOrderLines(hubId, storeId) {
  return db.prepare(`SELECT id, item_id, item_name, unit, requested_qty, ck_qty, shipped_qty, status
    FROM distribution_orders
    WHERE source_location_id=? AND to_location_id=? AND status IN ('requested','approved')
    ORDER BY item_name`).all(hubId, storeId)
    .map(o => ({ ...o, remaining: r3(Math.max(0, o.ck_qty - o.shipped_qty)) }))
    .filter(o => o.remaining > 0.0005 || o.shipped_qty > 0);
}

// Notify the order's requester that it shipped. DISABLED for now (owner will enable later) — the
// hook is here so turning it on is a one-line flag. requested_by holds the sender.
const NOTIFY_SENDER = process.env.DIST_NOTIFY_SENDER === '1';
function notifySender(order, hubName) {
  if (!NOTIFY_SENDER || !order || !order.requested_by) return;
  try {
    const u = db.prepare(`SELECT name, phone FROM users WHERE id=?`).get(order.requested_by);
    if (u && u.phone) require('../lib/sms').sendSms(u.phone, `${hubName} shipped ${r3(order.shipped_qty)} ${order.unit || ''} of ${order.item_name} on your order.`);
  } catch { /* best-effort; never breaks a ship */ }
}

// ── CK raw-stock warehouse (CK staff) ────────────────────────────────────────
// The Central Kitchen's own raw inventory, with how much is already promised to
// open store orders (reserved) so the kitchen can see true free-to-promise stock.
router.get('/ck-stock', requireRole(ROLES.OPS), (req, res) => {
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
router.put('/ck-stock/:id', requireRole(ROLES.OPS), (req, res) => {
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
router.get('/availability', requireRole(ROLES.OPS), (req, res) => {
  const locId = storeScope(req, true);
  if (!locId) return res.json({ items: [] });
  const hub = resolveHub(req, true) || ckLoc();   // availability is relative to the chosen hub
  const rows = db.prepare(`SELECT id, item_name, category, unit, quantity, min_quantity, par_level, unit_cost
    FROM inventory WHERE location_id=? AND is_active=1 AND quantity < min_quantity ORDER BY category, item_name`).all(locId);
  const items = rows.map(r => {
    const buildTo = (r.par_level && r.par_level > r.min_quantity) ? r.par_level : r.min_quantity;
    const need = Math.max(0, Math.ceil(buildTo - r.quantity));
    const ckAvail = hub ? hubAvailable(hub.id, r.item_name) : 0;
    const ckQty = Math.min(need, ckAvail);
    return { ...r, build_to: buildTo, need, ck_available: r3(ckAvail),
      from_ck: r3(ckQty), from_vendor: r3(Math.max(0, need - ckQty)) };
  }).filter(r => r.need > 0);
  res.json({ hub: hub ? { id: hub.id, name: hub.name, type: hub.type } : null, items });
});

// Quick lookup for the store order screen: which raw items a hub can supply right now
// (item_name → available qty). Defaults to the Central Kitchen; pass source_location_id for a
// Warehouse. Any OPS user (store managers included) may read it so the order modal can offer the
// hub as a source when it has stock.
router.get('/ck-catalog', requireRole(ROLES.OPS), (req, res) => {
  const hub = resolveHub(req, true) || ckLoc();
  const items = {};
  if (hub) {
    for (const r of db.prepare(`SELECT item_name, quantity FROM inventory
      WHERE location_id=? AND is_active=1 AND distributable=1 AND quantity > 0`).all(hub.id)) {
      items[r.item_name] = r3(r.quantity);
    }
  }
  res.json({ hub: hub ? { id: hub.id, name: hub.name, type: hub.type } : null, items });
});

// Create one or more distribution orders. Each item is split CK-first: ck_qty from
// the kitchen, the remainder auto-drafted as a vendor PO — unless the manager
// overrides source to 'vendor' (skip CK entirely).
router.post('/order', requireRole(ROLES.OPS), (req, res) => {
  const locId = storeScope(req, false);
  if (!locId) return res.status(400).json({ error: 'A store location is required.' });
  // The fulfilment hub: Central Kitchen (default) or a Warehouse, chosen by the store.
  const hub = resolveHub(req, false) || ckLoc();
  if (!hub) return res.status(404).json({ error: 'No fulfilment hub (Central Kitchen or Warehouse) is configured.' });
  if (String(locId) === String(hub.id)) return res.status(400).json({ error: 'A hub restocks itself from vendors, not from itself.' });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'No items to order.' });
  const vendorOnly = req.body.source === 'vendor';

  const insDist = db.prepare(`INSERT INTO distribution_orders
    (to_location_id, source_location_id, item_id, item_name, unit, requested_qty, ck_qty, vendor_qty, status, vendor_order_id, requested_by, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
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
      const ckQty = vendorOnly ? 0 : r3(Math.min(qty, hubAvailable(hub.id, inv.item_name)));
      const vendorQty = r3(qty - ckQty);
      let vendorOrderId = null;
      if (vendorQty > 0) {
        const vendorId = it.vendor_id ? parseInt(it.vendor_id, 10) : null;
        const vendorName = vendorId ? (db.prepare(`SELECT name FROM vendors WHERE id=?`).get(vendorId) || {}).name : null;
        vendorOrderId = insPO.run(inv.id, inv.item_name, locId, vendorQty, vendorName || null, vendorId,
          ckQty > 0 ? `${hub.name} shortfall (auto)` : 'Ordered from vendor', req.user.id).lastInsertRowid;
      }
      // Nothing for the hub to ship ⇒ the order is settled by the vendor PO alone.
      const status = ckQty > 0 ? 'requested' : 'received';
      insDist.run(locId, hub.id, inv.id, inv.item_name, inv.unit || it.unit || 'units', qty, ckQty, vendorQty,
        status, vendorOrderId, req.user.id, it.notes || null);
      created++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'Could not place the order.' }); }
  if (!created) return res.status(400).json({ error: 'No valid items to order.' });
  auditLog(req, 'distribution_order', 'location', locId, { count: created, hub: hub.name, source: vendorOnly ? 'vendor' : 'hub-first' });
  res.json({ success: true, created, hub: { id: hub.id, name: hub.name, type: hub.type } });
});

// The fulfilment hubs a store can order from (Central Kitchen + any Warehouse).
router.get('/hubs', requireRole(ROLES.OPS), (req, res) => { res.json({ hubs: hubs() }); });

// ── Order lists ──────────────────────────────────────────────────────────────
// scope=ck → the kitchen's incoming queue (all stores); scope=store → my orders.
router.get('/orders', requireRole(ROLES.OPS), (req, res) => {
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
router.put('/orders/:id', requireRole(ROLES.OPS), (req, res) => {
  const ck = ckLoc();
  const d = db.prepare(`SELECT * FROM distribution_orders WHERE id=?`).get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Order not found.' });
  const status = req.body.status;
  const hub = hubById(d.source_location_id) || ck;                 // the hub that fills this order
  const isStoreOwner = String(req.user.location_id) === String(d.to_location_id);
  const isSrcHubStaff = !!hub && isHubStaff(req, hub.id);
  // Shipping and cancelling are the hub's calls; receiving can be done by the hub or the store.
  const canReceive = isSrcHubStaff || isStoreOwner;
  if ((status === 'shipped' || status === 'cancelled') && !isSrcHubStaff) return res.status(403).json({ error: `${hub ? hub.name : 'Hub'} staff only.` });
  if (status === 'received' && !canReceive) return res.status(403).json({ error: 'Not your order.' });

  if (status === 'shipped') {
    if (d.status !== 'requested' && d.status !== 'approved') return res.status(400).json({ error: `Can't ship an order that is ${d.status}.` });
    if (!hub) return res.status(404).json({ error: 'This order has no fulfilment hub.' });
    const outstanding = r3(Math.max(0, d.ck_qty - d.shipped_qty));   // ship only what's left (scans may have shipped some)
    const src = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND item_name=?`).get(hub.id, d.item_name);
    if (!src || src.quantity < outstanding) return res.status(400).json({ error: `${hub.name} is short on ${d.item_name} (needs ${outstanding}, has ${r3(src ? src.quantity : 0)}). Restock or adjust the order.` });
    if (outstanding > 0) {
      db.prepare(`UPDATE inventory SET quantity=quantity-?, last_updated=datetime('now') WHERE id=?`).run(outstanding, src.id);
      consumeFIFO(src.id, outstanding);
      db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, to_location_id, quantity, type, user_id, notes)
        VALUES (?,?,?,?,'transfer_sent',?,?)`).run(src.id, hub.id, d.to_location_id, outstanding, req.user.id, `${hub.name} distribution`);
    }
    db.prepare(`UPDATE distribution_orders SET status='shipped', shipped_qty=ck_qty, approved_by=?, updated_at=datetime('now') WHERE id=?`).run(req.user.id, d.id);
    if (NOTIFY_SENDER) notifySender(db.prepare(`SELECT * FROM distribution_orders WHERE id=?`).get(d.id), hub.name);
    auditLog(req, 'distribution_ship', 'distribution_order', d.id, { item: d.item_name, qty: d.ck_qty, hub: hub.name, to: d.to_location_id });
    return res.json({ success: true });
  }
  if (status === 'received') {
    if (d.status !== 'shipped') return res.status(400).json({ error: `Only a shipped order can be received (this is ${d.status}).` });
    const landQty = r3(d.shipped_qty > 0 ? d.shipped_qty : d.ck_qty);   // actually-shipped (legacy rows fall back to ck_qty)
    const dest = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND item_name=?`).get(d.to_location_id, d.item_name);
    let destId;
    if (dest) { db.prepare(`UPDATE inventory SET quantity=quantity+?, last_updated=datetime('now') WHERE id=?`).run(landQty, dest.id); destId = dest.id; }
    else destId = db.prepare(`INSERT INTO inventory (location_id, item_name, unit, quantity, min_quantity) VALUES (?,?,?,?,0)`)
      .run(d.to_location_id, d.item_name, d.unit || 'units', landQty).lastInsertRowid;
    receiveLot({ item_id: destId, location_id: d.to_location_id, quantity: landQty, unit_cost: dest ? dest.unit_cost || 0 : 0, user_id: req.user.id });
    db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes)
      VALUES (?,?,?,'in',?,?)`).run(destId, d.to_location_id, landQty, req.user.id, `${hub ? hub.name : 'Hub'} distribution received`);
    db.prepare(`UPDATE distribution_orders SET status='received', updated_at=datetime('now') WHERE id=?`).run(d.id);
    auditLog(req, 'distribution_receive', 'distribution_order', d.id, { item: d.item_name, qty: landQty });
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

// ── Shipping from a hub (CK / Warehouse): the scan-to-fulfil order flow ───────
// 1) The queue: stores that have open orders for THIS hub, grouped per store.
router.get('/ship-queue', requireRole(ROLES.OPS), (req, res) => {
  const hub = resolveHub(req, true);
  if (!hub) return res.status(404).json({ error: 'Open the scanner from a Central Kitchen or Warehouse to ship orders.' });
  if (!isHubStaff(req, hub.id)) return res.status(403).json({ error: 'Not your hub.' });
  const rows = db.prepare(`
    SELECT d.to_location_id AS store_id, l.name AS store_name,
           COUNT(*) AS lines, SUM(d.ck_qty - d.shipped_qty) AS remaining, MIN(d.created_at) AS oldest_at,
           SUM(CASE WHEN d.shipped_qty > 0 THEN 1 ELSE 0 END) AS started
    FROM distribution_orders d JOIN locations l ON l.id = d.to_location_id
    WHERE d.source_location_id=? AND d.status IN ('requested','approved') AND (d.ck_qty - d.shipped_qty) > 0.0005
    GROUP BY d.to_location_id ORDER BY oldest_at`).all(hub.id);
  res.json({ hub: { id: hub.id, name: hub.name, type: hub.type }, orders: rows.map(r => ({ ...r, remaining: r3(r.remaining) })) });
});

// 2) One store's open order lines from this hub, with the hub's on-hand + barcode for matching.
router.get('/ship-queue/:storeId', requireRole(ROLES.OPS), (req, res) => {
  const hub = resolveHub(req, true);
  if (!hub) return res.status(404).json({ error: 'No hub selected.' });
  if (!isHubStaff(req, hub.id)) return res.status(403).json({ error: 'Not your hub.' });
  const store = db.prepare(`SELECT id, name FROM locations WHERE id=?`).get(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Store not found.' });
  const lines = hubOrderLines(hub.id, store.id).map(o => {
    const inv = db.prepare(`SELECT quantity, unit, barcode, is_catch_weight FROM inventory WHERE location_id=? AND item_name=? AND is_active=1`).get(hub.id, o.item_name);
    return { ...o, on_hand: inv ? r3(inv.quantity) : 0, barcode: inv ? inv.barcode : null, is_catch_weight: inv ? !!inv.is_catch_weight : false };
  });
  res.json({ hub: { id: hub.id, name: hub.name, type: hub.type }, store, lines });
});

// 3) Scan an item to fulfil a line of this store's order. Decrements the hub (FIFO), advances the
//    line's shipped_qty, and leaves the stock IN TRANSIT (the store receives it). Under-ship keeps
//    the line open; over-ship needs `confirm` and then raises the order's count to what shipped.
router.post('/ship-scan', requireRole(ROLES.OPS), (req, res) => {
  const hub = resolveHub(req, false);
  if (!hub) return res.status(404).json({ error: 'Open the scanner from a Central Kitchen or Warehouse to ship.' });
  if (!isHubStaff(req, hub.id)) return res.status(403).json({ error: 'Not your hub.' });
  const storeId = parseInt(req.body.to_location_id, 10);
  if (!storeId) return res.status(400).json({ error: 'Pick the store whose order you are filling.' });
  const p = parseScan(req.body.code);
  const key = (p.gtin || p.code || '').toString().trim();
  if (!key) return res.status(400).json({ error: 'A barcode is required.' });
  const src = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND barcode=? AND is_active=1`).get(hub.id, key);
  if (!src) return res.status(404).json({ found: false, code: key, error: `That barcode isn't stocked at ${hub.name}, so there's nothing to ship.` });
  // Must be an item on this store's open order from this hub.
  const line = db.prepare(`SELECT * FROM distribution_orders
    WHERE source_location_id=? AND to_location_id=? AND item_name=? AND status IN ('requested','approved')
    ORDER BY id LIMIT 1`).get(hub.id, storeId, src.item_name);
  if (!line) return res.status(200).json({ ok: false, not_on_order: true, item_name: src.item_name, error: `${src.item_name} isn't on this store's order from ${hub.name}.` });

  const catchw = !!src.is_catch_weight;
  const qty = parseFloat(catchw && (req.body.weight != null && req.body.weight !== '') ? req.body.weight
    : (req.body.quantity != null && req.body.quantity !== '') ? req.body.quantity
    : (p.weightLb != null ? p.weightLb : NaN));
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: catchw ? 'Enter the weight to ship.' : 'Enter a quantity to ship.' });
  if (src.quantity < qty - 0.0005) return res.status(400).json({ error: `Only ${r3(src.quantity)} ${src.unit} of ${src.item_name} on hand at ${hub.name}.` });

  const remaining = r3(Math.max(0, line.ck_qty - line.shipped_qty));
  const newShipped = r3(line.shipped_qty + qty);
  const over = newShipped > line.ck_qty + 0.0005;
  // Over-ship (more than the order asked for) needs an explicit confirm; on confirm we raise the
  // order's count to what actually shipped.
  if (over && !req.body.confirm) {
    return res.json({ ok: false, over: true, item_name: src.item_name, unit: src.unit,
      remaining, scanned: r3(qty), new_total: newShipped, ordered: r3(line.ck_qty),
      message: `You scanned ${r3(qty)} ${src.unit} of ${src.item_name}, but only ${remaining} ${src.unit} is left on the order. Accept the extra and update the order to ${newShipped} ${src.unit}?` });
  }

  db.exec('BEGIN');
  try {
    // Decrement the hub (FIFO) — the stock is now in transit to the store.
    db.prepare(`UPDATE inventory SET quantity=quantity-?, last_updated=datetime('now') WHERE id=?`).run(qty, src.id);
    consumeFIFO(src.id, qty);
    db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, to_location_id, quantity, type, user_id, notes)
      VALUES (?,?,?,?,'transfer_sent',?,?)`).run(src.id, hub.id, storeId, qty, req.user.id, `Order ship (scan) · order #${line.id}`);
    // Advance the order line. Over-ship raises ck_qty (and requested_qty by the same delta) to the
    // actually-shipped amount; otherwise just record progress. Fully shipped ⇒ status 'shipped'.
    let ckQty = line.ck_qty, requested = line.requested_qty;
    if (over) { const delta = r3(newShipped - line.ck_qty); ckQty = newShipped; requested = r3(line.requested_qty + delta); }
    const done = newShipped >= ckQty - 0.0005;
    db.prepare(`UPDATE distribution_orders SET shipped_qty=?, ck_qty=?, requested_qty=?, status=?, approved_by=?, updated_at=datetime('now') WHERE id=?`)
      .run(newShipped, ckQty, requested, done ? 'shipped' : line.status, req.user.id, line.id);
    db.exec('COMMIT');
    logScan({ itemId: src.id, locationId: hub.id, action: 'ship', parsed: p, quantity: qty, userId: req.user.id });
    auditLog(req, 'distribution_ship_scan', 'distribution_order', line.id, { item: src.item_name, qty: r3(qty), hub: hub.name, to: storeId, over: !!over });
    const fresh = db.prepare(`SELECT * FROM distribution_orders WHERE id=?`).get(line.id);
    if (done) notifySender(fresh, hub.name);
    const anyLeft = hubOrderLines(hub.id, storeId).length > 0;
    return res.json({ ok: true, success: true, item_name: src.item_name, unit: src.unit, shipped: r3(qty),
      order: { id: line.id, requested_qty: r3(requested), ck_qty: r3(ckQty), shipped_qty: newShipped, remaining: r3(Math.max(0, ckQty - newShipped)), done, raised: !!over },
      store_done: !anyLeft, on_hand: r3(Math.max(0, src.quantity - qty)) });
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } return res.status(500).json({ error: 'Could not ship that item.' }); }
});

module.exports = router;
