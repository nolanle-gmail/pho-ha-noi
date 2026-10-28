// Waitlist watchdog: guests often leave without staff clearing them, so a party can sit on the waitlist
// for ages. Every few minutes this reads the live waitlist (from the Waitlist app over the shared service
// key) and AUTO-MARKS a party 'left' when they've clearly walked off:
//   • weekday: waited MORE THAN WEEKDAY_MIN (35 min)     • weekend: waited MORE THAN WEEKEND_MIN (45 min)
//   • OR, any day, when the restaurant has at least AVAIL_PCT (30%) of its tables free AND they've waited
//     AVAIL_WAIT_MIN (30 min) — plenty of seating is open but they're still waiting ⇒ they're gone.
// It then sends Nha Le (the fulfilment contact) a single APP message listing who was cleared (no SMS).
const db = require('./../db/database');
const { notify } = require('../routes/messages');
const { DEFAULT_TZ } = require('../lib/tz');

const WL_URL = (process.env.WAITLIST_URL || 'https://pho-ha-noi-waitlist.fly.dev').replace(/\/+$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';
const WEEKDAY_MIN = parseInt(process.env.WAITLIST_LEAVE_WEEKDAY_MIN || '', 10) || 35;
const WEEKEND_MIN = parseInt(process.env.WAITLIST_LEAVE_WEEKEND_MIN || '', 10) || 45;
const AVAIL_PCT = parseInt(process.env.WAITLIST_LEAVE_AVAIL_PCT || '', 10) || 30;
const AVAIL_WAIT_MIN = parseInt(process.env.WAITLIST_LEAVE_AVAIL_WAIT_MIN || '', 10) || 30;

function nhaLe() { return db.prepare(`SELECT id, name FROM users WHERE is_active=1 AND name LIKE 'Nha Le%' ORDER BY id LIMIT 1`).get(); }
function sysSender() { const u = db.prepare(`SELECT id FROM users WHERE role IN ('owner','admin','ceo','president','hr') AND is_active=1 ORDER BY id LIMIT 1`).get(); return u && u.id; }
const shortLoc = (s) => String(s || '').replace('Pho Ha Noi — ', '');
const waitedMin = (createdAt, now) => Math.round((now - new Date(createdAt).getTime()) / 60000);
const locTz = (locId) => (db.prepare(`SELECT timezone FROM locations WHERE id=?`).get(locId) || {}).timezone || DEFAULT_TZ;

// Is it the weekend (Sat/Sun) at this location right now?
function isWeekend(locId, now) {
  try { const wd = new Intl.DateTimeFormat('en-US', { timeZone: locTz(locId), weekday: 'short' }).format(new Date(now)); return wd === 'Sat' || wd === 'Sun'; }
  catch { return false; }
}
// Percentage of this location's tables that are free right now (0 when there's no floor data). Reuses
// the same live floor picture as the Floor Plan / TV board; read-only (reconcile:false).
function availabilityPct(locId) {
  try {
    const f = require('../routes/floorplan').buildFloorplan(locId, { reconcile: false });
    const total = (f.summary && f.summary.tables) || 0;
    return total > 0 ? Math.round(((f.summary.available || 0) / total) * 100) : 0;
  } catch { return 0; }
}

// Decide which waiting parties should be auto-marked 'left'. Pure given the injected helpers
// (`weekendFor`/`availabilityFor`) so it's unit-testable without the Waitlist app or a floor plan.
// Returns [{ id, location_id, location_name, guest_name, party_size, waited, reason }].
function evaluateParties(parties, opts = {}) {
  const now = opts.nowMs || Date.now();
  const weekendFor = opts.weekendFor || ((locId) => isWeekend(locId, now));
  const availFor = opts.availabilityFor || availabilityPct;
  const weekendCache = {}, availCache = {}, out = [];
  for (const p of (parties || [])) {
    if (!p || !p.created_at) continue;
    const waited = waitedMin(p.created_at, now);
    const loc = p.location_id;
    if (!(loc in weekendCache)) weekendCache[loc] = !!weekendFor(loc);
    if (!(loc in availCache)) availCache[loc] = availFor(loc);
    const weekend = weekendCache[loc], avail = availCache[loc];
    let reason = null;
    if (avail >= AVAIL_PCT && waited >= AVAIL_WAIT_MIN) reason = `${avail}% tables free & waited ${waited} min`;
    else if (weekend && waited > WEEKEND_MIN) reason = `weekend — waited ${waited} min`;
    else if (!weekend && waited > WEEKDAY_MIN) reason = `weekday — waited ${waited} min`;
    if (reason) out.push({ id: p.id, location_id: loc, location_name: p.location_name, guest_name: p.guest_name, party_size: p.party_size, waited, reason });
  }
  return out;
}

// App-message Nha Le about the parties that were cleared (NO SMS — owner's request 2026-10-27).
function notifyNhaLe(cleared) {
  if (!cleared || !cleared.length) return { notified: 0 };
  const nha = nhaLe(), sender = sysSender();
  if (!nha || !sender) return { notified: 0 };
  const byLoc = {};
  for (const c of cleared) { const k = shortLoc(c.location_name) || ('Location ' + c.location_id); (byLoc[k] = byLoc[k] || []).push(c); }
  const lines = Object.entries(byLoc).map(([loc, cs]) => `${loc}: ${cs.map(c => `${c.guest_name || 'Guest'} (${c.waited}m${c.party_size ? ', ' + c.party_size + 'p' : ''}) — ${c.reason}`).join('; ')}`);
  const body = `Auto-cleared ${cleared.length} guest${cleared.length === 1 ? '' : 's'} from the waitlist (likely no-shows):\n${lines.join('\n')}`;
  try { notify(sender, nha.id, 'Waitlist: guests auto-cleared', body); } catch { /* best-effort */ }
  return { notified: cleared.length };
}

// Ask the Waitlist app to mark one party 'left' (service-key, server-to-server). Returns true on success.
async function markLeft(id, reason) {
  try {
    const r = await fetch(`${WL_URL}/api/wl-feed/left/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: JSON.stringify({ reason }),
    });
    return r.ok;
  } catch { return false; }
}

async function sweepWaitlist() {
  let parties = [];
  try {
    const r = await fetch(`${WL_URL}/api/wl-feed/active`, { headers: { 'X-Service-Key': KEY } });
    if (!r.ok) return { error: r.status };
    parties = (await r.json()).parties || [];
  } catch (e) { return { error: e.message }; }
  const decided = evaluateParties(parties);
  const cleared = [];
  for (const d of decided) { if (await markLeft(d.id, d.reason)) cleared.push(d); }   // only notify about ones we actually cleared
  const n = notifyNhaLe(cleared);
  return { evaluated: parties.length, cleared: cleared.length, notified: n.notified };
}

function startWaitlistMonitor() {
  const run = () => sweepWaitlist().catch((e) => console.error('[waitlist-monitor]', e.message));
  run();
  const t = setInterval(run, 5 * 60 * 1000);   // every 5 min
  if (t.unref) t.unref();
  return t;
}

module.exports = { evaluateParties, notifyNhaLe, markLeft, sweepWaitlist, startWaitlistMonitor, WEEKDAY_MIN, WEEKEND_MIN, AVAIL_PCT, AVAIL_WAIT_MIN };
