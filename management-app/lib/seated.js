// Clear a host-seated party that left before ordering: cancel the service_visit and free its
// floor table (so the table drops off the Service Flow "Seated" list and shows available again,
// not busy). Shared by the console, /sflow kiosk and staff-app Service Flow boards.
const db = require('../db/database');
const nowISO = () => new Date().toISOString();

// Location of an active (still-seated) visit — used by the endpoints for authorization.
function seatedVisitLocation(visitId) {
  const v = db.prepare(`SELECT location_id FROM service_visits WHERE id=? AND stage='seated'`).get(parseInt(visitId, 10));
  return v ? v.location_id : null;
}

function clearSeatedVisit(visitId, actor) {
  const v = db.prepare(`SELECT id, location_id, table_id FROM service_visits WHERE id=? AND stage='seated'`).get(parseInt(visitId, 10));
  if (!v) return { ok: false, code: 404, error: 'That seating was already cleared or the guest has an order.' };
  let label = null;
  if (v.table_id) { const t = db.prepare(`SELECT label FROM restaurant_tables WHERE id=?`).get(v.table_id); label = t && t.label; }
  db.prepare(`UPDATE service_visits SET stage='canceled', done_at=? WHERE id=?`).run(nowISO(), v.id);
  try {
    db.prepare(`INSERT INTO visit_events (visit_id, location_id, event, from_stage, to_stage, actor_name, actor_role, detail)
      VALUES (?,?,?,?,?,?,?,?)`).run(v.id, v.location_id, 'left_before_order', 'seated', 'canceled',
      (actor && actor.name) || 'Service Flow', (actor && actor.role) || 'service', JSON.stringify({ reason: 'guest left before ordering' }));
  } catch { /* visit_events optional */ }
  if (v.table_id) db.prepare(`UPDATE restaurant_tables SET status='available', guest_name=NULL, party_size=NULL, seated_at=NULL, est_free_at=NULL WHERE id=?`).run(v.table_id);
  try { require('./events').emitVisits(v.location_id); } catch { /* live push best-effort */ }
  return { ok: true, location_id: v.location_id, table_name: label };
}

module.exports = { clearSeatedVisit, seatedVisitLocation };
