// Tell the Waitlist app that a guest was seated here, so they drop off the waitlist board.
// The waitlist lives in the Waitlist app's own DB; a seat on this (Management) side — the floor
// plan or the visit lifecycle — can't touch it directly, so when a seat carries the party's
// `waitlist_ref` (the waitlist row id) we notify the Waitlist app over the shared service key.
//
// Best-effort by design: fire-and-forget, never throws, never blocks or fails the seat. If the
// Waitlist app is briefly unreachable the guest simply ages off the board on the next refresh.
const WL_URL = (process.env.WAITLIST_URL || 'https://pho-ha-noi-waitlist.fly.dev').replace(/\/+$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

function markWaitlistSeated(ref, tableLabel) {
  if (ref == null || ref === '') return;
  try {
    fetch(`${WL_URL}/api/wl-feed/seat/${encodeURIComponent(ref)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: JSON.stringify(tableLabel ? { table_number: String(tableLabel) } : {}),
    }).catch(() => { /* waitlist app unreachable — board self-heals on refresh */ });
  } catch { /* never let a sync attempt break seating */ }
}

// For a seat that carries NO waitlist_ref (a host tapping an open table, or the console Floor Plan
// seat): match a still-'waiting' party by exact name + location on the Waitlist app and drop them off
// the board. Same best-effort contract. A blank name is a no-op (so a nameless walk-in never matches).
function markWaitlistSeatedByName(locationId, guestName, tableLabel) {
  const name = (guestName || '').toString().trim();
  if (!locationId || !name) return;
  try {
    fetch(`${WL_URL}/api/wl-feed/seat-match`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: JSON.stringify({ location_id: locationId, guest_name: name, table_number: tableLabel ? String(tableLabel) : undefined }),
    }).catch(() => { /* waitlist app unreachable — board self-heals on refresh */ });
  } catch { /* never let a sync attempt break seating */ }
}

module.exports = { markWaitlistSeated, markWaitlistSeatedByName };
