// Team messaging — direct messages plus broadcasts (all staff / a location).
// Everyone can send direct messages; only owner/admin/manager can broadcast.
const express = require('express');
const db = require('../db/database');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);

const canBroadcast = (role) => ['owner', 'admin', 'manager'].includes(role);

// People I can message (everyone active except me).
router.get('/recipients', (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.name, u.role, l.name AS location
    FROM users u LEFT JOIN locations l ON u.location_id=l.id
    WHERE u.is_active=1 AND u.id<>? ORDER BY u.name
  `).all(req.user.id));
});

// Unread count (drives the sidebar badge).
router.get('/unread-count', (req, res) => {
  res.json({ count: db.prepare(`SELECT COUNT(*) c FROM message_recipients WHERE user_id=? AND is_read=0`).get(req.user.id).c });
});

// Inbox — messages addressed to me.
router.get('/inbox', (req, res) => {
  res.json(db.prepare(`
    SELECT m.id, m.subject, m.body, m.audience, m.created_at, mr.is_read,
           u.name AS sender_name, u.role AS sender_role
    FROM message_recipients mr JOIN messages m ON mr.message_id=m.id JOIN users u ON m.sender_id=u.id
    WHERE mr.user_id=? ORDER BY m.created_at DESC LIMIT 200
  `).all(req.user.id));
});

// Sent — messages I sent, with read progress.
router.get('/sent', (req, res) => {
  res.json(db.prepare(`
    SELECT m.id, m.subject, m.body, m.audience, m.location_id, m.created_at,
           (SELECT COUNT(*) FROM message_recipients r WHERE r.message_id=m.id) AS recipients,
           (SELECT COUNT(*) FROM message_recipients r WHERE r.message_id=m.id AND r.is_read=1) AS read_count,
           l.name AS location_name
    FROM messages m LEFT JOIN locations l ON m.location_id=l.id
    WHERE m.sender_id=? ORDER BY m.created_at DESC LIMIT 200
  `).all(req.user.id));
});

// Mark a message read for me.
router.post('/:id/read', (req, res) => {
  db.prepare(`UPDATE message_recipients SET is_read=1, read_at=datetime('now') WHERE message_id=? AND user_id=? AND is_read=0`).run(req.params.id, req.user.id);
  res.json({ success: true });
});

// Send a message.
router.post('/', (req, res) => {
  const { audience, recipient_id, location_id, subject, body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message body is required.' });
  const aud = ['direct', 'all', 'location'].includes(audience) ? audience : 'direct';
  if ((aud === 'all' || aud === 'location') && !canBroadcast(req.user.role)) {
    return res.status(403).json({ error: 'Only managers and above can broadcast messages.' });
  }

  let recipients = [], locId = null;
  if (aud === 'direct') {
    const u = db.prepare(`SELECT id FROM users WHERE id=? AND is_active=1`).get(parseInt(recipient_id));
    if (!u) return res.status(400).json({ error: 'Pick a valid recipient.' });
    recipients = [u.id];
  } else if (aud === 'all') {
    recipients = db.prepare(`SELECT id FROM users WHERE is_active=1 AND id<>?`).all(req.user.id).map(r => r.id);
  } else {
    locId = parseInt(location_id);
    if (!locId) return res.status(400).json({ error: 'Pick a location.' });
    recipients = db.prepare(`SELECT id FROM users WHERE is_active=1 AND location_id=? AND id<>?`).all(locId, req.user.id).map(r => r.id);
  }
  if (!recipients.length) return res.status(400).json({ error: 'No recipients for this message.' });

  const mid = db.prepare(`INSERT INTO messages (sender_id, audience, location_id, subject, body) VALUES (?,?,?,?,?)`)
    .run(req.user.id, aud, locId, (subject || '').toString().slice(0, 140) || null, String(body).slice(0, 4000)).lastInsertRowid;
  const ins = db.prepare(`INSERT INTO message_recipients (message_id, user_id) VALUES (?,?)`);
  recipients.forEach(uid => ins.run(mid, uid));
  res.json({ success: true, id: mid, recipients: recipients.length });
});

module.exports = router;
