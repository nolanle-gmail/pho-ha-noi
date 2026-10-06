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

module.exports = { markWaitlistSeated };
