// Smart scan-to-receive core, shared by the console (routes/inventory.js) and the staff app
// (routes/invscan.js) so both behave identically at the Central Kitchen and every location.
//
// Decision tree (what the user asked for):
//   1. A GS1 serial (21) that is already ON HAND at this location = the exact same physical
//      box → a TRUE duplicate. Warn and do nothing (unless `confirm` forces it).
//   2. Barcode already a stock item here → just add to it: catch-weight items add net WEIGHT,
//      everything else adds COUNT (the ~10s double-scan guard still applies to plain repeats).
//   3. Barcode new to stock → look it up in the Glossary (and the label). Hand the caller the
//      glossary + parsed-label data so it can pre-fill the add form. Saving then creates the
//      stock item, writes the item into the Glossary, and receives the opening amount.
const db = require('../db/database');
const { parseScan, logScan, dupMessage, recentDuplicate } = require('./barcode');
const { receiveLot } = require('./lots');
const { rememberProduct, catalogGet, catalogGetByScaleCode } = require('./productLookup');
const { resolveVendor } = require('./vendors');
const { resolveSection } = require('./sections');

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const findItem = (locId, code) => db.prepare(`SELECT i.*, s.name AS section_name FROM inventory i LEFT JOIN storage_sections s ON s.id=i.section_id WHERE i.location_id=? AND i.barcode=? AND i.is_active=1`).get(locId, code);

// Is this exact GS1 box (gtin+serial) already on hand? (Optionally scoped to a location.)
function serialOnHand({ locId, gtin, serial }) {
  if (!gtin || !serial) return null;
  try {
    const args = [gtin, serial];
    let sql = `SELECT lo.id, lo.location_id, i.item_name FROM inventory_lots lo
      JOIN inventory i ON i.id=lo.item_id
      WHERE i.barcode=? AND lo.serial=? AND lo.quantity>0 AND i.is_active=1`;
    if (locId) { sql += ` AND lo.location_id=?`; args.push(locId); }
    return db.prepare(sql + ` LIMIT 1`).get(...args) || null;
  } catch { return null; }
}

// One call the scanner UI makes on every scan: what is this, is it in stock here, and what
// does the Glossary/label already know (to pre-fill a form)?
function resolveScan({ locId, code }) {
  const p = parseScan(code);
  let gloss = null, key = '';
  // Deli-scale weigh label: match the Glossary by the scale (LF) code, then use that entry's
  // stable barcode as the stock key. The label's net weight (p.weightLb) pre-fills the amount.
  if (p.scaleCode) { gloss = catalogGetByScaleCode(p.scaleCode); if (gloss) key = (gloss.barcode || '').toString().trim(); }
  if (!key) key = (p.gtin || p.code || '').toString().trim();
  if (!gloss && key) gloss = catalogGet(key);
  const item = key ? findItem(locId, key) : null;
  const dupBox = serialOnHand({ locId, gtin: p.gtin, serial: p.serial });
  // The most recent lot on hand here — lets the UI show "this box vs the last one" (weight/dates)
  // before adding, so a different-weight/different-date case is reviewed, not silently merged.
  let last_box = null;
  if (item) {
    try {
      last_box = db.prepare(`SELECT net_weight_lb, net_weight_kg, expiry_date, lot_code, serial, pack_date, prod_date, received_at
        FROM inventory_lots WHERE item_id=? AND location_id=? ORDER BY received_at DESC, id DESC LIMIT 1`).get(item.id, locId) || null;
    } catch { /* older DB without the lot columns */ }
  }
  return {
    code: key, parsed: p, scale_code: p.scaleCode || null, in_stock: !!item, item: item || null,
    in_glossary: !!gloss, glossary: gloss || null, last_box,
    duplicate_box: dupBox ? { location_id: dupBox.location_id, item_name: dupBox.item_name, serial: p.serial } : null,
  };
}

// The weight/amount to add: catch-weight items add net weight (label 320x/310x or entered),
// everything else adds a unit count.
function amountFor({ item, body, parsed }) {
  const catch_weight = item ? item.is_catch_weight : (body.is_catch_weight ? 1 : 0);
  if (catch_weight) {
    const w = parseFloat(body.weight != null && body.weight !== '' ? body.weight : (parsed.weightLb != null ? parsed.weightLb : NaN));
    return { catch_weight: 1, qty: w, kind: 'weight' };
  }
  return { catch_weight: 0, qty: parseFloat(body.quantity), kind: 'count' };
}

// Receive into an EXISTING stock item (add count or weight). Returns {ok}|{error}|{duplicate}.
function receiveExisting({ locId, item, body, user }) {
  const p = parseScan(body.code || body.barcode);
  const amt = amountFor({ item, body, parsed: p });
  // Smart duplicate guard (skipped once the user confirms the override):
  //  • GS1 serial already on hand here = the exact same physical box → a TRUE duplicate.
  //  • No serial → only a rapid accidental re-scan (same item + amount within a few seconds) is
  //    flagged; deliberate repeat receiving of identical units always just adds to the count.
  // A different box (new serial, or a different weight/pack-date) is NOT blocked here — the
  // scanner panel already shows that box's data and the user confirms it by tapping Add.
  if (!body.confirm) {
    if (p.serial) {
      const dup = serialOnHand({ locId, gtin: p.gtin, serial: p.serial });
      if (dup) return { duplicate: true, kind: 'serial', message: `⚠ This exact box (serial ${p.serial}) of ${item.item_name} is already in stock — not added. Add it anyway?` };
    } else {
      const rd = recentDuplicate({ itemId: item.id, gtin: p.gtin, serial: null, actions: ['receive', 'create'], quantity: Number.isFinite(amt.qty) ? amt.qty : null });
      if (rd.dup) return { duplicate: true, kind: 'rapid', message: `⚠ You just received ${item.item_name} moments ago — this may be a double scan. Add it again anyway?` };
    }
  }
  if (!Number.isFinite(amt.qty) || amt.qty <= 0) return { error: amt.kind === 'weight' ? 'Enter the net weight to receive.' : 'Enter a quantity to receive.' };
  const expiry = body.expiry_date || p.expiry || p.packDate || p.prodDate || null;
  const lot = body.lot_code || p.lot || null;
  db.prepare(`UPDATE inventory SET quantity=quantity+?, last_updated=datetime('now') WHERE id=?`).run(amt.qty, item.id);
  receiveLot({ item_id: item.id, location_id: locId, quantity: amt.qty, unit_cost: item.unit_cost, expiry_date: expiry, lot_code: lot, user_id: user.id, serial: p.serial, net_weight_lb: p.weightLb, net_weight_kg: p.weightKg, pack_date: p.packDate, prod_date: p.prodDate });
  db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'in',?,?)`)
    .run(item.id, locId, amt.qty, user.id, `Scanned in${lot ? ` · lot ${lot}` : ''}${p.serial ? ` · #${p.serial}` : ''}${expiry ? ` · exp ${expiry}` : ''}`);
  logScan({ itemId: item.id, locationId: locId, action: 'receive', parsed: p, quantity: amt.qty, userId: user.id });
  return { ok: true, item: db.prepare(`SELECT * FROM inventory WHERE id=?`).get(item.id), added: round3(amt.qty), kind: amt.kind };
}

// Create a NEW stock item from the scan form, write it into the Glossary, and receive the
// opening amount. `body` carries the form fields the user filled in. Returns {ok}|{error}.
function createAndReceive({ locId, body, user }) {
  const p = parseScan(body.barcode || body.code);
  let code = (p.gtin || p.code || '').toString().trim() || null;
  // A weighed deli-scale label carries no stable GTIN, only a 2-digit scale code. Give the new
  // item a stable key (SCALE-NN) so it links to the Glossary by scale code on every future scan.
  const scaleCode = p.scaleCode || (body.scale_code != null && body.scale_code !== '' ? String(body.scale_code) : null);
  if (!code && scaleCode) code = `SCALE-${String(parseInt(scaleCode, 10) || 0).padStart(2, '0')}`;
  const gloss = code ? catalogGet(code) : null;
  // Name comes from the form; fall back to the glossary entry if the operator left it blank.
  const name = String(body.item_name || body.name || (gloss && gloss.name) || '').trim();
  if (!name) return { error: 'Item name is required.' };
  if (db.prepare(`SELECT id FROM inventory WHERE item_name=? AND location_id=? AND is_active=1`).get(name, locId)) return { error: 'That item already exists here — scan it to receive instead.' };
  if (code) { const clash = db.prepare(`SELECT item_name FROM inventory WHERE location_id=? AND barcode=? AND is_active=1`).get(locId, code); if (clash) return { error: `That barcode is already on “${clash.item_name}” here — scan it to receive that item.` }; }
  const catch_weight = body.is_catch_weight != null ? (body.is_catch_weight ? 1 : 0) : (gloss && gloss.is_catch_weight ? 1 : 0);
  const stackable = body.stackable != null ? (body.stackable ? 1 : 0) : (gloss ? (gloss.stackable ? 1 : 0) : 1);
  const unit = String(body.unit || (gloss && gloss.unit) || (catch_weight ? 'lb' : 'units')).trim();
  const category = String(body.category || (gloss && gloss.category) || 'Other').trim();
  const description = (body.description || (gloss && gloss.description) || '').toString().slice(0, 500) || null;
  const cost = Math.max(0, parseFloat(body.unit_cost) || (gloss && gloss.default_unit_cost) || 0);
  const minQ = Math.max(0, parseFloat(body.min_quantity) || 0);
  const par = body.par_level == null || body.par_level === '' ? null : Math.max(0, parseFloat(body.par_level) || 0);
  const vendorId = resolveVendor(locId, body);
  const sectionId = resolveSection(locId, body);   // typed shelf is matched or created on the fly
  const amt = amountFor({ item: { is_catch_weight: catch_weight }, body, parsed: p });
  const openQty = Number.isFinite(amt.qty) && amt.qty > 0 ? amt.qty : 0;
  const r = db.prepare(`INSERT INTO inventory
      (location_id, item_name, category, unit, quantity, min_quantity, par_level, unit_cost, sku, description, notes, barcode, vendor_id, vendor_code, is_catch_weight, stackable, section_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(locId, name, category, unit, openQty, minQ, par, cost,
         (body.sku || '').toString().trim() || null, description, (body.notes || '').toString().slice(0, 500) || null,
         code, vendorId, (body.vendor_code || '').toString().trim() || null, catch_weight, stackable, sectionId);
  const itemId = r.lastInsertRowid;
  if (openQty > 0) {
    const expiry = body.expiry_date || p.expiry || p.packDate || p.prodDate || null;
    const lot = body.lot_code || p.lot || null;
    receiveLot({ item_id: itemId, location_id: locId, quantity: openQty, unit_cost: cost, expiry_date: expiry, lot_code: lot, user_id: user.id, serial: p.serial, net_weight_lb: p.weightLb, net_weight_kg: p.weightKg, pack_date: p.packDate, prod_date: p.prodDate });
    db.prepare(`INSERT INTO inventory_transactions (item_id, to_location_id, quantity, type, user_id, notes) VALUES (?,?,?,'in',?,?)`)
      .run(itemId, locId, openQty, user.id, `Opening stock (scan)${p.serial ? ` · #${p.serial}` : ''}`);
  }
  // Write the item into the group Glossary (unless the operator opted out) so the next scan
  // anywhere pre-fills it. Only when we have a numeric GTIN key.
  if (code && body.save_to_glossary !== false && body.save_to_glossary !== 'false') {
    rememberProduct(code, name, user.id, {
      brand: body.brand, size: body.size, description, unit, category,
      notes: body.notes, default_unit_cost: cost, is_catch_weight: catch_weight, stackable,
      default_vendor_id: vendorId, default_vendor_code: body.vendor_code, barcode_type: body.barcode_type,
      scale_code: scaleCode || undefined,
    });
  }
  if (code) logScan({ itemId, locationId: locId, action: 'create', parsed: p, quantity: openQty, userId: user.id });
  return { ok: true, id: itemId, item: db.prepare(`SELECT * FROM inventory WHERE id=?`).get(itemId), received: round3(openQty), kind: amt.kind };
}

module.exports = { resolveScan, receiveExisting, createAndReceive, serialOnHand, findItem };
