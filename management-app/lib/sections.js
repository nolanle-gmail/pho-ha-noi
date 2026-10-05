// Storage sections (shelves) helpers, shared by the console (routes/inventory.js) and the smart
// scan-receive core (lib/receive.js) so a shelf typed on the scan "add item" form is resolved /
// created the same way as in the item editor. Items point at a section via inventory.section_id.
const db = require('../db/database');

// A section id is valid only if it exists at this location and is active. → id|null.
function validSection(locId, sid) {
  if (sid == null || sid === '') return null;
  const s = db.prepare(`SELECT id FROM storage_sections WHERE id=? AND location_id=? AND is_active=1`).get(parseInt(sid, 10) || 0, locId);
  return s ? s.id : null;
}
// Resolve a section for an item: a typed `section_name` is matched (case-insensitive) or CREATED
// on the fly (so staff can add a shelf just by naming it); otherwise fall back to section_id. → id|null.
function resolveSection(locId, body) {
  const nm = (body.section_name == null ? '' : String(body.section_name)).trim().slice(0, 60);
  if (nm) {
    const s = db.prepare(`SELECT id, is_active FROM storage_sections WHERE location_id=? AND name=? COLLATE NOCASE`).get(locId, nm);
    if (s) { if (!s.is_active) db.prepare(`UPDATE storage_sections SET is_active=1 WHERE id=?`).run(s.id); return s.id; }
    const sort = ((db.prepare(`SELECT MAX(sort_order) m FROM storage_sections WHERE location_id=?`).get(locId) || {}).m || 0) + 1;
    return db.prepare(`INSERT INTO storage_sections (location_id, name, sort_order) VALUES (?,?,?)`).run(locId, nm, sort).lastInsertRowid;
  }
  return validSection(locId, body.section_id);
}

module.exports = { validSection, resolveSection };
