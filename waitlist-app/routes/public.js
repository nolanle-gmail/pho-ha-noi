// Public, no-login endpoints for the customer self-check-in kiosk / QR page.
// A guest can see the current wait, add themselves to the list, and track their
// spot by a short reference code — all without a staff account. Front-desk entry
// is handled by the authenticated /api/waitlist routes.
const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { rateLimit } = require('../lib/rateLimit');

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
});

// Current wait at a location: parties ahead × the location's average turn time.
function statusFor(locId) {
  const location = db.prepare(`SELECT avg_turn_minutes FROM locations WHERE id=?`).get(locId);
  const ahead = db.prepare(`SELECT COUNT(*) c FROM waitlist WHERE location_id=? AND status='waiting'`).get(locId).c;
  return { parties_ahead: ahead, quoted_minutes: ahead * (location ? location.avg_turn_minutes : 8) };
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

// Customer adds themselves to the waitlist.
router.post('/checkin', checkinLimiter, (req, res) => {
  const locId = parseInt(req.body.location_id, 10);
  const loc = locId && db.prepare(`SELECT id, name FROM locations WHERE id=? AND is_active=1`).get(locId);
  if (!loc) return res.status(400).json({ error: 'Please choose a valid location.' });
  const name = (req.body.guest_name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  const size = Math.max(1, Math.min(50, parseInt(req.body.party_size, 10) || 2));
  const phone = (req.body.phone || '').toString().trim().slice(0, 40) || null;
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
  const r = db.prepare(`INSERT INTO waitlist (location_id, guest_name, party_size, phone, notes, quoted_minutes, source, public_ref)
    VALUES (?,?,?,?,?,?, 'self', ?)`).run(locId, name.slice(0, 120), size, phone, notes, s.quoted_minutes, ref);
  // Audit as a self check-in (no staff user).
  try {
    db.prepare(`INSERT INTO audit_log (user_id, location_id, action, entity, entity_id, detail) VALUES (NULL,?,?,?,?,?)`)
      .run(locId, 'party_added', 'waitlist', r.lastInsertRowid, JSON.stringify({ guest: name.slice(0, 120), party_size: size, source: 'self' }));
  } catch { /* audit is best-effort */ }
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
    quoted_minutes: position != null ? Math.max(0, position - 1) * (location ? location.avg_turn_minutes : 8) : 0,
    location: location ? location.name : '',
  });
});

module.exports = router;
