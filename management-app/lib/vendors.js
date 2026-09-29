// Vendor resolution for the scan form — pick an existing supplier or quick-add a new one.
const db = require('../db/database');

// Find an active vendor by name at a location, else create a lightweight store-level vendor.
function findOrCreateVendor(locationId, name) {
  const n = String(name || '').trim();
  if (!locationId || !n) return null;
  const hit = db.prepare(`SELECT id FROM vendors WHERE location_id=? AND lower(name)=lower(?) AND is_active=1`).get(locationId, n);
  if (hit) return hit.id;
  try { return db.prepare(`INSERT INTO vendors (name, location_id) VALUES (?,?)`).run(n, locationId).lastInsertRowid; }
  catch { return null; }
}

// Resolve a vendor id from { vendor_id } (must belong to the location) or { vendor_name }.
function resolveVendor(locationId, body = {}) {
  if (body.vendor_id) {
    const v = db.prepare(`SELECT id FROM vendors WHERE id=? AND location_id=? AND is_active=1`).get(body.vendor_id, locationId);
    if (v) return v.id;
  }
  if (body.vendor_name) return findOrCreateVendor(locationId, body.vendor_name);
  return null;
}

module.exports = { findOrCreateVendor, resolveVendor };
