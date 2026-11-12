// Public, no-login endpoints for the customer self-check-in kiosk / QR page.
// A guest can see the current wait, add themselves to the list, and track their
// spot by a short reference code — all without a staff account. Front-desk entry
// is handled by the authenticated /api/waitlist routes.
const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { rateLimit } = require('../lib/rateLimit');
const { notifyGuest } = require('../lib/guest-notify');

const router = express.Router();
const genRef = () => crypto.randomBytes(4).toString('hex'); // 8-char code

// ── Abuse protection (public, unauthenticated surface) ───────────────────────
// A generous backstop across all public reads/writes, plus a stricter cap on the
// only mutating endpoint (check-in). Tunable per deployment via env so a busy
// shared-WiFi lobby can be loosened, or a QR-per-phone rollout tightened.
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
router.use(rateLimit({ windowMs: 5 * 60000, max: num(process.env.PUBLIC_MAX, 600) }));
const checkinLimiter = rateLimit({
  windowMs: num(process.env.CHECKIN_WINDOW_MS, 10 * 60000),
  max: num(process.env.CHECKIN_MAX, 20),
  key: (req) => 'checkin|' + (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'),
  message: 'You have added several parties recently. Please ask the host if you need another.',
  // A host-operated front-desk board adds many parties from one tablet, so exempt board joins from the
  // strict per-guest cap (they're still covered by the generic public limiter above).
  skip: (req) => !!(req.body && req.body.board),
});

// Current wait at a location: parties ahead × the location's average turn time.
function statusFor(locId) {
  const location = db.prepare(`SELECT avg_turn_minutes FROM locations WHERE id=?`).get(locId);
  const ahead = db.prepare(`SELECT COUNT(*) c FROM waitlist WHERE location_id=? AND status='waiting'`).get(locId).c;
  return { parties_ahead: ahead, quoted_minutes: ahead * (location ? location.avg_turn_minutes : 3) };
}

// A URL-friendly slug from a location name ("Pho Ha Noi — Berkeley" → "berkeley").
const slugify = (name) => String(name || '').replace(/^pho ha noi\s*[—-]\s*/i, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Locations to pick from (for the kiosk dropdown / QR landing). Each carries a
// slug so a store can use a clean per-location URL like /checkin/berkeley.
router.get('/locations', (req, res) => {
  const rows = db.prepare(`SELECT id, name FROM locations WHERE is_active=1 ORDER BY name`).all();
  res.json(rows.map(l => ({ ...l, slug: slugify(l.name) })));
});

// Live wait for a location.
router.get('/status', (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  const loc = db.prepare(`SELECT id, name FROM locations WHERE id=? AND is_active=1`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  res.json({ location: loc, ...statusFor(locId) });
});

// Public "current waitlist" for a location (by slug) — the parties waiting, in order,
// so a guest can find their own name and see who's ahead. Names only (first + last
// initial), party size and how long they've waited; never phone numbers.
router.get('/waitlist/:slug', (req, res) => {
  // Case/hyphen-insensitive so /checkin/fountainvalley/current and /fountain-valley/current both work.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const slug = norm(req.params.slug);
  const loc = db.prepare(`SELECT id, name, avg_turn_minutes FROM locations WHERE is_active=1`).all()
    .find(l => norm(slugify(l.name)) === slug);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const rows = db.prepare(`SELECT guest_name, party_size,
      CAST((julianday('now') - julianday(created_at)) * 1440 AS INTEGER) AS waited_min
    FROM waitlist WHERE location_id=? AND status='waiting' ORDER BY created_at ASC, id ASC`).all(loc.id);
  const parties = rows.map((w, i) => {
    const parts = String(w.guest_name || '').trim().split(/\s+/).filter(Boolean);
    const first = parts[0] || 'Guest';
    const lastInit = parts.length > 1 && parts[parts.length - 1][0] ? ` ${parts[parts.length - 1][0].toUpperCase()}.` : '';
    return { position: i + 1, name: first + lastInit, party_size: w.party_size, waiting_min: Math.max(0, w.waited_min || 0) };
  });
  res.json({ location: { name: loc.name, slug }, count: parties.length,
    quoted_minutes: parties.length * (loc.avg_turn_minutes || 3), parties });
});

// Customer adds themselves to the waitlist.
router.post('/checkin', checkinLimiter, (req, res) => {
  const locId = parseInt(req.body.location_id, 10);
  const loc = locId && db.prepare(`SELECT id, name FROM locations WHERE id=? AND is_active=1`).get(locId);
  if (!loc) return res.status(400).json({ error: 'Please choose a valid location.' });
  const name = (req.body.guest_name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  const size = Math.max(1, Math.min(50, parseInt(req.body.party_size, 10) || 2));
  const phone = (req.body.phone || '').toString().trim().slice(0, 40) || null;
  // Front-desk BOARD joins skip the join confirmation text (the guest watches the board) and make the
  // mobile number OPTIONAL. A regular self check-in still REQUIRES a number so we can text them.
  const board = !!(req.body && req.body.board);
  if (!board && (!phone || (phone.match(/\d/g) || []).length < 10)) return res.status(400).json({ error: 'A valid mobile number is required.' });
  if (board && phone && (phone.match(/\d/g) || []).length < 10) return res.status(400).json({ error: 'That mobile number doesn’t look right — leave it blank or fix it.' });
  // A provided number is the opt-in to table-status texts; no number → we can't text (host calls them).
  const smsConsent = phone ? 1 : 0;
  const notes = (req.body.notes || '').toString().trim().slice(0, 300) || null; // special requests
  // Duplicate-submit guard: if an identical party is already waiting here (double
  // tap, page reload, back button), return that entry instead of a second one.
  const dupe = db.prepare(`SELECT public_ref, quoted_minutes FROM waitlist
    WHERE location_id=? AND status='waiting' AND source='self'
      AND lower(trim(guest_name))=lower(?) AND IFNULL(phone,'')=IFNULL(?, '')
      AND created_at >= datetime('now','-30 minutes') ORDER BY id DESC LIMIT 1`).get(locId, name, phone);
  if (dupe) {
    const ahead = db.prepare(`SELECT COUNT(*) c FROM waitlist w WHERE location_id=? AND status='waiting'
      AND created_at < (SELECT created_at FROM waitlist WHERE public_ref=?)`).get(locId, dupe.public_ref).c;
    return res.json({ success: true, ref: dupe.public_ref, position: ahead + 1, quoted_minutes: dupe.quoted_minutes,
      guest_name: name, party_size: size, location: loc.name, duplicate: true });
  }
  const s = statusFor(locId);
  const ref = genRef();
  const r = db.prepare(`INSERT INTO waitlist (location_id, guest_name, party_size, phone, notes, quoted_minutes, source, public_ref, sms_consent, consent_at)
    VALUES (?,?,?,?,?,?, 'self', ?,?,?)`).run(locId, name.slice(0, 120), size, phone, notes, s.quoted_minutes, ref, smsConsent, smsConsent ? new Date().toISOString() : null);
  // Audit as a self check-in (no staff user).
  try {
    db.prepare(`INSERT INTO audit_log (user_id, location_id, action, entity, entity_id, detail) VALUES (NULL,?,?,?,?,?)`)
      .run(locId, 'party_added', 'waitlist', r.lastInsertRowid, JSON.stringify({ guest: name.slice(0, 120), party_size: size, source: 'self' }));
  } catch { /* audit is best-effort */ }
  try { require('../lib/events').emitWaitlist(locId); } catch { /* live-push best-effort */ }
  // Text the guest a join confirmation with their spot + a link to the live waitlist — only if they opted
  // in AND this isn't a board join (board guests watch their name on the screen, so no join text).
  if (!board && phone && smsConsent) {
    const pos = s.parties_ahead + 1;
    const wait = s.quoted_minutes > 0 ? `about ${s.quoted_minutes} min` : 'a short wait';
    const base = (process.env.WAITLIST_PUBLIC_URL || ('https://' + (req.get('host') || 'pho-ha-noi-waitlist.fly.dev'))).replace(/\/+$/, '');
    const listUrl = `${base}/checkin/${slugify(loc.name)}/current`;
    notifyGuest(r.lastInsertRowid, phone, `Hi ${name}, you're #${pos} on the ${loc.name} waitlist (party of ${size}), ${wait}. We'll text when your table is ready. Your spot: ${listUrl} Reply STOP to opt out.`, 'joined');
  }
  res.json({
    success: true, ref, position: s.parties_ahead + 1, quoted_minutes: s.quoted_minutes,
    guest_name: name, party_size: size, location: loc.name,
  });
});

// A guest tracks their own spot by reference code.
router.get('/position/:ref', (req, res) => {
  const w = db.prepare(`SELECT * FROM waitlist WHERE public_ref=?`).get(req.params.ref);
  if (!w) return res.status(404).json({ error: 'We could not find that check-in.' });
  const location = db.prepare(`SELECT name, avg_turn_minutes FROM locations WHERE id=?`).get(w.location_id);
  let position = null;
  if (w.status === 'waiting') {
    position = db.prepare(`SELECT COUNT(*) c FROM waitlist WHERE location_id=? AND status='waiting' AND created_at <= ?`)
      .get(w.location_id, w.created_at).c;
  }
  res.json({
    status: w.status, guest_name: w.guest_name, party_size: w.party_size,
    position, notified: !!w.notified_at, table_number: w.table_number,
    quoted_minutes: position != null ? Math.max(0, position - 1) * (location ? location.avg_turn_minutes : 3) : 0,
    location: location ? location.name : '',
  });
});

// ── Front-desk BOARD (/checkin/<slug>/board) ─────────────────────────────────
// A shared host-stand screen: guests watch who's ahead, staff run the list. The list carries the FULL
// guest name + party size (never the phone). Staff actions go through /board-action, gated by an
// employee code so a passer-by can't tap one by accident.
const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/+$/, '');
const SVC_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const locBySlug = (slug) => db.prepare(`SELECT id, name, avg_turn_minutes FROM locations WHERE is_active=1`).all()
  .find(l => norm(slugify(l.name)) === norm(slug));

// The waiting list for the board: order, FULL name, party size, how long they've waited (no phone).
router.get('/board/:slug', (req, res) => {
  const loc = locBySlug(req.params.slug);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const rows = db.prepare(`SELECT id, guest_name, party_size, phone, notified_at,
      CAST((julianday('now') - julianday(created_at)) * 1440 AS INTEGER) AS waited_min
    FROM waitlist WHERE location_id=? AND status='waiting' ORDER BY created_at ASC, id ASC`).all(loc.id);
  const parties = rows.map((w, i) => ({
    id: w.id, position: i + 1, name: String(w.guest_name || 'Guest').slice(0, 80),
    party_size: w.party_size, waiting_min: Math.max(0, w.waited_min || 0),
    has_phone: !!w.phone, notified: !!w.notified_at,
  }));
  res.json({ location: { id: loc.id, name: loc.name, slug: norm(req.params.slug) }, count: parties.length,
    quoted_minutes: parties.length * (loc.avg_turn_minutes || 3), parties });
});

// A board action (notify / seat / left) — validated by an employee code (checked against Management,
// where codes live) before it fires. Rate-limited by the shared public limiter above.
router.post('/board-action', async (req, res) => {
  const loc = locBySlug((req.body && req.body.slug) || '');
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const action = ['notify', 'seat', 'left'].includes(req.body && req.body.action) ? req.body.action : null;
  if (!action) return res.status(400).json({ error: 'Unknown action.' });
  const pid = parseInt(req.body && req.body.party_id, 10);
  const code = String((req.body && req.body.employee_code) || '').trim();
  if (!pid || !code) return res.status(400).json({ error: 'Pick a guest and enter your employee code.' });
  // Verify the employee code with Management (service-key, server-to-server).
  let v = { ok: false };
  try {
    const r = await fetch(`${MGMT_URL}/api/wl-staff/validate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SVC_KEY },
      body: JSON.stringify({ employee_code: code, location_id: loc.id }),
    });
    v = await r.json().catch(() => ({ ok: false }));
  } catch { v = { ok: false, reason: 'offline' }; }
  if (!v.ok) {
    const msg = v.reason === 'notfound' ? 'Employee code not recognized.'
      : v.reason === 'role' ? 'That code isn’t allowed to manage the waitlist.'
      : v.reason === 'location' ? 'That code isn’t for this location.'
      : 'Couldn’t verify that employee code — please try again.';
    return res.status(403).json({ error: msg });
  }
  const w = db.prepare(`SELECT * FROM waitlist WHERE id=? AND location_id=?`).get(pid, loc.id);
  if (!w) return res.status(404).json({ error: 'That guest is no longer on the list.' });
  if (w.status !== 'waiting') return res.status(409).json({ error: `That guest is already ${w.status}.` });
  const by = v.name || 'Staff';
  const audit = (act, detail) => {
    try { db.prepare(`INSERT INTO audit_log (user_id, user_name, user_role, location_id, action, entity, entity_id, detail) VALUES (NULL,?,?,?,?,?,?,?)`)
      .run(by, v.role || null, loc.id, act, 'waitlist', w.id, JSON.stringify(detail)); } catch { /* best-effort */ }
  };
  const bump = () => { try { require('../lib/events').emitWaitlist(loc.id); } catch { /* */ } };

  if (action === 'notify') {
    const canText = !!(w.phone && w.sms_consent);
    const short = String(loc.name || '').replace('Pho Ha Noi — ', '');
    const body = `Hi ${String(w.guest_name || '').trim()}, your table at ${short} is ready! Please see the host to be seated.`;
    // Stamp notified_at (same as the Front Desk notify) so the 🔔 shows on the board and the guest
    // isn't paged twice; then text them if they left a number (a guest who stepped away still gets it).
    db.prepare(`UPDATE waitlist SET notified_at=datetime('now') WHERE id=?`).run(w.id);
    notifyGuest(w.id, canText ? w.phone : null, body, 'ready');
    audit('party_notified', { guest: w.guest_name, by, channel: canText ? 'sms' : 'none' });
    bump();
    return res.json({ ok: true, action, texted: canText, by });
  }
  if (action === 'seat') {
    db.prepare(`UPDATE waitlist SET status='seated', seated_at=datetime('now') WHERE id=? AND status='waiting'`).run(w.id);
    audit('party_seated', { guest: w.guest_name, party_size: w.party_size, by });
    bump();
    return res.json({ ok: true, action, by });
  }
  // left
  db.prepare(`UPDATE waitlist SET status='left' WHERE id=? AND status='waiting'`).run(w.id);
  audit('party_left', { guest: w.guest_name, party_size: w.party_size, by });
  bump();
  return res.json({ ok: true, action, by });
});

module.exports = router;
