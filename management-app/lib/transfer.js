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
  // Two-step transfer: decrement the source now; the stock is IN TRANSIT and is NOT added to the
  // destination yet. The destination scans it to receive (lib/inbound.receiveAgainstTransfer), which
  // lands it there and closes the transfer. (Orders are filled via the Shipping flow, not here.)
  db.prepare(`UPDATE inventory SET quantity=quantity-?, last_updated=datetime('now') WHERE id=?`).run(qty, src.id);
  consumeFIFO(src.id, qty);
  const tr = db.prepare(`INSERT INTO transfer_requests (item_name, quantity, unit, is_catch_weight, from_location_id, to_location_id, requested_by, status, notes)
    VALUES (?,?,?,?,?,?,?, 'in_transit', ?)`).run(src.item_name, qty, src.unit || 'units', src.is_catch_weight ? 1 : 0, from, to, userId || null, 'Scanned transfer');
  db.prepare(`INSERT INTO inventory_transactions (item_id, from_location_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,?, 'transfer_sent', ?, ?)`)
    .run(src.id, from, to, qty, userId, `Transfer #${tr.lastInsertRowid} · in transit`);
  logScan({ itemId: src.id, locationId: from, action: 'ship', parsed: p, quantity: qty, userId });
  return { ok: true, in_transit: true, transfer_id: tr.lastInsertRowid, item: db.prepare(`SELECT * FROM inventory WHERE id=?`).get(src.id), to, src };
}

module.exports = { shipByBarcode, openOrders };
