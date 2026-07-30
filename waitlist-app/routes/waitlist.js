const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole } = require('../lib/auth');
const { auditLog } = require('../lib/audit');

const router = express.Router();
router.use(verifyToken);
const HOST = ['owner', 'manager', 'frontdesk'];

// Resolve which location a request targets (owner may choose; others are pinned).
function loc(req, fromQuery) {
  if (req.user.role === 'owner') return (fromQuery ? req.query.location_id : req.body.location_id) || null;
  return req.user.location_id;
}
function requireLoc(req, res, fromQuery) {
  const l = loc(req, fromQuery);
  if (!l) { res.status(400).json({ error: 'A location is required.' }); return null; }
  return l;
}

router.get('/locations', requireRole(...HOST), (req, res) => {
  res.json(db.prepare(`SELECT id, name, avg_turn_minutes FROM locations WHERE is_active=1 ORDER BY name`).all());
});

// Current queue (waiting parties, oldest first).
router.get('/', requireRole(...HOST), (req, res) => {
  const l = requireLoc(req, res, true); if (!l) return;
  res.json(db.prepare(`SELECT * FROM waitlist WHERE location_id=? AND status='waiting' ORDER BY created_at`).all(l));
});

// Suggested quote (minutes) for a new party = parties ahead × avg turn.
router.get('/quote', requireRole(...HOST), (req, res) => {
  const l = requireLoc(req, res, true); if (!l) return;
  const location = db.prepare(`SELECT avg_turn_minutes FROM locations WHERE id=?`).get(l);
  const ahead = db.prepare(`SELECT COUNT(*) c FROM waitlist WHERE location_id=? AND status='waiting'`).get(l).c;
  res.json({ parties_ahead: ahead, suggested_minutes: ahead * (location ? location.avg_turn_minutes : 8) });
});

router.get('/stats', requireRole(...HOST), (req, res) => {
  const l = requireLoc(req, res, true); if (!l) return;
  const waiting = db.prepare(`SELECT COUNT(*) c FROM waitlist WHERE location_id=? AND status='waiting'`).get(l).c;
  const seatedToday = db.prepare(`SELECT COUNT(*) c FROM waitlist WHERE location_id=? AND status='seated' AND date(seated_at)=date('now')`).get(l).c;
  const leftToday = db.prepare(`SELECT COUNT(*) c FROM waitlist WHERE location_id=? AND status='left' AND date(created_at)=date('now')`).get(l).c;
  const longest = db.prepare(`SELECT MIN(created_at) m FROM waitlist WHERE location_id=? AND status='waiting'`).get(l).m;
  const longestWait = longest ? Math.round((Date.now() - new Date(longest.replace(' ', 'T') + 'Z').getTime()) / 60000) : 0;
  const location = db.prepare(`SELECT avg_turn_minutes FROM locations WHERE id=?`).get(l);
  res.json({ waiting, seated_today: seatedToday, left_today: leftToday, longest_wait_min: longestWait,
             next_quote_min: waiting * (location ? location.avg_turn_minutes : 8) });
});

// Add a party.
router.post('/', requireRole(...HOST), (req, res) => {
  const l = requireLoc(req, res, false); if (!l) return;
  const { guest_name, party_size, phone, quoted_minutes, notes } = req.body;
  if (!guest_name || !String(guest_name).trim()) return res.status(400).json({ error: 'Guest name is required.' });
  const size = Math.max(1, Math.min(50, parseInt(party_size) || 2));
  let quote = parseInt(quoted_minutes);
  if (!Number.isFinite(quote)) {
    const location = db.prepare(`SELECT avg_turn_minutes FROM locations WHERE id=?`).get(l);
    const ahead = db.prepare(`SELECT COUNT(*) c FROM waitlist WHERE location_id=? AND status='waiting'`).get(l).c;
    quote = ahead * (location ? location.avg_turn_minutes : 8);
  }
  const r = db.prepare(`INSERT INTO waitlist (location_id, guest_name, party_size, phone, quoted_minutes, notes) VALUES (?,?,?,?,?,?)`)
    .run(l, String(guest_name).slice(0, 120), size, phone || null, quote, notes ? String(notes).slice(0, 300) : null);
  auditLog(req, l, 'party_added', r.lastInsertRowid, { guest: String(guest_name).slice(0, 120), party_size: size, quoted_minutes: quote });
  res.json({ success: true, id: r.lastInsertRowid, quoted_minutes: quote });
});

// Page the guest that their table is ready (SMS is stubbed → notify_log).
router.post('/:id/notify', requireRole(...HOST), (req, res) => {
  const w = db.prepare(`SELECT * FROM waitlist WHERE id=?`).get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Waitlist entry not found' });
  if (req.user.role !== 'owner' && w.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
  if (w.status !== 'waiting') return res.status(409).json({ error: 'This party is no longer waiting.' });
  const locName = (db.prepare(`SELECT name FROM locations WHERE id=?`).get(w.location_id) || {}).name || 'Pho Ha Noi';
  const body = `${locName}: your table is ready! Please see the host. 🍜`;
  db.prepare(`UPDATE waitlist SET notified_at=datetime('now') WHERE id=?`).run(w.id);
  db.prepare(`INSERT INTO notify_log (waitlist_id, channel, recipient, body) VALUES (?,?,?,?)`)
    .run(w.id, w.phone ? 'sms' : 'none', w.phone || null, body);
  auditLog(req, w.location_id, 'party_notified', w.id, { guest: w.guest_name, channel: w.phone ? 'sms' : 'none' });
  res.json({ success: true, sent: !!w.phone, message: body });
});

// Seat a party.
router.put('/:id/seat', requireRole(...HOST), (req, res) => {
  const w = db.prepare(`SELECT * FROM waitlist WHERE id=?`).get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Waitlist entry not found' });
  if (req.user.role !== 'owner' && w.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
  if (w.status !== 'waiting') return res.status(409).json({ error: 'This party is no longer waiting.' });
  const table = (req.body.table_number || '').toString().slice(0, 20) || null;
  db.prepare(`UPDATE waitlist SET status='seated', seated_at=datetime('now'), table_number=? WHERE id=?`).run(table, w.id);
  auditLog(req, w.location_id, 'party_seated', w.id, { guest: w.guest_name, party_size: w.party_size, table_number: table });
  res.json({ success: true });
});

// Remove a party who left / no-showed.
router.put('/:id/leave', requireRole(...HOST), (req, res) => {
  const w = db.prepare(`SELECT * FROM waitlist WHERE id=?`).get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Waitlist entry not found' });
  if (req.user.role !== 'owner' && w.location_id !== req.user.location_id) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`UPDATE waitlist SET status='left' WHERE id=?`).run(w.id);
  auditLog(req, w.location_id, 'party_left', w.id, { guest: w.guest_name, party_size: w.party_size });
  res.json({ success: true });
});

// Activity log — who did what (added / notified / seated / removed), newest first.
router.get('/audit', requireRole(...HOST), (req, res) => {
  const l = requireLoc(req, res, true); if (!l) return;
  const rows = db.prepare(`
    SELECT a.id, a.action, a.entity_id, a.detail, a.created_at, u.name AS user_name, u.role AS user_role
    FROM audit_log a LEFT JOIN users u ON a.user_id=u.id
    WHERE a.location_id=? ORDER BY a.created_at DESC, a.id DESC LIMIT 200
  `).all(l);
  res.json(rows.map(r => { let d = null; try { d = r.detail ? JSON.parse(r.detail) : null; } catch { d = null; } return { ...r, detail: d }; }));
});

// Today's seated / left history.
router.get('/history', requireRole(...HOST), (req, res) => {
  const l = requireLoc(req, res, true); if (!l) return;
  res.json(db.prepare(`SELECT * FROM waitlist WHERE location_id=? AND status IN ('seated','left') AND date(created_at)=date('now') ORDER BY created_at DESC LIMIT 100`).all(l));
});

module.exports = router;
