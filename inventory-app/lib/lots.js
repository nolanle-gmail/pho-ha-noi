// Inventory lots & FIFO consumption (ported from the source design).
//
// Received stock is recorded as a *lot* with an optional expiry date. When stock
// is consumed (waste, transfer out, cycle-count shrinkage), lots are drawn down
// FIFO — earliest expiry first, then earliest received — so older stock is used
// before it spoils. inventory.quantity stays the authoritative total; lots are a
// parallel ledger for expiry/traceability.
const db = require('../db/database');

function receiveLot({ item_id, location_id, quantity, unit_cost = 0, expiry_date = null, lot_code = null, user_id = null }) {
  const qty = Math.max(0, Number(quantity) || 0);
  if (!item_id || qty <= 0) return null;
  const r = db.prepare(`
    INSERT INTO inventory_lots (item_id, location_id, lot_code, received_qty, quantity, unit_cost, expiry_date, received_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(item_id, location_id || null, lot_code || null, qty, qty, Number(unit_cost) || 0, expiry_date || null, user_id || null);
  return r.lastInsertRowid;
}

function consumeFIFO(itemId, qty) {
  let remaining = Math.max(0, Number(qty) || 0);
  if (!itemId || remaining <= 0) return 0;
  let consumed = 0;
  try {
    const lots = db.prepare(`
      SELECT id, quantity FROM inventory_lots
      WHERE item_id=? AND quantity > 0
      ORDER BY (expiry_date IS NULL), expiry_date ASC, received_at ASC, id ASC
    `).all(itemId);
    const setQty = db.prepare(`UPDATE inventory_lots SET quantity=?, depleted_at=CASE WHEN ?<=0 THEN datetime('now') ELSE depleted_at END WHERE id=?`);
    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(lot.quantity, remaining);
      const next = Math.round((lot.quantity - take) * 1000) / 1000;
      setQty.run(next, next, lot.id);
      remaining = Math.round((remaining - take) * 1000) / 1000;
      consumed += take;
    }
  } catch (e) {
    console.error('consumeFIFO failed:', e.message);
  }
  return consumed;
}

module.exports = { receiveLot, consumeFIFO };
