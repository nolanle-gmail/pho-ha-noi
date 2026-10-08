// Order/transfer-aware receiving at a store.
//
// When a store scans an incoming item to RECEIVE, it first checks whether that item is on an open
// **shipped order** (from the Central Kitchen / Warehouse) or an **in-transit transfer** to this
// location. If so, the staffer receives it *against* that line: the stock is landed at the store at
// the SOURCE's cost, `received_qty` advances, and the order/transfer closes only on an **exact**
// quantity/weight match. A short or over receipt still lands what physically arrived but leaves the
// line OPEN and flagged for review (never silently closed). No match → the caller falls through to a
// normal new-item / increase-count receive. Shared by the console, staff app and kiosk.
const db = require('../db/database');
const { receiveLot } = require('./lots');
const { parseScan, logScan } = require('./barcode');

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const EPS = 0.005;

// Open inbound lines for `itemName` arriving at `locId` — shipped orders + in-transit transfers,
// each with how much is still to receive. Fully-received lines are excluded.
function inboundMatches(locId, itemName) {
  const orders = db.prepare(`
    SELECT d.id, d.item_name, d.unit, d.requested_qty, d.shipped_qty, d.received_qty,
           d.source_location_id, l.name AS source_name,
           d.shipped_qty - d.received_qty AS remaining
    FROM distribution_orders d LEFT JOIN locations l ON l.id = d.source_location_id
    WHERE d.to_location_id=? AND d.item_name=? AND d.status='shipped' AND d.shipped_qty - d.received_qty > ?
    ORDER BY d.created_at`).all(locId, itemName, EPS)
    .map(o => ({ ...o, kind: 'order', remaining: r3(o.remaining), requested_qty: r3(o.requested_qty), shipped_qty: r3(o.shipped_qty), received_qty: r3(o.received_qty) }));
  const transfers = db.prepare(`
    SELECT t.id, t.item_name, t.unit, t.quantity, t.received_qty, t.is_catch_weight,
           t.from_location_id, l.name AS source_name,
           t.quantity - t.received_qty AS remaining
    FROM transfer_requests t LEFT JOIN locations l ON l.id = t.from_location_id
    WHERE t.to_location_id=? AND t.item_name=? AND t.status='in_transit' AND t.quantity - t.received_qty > ?
    ORDER BY t.created_at`).all(locId, itemName, EPS)
    .map(t => ({ ...t, kind: 'transfer', remaining: r3(t.remaining), quantity: r3(t.quantity), received_qty: r3(t.received_qty) }));
  return { orders, transfers };
}

// Add `qty` of `itemName` into the store's inventory as a received lot at `srcCost`, capturing the
// scanned label (serial/weight/dates/lot) when present. Creates the stock row if it doesn't exist.
function landAtStore({ locId, itemName, unit, qty, srcCost, userId, p, note }) {
  let item = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND item_name=? AND is_active=1`).get(locId, itemName);
  if (!item) {
    // New to this store — seed category / unit / catch-weight from an existing same-name row
    // elsewhere (e.g. the CK master), so the received item isn't a bare stub. Barcode is left for a
    // later scan-link to avoid a per-location barcode clash.
    const tmpl = db.prepare(`SELECT category, unit, is_catch_weight, min_quantity FROM inventory WHERE item_name=? AND is_active=1 ORDER BY (category IS NOT NULL) DESC LIMIT 1`).get(itemName);
    const id = db.prepare(`INSERT INTO inventory (location_id, item_name, category, unit, quantity, min_quantity, unit_cost, is_catch_weight) VALUES (?,?,?,?,0,?,?,?)`)
      .run(locId, itemName, (tmpl && tmpl.category) || 'Other', (tmpl && tmpl.unit) || unit || 'units', (tmpl && tmpl.min_quantity) || 0, srcCost || 0, (tmpl && tmpl.is_catch_weight) ? 1 : 0).lastInsertRowid;
    item = db.prepare(`SELECT * FROM inventory WHERE id=?`).get(id);
  }
  db.prepare(`UPDATE inventory SET quantity=quantity+?, last_updated=datetime('now') WHERE id=?`).run(qty, item.id);
  receiveLot({ item_id: item.id, location_id: locId, quantity: qty, unit_cost: srcCost || 0, user_id: userId,
    serial: p && p.serial, net_weight_lb: p && p.weightLb, net_weight_kg: p && p.weightKg,
    pack_date: p && p.packDate, prod_date: p && p.prodDate, lot_code: p && p.lot, expiry_date: p && p.expiry });
  db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'in',?,?)`)
    .run(item.id, locId, qty, userId || null, note || 'Received');
  if (p) logScan({ itemId: item.id, locationId: locId, action: 'receive', parsed: p, quantity: qty, userId });
  return item;
}

const srcCostOf = (locId, itemName) => (locId ? (db.prepare(`SELECT unit_cost FROM inventory WHERE location_id=? AND item_name=?`).get(locId, itemName) || {}).unit_cost || 0 : 0);

// Receive `qty` against a shipped order (one scan / box). `code` carries the label for lot capture.
function receiveAgainstOrder({ orderId, qty, code, userId, locId }) {
  const o = db.prepare(`SELECT * FROM distribution_orders WHERE id=?`).get(orderId);
  if (!o) return { error: 'Order not found.', status: 404 };
  if (locId && String(o.to_location_id) !== String(locId)) return { error: 'That order is for another location.', status: 403 };
  if (o.status !== 'shipped') return { error: `This order is ${o.status}, not awaiting receipt.`, status: 400 };
  const amt = r3(qty);
  if (!(amt > 0)) return { error: 'Enter the amount received.', status: 400 };
  const p = code ? parseScan(code) : null;
  db.exec('BEGIN');
  try {
    landAtStore({ locId: o.to_location_id, itemName: o.item_name, unit: o.unit, qty: amt, srcCost: srcCostOf(o.source_location_id, o.item_name), userId, p, note: `Received · order #${o.id}` });
    const newRecv = r3(o.received_qty + amt);
    const exact = Math.abs(newRecv - o.shipped_qty) <= EPS;   // only an exact match to what shipped closes it
    db.prepare(`UPDATE distribution_orders SET received_qty=?, received_by=?, status=?, updated_at=datetime('now') WHERE id=?`)
      .run(newRecv, userId || null, exact ? 'received' : 'shipped', o.id);
    db.exec('COMMIT');
    return { ok: true, kind: 'order', line_id: o.id, item_name: o.item_name, unit: o.unit, received: amt,
      order: { id: o.id, requested_qty: r3(o.requested_qty), shipped_qty: r3(o.shipped_qty), received_qty: newRecv,
        remaining: r3(Math.max(0, o.shipped_qty - newRecv)), closed: exact,
        over: newRecv > o.shipped_qty + EPS, short: !exact && newRecv < o.shipped_qty - EPS } };
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } return { error: 'Could not receive that item.', status: 500 }; }
}

// Receive `qty` against an in-transit transfer (same exact-match rule).
function receiveAgainstTransfer({ transferId, qty, code, userId, locId }) {
  const t = db.prepare(`SELECT * FROM transfer_requests WHERE id=?`).get(transferId);
  if (!t) return { error: 'Transfer not found.', status: 404 };
  if (locId && String(t.to_location_id) !== String(locId)) return { error: 'That transfer is for another location.', status: 403 };
  if (t.status !== 'in_transit') return { error: `This transfer is ${t.status}, not in transit.`, status: 400 };
  const amt = r3(qty);
  if (!(amt > 0)) return { error: 'Enter the amount received.', status: 400 };
  const p = code ? parseScan(code) : null;
  db.exec('BEGIN');
  try {
    landAtStore({ locId: t.to_location_id, itemName: t.item_name, unit: t.unit, qty: amt, srcCost: srcCostOf(t.from_location_id, t.item_name), userId, p, note: `Received · transfer #${t.id}` });
    const newRecv = r3(t.received_qty + amt);
    const exact = Math.abs(newRecv - t.quantity) <= EPS;
    db.prepare(`UPDATE transfer_requests SET received_qty=?, received_by=?, status=?, updated_at=datetime('now') WHERE id=?`)
      .run(newRecv, userId || null, exact ? 'received' : 'in_transit', t.id);
    db.exec('COMMIT');
    return { ok: true, kind: 'transfer', line_id: t.id, item_name: t.item_name, unit: t.unit, received: amt,
      transfer: { id: t.id, quantity: r3(t.quantity), received_qty: newRecv, remaining: r3(Math.max(0, t.quantity - newRecv)),
        closed: exact, over: newRecv > t.quantity + EPS, short: !exact && newRecv < t.quantity - EPS } };
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } return { error: 'Could not receive that transfer.', status: 500 }; }
}

module.exports = { inboundMatches, receiveAgainstOrder, receiveAgainstTransfer, landAtStore, EPS };
