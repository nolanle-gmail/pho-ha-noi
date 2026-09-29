// Scan-to-ship core, shared by the console scanner and the kiosk. Moves a scanned item from
// one location to another: decrements the source (FIFO), adds/creates it at the destination,
// logs a `transfer_sent`, and fills a matching open order line (a store's request to the CK).
const db = require('../db/database');
const { receiveLot, consumeFIFO } = require('./lots');
const { parseScan, logScan, recentDuplicate, dupMessage } = require('./barcode');

// Open order lines a destination store is waiting on (distribution_orders → the CK).
function openOrders(toLoc) {
  const to = parseInt(toLoc, 10);
  if (!to) return [];
  return db.prepare(`SELECT id, item_name, unit, requested_qty, ck_qty, status FROM distribution_orders
    WHERE to_location_id=? AND status IN ('requested','approved') ORDER BY item_name`).all(to)
    .map(o => ({ ...o, remaining: Math.max(0, Math.round((o.requested_qty - o.ck_qty) * 1000) / 1000) }));
}

// Returns { ok, status?, error?, found?, code?, item?, to?, order?, src? }.
function shipByBarcode({ fromLoc, toLoc, code, quantity, userId, confirm }) {
  const p = parseScan(code);
  const key = (p.gtin || p.code || '').toString().trim();
  const from = fromLoc, to = parseInt(toLoc, 10), qty = parseFloat(quantity);
  if (!from || !to || !key) return { ok: false, status: 400, error: 'A source, destination and barcode are required.' };
  if (String(from) === String(to)) return { ok: false, status: 400, error: 'Pick a different destination.' };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, status: 400, error: 'Enter a quantity to ship.' };
  const src = db.prepare(`SELECT * FROM inventory WHERE location_id=? AND barcode=? AND is_active=1`).get(from, key);
  if (!src) return { ok: false, status: 404, found: false, code: key, error: 'No item is linked to that barcode here.' };
  if (src.quantity < qty) return { ok: false, status: 400, error: `Only ${src.quantity} ${src.unit} on hand here.` };
  if (!confirm) {
    const d = recentDuplicate({ itemId: src.id, gtin: p.gtin, serial: p.serial, actions: ['ship'], quantity: qty });
    if (d.dup) return { ok: false, duplicate: true, status: 200, message: dupMessage(d, 'ship', src.item_name, p.serial) };
  }
  db.prepare(`UPDATE inventory SET quantity=quantity-?, last_updated=datetime('now') WHERE id=?`).run(qty, src.id);
  consumeFIFO(src.id, qty);
  const dest = db.prepare(`SELECT * FROM inventory WHERE item_name=? AND location_id=? AND is_active=1`).get(src.item_name, to);
  let destId;
  if (dest) { db.prepare(`UPDATE inventory SET quantity=quantity+?, last_updated=datetime('now') WHERE id=?`).run(qty, dest.id); destId = dest.id; }
  else { destId = db.prepare(`INSERT INTO inventory (location_id, item_name, category, unit, quantity, min_quantity, unit_cost, barcode, vendor_code) SELECT ?, item_name, category, unit, ?, min_quantity, unit_cost, barcode, vendor_code FROM inventory WHERE id=?`).run(to, qty, src.id).lastInsertRowid; }
  receiveLot({ item_id: destId, location_id: to, quantity: qty, unit_cost: src.unit_cost, user_id: userId });
  db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,?, 'transfer_sent', ?, ?)`).run(src.id, from, to, qty, userId, 'Scanned ship');
  logScan({ itemId: src.id, locationId: from, action: 'ship', parsed: p, quantity: qty, userId });
  let order = null;
  const line = db.prepare(`SELECT * FROM distribution_orders WHERE to_location_id=? AND item_name=? AND status IN ('requested','approved') ORDER BY id LIMIT 1`).get(to, src.item_name);
  if (line) {
    const ckq = Math.round((line.ck_qty + qty) * 1000) / 1000;
    const done = ckq >= line.requested_qty;
    db.prepare(`UPDATE distribution_orders SET ck_qty=?, status=? WHERE id=?`).run(ckq, done ? 'shipped' : line.status, line.id);
    order = { id: line.id, item_name: line.item_name, requested_qty: line.requested_qty, ck_qty: ckq, remaining: Math.max(0, Math.round((line.requested_qty - ckq) * 1000) / 1000), shipped: done };
  }
  return { ok: true, item: db.prepare(`SELECT * FROM inventory WHERE id=?`).get(src.id), to, order, src };
}

module.exports = { shipByBarcode, openOrders };
