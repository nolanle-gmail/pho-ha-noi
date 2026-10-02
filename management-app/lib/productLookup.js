// Barcode → product name/brand/size resolution, shared by every scan surface.
//
// Order of resolution (first hit wins):
//   1. product_catalog — the group-wide dictionary. A name someone typed ('staff') is
//      authoritative and returned immediately. An 'external' cache row is used but we still
//      let a later staff name overwrite it.
//   2. Open Food Facts (food/beverage) — free, community.
//   3. Open Beauty / Products / Pet Food Facts — same org, cover non-food.
//   4. UPCitemdb free trial — broad general-merchandise catalog (name/brand/size).
//
// Any external hit is cached back into product_catalog (source='external') so the next scan
// anywhere is instant and coverage compounds. Weighed in-store items (UPC starting with '2')
// are flagged locally and never sent to a database — that number is store-specific.
const db = require('../db/database');
const { parseScan } = require('./barcode');

const digits = (s) => String(s || '').replace(/\D/g, '');
const clean = (s) => (s == null ? '' : String(s)).trim();

// A short per-request timeout so a slow/offline source never hangs the scanner.
async function fetchJson(url, ms = 2800) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'PhoHaNoi-Inventory/1.0 (inventory@phohanoi)' }, signal: ctrl.signal });
    return await r.json().catch(() => null);
  } catch { return null; } finally { clearTimeout(t); }
}

// Resolve to the FIRST source that returns a usable name; ignore the rest. All sources run
// concurrently, so total latency is one slow request (~timeout), never the sum of them.
function firstNamed(promises) {
  return new Promise((resolve) => {
    let pending = promises.length, done = false;
    if (!pending) return resolve(null);
    for (const pr of promises) {
      Promise.resolve(pr).then(
        (v) => { if (done) return; if (v && clean(v.name)) { done = true; resolve(v); } else if (--pending === 0) resolve(null); },
        () => { if (!done && --pending === 0) resolve(null); }
      );
    }
  });
}

// ── Individual sources ───────────────────────────────────────────────────────
// Open*Facts family (identical API shape across the four sister databases). One host each.
const OFF_HOSTS = [
  'https://world.openfoodfacts.org',
  'https://world.openproductsfacts.org',
  'https://world.openbeautyfacts.org',
  'https://world.openpetfoodfacts.org',
];
async function offOne(host, code) {
  const d = await fetchJson(`${host}/api/v2/product/${code}.json?fields=product_name,brands,quantity`);
  if (d && d.status === 1 && d.product) {
    const p = d.product;
    const brand = p.brands ? p.brands.split(',')[0].trim() : '';
    const name = [brand, p.product_name || ''].filter(Boolean).join(' ').trim();
    if (name) return { name, brand: brand || null, size: clean(p.quantity) || null, source: 'external' };
  }
  return null;
}

// All external catalogs at once — first usable hit wins.
function externalLookup(code) {
  return firstNamed([...OFF_HOSTS.map((h) => offOne(h, code)), upcItemDb(code)]);
}

// UPCitemdb free trial — broad catalog; returns title/brand and often a size.
async function upcItemDb(code) {
  const d = await fetchJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`);
  const it = d && Array.isArray(d.items) && d.items[0];
  if (it && clean(it.title)) {
    return { name: clean(it.title), brand: clean(it.brand) || null, size: clean(it.size) || clean(it.weight) || null, source: 'external' };
  }
  return null;
}

// ── Catalog helpers ──────────────────────────────────────────────────────────
// Full glossary column set (product_catalog is the group-wide "Glossary").
const GLOSSARY_COLS = `barcode, name, name_vi, name_es, brand, size, description, unit, category, notes,
  default_unit_cost, stackable, is_catch_weight, default_vendor_id, default_vendor_code,
  barcode_type, scale_code, image_url, active, source, created_by, created_at, updated_by, updated_at`;
// Normalize a deli-scale item code to a canonical digits-only, no-leading-zero string
// (so "000010", "10" and "0010" all match), or null when blank/non-numeric.
function normScale(v) { const d = digits(v); if (!d) return null; const n = parseInt(d, 10); return Number.isFinite(n) ? String(n) : null; }
function catalogGet(code) {
  try { return db.prepare(`SELECT ${GLOSSARY_COLS} FROM product_catalog WHERE barcode=?`).get(code) || null; }
  catch {
    // Pre-migration fallback (columns not yet added).
    try { return db.prepare(`SELECT barcode, name, brand, size, source FROM product_catalog WHERE barcode=?`).get(code) || null; }
    catch { return null; }
  }
}
// Resolve a glossary entry by its deli-scale item code (AvaWeigh LF Code / PLU) — used when a
// price/weight-embedded EAN-13 from the scale is scanned. Codes are matched canonically
// (leading zeros ignored). Returns the full glossary row or null.
function catalogGetByScaleCode(scaleCode) {
  const s = normScale(scaleCode);
  if (!s) return null;
  try { return db.prepare(`SELECT ${GLOSSARY_COLS} FROM product_catalog WHERE scale_code=?`).get(s) || null; }
  catch { return null; }
}
// Upsert a catalog row. A 'staff' entry always wins; an 'external' entry never clobbers a
// 'staff' one. Called whenever a barcode gets a name (staff) or an API resolves it (external).
function catalogUpsert(code, { name, brand, size, source, userId } = {}) {
  const c = digits(code) || clean(code);
  if (!c || !clean(name)) return;
  try {
    const existing = catalogGet(c);
    if (existing && existing.source === 'staff' && source !== 'staff') return; // don't downgrade
    db.prepare(`INSERT INTO product_catalog (barcode, name, brand, size, source, updated_by, updated_at)
                VALUES (?,?,?,?,?,?,datetime('now'))
                ON CONFLICT(barcode) DO UPDATE SET
                  name=excluded.name, brand=excluded.brand, size=excluded.size,
                  source=excluded.source, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(c, clean(name), clean(brand) || null, clean(size) || null, source === 'staff' ? 'staff' : 'external', userId || null);
  } catch { /* best effort — a lookup cache miss is harmless */ }
}

// Detect a weighed in-store / price-embedded item (Type-2 UPC-A begins with '2'). Its digits
// are the store's own item + price/weight, not a national GTIN — so we flag it rather than
// look it up, and surface any embedded price (cents in the last 5 digits, common layout).
function weighedInfo(code) {
  const c = digits(code);
  if (!(c.length === 12 && c[0] === '2')) return null;
  const cents = parseInt(c.slice(6, 11), 10);
  const price = Number.isFinite(cents) && cents > 0 && cents < 99999 ? cents / 100 : null;
  return { weighed: true, price };
}

// ── Public API ───────────────────────────────────────────────────────────────
// Resolve a scanned barcode to product info plus anything the label itself carries.
// Returns { found, name, brand, size, source, weighed, price, gtin, is_gs1, weight_lb,
// weight_kg, prod_date, pack_date, expiry, lot, serial }. Works for plain UPC/EAN and for
// GS1-128 case/meat labels (where the GTIN is the key and weight/date/lot are extracted).
// `userId` (optional) is recorded on any catalog write.
async function lookupProduct(rawCode, userId) {
  const p = parseScan(rawCode);
  const code = p.gtin;   // canonical numeric key (null for alphanumeric SKUs)
  const out = {
    found: false, name: null, brand: null, size: null, source: null, weighed: false, price: null,
    gtin: p.gtin, code: p.code, is_gs1: p.isGs1, weight_lb: p.weightLb, weight_kg: p.weightKg,
    prod_date: p.prodDate, pack_date: p.packDate, expiry: p.expiry, lot: p.lot, serial: p.serial,
    // Glossary fields (null until a matching glossary entry is found).
    in_glossary: false, name_vi: null, name_es: null, description: null, unit: null, category: null, notes: null,
    default_unit_cost: 0, stackable: 1, is_catch_weight: 0,
    default_vendor_id: null, default_vendor_code: null, barcode_type: null, scale_code: null,
  };
  if (p.weightLb) out.size = p.weightLb + ' lb';   // label net weight as a size hint
  // Deli-scale weigh label: resolve by the scale (LF) code against the Glossary; the label's net
  // weight pre-fills the amount. The varying barcode is not a stable key, so match by scale_code.
  if (p.scaleCode) {
    out.weighed = true; out.scale_code = p.scaleCode;
    if (p.weightLb) out.weight_lb = p.weightLb;
    const g = catalogGetByScaleCode(p.scaleCode);
    if (g && clean(g.name)) {
      return Object.assign(out, {
        found: true, name: g.name, name_vi: g.name_vi || null, name_es: g.name_es || null,
        brand: g.brand || null, size: out.size || clean(g.size),
        source: g.source || 'catalog', in_glossary: true, description: g.description || null,
        unit: g.unit || null, category: g.category || null, notes: g.notes || null,
        default_unit_cost: g.default_unit_cost || 0,
        stackable: g.stackable == null ? 1 : (g.stackable ? 1 : 0),
        is_catch_weight: g.is_catch_weight ? 1 : 0,
        default_vendor_id: g.default_vendor_id || null, default_vendor_code: g.default_vendor_code || null,
        barcode_type: g.barcode_type || null,
      });
    }
    return out;   // weighed, not yet in the Glossary — the UI prompts to add it with this scale code
  }
  if (!code) return out;

  if (!p.isGs1) { const w = weighedInfo(code); if (w) { out.weighed = true; out.price = w.price; return out; } }

  const hit = catalogGet(code);
  if (hit && clean(hit.name)) {
    return Object.assign(out, {
      found: true, name: hit.name, name_vi: hit.name_vi || null, name_es: hit.name_es || null,
      brand: hit.brand || null,
      size: clean(hit.size) || out.size, source: hit.source || 'catalog',
      in_glossary: true, description: hit.description || null, unit: hit.unit || null,
      category: hit.category || null, notes: hit.notes || null,
      default_unit_cost: hit.default_unit_cost || 0,
      stackable: hit.stackable == null ? 1 : (hit.stackable ? 1 : 0),
      is_catch_weight: hit.is_catch_weight ? 1 : 0,
      default_vendor_id: hit.default_vendor_id || null,
      default_vendor_code: hit.default_vendor_code || null,
      barcode_type: hit.barcode_type || null,
    });
  }

  // A GS1-128 label carrying a net-weight AI (e.g. 3202) is a variable-measure / catch-weight
  // case item — wholesale, never in retail catalogs. Skip the network round-trip and prompt for
  // a Glossary entry instantly instead of waiting on lookups that will always miss.
  if (p.isGs1 && p.weightLb) return out;

  const ext = await externalLookup(code);
  if (ext && clean(ext.name)) {
    catalogUpsert(code, { ...ext, userId });
    return Object.assign(out, { found: true, name: ext.name, brand: ext.brand || null, size: clean(ext.size) || out.size, source: 'external' });
  }
  return out;
}

// Remember a staff-entered name for a barcode (authoritative). Called from create/link.
// If richer glossary fields are supplied (unit/category/description/…), write the full entry
// so the next scan pre-fills everything; otherwise just cache the name/brand/size.
function rememberProduct(code, name, userId, extra = {}) {
  const rich = extra && (extra.unit || extra.category || extra.description || extra.notes ||
    extra.is_catch_weight != null || extra.stackable != null || extra.default_unit_cost != null ||
    extra.default_vendor_id || extra.default_vendor_code || extra.barcode_type);
  if (rich) { glossaryUpsert({ barcode: code, name, ...extra }, userId); return; }
  catalogUpsert(code, { name, brand: extra.brand, size: extra.size, source: 'staff', userId });
}

// ── Glossary management (manual add / edit / delete + search) ─────────────────
// The glossary is group-wide (one row per GTIN, shared by the CK and every location).
function glossaryList({ q = '', category = '', activeOnly = false, limit = 500 } = {}) {
  try {
    const conds = [], args = [];
    if (q) { const like = `%${clean(q)}%`; conds.push('(barcode LIKE ? OR name LIKE ? OR name_vi LIKE ? OR name_es LIKE ? OR brand LIKE ? OR category LIKE ? OR scale_code LIKE ?)'); args.push(like, like, like, like, like, like, like); }
    if (category) { conds.push('category=?'); args.push(category); }
    if (activeOnly) conds.push('COALESCE(active,1)=1');
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const lim = Math.max(1, Math.min(2000, parseInt(limit, 10) || 500));
    return db.prepare(`SELECT ${GLOSSARY_COLS} FROM product_catalog ${where} ORDER BY name IS NULL, name LIMIT ?`).all(...args, lim);
  } catch { return []; }
}

// Full manual/staff upsert of a glossary row (source is forced to 'staff' — authoritative).
function glossaryUpsert(fields, userId) {
  // Canonical GTIN key — the same one every scan lookup uses (leading-zero-normalized).
  const pk = parseScan(fields.barcode);
  const code = (pk.gtin || pk.code || '').toString().trim() || (digits(fields.barcode) || clean(fields.barcode));
  const name = clean(fields.name);
  if (!code) return { error: 'A GTIN / barcode is required.' };
  if (!name) return { error: 'A name is required.' };
  const existing = catalogGet(code);
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  const bool = (v, d) => (v == null || v === '' ? d : (v && v !== '0' && v !== 'false' ? 1 : 0));
  const vals = [
    code, name, clean(fields.name_vi) || null, clean(fields.name_es) || null,
    clean(fields.brand) || null, clean(fields.size) || null,
    clean(fields.description) || null, clean(fields.unit) || null, clean(fields.category) || null,
    clean(fields.notes) || null,
    num(fields.default_unit_cost, existing ? existing.default_unit_cost : 0),
    bool(fields.stackable, existing ? (existing.stackable ? 1 : 0) : 1),
    bool(fields.is_catch_weight, existing ? (existing.is_catch_weight ? 1 : 0) : 0),
    fields.default_vendor_id ? (parseInt(fields.default_vendor_id, 10) || null) : null,
    clean(fields.default_vendor_code) || null, clean(fields.barcode_type) || null,
    normScale(fields.scale_code),
    clean(fields.image_url) || null, bool(fields.active, existing ? (existing.active ? 1 : 0) : 1),
    userId || null,
  ];
  try {
    db.prepare(`INSERT INTO product_catalog
        (barcode,name,name_vi,name_es,brand,size,description,unit,category,notes,default_unit_cost,stackable,is_catch_weight,
         default_vendor_id,default_vendor_code,barcode_type,scale_code,image_url,active,source,created_by,created_at,updated_by,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'staff',?,datetime('now'),?,datetime('now'))
        ON CONFLICT(barcode) DO UPDATE SET
          name=excluded.name, name_vi=excluded.name_vi, name_es=excluded.name_es,
          brand=excluded.brand, size=excluded.size, description=excluded.description,
          unit=excluded.unit, category=excluded.category, notes=excluded.notes,
          default_unit_cost=excluded.default_unit_cost, stackable=excluded.stackable,
          is_catch_weight=excluded.is_catch_weight, default_vendor_id=excluded.default_vendor_id,
          default_vendor_code=excluded.default_vendor_code, barcode_type=excluded.barcode_type,
          scale_code=excluded.scale_code,
          image_url=excluded.image_url, active=excluded.active, source='staff',
          updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(...vals, userId || null);
    return { ok: true, barcode: code, created: !existing };
  } catch (e) { return { error: e.message }; }
}

function glossaryDelete(code) {
  try {
    const pk = parseScan(code);
    const c = (pk.gtin || pk.code || '').toString().trim() || (digits(code) || clean(code));
    const r = db.prepare(`DELETE FROM product_catalog WHERE barcode=?`).run(c);
    return { ok: r.changes > 0 };
  } catch (e) { return { error: e.message }; }
}

module.exports = { lookupProduct, rememberProduct, catalogGet, catalogGetByScaleCode, glossaryList, glossaryUpsert, glossaryDelete };
