// Barcode parsing — turns whatever a scanner decodes into a clean, stable product key
// plus any extra data the label carries.
//
// Handles:
//   • Plain retail codes — UPC-A (12), UPC-E, EAN-8/13 → the digits (leading zeros trimmed
//     to one canonical form so 0602569000493 and 602569000493 match).
//   • GS1-128 / GS1 DataMatrix (case & meat labels) — an "Application Identifier" payload
//     like (01)96063000120625(3202)004294(11)260818(21)160000078798. We extract the GTIN
//     (01) as the stable barcode, and pull net weight (310x/320x), production/pack/expiry
//     dates (11/13/15/17) and lot (10) / serial (21). The serial varies per case, so it is
//     NEVER used as the item's barcode — only the GTIN is.
//   • Alphanumeric codes (Code 39/128 SKUs) — kept verbatim.

// A GS1 YYMMDD date → ISO. YY 00–50 ⇒ 2000–2050, 51–99 ⇒ 1951–1999 (GS1 rule). DD 00 ⇒ 01.
function gs1Date(v) {
  if (!/^\d{6}$/.test(v)) return null;
  const yy = parseInt(v.slice(0, 2), 10);
  const yyyy = yy <= 50 ? 2000 + yy : 1900 + yy;
  const mm = v.slice(2, 4); let dd = v.slice(4, 6);
  if (dd === '00') dd = '01';
  if (+mm < 1 || +mm > 12 || +dd < 1 || +dd > 31) return null;
  return `${yyyy}-${mm}-${dd}`;
}
// Canonical GTIN/UPC key: digits only, drop leading zeros (padding). A real GTIN-14 that
// starts with a non-zero packaging indicator (e.g. a meat case) is left intact.
function normGtin(d) {
  const t = String(d == null ? '' : d).replace(/\D/g, '').replace(/^0+/, '');
  return t || null;
}

function parseScan(raw) {
  const s0 = String(raw == null ? '' : raw).trim();
  // Strip a leading AIM symbology identifier the scanner may prepend (e.g. "]C1", "]d2", "]e0").
  const s = s0.replace(/^\][A-Za-z0-9][0-9A-Za-z]/, '');
  const GS = String.fromCharCode(29);   // FNC1 group separator
  const res = { raw: s, isGs1: false, code: null, gtin: null, lot: null, serial: null, prodDate: null, packDate: null, expiry: null, weightLb: null, weightKg: null, ais: null };

  const looksGs1 = /\(\d{2,4}\)/.test(s) || s.indexOf(GS) >= 0 || /^01\d{14}/.test(s) || /^00\d{18}/.test(s) || /^02\d{14}/.test(s);
  if (!looksGs1) {
    const digitsOnly = /^[0-9\s-]+$/.test(s) && /\d/.test(s);
    res.code = digitsOnly ? s.replace(/\D/g, '') : s;
    res.gtin = digitsOnly ? normGtin(res.code) : null;
    if (res.gtin) res.code = res.gtin;   // canonical key for retail codes
    return res;
  }

  res.isGs1 = true;
  const ais = {};
  if (s.indexOf('(') >= 0) {
    // Human-readable / parenthesised form: (01)...(3202)...(11)...
    const re = /\((\d{2,4})\)([^(]*)/g; let m;
    while ((m = re.exec(s))) ais[m[1]] = m[2].split(GS).join('');
  } else {
    // Raw concatenated form: walk it using AI length rules.
    const FIXED = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };
    const VAR = new Set(['10', '21', '22', '240', '241', '250', '251', '30', '37', '90', '91', '92', '93', '94', '95', '96', '97', '98', '99', '400', '401', '410', '420', '421']);
    const isMeasure = (a) => /^3[0-9]\d\d$/.test(a);   // 4-digit measurement AIs → 6-digit value
    let i = 0, guard = 0;
    while (i < s.length && guard++ < 64) {
      let ai = null, al = 0;
      if (isMeasure(s.substr(i, 4))) { ai = s.substr(i, 4); al = 4; }
      else for (const L of [2, 3, 4]) { const c = s.substr(i, L); if (FIXED[c] !== undefined || VAR.has(c)) { ai = c; al = L; break; } }
      if (!ai) break;
      i += al;
      let vlen;
      if (FIXED[ai] !== undefined) vlen = FIXED[ai];
      else if (isMeasure(ai)) vlen = 6;
      else { const g = s.indexOf(GS, i); vlen = (g < 0 ? s.length : g) - i; }
      ais[ai] = s.substr(i, vlen); i += vlen;
      if (s[i] === GS) i++;
    }
  }

  res.gtin = normGtin(ais['01'] || ais['02']);
  res.code = res.gtin || res.code;
  if (ais['10']) res.lot = ais['10'].trim() || null;
  if (ais['21']) res.serial = ais['21'].trim() || null;
  if (ais['11']) res.prodDate = gs1Date(ais['11']);
  if (ais['13']) res.packDate = gs1Date(ais['13']);
  if (ais['17']) res.expiry = gs1Date(ais['17']);
  if (!res.expiry && ais['15']) res.expiry = gs1Date(ais['15']);   // best-before as a fallback
  for (const a of Object.keys(ais)) {
    const val = parseInt(ais[a], 10);
    if (/^320\d$/.test(a) && Number.isFinite(val)) res.weightLb = +(val / Math.pow(10, +a[3])).toFixed(+a[3]);
    if (/^310\d$/.test(a) && Number.isFinite(val)) res.weightKg = +(val / Math.pow(10, +a[3])).toFixed(+a[3]);
  }
  if (res.weightLb == null && res.weightKg != null) res.weightLb = +(res.weightKg * 2.20462).toFixed(2);
  if (res.weightKg == null && res.weightLb != null) res.weightKg = +(res.weightLb / 2.20462).toFixed(2);
  res.ais = Object.keys(ais).length ? ais : null;   // every Application Identifier found, verbatim
  return res;
}

// Persist a scan's full detail (GS1 weight/dates/lot/serial + every AI) against an item, so
// the information a box carried is kept for later. Best-effort — never throws into a scan.
let _db = null;
function db() { if (!_db) _db = require('../db/database'); return _db; }
function logScan({ itemId, locationId, action, parsed, quantity, userId }) {
  try {
    const p = parsed || {};
    // Only worth recording when the code carried extra data or it's a stock movement.
    if (!p.isGs1 && p.weightLb == null && !p.lot && !p.serial && !p.expiry && !p.prodDate && !p.packDate && quantity == null) return;
    db().prepare(`INSERT INTO scan_events (item_id, location_id, action, gtin, quantity, weight_lb, weight_kg, prod_date, pack_date, expiry, lot, serial, ais, raw, user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      itemId || null, locationId || null, action || null, p.gtin || null,
      quantity == null ? null : (Number(quantity) || 0),
      p.weightLb == null ? null : p.weightLb, p.weightKg == null ? null : p.weightKg,
      p.prodDate || null, p.packDate || null, p.expiry || null, p.lot || null, p.serial || null,
      p.ais ? JSON.stringify(p.ais) : null, p.raw || null, userId || null);
  } catch { /* best-effort */ }
}

// Detect a likely duplicate scan so the same box isn't received/shipped twice.
//  • GS1 serial (21) present → the SAME physical box: if that exact gtin+serial was already
//    recorded for one of `actions` in the last `serialDays`, it's a strong duplicate.
//  • No serial → guard accidental rapid re-scans: same item+action(+qty) within `windowSec`.
// Returns { dup:true, kind:'serial'|'rapid', at } or { dup:false }.
// windowSec is short by design: a plain UPC has no way to tell two real boxes apart, so we
// only guard a genuine accidental double-scan (a few seconds), not deliberate repeat receiving
// (you buy the same item many times — that always just adds to the count). A GS1 serial is the
// precise signal and is checked over serialDays regardless.
function recentDuplicate({ itemId, gtin, serial, actions = ['receive'], quantity = null, windowSec = 10, serialDays = 14 }) {
  try {
    const acts = actions && actions.length ? actions : ['receive'];
    const inC = acts.map(() => '?').join(',');
    // A GS1 serial uniquely identifies the physical box: if there is one, it is the ONLY
    // signal we trust. A new serial = a genuinely different box, so we never fall through to
    // the time heuristic (which would wrongly flag a real second box of the same weight).
    if (serial && gtin) {
      const s = db().prepare(`SELECT action, created_at FROM scan_events WHERE gtin=? AND serial=? AND action IN (${inC}) AND created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 1`).get(gtin, serial, ...acts, `-${serialDays} days`);
      return s ? { dup: true, kind: 'serial', action: s.action, at: s.created_at } : { dup: false };
    }
    if (itemId) {
      let sql = `SELECT created_at FROM scan_events WHERE item_id=? AND action IN (${inC}) AND created_at >= datetime('now', ?)`;
      const args = [itemId, ...acts, `-${Math.max(1, Math.round(windowSec))} seconds`];
      if (quantity != null) { sql += ` AND quantity=?`; args.push(Number(quantity)); }
      sql += ` ORDER BY id DESC LIMIT 1`;
      const r = db().prepare(sql).get(...args);
      if (r) return { dup: true, kind: 'rapid', at: r.created_at };
    }
  } catch { /* best-effort */ }
  return { dup: false };
}

// Friendly confirm text for a detected duplicate.
function dupMessage(d, action, itemName, serial) {
  const verb = action === 'ship' ? 'shipped' : 'received';
  const again = action === 'ship' ? 'Ship it again anyway?' : 'Receive it again anyway?';
  if (d.kind === 'serial') return `⚠ This exact box${serial ? ` (serial ${serial})` : ''} of ${itemName} was already ${verb}. ${again}`;
  return `⚠ You just ${verb} ${itemName} moments ago — this may be a double scan. ${again}`;
}

module.exports = { parseScan, normGtin, gs1Date, logScan, recentDuplicate, dupMessage };
