// Team messaging — direct messages, custom groups, and broadcasts (all / a
// location). Everyone can send to specific people; only owner/admin/manager can
// broadcast. The Staff app reaches this over the service key, acting on behalf
// of a staff member resolved by email (?as=), so both apps share one inbox.
const express = require('express');
const db = require('../db/database');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

// Auth: a normal Management JWT, OR the Staff-app service key with ?as=<email>
// (or X-As-User) naming the acting staff member from the shared directory.
router.use((req, res, next) => {
  const key = req.headers['x-service-key'] || req.query.key;
  if (key && key === SERVICE_KEY) {
    const email = String(req.query.as || req.headers['x-as-user'] || '').toLowerCase().trim();
    const u = email && db.prepare(`SELECT id, name, role, location_id FROM users WHERE lower(email)=? AND is_active=1`).get(email);
    if (!u) return res.status(401).json({ error: 'Unknown messaging user.' });
    req.user = { id: u.id, name: u.name, role: u.role, location_id: u.location_id };
    return next();
  }
  return verifyToken(req, res, next);
});

const canBroadcast = (role) => ['owner', 'admin', 'manager'].includes(role);

// People I can message (everyone active except me), with location for grouping.
router.get('/recipients', (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.name, u.role, u.location_id, l.name AS location
    FROM users u LEFT JOIN locations l ON u.location_id=l.id
    WHERE u.is_active=1 AND u.id<>? ORDER BY u.name
  `).all(req.user.id));
});

// Unread count (drives the sidebar badge).
router.get('/unread-count', (req, res) => {
  res.json({ count: db.prepare(`SELECT COUNT(*) c FROM message_recipients WHERE user_id=? AND is_read=0`).get(req.user.id).c });
});

// Inbox — messages addressed to me, with each message's thread + reply count.
router.get('/inbox', (req, res) => {
  res.json(db.prepare(`
    SELECT m.id, m.subject, m.body, m.audience, m.created_at, mr.is_read,
           COALESCE(m.thread_id, m.id) AS thread_id,
           (SELECT COUNT(*) FROM messages t WHERE COALESCE(t.thread_id, t.id)=COALESCE(m.thread_id, m.id)) AS thread_count,
           u.name AS sender_name, u.role AS sender_role
    FROM message_recipients mr JOIN messages m ON mr.message_id=m.id JOIN users u ON m.sender_id=u.id
    WHERE mr.user_id=? ORDER BY m.created_at DESC LIMIT 200
  `).all(req.user.id));
});

// A full conversation thread I'm part of (messages I sent or received), oldest
// first. Opening it marks my unread messages in the thread as read.
router.get('/thread/:id', (req, res) => {
  const tid = parseInt(req.params.id, 10);
  if (!tid) return res.status(400).json({ error: 'Bad thread id.' });
  const msgs = db.prepare(`
    SELECT m.id, m.subject, m.body, m.audience, m.created_at, m.sender_id,
           u.name AS sender_name, u.role AS sender_role
    FROM messages m JOIN users u ON m.sender_id=u.id
    WHERE COALESCE(m.thread_id, m.id)=?
      AND (m.sender_id=? OR m.id IN (SELECT message_id FROM message_recipients WHERE user_id=?))
    ORDER BY m.id ASC
  `).all(tid, req.user.id, req.user.id);
  if (!msgs.length) return res.status(404).json({ error: 'No such conversation.' });
  db.prepare(`UPDATE message_recipients SET is_read=1, read_at=datetime('now')
              WHERE user_id=? AND is_read=0 AND message_id IN (SELECT id FROM messages WHERE COALESCE(thread_id, id)=?)`)
    .run(req.user.id, tid);
  res.json({ thread_id: tid, subject: msgs[0].subject, messages: msgs, me: req.user.id });
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

// Deliver a message to a set of recipients. Returns the message id.
// `audience` is what's stored for display ('direct' covers person + group).
// threadId/parentId link replies; a root message threads to its own id.
function deliver(senderId, audience, locId, subject, body, recipientIds, threadId = null, parentId = null) {
  const recips = [...new Set(recipientIds)].filter(Boolean);
  if (!recips.length) return null;
  const mid = db.prepare(`INSERT INTO messages (sender_id, audience, location_id, subject, body, thread_id, parent_id) VALUES (?,?,?,?,?,?,?)`)
    .run(senderId, audience, locId, (subject || '').toString().slice(0, 140) || null, String(body).slice(0, 4000), threadId, parentId).lastInsertRowid;
  if (!threadId) db.prepare(`UPDATE messages SET thread_id=? WHERE id=?`).run(mid, mid);
  const ins = db.prepare(`INSERT INTO message_recipients (message_id, user_id) VALUES (?,?)`);
  recips.forEach(uid => ins.run(mid, uid));
  return mid;
}

// Fire a system notification to one user (e.g. a task assignment). Best-effort.
function notify(senderId, userId, subject, body) {
  try {
    if (!userId || !senderId || String(userId) === String(senderId)) return;
    if (!db.prepare(`SELECT 1 FROM users WHERE id=? AND is_active=1`).get(userId)) return;
    deliver(senderId, 'direct', null, subject, body, [userId]);
  } catch (e) { console.error('notify failed:', e.message); }
}

// Send a message.
router.post('/', (req, res) => {
  const { audience, recipient_id, recipient_ids, location_id, subject, body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message body is required.' });

  // An explicit id list is a custom group send (stored as 'direct').
  const ids = Array.isArray(recipient_ids) ? recipient_ids.map(n => parseInt(n, 10)).filter(Boolean) : [];
  let aud = ids.length ? 'group' : (['direct', 'all', 'location'].includes(audience) ? audience : 'direct');
  if ((aud === 'all' || aud === 'location') && !canBroadcast(req.user.role)) {
    return res.status(403).json({ error: 'Only managers and above can broadcast messages.' });
  }

  let recipients = [], locId = null;
  if (aud === 'group') {
    recipients = db.prepare(`SELECT id FROM users WHERE is_active=1 AND id<>? AND id IN (${ids.map(() => '?').join(',')})`)
      .all(req.user.id, ...ids).map(r => r.id);
    if (!recipients.length) return res.status(400).json({ error: 'Pick at least one valid recipient.' });
  } else if (aud === 'direct') {
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

  // 'group' is a display alias for a multi-person direct message.
  const mid = deliver(req.user.id, aud === 'group' ? 'direct' : aud, locId,
    subject, body, recipients);
  res.json({ success: true, id: mid, recipients: recipients.length });
});

// Reply within a thread. Goes to the parent's participants (for a broadcast,
// just its sender — you answer the announcer, not the whole company).
router.post('/:id/reply', (req, res) => {
  const body = req.body && req.body.body;
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Write a reply first.' });
  const parent = db.prepare(`SELECT id, sender_id, audience, subject, thread_id FROM messages WHERE id=?`).get(parseInt(req.params.id, 10));
  if (!parent) return res.status(404).json({ error: 'Message not found.' });
  const amIn = parent.sender_id === req.user.id
    || db.prepare(`SELECT 1 FROM message_recipients WHERE message_id=? AND user_id=?`).get(parent.id, req.user.id);
  if (!amIn) return res.status(403).json({ error: 'Not part of this conversation.' });

  let recipients;
  if (parent.audience === 'all' || parent.audience === 'location') {
    recipients = [parent.sender_id];
  } else {
    recipients = db.prepare(`SELECT user_id FROM message_recipients WHERE message_id=?`).all(parent.id).map(r => r.user_id);
    recipients.push(parent.sender_id);
  }
  recipients = db.prepare(`SELECT id FROM users WHERE is_active=1 AND id<>? AND id IN (${recipients.map(() => '?').join(',') || 'NULL'})`)
    .all(req.user.id, ...recipients).map(r => r.id);
  if (!recipients.length) return res.status(400).json({ error: 'No one to reply to.' });

  const subject = parent.subject ? (/^re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`) : null;
  const mid = deliver(req.user.id, 'direct', null, subject, body, recipients, parent.thread_id || parent.id, parent.id);
  res.json({ success: true, id: mid, recipients: recipients.length });
});

module.exports = router;
module.exports.notify = notify;
