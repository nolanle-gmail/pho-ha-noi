// Central Kitchen master-catalog replication, shared by the console (routes/inventory.js) and
// the standalone scanner kiosk (routes/scannerkiosk.js) so a new CK item seeds every store the
// same way whichever surface created it. The CK is the master: an item created there fans out a
// 0-qty stock row to every active restaurant (linked by `source_id`), so stores can order it and
// CK edits propagate. The Warehouse never replicates — callers gate on isCk().
const db = require('../db/database');

const ckLocId = () => (db.prepare(`SELECT id FROM locations WHERE type='central_kitchen' LIMIT 1`).get() || {}).id || null;
const restaurantLocs = () => db.prepare(`SELECT id FROM locations WHERE type='restaurant' AND is_active=1`).all().map(r => r.id);
const isCk = (locId) => locId != null && String(locId) === String(ckLocId());

function replicateItemFromCk(ckItem) {
  const ins = db.prepare(`INSERT INTO inventory (location_id, item_name, category, unit, quantity, min_quantity, par_level, unit_cost, sku, description, notes, barcode, source_id)
    VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?)`);
  const exists = db.prepare(`SELECT id FROM inventory WHERE location_id=? AND item_name=? AND is_active=1`);
  let n = 0;
  for (const loc of restaurantLocs()) {
    if (exists.get(loc, ckItem.item_name)) continue;   // store already has this item — leave it
    try { ins.run(loc, ckItem.item_name, ckItem.category, ckItem.unit, ckItem.min_quantity, ckItem.par_level, ckItem.unit_cost, ckItem.sku, ckItem.description, ckItem.notes, ckItem.barcode, ckItem.id); n++; } catch { /* skip on conflict */ }
  }
  return n;
}

module.exports = { ckLocId, restaurantLocs, isCk, replicateItemFromCk };
