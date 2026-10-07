// Inventory lots & FIFO consumption (ported from the source design).
//
// Received stock is recorded as a *lot* with an optional expiry date. When stock
// is consumed (waste, transfer out, cycle-count shrinkage), lots are drawn down
// FIFO — earliest expiry first, then earliest received — so older stock is used
// before it spoils. inventory.quantity stays the authoritative total; lots are a
// parallel ledger for expiry/traceability.
const db = require('../db/database');

function receiveLot({ item_id, location_id, quantity, unit_cost = 0, expiry_date = null, lot_code = null, user_id = null, serial = null, net_weight_lb = null, net_weight_kg = null, pack_date = null, prod_date = null }) {
  const qty = Math.max(0, Number(quantity) || 0);
  if (!item_id || qty <= 0) return null;
  // Store serial + net weight + label dates when the label carried them (best-effort — older DBs
  // may lack the columns, so fall back to the original column set).
  try {
    const r = db.prepare(`
      INSERT INTO inventory_lots (item_id, location_id, lot_code, received_qty, quantity, unit_cost, expiry_date, received_by, serial, net_weight_lb, net_weight_kg, pack_date, prod_date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(item_id, location_id || null, lot_code || null, qty, qty, Number(unit_cost) || 0, expiry_date || null, user_id || null,
           serial || null, net_weight_lb == null ? null : Number(net_weight_lb), net_weight_kg == null ? null : Number(net_weight_kg),
           pack_date || null, prod_date || null);
    return r.lastInsertRowid;
  } catch {
    const r = db.prepare(`
      INSERT INTO inventory_lots (item_id, location_id, lot_code, received_qty, quantity, unit_cost, expiry_date, received_by)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(item_id, location_id || null, lot_code || null, qty, qty, Number(unit_cost) || 0, expiry_date || null, user_id || null);
    return r.lastInsertRowid;
  }
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

// Like consumeFIFO, but also reports the TRUE cost consumed — each drawn-down layer is valued at
// that batch's own unit_cost, so "Use" / shrinkage knows the real COGS even when prices moved
// between purchases. Returns { qty, cost, layers:[{lot_id, qty, unit_cost}] }.
function consumeFIFOCosted(itemId, qty) {
  let remaining = Math.max(0, Number(qty) || 0);
  const out = { qty: 0, cost: 0, layers: [] };
  if (!itemId || remaining <= 0) return out;
  try {
    const lots = db.prepare(`
      SELECT id, quantity, unit_cost FROM inventory_lots
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
      out.qty += take;
      out.cost += take * (Number(lot.unit_cost) || 0);
      out.layers.push({ lot_id: lot.id, qty: Math.round(take * 1000) / 1000, unit_cost: Number(lot.unit_cost) || 0 });
    }
    out.qty = Math.round(out.qty * 1000) / 1000;
    out.cost = Math.round(out.cost * 100) / 100;
  } catch (e) {
    console.error('consumeFIFOCosted failed:', e.message);
  }
  return out;
}

module.exports = { receiveLot, consumeFIFO, consumeFIFOCosted };
