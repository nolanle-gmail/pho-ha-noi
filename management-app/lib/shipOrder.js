// Shared scan-to-fulfil shipping core for distribution orders, used by the console/staff JWT routes
// (routes/distribution.js) and the no-login kiosk (routes/scannerkiosk.js). Pure logic: each
// function takes explicit ids and returns a plain result; the caller handles auth + the audit log.
//
// A hub (Central Kitchen or Warehouse) ships the items a store ordered from it. Each scan decrements
// the hub (FIFO) and advances the order line's shipped_qty — the stock is IN TRANSIT; the store then
// receives it. Under-ship leaves the line open; over-ship needs `confirm` and raises the order count.
const db = require('../db/database');
const { consumeFIFO } = require('./lots');
const { parseScan, logScan } = require('./barcode');

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const HUB_TYPES = ['central_kitchen', 'warehouse'];

function hubById(id) {
  const h = db.prepare(`SELECT id, name, type FROM locations WHERE id=? AND is_active=1`).get(id);
  return h && HUB_TYPES.includes(h.type) ? h : null;
}
function hubAvailable(hubId, itemName) {
  if (!hubId) return 0;
  const row = db.prepare(`SELECT quantity FROM inventory WHERE location_id=? AND item_name=? AND is_active=1 AND distributable=1`).get(hubId, itemName);
  return row ? Math.max(0, row.quantity) : 0;
}
// Open order lines for a store from a hub, with how much is still to ship. Only APPROVED items are
// loadable — items awaiting review (pending), held or rejected don't ship.
function hubOrderLines(hubId, storeId) {
  return db.prepare(`SELECT id, order_no, item_id, item_name, unit, requested_qty, ck_qty, shipped_qty, status
    FROM distribution_orders
    WHERE source_location_id=? AND to_location_id=? AND approval='approved' AND status IN ('requested','approved')
    ORDER BY item_name`).all(hubId, storeId)
    .map(o => ({ ...o, remaining: r3(Math.max(0, o.ck_qty - o.shipped_qty)) }))
    .filter(o => o.remaining > 0.0005 || o.shipped_qty > 0);
}
// The queue: stores with approved orders ready to load for this hub, grouped per store.
function hubQueue(hubId) {
  return db.prepare(`
    SELECT d.to_location_id AS store_id, l.name AS store_name,
           COUNT(*) AS lines, SUM(d.ck_qty - d.shipped_qty) AS remaining, MIN(d.created_at) AS oldest_at,
           SUM(CASE WHEN d.shipped_qty > 0 THEN 1 ELSE 0 END) AS started
    FROM distribution_orders d JOIN locations l ON l.id = d.to_location_id
    WHERE d.source_location_id=? AND d.approval='approved' AND d.status IN ('requested','approved') AND (d.ck_qty - d.shipped_qty) > 0.0005
    GROUP BY d.to_location_id ORDER BY oldest_at`).all(hubId)
    .map(r => ({ ...r, remaining: r3(r.remaining) }));
}
// Once every APPROVED line of an order has fully shipped (loaded onto the truck), advance its header
// from 'approved' to 'loaded'. Keeps the scan-to-load path in step with the stage machine.
function syncLoaded(orderNo) {
  if (!orderNo) return;
  const approved = db.prepare(`SELECT status FROM distribution_orders WHERE order_no=? AND ck_qty>0.0005 AND approval='approved'`).all(orderNo);
  if (approved.length && approved.every(l => ['shipped', 'received'].includes(l.status)))
    db.prepare(`UPDATE distribution_order_headers SET stage='loaded', loaded_at=COALESCE(loaded_at, datetime('now')), updated_at=datetime('now') WHERE order_no=? AND stage='approved'`).run(orderNo);
}
// One store's open lines plus the hub's on-hand + barcode for scan matching.
function storeLines(hubId, storeId) {
  return hubOrderLines(hubId, storeId).map(o => {
    const inv = db.prepare(`SELECT quantity, unit, barcode, is_catch_weight FROM inventory WHERE location_id=? AND item_name=? AND is_active=1`).get(hubId, o.item_name);
    return { ...o, on_hand: inv ? r3(inv.quantity) : 0, barcode: inv ? inv.barcode : null, is_catch_weight: inv ? !!inv.is_catch_weight : false };
  });
}

// Notify the order's requester that it shipped. DISABLED by default (owner enables later).
const NOTIFY_SENDER = process.env.DIST_NOTIFY_SENDER === '1';
function notifySender(order, hubName) {
  if (!NOTIFY_SENDER || !order || !order.requested_by) return;
  try {
    const u = db.prepare(`SELECT name, phone FROM users WHERE id=?`).get(order.requested_by);
    if (u && u.phone) require('./sms').sendSms(u.phone, `${hubName} shipped ${r3(order.shipped_qty)} ${order.unit || ''} of ${order.item_name} on your order.`);
  } catch { /* best-effort; never breaks a ship */ }
}

// Scan one item to fulfil a line of a store's order from this hub. Returns a plain result object:
//   { error, status }                              — validation / stock error
//   { not_on_order, item_name, error }             — scanned item isn't on this store's order
//   { over, message, ... }                         — over-ship; re-call with confirm:true
//   { ok, item_name, unit, shipped, order, ... }   — shipped (committed)
function shipScanOrder({ hubId, storeId, code, quantity, weight, confirm, userId }) {
  const hub = hubById(hubId);
  if (!hub) return { error: 'Open the scanner from a Central Kitchen or Warehouse to ship.', status: 404 };
  storeId = parseInt(storeId, 10);
  if (!storeId) return { error: 'Pick the store whose order you are filling.', status: 400 };
  const p = parseScan(code);
  const key = (p.gtin || p.code || '').toString().trim();
  if (!key) return { error: 'A barcode is required.', status: 400 };
  const src = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND barcode=? AND is_active=1`).get(hub.id, key);
  if (!src) return { error: `That barcode isn't stocked at ${hub.name}, so there's nothing to ship.`, found: false, code: key, status: 404 };
  const line = db.prepare(`SELECT * FROM distribution_orders
    WHERE source_location_id=? AND to_location_id=? AND item_name=? AND approval='approved' AND status IN ('requested','approved')
    ORDER BY id LIMIT 1`).get(hub.id, storeId, src.item_name);
  if (!line) return { not_on_order: true, item_name: src.item_name, error: `${src.item_name} isn't an approved item to load for this store from ${hub.name}.` };

  const catchw = !!src.is_catch_weight;
  const qty = parseFloat(catchw && (weight != null && weight !== '') ? weight
    : (quantity != null && quantity !== '') ? quantity
    : (p.weightLb != null ? p.weightLb : NaN));
  if (!Number.isFinite(qty) || qty <= 0) return { error: catchw ? 'Enter the weight to ship.' : 'Enter a quantity to ship.', status: 400 };
  if (src.quantity < qty - 0.0005) return { error: `Only ${r3(src.quantity)} ${src.unit} of ${src.item_name} on hand at ${hub.name}.`, status: 400 };

  const remaining = r3(Math.max(0, line.ck_qty - line.shipped_qty));
  const newShipped = r3(line.shipped_qty + qty);
  const over = newShipped > line.ck_qty + 0.0005;
  if (over && !confirm) {
    return { over: true, item_name: src.item_name, unit: src.unit, remaining, scanned: r3(qty), new_total: newShipped, ordered: r3(line.requested_qty),
      message: `You scanned ${r3(qty)} ${src.unit} of ${src.item_name} — more than the ${remaining} ${src.unit} left on this order (originally ${r3(line.requested_qty)} ${src.unit}). Accept the extra? The order keeps the original ${r3(line.requested_qty)} ${src.unit} and records ${newShipped} ${src.unit} shipped.` };
  }

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE inventory SET quantity=quantity-?, last_updated=datetime('now') WHERE id=?`).run(qty, src.id);
    consumeFIFO(src.id, qty);
    db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, to_location_id, quantity, type, user_id, notes)
      VALUES (?,?,?,?,'transfer_sent',?,?)`).run(src.id, hub.id, storeId, qty, userId || null, `Order ship (scan) · order #${line.id}`);
    // The order's ORIGINAL amounts stay frozen — the store's request (requested_qty) and the hub's
    // planned portion (ck_qty) are never overwritten. Only shipped_qty moves, so the requester always
    // sees what they ordered next to what actually shipped (under, exact, or over).
    const ckQty = line.ck_qty, requested = line.requested_qty;
    const done = newShipped >= ckQty - 0.0005;
    db.prepare(`UPDATE distribution_orders SET shipped_qty=?, ck_qty=?, requested_qty=?, status=?, approved_by=?, updated_at=datetime('now') WHERE id=?`)
      .run(newShipped, ckQty, requested, done ? 'shipped' : line.status, userId || null, line.id);
    if (done) syncLoaded(line.order_no);   // all approved items loaded ⇒ the order's header moves to 'loaded'
    db.exec('COMMIT');
    logScan({ itemId: src.id, locationId: hub.id, action: 'ship', parsed: p, quantity: qty, userId });
    const fresh = db.prepare(`SELECT * FROM distribution_orders WHERE id=?`).get(line.id);
    if (done) notifySender(fresh, hub.name);
    return { ok: true, success: true, hub, line_id: line.id, item_name: src.item_name, unit: src.unit, shipped: r3(qty), over: !!over,
      order: { id: line.id, requested_qty: r3(requested), ck_qty: r3(ckQty), shipped_qty: newShipped, remaining: r3(Math.max(0, ckQty - newShipped)), done, raised: !!over },
      store_done: hubOrderLines(hub.id, storeId).length === 0, on_hand: r3(Math.max(0, src.quantity - qty)) };
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } return { error: 'Could not ship that item.', status: 500 }; }
}

module.exports = { r3, hubById, hubAvailable, hubOrderLines, hubQueue, storeLines, shipScanOrder, notifySender, syncLoaded, HUB_TYPES };
