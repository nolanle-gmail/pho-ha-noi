// Central-Kitchen distribution — the CK acts as the raw-food warehouse for every
// store. A store reorders a raw item "from the Central Kitchen first": we fill what
// CK has on hand and auto-route the shortfall to an external vendor PO (split order).
// The CK portion moves through a ship → receive lifecycle that decrements CK stock
// and lands it in the store's inventory. See routes/inventory.js for the vendor and
// transfer flows this reuses.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations, roleHasCap } = require('../lib/auth');
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
const { hubById, hubAvailable, hubOrderLines, hubQueue, storeLines, shipScanOrder, notifySender, recomputeOrderStage } = require('../lib/shipOrder');
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
// A hub MANAGER (or org leadership) — the people who may review/approve orders.
function isHubManager(req, hubId) {
  if (seesAllLocations(req.user.role)) return true;
  return String(req.user.location_id) === String(hubId) && roleHasCap(req.user.role, 'manage');
}

// ── Order headers & the fulfilment stage machine ─────────────────────────────
// A multi-item order has one header (keyed by order_no) carrying its STAGE; the per-item review
// decision (approved/held/rejected) lives on the lines. The board shows one row per order.
const PRIORITY_RANK = { urgent: 0, high: 1, standard: 2, low: 3 };
function headerOf(orderNo) { return orderNo ? db.prepare(`SELECT * FROM distribution_order_headers WHERE order_no=?`).get(orderNo) : null; }
// The display label for an order: maps (stage + per-item approvals + receipt) onto the board labels.
// The item's TRUE lifecycle label: Ready to ship → Loaded (scanned onto the truck at the hub) →
// Shipped (dispatched / in transit) → Received. Rejected / cancelled lines read as themselves.
function lineStageLabel(l) {
  if (l.approval === 'rejected') return 'Rejected';
  if (l.status === 'cancelled') return 'Cancelled';
  if (l.status === 'received') return 'Received';
  if (l.status === 'shipped') return l.dispatched ? 'Shipped' : 'Loaded';
  return 'Ready to ship';
}
// The ORDER's board label — an aggregate of its item states, so a multi-item order that is part-way
// reads "Partially Loaded / Shipped / Received" while each item still shows its own true status.
function orderStatusLabel(h, lines) {
  if (!h) return 'Unknown';
  if (h.stage === 'cancelled') return 'Cancelled';
  if (h.stage === 'rejected') return 'Rejected';
  const live = lines.filter(l => l.ck_qty > 0.0005 && l.approval === 'approved' && l.status !== 'cancelled');
  const n = live.length;
  if (!n) return 'Ready to ship';
  const received = live.filter(l => l.status === 'received').length;
  const dispatched = live.filter(l => l.status === 'shipped' && l.dispatched).length;
  const loaded = live.filter(l => l.status === 'shipped' && !l.dispatched).length;
  if (received === n) return h.partial_receipt ? 'Partially Received' : 'Received';
  if (received > 0) return 'Partially Received';
  if (dispatched === n) return 'In Transit';
  if (dispatched > 0) return 'Partially Shipped';
  if (loaded === n) return 'Loaded';
  if (loaded > 0) return 'Partially Loaded';
  return 'Ready to ship';
}
// Once every hub line of an order is cancelled, mark its header cancelled (called after cancels).
function syncCancelled(orderNo) {
  if (!orderNo) return;
  const hub = db.prepare(`SELECT status FROM distribution_orders WHERE order_no=? AND ck_qty > 0.0005`).all(orderNo);
  if (hub.length && hub.every(l => l.status === 'cancelled')) db.prepare(`UPDATE distribution_order_headers SET stage='cancelled', updated_at=datetime('now') WHERE order_no=?`).run(orderNo);
}
// After a line-level receive, flag the header's partial_receipt when a shipped line was received short,
// then recompute the header stage from the lines (→ delivered once every shipped line is received).
function syncDelivered(orderNo) {
  if (!orderNo) return;
  const shipped = db.prepare(`SELECT status, shipped_qty, received_qty FROM distribution_orders WHERE order_no=? AND ck_qty > 0.0005 AND approval='approved' AND shipped_qty > 0.0005`).all(orderNo);
  const short = shipped.some(l => l.status === 'received' && l.received_qty > 0.0005 && l.received_qty < l.shipped_qty - 0.005) ? 1 : 0;
  if (short) db.prepare(`UPDATE distribution_order_headers SET partial_receipt=1, updated_at=datetime('now') WHERE order_no=?`).run(orderNo);
  recomputeOrderStage(orderNo);
}

// ── CK raw-stock warehouse (CK staff) ────────────────────────────────────────
// The Central Kitchen's own raw inventory, with how much is already promised to
// open store orders (reserved) so the kitchen can see true free-to-promise stock.
router.get('/ck-stock', requireRole(ROLES.OPS), (req, res) => {
  const hub = resolveHub(req, true);
  if (!hub) return res.status(404).json({ error: 'No fulfilment hub is configured.' });
  if (!isHubStaff(req, hub.id)) return res.status(403).json({ error: `${hub.name} staff only.` });
  const rows = db.prepare(`SELECT id, item_name, category, unit, quantity, min_quantity, par_level, unit_cost, distributable
    FROM inventory WHERE location_id=? AND is_active=1 ORDER BY item_name`).all(hub.id);
  const reservedBy = db.prepare(`SELECT item_name, COALESCE(SUM(ck_qty),0) AS reserved
    FROM distribution_orders WHERE source_location_id=? AND status IN ('requested','approved') GROUP BY item_name`).all(hub.id);
  const reserved = Object.fromEntries(reservedBy.map(r => [r.item_name, r.reserved]));
  res.json({
    location: { id: hub.id, name: hub.name },
    items: rows.map(r => {
      const rsv = r3(reserved[r.item_name] || 0);
      return { ...r, reserved: rsv, free: r3(Math.max(0, r.quantity - rsv)), low: r.quantity < (r.min_quantity || 0) };
    }),
  });
});

// Curate a hub item: offer/withhold it from stores, or set its reorder thresholds.
router.put('/ck-stock/:id', requireRole(ROLES.OPS), (req, res) => {
  const item0 = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(req.params.id);
  const hub = item0 ? hubById(item0.location_id) : null;
  if (!hub || !isHubStaff(req, hub.id)) return res.status(403).json({ error: 'Not your hub.' });
  const item = db.prepare(`SELECT * FROM inventory WHERE id=? AND location_id=?`).get(req.params.id, hub.id);
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
    (to_location_id, source_location_id, item_id, item_name, unit, requested_qty, ck_qty, vendor_qty, status, approval, vendor_order_id, requested_by, notes, order_no, priority)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
      // No review step: every hub-fulfilled line is immediately ready to ship (approval='approved').
      // A vendor-only line (nothing for the hub) is settled by the vendor PO alone.
      const status = ckQty > 0 ? 'requested' : 'received';
      const approval = 'approved';
      insDist.run(locId, hub.id, inv.id, inv.item_name, inv.unit || it.unit || 'units', qty, ckQty, vendorQty,
        status, approval, vendorOrderId, req.user.id, it.notes || null, orderNo, priority);
      if (ckQty > 0) hubLines++;
      summary.push(`• ${inv.item_name} — ${r3(qty)} ${inv.unit || ''}`.trim());
      created++;
    }
    // The order header carries the fulfilment STAGE. Hub-fulfilled orders start at 'approved'
    // (= Ready to ship — no review gate); a vendor-only order has nothing for the hub to do.
    if (created) db.prepare(`INSERT INTO distribution_order_headers (order_no, to_location_id, source_location_id, priority, requested_by, stage)
      VALUES (?,?,?,?,?,?)`).run(orderNo, locId, hub.id, priority, req.user.id, hubLines > 0 ? 'approved' : 'delivered');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'Could not place the order.' }); }
  if (!created) return res.status(400).json({ error: 'No valid items to order.' });
  auditLog(req, 'distribution_order', 'location', locId, { order_no: orderNo, count: created, hub: hub.name, priority, source: vendorOnly ? 'vendor' : 'hub-first' });
  // Notify the fulfilment team that a new order came in (hub-fulfilled orders only). Recipient is
  // Nha Le for now (owner will change later). Best-effort — never blocks the order.
  if (hubLines > 0 && !vendorOnly) {
    try {
      // TESTING: route to Nolan Le; falls back to the fulfilment team when he isn't set up.
      const recipient = testNotifyUser() || fulfillmentContact();
      if (recipient) {
        const pri = priority !== 'standard' ? ` · priority: ${priority.toUpperCase()}` : '';
        notify(req.user.id, recipient.id, `New ${hub.name} order ${orderNo}${pri}`,
          `${(store && store.name) || 'A store'} placed order ${orderNo} to ${hub.name} — ${created} item${created === 1 ? '' : 's'}${pri}.\n${summary.join('\n')}`);
      }
    } catch { /* notify is best-effort */ }
  }
  res.json({ success: true, created, order_no: orderNo, priority, hub: { id: hub.id, name: hub.name, type: hub.type } });
});

// The fulfilment hubs a store can order from (Central Kitchen + any Warehouse).
router.get('/hubs', requireRole(ROLES.ALL), (req, res) => { res.json({ hubs: hubs() }); });

// ── Order lists ──────────────────────────────────────────────────────────────
// scope=ck|hub → a hub's incoming queue (orders it fills, all stores); scope=store → my orders.
router.get('/orders', requireRole(ROLES.OPS), (req, res) => {
  const scope = (req.query.scope === 'ck' || req.query.scope === 'hub') ? 'hub' : 'store';
  let where, args;
  if (scope === 'hub') {
    const hub = resolveHub(req, true);
    if (!hub) return res.status(404).json({ error: 'No fulfilment hub selected.' });
    if (!isHubStaff(req, hub.id)) return res.status(403).json({ error: `${hub.name} staff only.` });
    where = 'WHERE d.source_location_id=?'; args = [hub.id];
  } else {
    const locId = storeScope(req, true);
    if (!locId) return res.json({ orders: [] });
    where = 'WHERE d.to_location_id=?'; args = [locId];
  }
  const rows = db.prepare(`
    SELECT d.*, l.name AS store_name, u.name AS requested_by_name, so.status AS vendor_status, so.vendor AS vendor_name,
      h.stage AS order_stage, h.reviewed_at AS order_reviewed_at, ru.name AS order_reviewed_by_name,
      h.partial_load AS order_partial_load, h.partial_receipt AS order_partial_receipt
    FROM distribution_orders d
    JOIN locations l ON l.id = d.to_location_id
    LEFT JOIN users u ON u.id = d.requested_by
    LEFT JOIN supply_orders so ON so.id = d.vendor_order_id
    LEFT JOIN distribution_order_headers h ON h.order_no = d.order_no
    LEFT JOIN users ru ON ru.id = h.reviewed_by
    ${where} ORDER BY d.created_at DESC LIMIT 200`).all(...args);
  // Attach each order's overall status label (the same one the hub board shows) to its lines, so the
  // store sees New Order / Approved / In Transit / Received rather than just the raw line status.
  const byOrder = {};
  rows.forEach(r => { if (r.order_no) (byOrder[r.order_no] = byOrder[r.order_no] || []).push(r); });
  for (const r of rows) {
    r.order_status = r.order_no && r.order_stage
      ? orderStatusLabel({ stage: r.order_stage, reviewed_at: r.order_reviewed_at, partial_load: r.order_partial_load, partial_receipt: r.order_partial_receipt }, byOrder[r.order_no]) : null;
    r.stage_label = lineStageLabel(r);   // the item's own true status (Ready to ship / Loaded / Shipped / Received)
  }
  res.json({ orders: rows });
});

// The fulfilment contact notified about new orders and cancellation requests (Nha Le for now;
// the owner will reconfigure later). Best-effort — callers wrap notify() in try/catch.
function fulfillmentContact() { return db.prepare(`SELECT id FROM users WHERE is_active=1 AND name LIKE 'Nha Le%' ORDER BY id LIMIT 1`).get(); }
// TESTING (2026-10-10): while the order → review → reject workflow is being validated, route its
// notifications (new order to the hub; review outcome to the requester) to Nolan Le so he can
// confirm they fire. Resolved by his email, then by name. When testing is done, remove this and the
// two `testNotifyUser() || …` fallbacks revert to the real recipients.
function testNotifyUser() {
  return db.prepare(`SELECT id FROM users WHERE is_active=1 AND lower(email)='nolanle@gmail.com' ORDER BY id LIMIT 1`).get()
    || db.prepare(`SELECT id FROM users WHERE is_active=1 AND lower(name) LIKE 'nolan%' ORDER BY id LIMIT 1`).get();
}

// Cancel one order line: mark it cancelled and cancel any linked vendor PO (the store no longer
// wants the shortfall). Caller must have already checked permission + that it's still cancellable.
function cancelDistLine(d) {
  db.prepare(`UPDATE distribution_orders SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(d.id);
  if (d.vendor_order_id) db.prepare(`UPDATE supply_orders SET status='cancelled' WHERE id=? AND status NOT IN ('received','cancelled')`).run(d.vendor_order_id);
}

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
  // Shipping is the hub's call; receiving and CANCELLING can be done by the hub or the store that
  // placed the order (the requester may change their mind or no longer want it, before it ships).
  const canReceive = isSrcHubStaff || isStoreOwner;
  const canCancel = isSrcHubStaff || isStoreOwner;
  if (status === 'shipped' && !isSrcHubStaff) return res.status(403).json({ error: `${hub ? hub.name : 'Hub'} staff only.` });
  if (status === 'cancelled' && !canCancel) return res.status(403).json({ error: 'Not your order.' });
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
    const shippedQty = r3(d.shipped_qty > 0 ? d.shipped_qty : d.ck_qty);   // actually-shipped (legacy rows fall back to ck_qty)
    // A full "Mark received" confirms the whole shipment; "Partially received" passes the actual amount
    // the store got (never more than shipped). Scans may already have landed some (received_qty), so we
    // land only the not-yet-landed difference and close the line at `got`. Any shortfall is dropped.
    const hasQty = req.body.received_qty !== undefined && req.body.received_qty !== null && req.body.received_qty !== '';
    let got = hasQty ? r3(Math.max(0, parseFloat(req.body.received_qty) || 0)) : shippedQty;
    if (got > shippedQty) got = shippedQty;
    const already = r3(Math.max(0, d.received_qty || 0));
    const landQty = r3(Math.max(0, got - already));
    if (landQty > 0) {
      const dest = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND item_name=?`).get(d.to_location_id, d.item_name);
      let destId;
      if (dest) { db.prepare(`UPDATE inventory SET quantity=quantity+?, last_updated=datetime('now') WHERE id=?`).run(landQty, dest.id); destId = dest.id; }
      else destId = db.prepare(`INSERT INTO inventory (location_id, item_name, unit, quantity, min_quantity) VALUES (?,?,?,?,0)`)
        .run(d.to_location_id, d.item_name, d.unit || 'units', landQty).lastInsertRowid;
      receiveLot({ item_id: destId, location_id: d.to_location_id, quantity: landQty, unit_cost: dest ? dest.unit_cost || 0 : 0, user_id: req.user.id });
      db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes)
        VALUES (?,?,?,'in',?,?)`).run(destId, d.to_location_id, landQty, req.user.id, `${hub ? hub.name : 'Hub'} distribution received`);
    }
    const short = got < shippedQty - 0.005;
    db.prepare(`UPDATE distribution_orders SET status='received', received_qty=?, received_by=?, cancel_requested=0, updated_at=datetime('now') WHERE id=?`).run(got, req.user.id, d.id);
    syncDelivered(d.order_no);
    auditLog(req, 'distribution_receive', 'distribution_order', d.id, { item: d.item_name, qty: got, short });
    return res.json({ success: true, received: got, short });
  }
  if (status === 'cancelled') {
    if (d.status === 'received' || d.status === 'shipped') return res.status(400).json({ error: `Can't cancel an order that is ${d.status}.` });
    if (d.shipped_qty > 0) return res.status(400).json({ error: `Part of this item has already shipped — receive it, or ask ${hub ? hub.name : 'the hub'} before cancelling.` });
    cancelDistLine(d);
    syncCancelled(d.order_no);
    auditLog(req, 'distribution_cancel', 'distribution_order', d.id, { item: d.item_name, by: isStoreOwner && !isSrcHubStaff ? 'requester' : 'hub' });
    return res.json({ success: true });
  }
  return res.status(400).json({ error: 'Unsupported status change.' });
});

// Cancel a whole (multi-item) order by its order number — the requester changed their mind or no
// longer wants it. Cancels every line not yet shipped (and each line's linked vendor PO); lines
// already shipped/received are left untouched. Scoped to the caller's store unless they see all.
router.post('/cancel-order', requireRole(ROLES.OPS), (req, res) => {
  const orderNo = String((req.body && req.body.order_no) || '').trim();
  if (!orderNo) return res.status(400).json({ error: 'Order number required.' });
  const seesAll = seesAllLocations(req.user.role);
  const where = seesAll ? 'order_no=?' : 'order_no=? AND to_location_id=?';
  const args = seesAll ? [orderNo] : [orderNo, req.user.location_id];
  const lines = db.prepare(`SELECT * FROM distribution_orders WHERE ${where}`).all(...args);
  if (!lines.length) return res.status(404).json({ error: 'Order not found.' });
  let cancelled = 0, blocked = 0;
  db.exec('BEGIN');
  try {
    for (const d of lines) {
      if (d.status === 'cancelled') continue;
      const canStore = seesAll || String(req.user.location_id) === String(d.to_location_id);
      const hub = hubById(d.source_location_id);
      const canHub = !!hub && isHubStaff(req, hub.id);
      if (!canStore && !canHub) { blocked++; continue; }
      if (d.status === 'received' || d.status === 'shipped' || d.shipped_qty > 0) { blocked++; continue; }
      cancelDistLine(d);
      cancelled++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'Could not cancel the order.' }); }
  if (!cancelled) return res.status(400).json({ error: blocked ? 'Nothing to cancel — those items have already shipped or been received.' : 'Nothing to cancel.' });
  syncCancelled(orderNo);
  auditLog(req, 'distribution_cancel_order', 'location', lines[0].to_location_id, { order_no: orderNo, cancelled, blocked });
  res.json({ success: true, cancelled, blocked });
});

// ── Cancellation requests for SHIPPED orders ─────────────────────────────────
// Once an order ships, the stock is in transit, so the store can't cancel it outright — it asks the
// hub, which either recalls the stock (cancelling the line) or declines (the store receives it).
function notifyCancelRequest(req, d, hub) {
  try {
    const nha = fulfillmentContact();
    const store = db.prepare(`SELECT name FROM locations WHERE id=?`).get(d.to_location_id);
    const tag = d.order_no || ('order ' + d.id);
    if (nha) notify(req.user.id, nha.id, `Cancellation requested · ${tag}`,
      `${(store && store.name) || 'A store'} is asking to cancel a SHIPPED item: ${d.item_name} (${r3(d.shipped_qty || d.ck_qty)} ${d.unit || ''}) on ${tag}, from ${hub ? hub.name : 'the hub'}.${d.cancel_reason ? '\nReason: ' + d.cancel_reason : ''}\nReview it on the hub's Distribution board — Recall & cancel, or Decline.`);
  } catch { /* best-effort */ }
}
// The store asks the hub to cancel one shipped line.
router.post('/orders/:id/request-cancel', requireRole(ROLES.OPS), (req, res) => {
  const d = db.prepare(`SELECT * FROM distribution_orders WHERE id=?`).get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Order not found.' });
  const hub = hubById(d.source_location_id);
  const canReq = String(req.user.location_id) === String(d.to_location_id) || seesAllLocations(req.user.role) || (!!hub && isHubStaff(req, hub.id));
  if (!canReq) return res.status(403).json({ error: 'Not your order.' });
  if (d.status !== 'shipped') return res.status(400).json({ error: d.status === 'requested' || d.status === 'approved' ? 'This hasn’t shipped yet — cancel it directly instead.' : `Can't request cancellation of an order that is ${d.status}.` });
  if (d.cancel_requested) return res.status(400).json({ error: 'A cancellation is already requested for this item.' });
  const reason = ((req.body && req.body.reason) || '').toString().trim().slice(0, 500) || null;
  db.prepare(`UPDATE distribution_orders SET cancel_requested=1, cancel_reason=?, cancel_requested_by=?, updated_at=datetime('now') WHERE id=?`).run(reason, req.user.id, d.id);
  auditLog(req, 'distribution_cancel_request', 'distribution_order', d.id, { item: d.item_name, order_no: d.order_no, reason });
  notifyCancelRequest(req, Object.assign({}, d, { cancel_reason: reason }), hub);
  res.json({ success: true });
});
// The store asks the hub to cancel every shipped line of a whole order.
router.post('/request-cancel-order', requireRole(ROLES.OPS), (req, res) => {
  const orderNo = String((req.body && req.body.order_no) || '').trim();
  if (!orderNo) return res.status(400).json({ error: 'Order number required.' });
  const reason = ((req.body && req.body.reason) || '').toString().trim().slice(0, 500) || null;
  const seesAll = seesAllLocations(req.user.role);
  const where = seesAll ? 'order_no=?' : 'order_no=? AND to_location_id=?';
  const args = seesAll ? [orderNo] : [orderNo, req.user.location_id];
  const lines = db.prepare(`SELECT * FROM distribution_orders WHERE ${where}`).all(...args);
  if (!lines.length) return res.status(404).json({ error: 'Order not found.' });
  let requested = 0;
  for (const d of lines) {
    const canStore = seesAll || String(req.user.location_id) === String(d.to_location_id);
    const hub = hubById(d.source_location_id);
    if (!canStore && !(hub && isHubStaff(req, hub.id))) continue;
    if (d.status !== 'shipped' || d.cancel_requested) continue;
    db.prepare(`UPDATE distribution_orders SET cancel_requested=1, cancel_reason=?, cancel_requested_by=?, updated_at=datetime('now') WHERE id=?`).run(reason, req.user.id, d.id);
    notifyCancelRequest(req, Object.assign({}, d, { cancel_reason: reason }), hub);
    requested++;
  }
  if (!requested) return res.status(400).json({ error: 'Nothing to request — the order hasn’t shipped, or a request is already pending.' });
  auditLog(req, 'distribution_cancel_request_order', 'location', lines[0].to_location_id, { order_no: orderNo, requested });
  res.json({ success: true, requested });
});
// The store withdraws its own pending cancellation request (changed their mind again).
router.post('/orders/:id/withdraw-cancel', requireRole(ROLES.OPS), (req, res) => {
  const d = db.prepare(`SELECT * FROM distribution_orders WHERE id=?`).get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Order not found.' });
  const canReq = String(req.user.location_id) === String(d.to_location_id) || seesAllLocations(req.user.role);
  if (!canReq) return res.status(403).json({ error: 'Not your order.' });
  if (!d.cancel_requested) return res.status(400).json({ error: 'No cancellation request to withdraw.' });
  db.prepare(`UPDATE distribution_orders SET cancel_requested=0, cancel_reason=NULL, updated_at=datetime('now') WHERE id=?`).run(d.id);
  auditLog(req, 'distribution_cancel_withdraw', 'distribution_order', d.id, { item: d.item_name, order_no: d.order_no });
  res.json({ success: true });
});
// The hub resolves a cancellation request: recall the in-transit stock (and cancel the line), or
// decline (the store should receive it after all).
router.post('/orders/:id/resolve-cancel', requireRole(ROLES.OPS), (req, res) => {
  const d = db.prepare(`SELECT * FROM distribution_orders WHERE id=?`).get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Order not found.' });
  const hub = hubById(d.source_location_id);
  if (!hub || !isHubStaff(req, hub.id)) return res.status(403).json({ error: `${hub ? hub.name : 'Hub'} staff only.` });
  if (!d.cancel_requested) return res.status(400).json({ error: 'No cancellation was requested for this item.' });
  const action = (req.body && req.body.action) === 'recall' ? 'recall' : (req.body && req.body.action) === 'decline' ? 'decline' : null;
  if (!action) return res.status(400).json({ error: 'Choose to recall or decline.' });
  const store = db.prepare(`SELECT name FROM locations WHERE id=?`).get(d.to_location_id);
  const tag = d.order_no || ('order ' + d.id);
  if (action === 'decline') {
    db.prepare(`UPDATE distribution_orders SET cancel_requested=0, updated_at=datetime('now') WHERE id=?`).run(d.id);
    auditLog(req, 'distribution_cancel_declined', 'distribution_order', d.id, { item: d.item_name, order_no: d.order_no });
    try { if (d.cancel_requested_by) notify(req.user.id, d.cancel_requested_by, `Cancellation declined · ${tag}`, `${hub.name} declined to cancel ${d.item_name} on ${tag} — it’s on its way, please receive it.`); } catch { /* best-effort */ }
    return res.json({ success: true, action: 'declined' });
  }
  if (d.status !== 'shipped') return res.status(400).json({ error: `Can only recall a shipped order (this is ${d.status}).` });
  const back = r3(d.shipped_qty > 0 ? d.shipped_qty : d.ck_qty);
  db.exec('BEGIN');
  try {
    const hubItem = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND item_name=?`).get(hub.id, d.item_name);
    let hubItemId;
    if (hubItem) { db.prepare(`UPDATE inventory SET quantity=quantity+?, last_updated=datetime('now') WHERE id=?`).run(back, hubItem.id); hubItemId = hubItem.id; }
    else hubItemId = db.prepare(`INSERT INTO inventory (location_id, item_name, unit, quantity, min_quantity) VALUES (?,?,?,?,0)`).run(hub.id, d.item_name, d.unit || 'units', back).lastInsertRowid;
    receiveLot({ item_id: hubItemId, location_id: hub.id, quantity: back, unit_cost: hubItem ? hubItem.unit_cost || 0 : 0, user_id: req.user.id });
    db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'in',?,?)`).run(hubItemId, hub.id, back, req.user.id, `Recalled from ${(store && store.name) || 'store'} (cancellation)`);
    db.prepare(`UPDATE distribution_orders SET status='cancelled', cancel_requested=0, updated_at=datetime('now') WHERE id=?`).run(d.id);
    if (d.vendor_order_id) db.prepare(`UPDATE supply_orders SET status='cancelled' WHERE id=? AND status NOT IN ('received','cancelled')`).run(d.vendor_order_id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'Could not recall the order.' }); }
  syncCancelled(d.order_no);
  auditLog(req, 'distribution_cancel_recalled', 'distribution_order', d.id, { item: d.item_name, order_no: d.order_no, qty: back });
  try { if (d.cancel_requested_by) notify(req.user.id, d.cancel_requested_by, `Cancellation approved · ${tag}`, `${hub.name} recalled ${d.item_name} (${back} ${d.unit || ''}) on ${tag} — the order is cancelled. Please don’t receive it; the stock returns to ${hub.name}.`); } catch { /* best-effort */ }
  res.json({ success: true, action: 'recalled', returned: back });
});

// ── The hub's order board: one row per order + the fulfilment stage machine ──
// Incoming orders for a hub, ONE per order, ranked active-first then highest-priority then oldest.
router.get('/hub-orders', requireRole(ROLES.ALL), (req, res) => {
  const hub = resolveHub(req, true);
  if (!hub) return res.status(404).json({ error: 'No fulfilment hub selected.' });
  if (!isHubStaff(req, hub.id)) return res.status(403).json({ error: `${hub.name} staff only.` });
  const heads = db.prepare(`SELECT h.*, l.name AS store_name, u.name AS requested_by_name
    FROM distribution_order_headers h JOIN locations l ON l.id=h.to_location_id
    LEFT JOIN users u ON u.id=h.requested_by
    WHERE h.source_location_id=? ORDER BY h.created_at DESC LIMIT 400`).all(hub.id);
  const out = heads.map(h => {
    const lines = db.prepare(`SELECT ck_qty, status, approval, received_qty, cancel_requested FROM distribution_orders WHERE order_no=?`).all(h.order_no);
    const hubLines = lines.filter(l => l.ck_qty > 0.0005);
    return {
      order_no: h.order_no, store_id: h.to_location_id, store_name: h.store_name, priority: h.priority, created_at: h.created_at,
      stage: h.stage, requested_by_name: h.requested_by_name, status_label: orderStatusLabel(h, lines),
      items: hubLines.length,
      approved: hubLines.filter(l => l.approval === 'approved').length,
      held: hubLines.filter(l => l.approval === 'held').length,
      rejected: lines.filter(l => l.approval === 'rejected').length,
      cancel_requested: lines.some(l => l.cancel_requested),
    };
  });
  // An order is "done" only when it's in a terminal stage AND has no unresolved held items — a held
  // item keeps the order active so it's never orphaned after a partial delivery.
  const done = (o) => (['delivered', 'cancelled', 'rejected'].includes(o.stage) && !o.held) ? 1 : 0;
  out.sort((a, b) => (done(a) - done(b))
    || ((PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2))
    || String(a.created_at).localeCompare(String(b.created_at)));
  res.json({ hub: { id: hub.id, name: hub.name, type: hub.type }, orders: out });
});

// One order's header + all its lines (the drill-in detail page).
router.get('/hub-orders/:orderNo', requireRole(ROLES.ALL), (req, res) => {
  const h = headerOf(req.params.orderNo);
  if (!h) return res.status(404).json({ error: 'Order not found.' });
  const hub = hubById(h.source_location_id);
  if (!hub || !isHubStaff(req, hub.id)) return res.status(403).json({ error: 'Not your hub.' });
  const lines = db.prepare(`SELECT d.*, so.status AS vendor_status, so.vendor AS vendor_name
    FROM distribution_orders d LEFT JOIN supply_orders so ON so.id=d.vendor_order_id
    WHERE d.order_no=? ORDER BY d.id`).all(h.order_no).map(l => ({ ...l, stage_label: lineStageLabel(l) }));
  const store = db.prepare(`SELECT id, name FROM locations WHERE id=?`).get(h.to_location_id);
  const reviewer = h.reviewed_by ? db.prepare(`SELECT name FROM users WHERE id=?`).get(h.reviewed_by) : null;
  const driver = h.driver_id ? db.prepare(`SELECT name FROM users WHERE id=?`).get(h.driver_id) : null;
  res.json({
    hub: { id: hub.id, name: hub.name, type: hub.type }, store, header: h,
    status_label: orderStatusLabel(h, lines),
    can_review: isHubManager(req, hub.id),
    reviewer: reviewer && reviewer.name, driver: driver && driver.name, lines,
  });
});

// (Review / hold / reject removed — orders are Ready to ship on arrival, so there is no review gate
// and no held-item resolution. A hub that can't fully fill a line just ships what it has, or the
// requester cancels it.)

// Load the ready-to-ship items onto the truck — deducts the hub's on-hand (stock leaves the shelf) and
// marks each loaded line 'shipped' (Loaded). Loads every item the hub has enough of right now and
// SKIPS the ones it's short on (they stay "Ready to ship" for a later load — an order can ship in
// several trips). The barcode scan path (ship-scan) is the item-by-item equivalent.
router.post('/hub-orders/:orderNo/load', requireRole(ROLES.ALL), (req, res) => {
  const h = headerOf(req.params.orderNo);
  if (!h) return res.status(404).json({ error: 'Order not found.' });
  const hub = hubById(h.source_location_id);
  if (!hub || !isHubStaff(req, hub.id)) return res.status(403).json({ error: `${hub ? hub.name : 'Hub'} staff only.` });
  if (!['approved', 'loaded', 'in_transit'].includes(h.stage)) return res.status(400).json({ error: `This order is ${h.stage} — nothing to load.` });
  const lines = db.prepare(`SELECT * FROM distribution_orders WHERE order_no=? AND approval='approved' AND status='requested' AND ck_qty > 0.0005`).all(h.order_no);
  if (!lines.length) return res.status(400).json({ error: 'No items left to load.' });
  let loaded = 0, short = 0;
  db.exec('BEGIN');
  try {
    for (const d of lines) {
      const outstanding = r3(Math.max(0, d.ck_qty - d.shipped_qty));
      const src = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND item_name=?`).get(hub.id, d.item_name);
      if (!src || src.quantity < outstanding - 0.0005) { short++; continue; }   // not enough on hand — leave it Ready to ship
      if (outstanding > 0) {
        db.prepare(`UPDATE inventory SET quantity=quantity-?, last_updated=datetime('now') WHERE id=?`).run(outstanding, src.id);
        consumeFIFO(src.id, outstanding);
        db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, to_location_id, quantity, type, user_id, notes)
          VALUES (?,?,?,?,'transfer_sent',?,?)`).run(src.id, hub.id, d.to_location_id, outstanding, req.user.id, `${hub.name} distribution (loaded)`);
      }
      db.prepare(`UPDATE distribution_orders SET status='shipped', dispatched=0, shipped_qty=ck_qty, approved_by=?, updated_at=datetime('now') WHERE id=?`).run(req.user.id, d.id);
      loaded++;
    }
    if (!loaded) { db.exec('ROLLBACK'); return res.status(400).json({ error: `${hub.name} is short on every remaining item — restock before loading.` }); }
    recomputeOrderStage(h.order_no);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'Could not load the order.' }); }
  auditLog(req, 'distribution_load', 'location', h.to_location_id, { order_no: h.order_no, loaded, short });
  res.json({ success: true, loaded, short });
});

// A driver takes a loaded order out for delivery.
router.post('/hub-orders/:orderNo/dispatch', requireRole(ROLES.DELIVERY), (req, res) => {
  const h = headerOf(req.params.orderNo);
  if (!h) return res.status(404).json({ error: 'Order not found.' });
  const hub = hubById(h.source_location_id);
  if (!hub || !(seesAllLocations(req.user.role) || String(req.user.location_id) === String(hub.id))) return res.status(403).json({ error: `${hub ? hub.name : 'Hub'} drivers only.` });
  // Dispatch whatever is currently LOADED (scanned onto the truck, not yet in transit). An order can
  // ship in several trips, so leftover items still "Ready to ship" stay for a later load + dispatch.
  const loaded = db.prepare(`SELECT id FROM distribution_orders WHERE order_no=? AND status='shipped' AND dispatched=0 AND approval='approved'`).all(h.order_no);
  if (!loaded.length) return res.status(400).json({ error: 'Nothing is loaded onto the truck to dispatch yet — scan items first.' });
  for (const l of loaded) db.prepare(`UPDATE distribution_orders SET dispatched=1, updated_at=datetime('now') WHERE id=?`).run(l.id);
  db.prepare(`UPDATE distribution_order_headers SET driver_id=? WHERE order_no=?`).run(req.user.id, h.order_no);
  recomputeOrderStage(h.order_no);   // → in_transit (or Partially Shipped label if items still loading)
  auditLog(req, 'distribution_dispatch', 'location', h.to_location_id, { order_no: h.order_no, items: loaded.length });
  try { if (h.requested_by) notify(req.user.id, h.requested_by, `Order ${h.order_no} is on its way`, `Your order ${h.order_no} from ${hub.name} is in transit (${loaded.length} item${loaded.length === 1 ? '' : 's'}).`); } catch { /* best-effort */ }
  res.json({ success: true, dispatched: loaded.length });
});

// Hand off at the store — land the approved items into the store's inventory and mark delivered.
// (Manual now; the handoff scan at the location plugs in here later.)
router.post('/hub-orders/:orderNo/deliver', requireRole(ROLES.OPS), (req, res) => {
  const h = headerOf(req.params.orderNo);
  if (!h) return res.status(404).json({ error: 'Order not found.' });
  const hub = hubById(h.source_location_id);
  const canDeliver = seesAllLocations(req.user.role) || String(req.user.location_id) === String(h.to_location_id)
    || (hub && isHubStaff(req, hub.id)) || roleHasCap(req.user.role, 'delivery');
  if (!canDeliver) return res.status(403).json({ error: 'Not your order.' });
  if (h.stage !== 'in_transit' && h.stage !== 'loaded') return res.status(400).json({ error: `Only an in-transit order can be delivered (this is ${h.stage}).` });
  const lines = db.prepare(`SELECT * FROM distribution_orders WHERE order_no=? AND status='shipped' AND approval='approved'`).all(h.order_no);
  if (!lines.length) return res.status(400).json({ error: 'Nothing to deliver.' });
  db.exec('BEGIN');
  try {
    for (const d of lines) {
      const landQty = r3(d.shipped_qty > 0 ? d.shipped_qty : d.ck_qty);
      const dest = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND item_name=?`).get(d.to_location_id, d.item_name);
      let destId;
      if (dest) { db.prepare(`UPDATE inventory SET quantity=quantity+?, last_updated=datetime('now') WHERE id=?`).run(landQty, dest.id); destId = dest.id; }
      else destId = db.prepare(`INSERT INTO inventory (location_id, item_name, unit, quantity, min_quantity) VALUES (?,?,?,?,0)`).run(d.to_location_id, d.item_name, d.unit || 'units', landQty).lastInsertRowid;
      receiveLot({ item_id: destId, location_id: d.to_location_id, quantity: landQty, unit_cost: dest ? dest.unit_cost || 0 : 0, user_id: req.user.id });
      db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes)
        VALUES (?,?,?,'in',?,?)`).run(destId, d.to_location_id, landQty, req.user.id, `${hub ? hub.name : 'Hub'} delivery received`);
      db.prepare(`UPDATE distribution_orders SET status='received', received_qty=?, received_by=?, cancel_requested=0, updated_at=datetime('now') WHERE id=?`).run(landQty, req.user.id, d.id);
    }
    recomputeOrderStage(h.order_no);   // → delivered once every shipped line is received (leftovers don't block)
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'Could not deliver the order.' }); }
  auditLog(req, 'distribution_deliver', 'location', h.to_location_id, { order_no: h.order_no, items: lines.length });
  res.json({ success: true, received: lines.length });
});

// ── Shipping from a hub (CK / Warehouse): the scan-to-fulfil order flow ───────
// 1) The queue: stores that have open orders for THIS hub, grouped per store.
router.get('/ship-queue', requireRole(ROLES.ALL), (req, res) => {
  const hub = resolveHub(req, true);
  if (!hub) return res.status(404).json({ error: 'Open the scanner from a Central Kitchen or Warehouse to ship orders.' });
  if (!isHubStaff(req, hub.id)) return res.status(403).json({ error: 'Not your hub.' });
  res.json({ hub: { id: hub.id, name: hub.name, type: hub.type }, orders: hubQueue(hub.id) });
});

// 2) One store's open order lines from this hub, with the hub's on-hand + barcode for matching.
router.get('/ship-queue/:storeId', requireRole(ROLES.ALL), (req, res) => {
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
router.post('/ship-scan', requireRole(ROLES.ALL), (req, res) => {
  const hub = resolveHub(req, false);
  if (!hub) return res.status(404).json({ error: 'Open the scanner from a Central Kitchen or Warehouse to ship.' });
  if (!isHubStaff(req, hub.id)) return res.status(403).json({ error: 'Not your hub.' });
  const r = shipScanOrder({ hubId: hub.id, storeId: req.body.to_location_id, code: req.body.code, quantity: req.body.quantity, weight: req.body.weight, confirm: req.body.confirm, adjust: req.body.adjust, userId: req.user.id });
  if (r.not_on_order) return res.json({ ok: false, not_on_order: true, item_name: r.item_name, error: r.error });
  if (r.over) return res.json({ ok: false, ...r });
  if (r.error) return res.status(r.status || 400).json({ error: r.error, found: r.found, code: r.code });
  auditLog(req, 'distribution_ship_scan', 'distribution_order', r.line_id, { item: r.item_name, qty: r.shipped, hub: hub.name, to: parseInt(req.body.to_location_id, 10), over: r.over, adjusted: r.adjusted });
  // On an ADJUST, tell the order's creator the quantity was changed.
  if (r.adjusted && r.requested_by) {
    try { notify(req.user.id, r.requested_by, `Order ${r.order_no} updated`, `${hub.name} set ${r.item_name} to ${r.order.ck_qty} ${r.unit || ''} on order ${r.order_no} (shipped what was on hand).`); } catch { /* best-effort */ }
  }
  res.json(r);
});

// ── End-of-day close (9 PM Pacific) ──────────────────────────────────────────
// A store's current need for one item (the reorder calc: build up to par, else the min).
function storeItemNeed(locId, itemName) {
  const r = db.prepare(`SELECT quantity, min_quantity, par_level FROM inventory WHERE location_id=? AND item_name=? AND is_active=1`).get(locId, itemName);
  if (!r) return 0;
  const buildTo = (r.par_level && r.par_level > r.min_quantity) ? r.par_level : r.min_quantity;
  return Math.max(0, Math.ceil(buildTo - r.quantity));
}
function systemSenderId() {
  const u = db.prepare(`SELECT id FROM users WHERE role IN ('owner','admin','ceo','president','hr') AND is_active=1 ORDER BY id LIMIT 1`).get();
  return u ? u.id : null;
}
// At 9 PM Pacific, close each still-open order from a PRIOR Pacific day on what actually shipped, and
// roll its never-shipped items into a FRESH order — recomputing every item's quantity from the store's
// CURRENT need (the count may have changed since the order was placed). Processing only prior-day orders
// keeps it idempotent across the evening: a carried order is dated today and isn't eligible until the
// next night. The requester is messaged about the roll-over.
function carryOpenOrders({ force = false } = {}) {
  const ptHour = parseInt(db.prepare(`SELECT strftime('%H', 'now', '-7 hours') AS h`).get().h, 10);
  if (!force && ptHour < 21) return { skipped: 'before 21:00 PT' };
  const heads = db.prepare(`SELECT * FROM distribution_order_headers
    WHERE stage NOT IN ('delivered','cancelled','rejected') AND date(created_at,'-7 hours') < date('now','-7 hours')`).all();
  let closed = 0, carried = 0;
  for (const h of heads) {
    const leftovers = db.prepare(`SELECT * FROM distribution_orders
      WHERE order_no=? AND approval='approved' AND status IN ('requested','approved') AND ck_qty > 0.0005 AND shipped_qty <= 0.0005 AND carried_to IS NULL`).all(h.order_no);
    if (!leftovers.length) continue;
    const newNo = nextOrderNo(h.to_location_id);
    let newLines = 0;
    db.exec('BEGIN');
    try {
      let madeHeader = false;
      for (const d of leftovers) {
        const need = storeItemNeed(h.to_location_id, d.item_name);   // re-check the store's latest need
        db.prepare(`UPDATE distribution_orders SET status='cancelled', carried_to=?, updated_at=datetime('now') WHERE id=?`).run(need > 0 ? newNo : null, d.id);
        if (need > 0) {
          if (!madeHeader) {
            db.prepare(`INSERT INTO distribution_order_headers (order_no, to_location_id, source_location_id, priority, requested_by, stage)
              VALUES (?,?,?,?,?,'approved')`).run(newNo, h.to_location_id, h.source_location_id, h.priority || 'standard', h.requested_by);
            madeHeader = true;
          }
          db.prepare(`INSERT INTO distribution_orders
            (to_location_id, source_location_id, item_id, item_name, unit, requested_qty, ck_qty, vendor_qty, status, approval, requested_by, notes, order_no, priority)
            VALUES (?,?,?,?,?,?,?,0,'requested','approved',?,?,?,?)`)
            .run(h.to_location_id, h.source_location_id, d.item_id, d.item_name, d.unit, need, need, h.requested_by, `Carried from ${h.order_no}`, newNo, h.priority || 'standard');
          newLines++;
        }
      }
      syncCancelled(h.order_no);        // all-leftover order → header cancelled
      recomputeOrderStage(h.order_no);  // else reflect what actually shipped/received
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } console.error('[dist-dayclose]', h.order_no, e.message); continue; }
    closed++;
    if (newLines) {
      carried++;
      const sender = systemSenderId();
      if (sender && h.requested_by) { try { notify(sender, h.requested_by, `Order ${h.order_no} rolled over`, `Items not shipped on order ${h.order_no} were moved to a new order ${newNo}, with quantities updated to your current need.`); } catch { /* best-effort */ } }
    }
  }
  return { closed, carried };
}
function startDistributionDayClose() {
  const run = () => { try { carryOpenOrders(); } catch (e) { console.error('[dist-dayclose]', e.message); } };
  const t = setInterval(run, 30 * 60 * 1000);   // every 30 min; the function itself gates on 9 PM Pacific
  if (t.unref) t.unref();
  return t;
}

module.exports = router;
module.exports.startDistributionDayClose = startDistributionDayClose;
module.exports.carryOpenOrders = carryOpenOrders;
