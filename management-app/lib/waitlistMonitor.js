// Waitlist watchdog: guests sometimes leave without staff clearing them, so a party can sit on the
// waitlist for ages. Every few minutes this reads the live waitlist (from the Waitlist app over the
// shared service key) and, for any party "waiting" longer than the threshold, sends Nha Le (the
// fulfilment contact) an app message AND a text so a person checks and clears them. Each guest is
// alerted once (waitlist_over30_alerts dedupe) — we notify, we never auto-remove a guest.
const db = require('./../db/database');
const { notify } = require('../routes/messages');
const { sendSms, smsEnabled } = require('./sms');

const WL_URL = (process.env.WAITLIST_URL || 'https://pho-ha-noi-waitlist.fly.dev').replace(/\/+$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';
const OVER_MIN = parseInt(process.env.WAITLIST_OVER_MIN || '', 10) || 30;

function nhaLe() { return db.prepare(`SELECT id, name, phone FROM users WHERE is_active=1 AND name LIKE 'Nha Le%' ORDER BY id LIMIT 1`).get(); }
function sysSender() { const u = db.prepare(`SELECT id FROM users WHERE role IN ('owner','admin','ceo','president','hr') AND is_active=1 ORDER BY id LIMIT 1`).get(); return u && u.id; }
const shortLoc = (s) => String(s || '').replace('Pho Ha Noi — ', '');
const waitedMin = (createdAt, now) => Math.round((now - new Date(createdAt).getTime()) / 60000);

// Alert Nha Le about parties waiting over the limit, once each. Pure (takes the party list) so it's
// testable without the Waitlist app. Returns a small summary.
function alertForParties(parties, opts = {}) {
  const now = opts.nowMs || Date.now();
  const stale = (parties || []).filter(p => p && p.created_at && waitedMin(p.created_at, now) >= OVER_MIN);
  if (!stale.length) return { stale: 0, alerted: 0 };
  const ins = db.prepare(`INSERT OR IGNORE INTO waitlist_over30_alerts (wl_entry_id, location_id) VALUES (?,?)`);
  const fresh = stale.filter(p => ins.run(p.id, p.location_id || null).changes > 0);   // each guest once
  if (!fresh.length) return { stale: stale.length, alerted: 0 };
  const nha = nhaLe(), sender = sysSender();
  if (nha && sender) {
    const byLoc = {};
    for (const p of fresh) { const k = shortLoc(p.location_name) || ('Location ' + p.location_id); (byLoc[k] = byLoc[k] || []).push(p); }
    const locs = Object.entries(byLoc);
    const lines = locs.map(([loc, ps]) => `${loc}: ${ps.map(p => `${p.guest_name || 'Guest'} (${waitedMin(p.created_at, now)}m${p.party_size ? ', ' + p.party_size + 'p' : ''})`).join(', ')}`);
    const appBody = `${fresh.length} guest${fresh.length === 1 ? ' has' : 's have'} been waiting over ${OVER_MIN} minutes — please check if they left and clear them from the waitlist:\n${lines.join('\n')}`;
    try { notify(sender, nha.id, 'Waitlist: guests waiting over 30 min', appBody); } catch { /* best-effort */ }
    let sms = `PHN waitlist: ${fresh.length} guest${fresh.length === 1 ? '' : 's'} waiting >${OVER_MIN} min (${locs.map(([l, ps]) => `${l} ${ps.length}`).join(', ')}). Please check & clear.`;
    if (sms.length > 140) sms = sms.slice(0, 139) + '…';
    if (smsEnabled() && nha.phone) { try { sendSms(nha.phone, sms).catch(() => {}); } catch { /* */ } }
  }
  try { db.prepare(`DELETE FROM waitlist_over30_alerts WHERE alerted_at < datetime('now','-7 days')`).run(); } catch { /* tidy */ }
  return { stale: stale.length, alerted: fresh.length };
}

async function sweepWaitlistOver30() {
  let parties = [];
  try {
    const r = await fetch(`${WL_URL}/api/wl-feed/active`, { headers: { 'X-Service-Key': KEY } });
    if (!r.ok) return { error: r.status };
    parties = (await r.json()).parties || [];
  } catch (e) { return { error: e.message }; }
  return alertForParties(parties);
}

function startWaitlistMonitor() {
  const run = () => sweepWaitlistOver30().catch((e) => console.error('[waitlist-monitor]', e.message));
  run();
  const t = setInterval(run, 5 * 60 * 1000);   // every 5 min; threshold is 30, so this is plenty
  if (t.unref) t.unref();
  return t;
}

module.exports = { alertForParties, sweepWaitlistOver30, startWaitlistMonitor, OVER_MIN };
