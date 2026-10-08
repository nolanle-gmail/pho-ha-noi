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
const { notify } = require('./messages');

const router = express.Router();
router.use(verifyToken);

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const PRIORITIES = ['urgent', 'high', 'standard', 'low'];

// A short, unique code per location for order numbers (San Jose → SJ, Milpitas → MIL, Milbrae → MILB
// when MIL is taken). Computed across all locations so no two collide.
function locCodes() {
  const locs = db.prepare(`SELECT id, name FROM locations ORDER BY id`).all();
  const used = new Set(), map = {};
  for (const l of locs) {
    const clean = String(l.name).replace(/ph[oở] h[aà] n[oộ]i/i, '').replace(/[—–-]/g, ' ').replace(/[^a-z0-9 ]/gi, '').trim();
    const words = clean.split(/\s+/).filter(Boolean);
    const letters = clean.replace(/[^a-z0-9]/gi, '').toUpperCase();
    let base = words.length > 1 ? words.map(w => w[0]).join('').toUpperCase() : letters.slice(0, 3);
    if (!base) base = 'LOC';
    let code = base, i = base.length, n = 2;
    while (used.has(code)) { code = letters.slice(0, ++i).toUpperCase() || (base + n++); if (i > 10) { code = base + n++; } }
    used.add(code); map[l.id] = code;
  }
  return map;
}
// Next order number for a store today: <CODE>-<YYMMDD>-<NN> (NN = daily sequence, per store).
function nextOrderNo(locId) {
  const code = locCodes()[locId] || 'LOC';
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: '2-digit', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '');
  const prefix = `${code}-${ymd}-`;
  const n = db.prepare(`SELECT COUNT(DISTINCT order_no) c FROM distribution_orders WHERE to_location_id=? AND order_no LIKE ?`).get(locId, prefix + '%').c;
  return prefix + String(n + 1).padStart(2, '0');
}
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
// A store can order from, and a hub ships, raw stock. Both the Central Kitchen and a Warehouse act
// as fulfilment hubs. The scan-to-fulfil core is shared with the kiosk in lib/shipOrder.js.
const { hubById, hubAvailable, hubOrderLines, hubQueue, storeLines, shipScanOrder, notifySender } = require('../lib/shipOrder');
function hubs() { return db.prepare(`SELECT id, name, type FROM locations WHERE type IN ('central_kitchen','warehouse') AND is_active=1 ORDER BY (type='central_kitchen') DESC, name`).all(); }
// Is this person allowed to run that hub? (leadership, or a staffer based at the hub.)
function isHubStaff(req, hubId) { return seesAllLocations(req.user.role) || String(req.user.location_id) === String(hubId); }
// Resolve the hub a request is for: an explicit source_location_id (validated as a hub), else the
// staffer's own hub if they're based at one, else the Central Kitchen (back-compat default).
function resolveHub(req, fromQuery) {
  const asked = fromQuery ? req.query.source_location_id : (req.body && req.body.source_location_id);
  if (asked) return hubById(parseInt(asked, 10));
  const own = hubById(req.user.location_id);
  if (own) return own;
  return ckLoc();
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
  const priority = PRIORITIES.includes((req.body.priority || '').toLowerCase()) ? req.body.priority.toLowerCase() : 'standard';
  // One order number for the whole (multi-item) order; its lines are grouped by it for tracking.
  const orderNo = nextOrderNo(locId);
  const store = db.prepare(`SELECT name FROM locations WHERE id=?`).get(locId);

  const insDist = db.prepare(`INSERT INTO distribution_orders
    (to_location_id, source_location_id, item_id, item_name, unit, requested_qty, ck_qty, vendor_qty, status, vendor_order_id, requested_by, notes, order_no, priority)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insPO = db.prepare(`INSERT INTO supply_orders (item_id, item_name, location_id, quantity, vendor, vendor_id, notes, status, ordered_by)
    VALUES (?,?,?,?,?,?,?,'pending',?)`);

  let created = 0, hubLines = 0; const summary = [];
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
        status, vendorOrderId, req.user.id, it.notes || null, orderNo, priority);
      if (ckQty > 0) hubLines++;
      summary.push(`• ${inv.item_name} — ${r3(qty)} ${inv.unit || ''}`.trim());
      created++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'Could not place the order.' }); }
  if (!created) return res.status(400).json({ error: 'No valid items to order.' });
  auditLog(req, 'distribution_order', 'location', locId, { order_no: orderNo, count: created, hub: hub.name, priority, source: vendorOnly ? 'vendor' : 'hub-first' });
  // Notify the fulfilment team that a new order came in (hub-fulfilled orders only). Recipient is
  // Nha Le for now (owner will change later). Best-effort — never blocks the order.
  if (hubLines > 0 && !vendorOnly) {
    try {
      const nha = db.prepare(`SELECT id FROM users WHERE is_active=1 AND name LIKE 'Nha Le%' ORDER BY id LIMIT 1`).get();
      if (nha) {
        const pri = priority !== 'standard' ? ` · priority: ${priority.toUpperCase()}` : '';
        notify(req.user.id, nha.id, `New ${hub.name} order ${orderNo}${pri}`,
          `${(store && store.name) || 'A store'} placed order ${orderNo} to ${hub.name} — ${created} item${created === 1 ? '' : 's'}${pri}.\n${summary.join('\n')}`);
      }
    } catch { /* notify is best-effort */ }
  }
  res.json({ success: true, created, order_no: orderNo, priority, hub: { id: hub.id, name: hub.name, type: hub.type } });
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
    notifySender(db.prepare(`SELECT * FROM distribution_orders WHERE id=?`).get(d.id), hub.name);   // self-gated (disabled by default)
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
  res.json({ hub: { id: hub.id, name: hub.name, type: hub.type }, orders: hubQueue(hub.id) });
});

// 2) One store's open order lines from this hub, with the hub's on-hand + barcode for matching.
router.get('/ship-queue/:storeId', requireRole(ROLES.OPS), (req, res) => {
  const hub = resolveHub(req, true);
  if (!hub) return res.status(404).json({ error: 'No hub selected.' });
  if (!isHubStaff(req, hub.id)) return res.status(403).json({ error: 'Not your hub.' });
  const store = db.prepare(`SELECT id, name FROM locations WHERE id=?`).get(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Store not found.' });
  res.json({ hub: { id: hub.id, name: hub.name, type: hub.type }, store, lines: storeLines(hub.id, store.id) });
});

// 3) Scan an item to fulfil a line of this store's order. Decrements the hub (FIFO), advances the
//    line's shipped_qty, and leaves the stock IN TRANSIT (the store receives it). Under-ship keeps
//    the line open; over-ship needs `confirm` and then raises the order's count to what shipped.
router.post('/ship-scan', requireRole(ROLES.OPS), (req, res) => {
  const hub = resolveHub(req, false);
  if (!hub) return res.status(404).json({ error: 'Open the scanner from a Central Kitchen or Warehouse to ship.' });
  if (!isHubStaff(req, hub.id)) return res.status(403).json({ error: 'Not your hub.' });
  const r = shipScanOrder({ hubId: hub.id, storeId: req.body.to_location_id, code: req.body.code, quantity: req.body.quantity, weight: req.body.weight, confirm: req.body.confirm, userId: req.user.id });
  if (r.not_on_order) return res.json({ ok: false, not_on_order: true, item_name: r.item_name, error: r.error });
  if (r.over) return res.json({ ok: false, ...r });
  if (r.error) return res.status(r.status || 400).json({ error: r.error, found: r.found, code: r.code });
  auditLog(req, 'distribution_ship_scan', 'distribution_order', r.line_id, { item: r.item_name, qty: r.shipped, hub: hub.name, to: parseInt(req.body.to_location_id, 10), over: r.over });
  res.json(r);
});

module.exports = router;
