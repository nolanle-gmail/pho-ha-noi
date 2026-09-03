// Team messaging — direct messages, custom groups, and broadcasts (all / a
// location). Everyone can send to specific people; only owner/admin/manager can
// broadcast. The Staff app reaches this over the service key, acting on behalf
// of a staff member resolved by email (?as=), so both apps share one inbox.
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const { verifyToken, SECRET } = require('../lib/auth');
const { emitMessages, onMessages, onAlert, onAlertAck } = require('../lib/events');

const router = express.Router();
const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

// Message attachments (pictures & videos) — stored as bytes, with per-kind caps.
const MAX_IMG = parseInt(process.env.MESSAGE_IMG_MAX || '', 10) || 10 * 1024 * 1024; // 10 MB
const MAX_VID = parseInt(process.env.MESSAGE_VID_MAX || '', 10) || 25 * 1024 * 1024; // 25 MB
const MAX_ATTACH = parseInt(process.env.MESSAGE_ATTACH_MAX || '', 10) || 10;          // per message
const OK_IMG = /^image\/(jpeg|png|webp|heic|heif|gif)$/i;
const OK_VID = /^video\/(mp4|quicktime|webm|ogg|3gpp|x-m4v|x-matroska)$/i;

// Resolve the acting user from a service key (+ ?as=email) or a query JWT.
// EventSource can't send headers, so the live stream authenticates this way.
function streamUser(req) {
  const key = req.headers['x-service-key'] || req.query.key;
  if (key && key === SERVICE_KEY) {
    const email = String(req.query.as || '').toLowerCase().trim();
    const u = email && db.prepare(`SELECT id, role, location_id FROM users WHERE lower(email)=? AND is_active=1`).get(email);
    return u ? { id: u.id, role: u.role, location_id: u.location_id } : null;
  }
  try { return jwt.verify(req.query.token || '', SECRET); } catch { return null; }
}
// Does a floor alert target this connected user? (them specifically, their role
// at their store, or everyone at their store.)
function alertHitsUser(a, user) {
  if (a.target_type === 'user') return Number(a.target_user_id) === Number(user.id);
  const sameLoc = user.location_id != null && String(a.location_id) === String(user.location_id);
  if (a.target_type === 'role') return sameLoc && a.target_role === user.role;
  return sameLoc; // 'all'
}

// Live push: fires whenever a message is delivered to me (badge + inbox refresh).
// Defined before the auth middleware since it authenticates via query/service key.
router.get('/stream', (req, res) => {
  const user = streamUser(req);
  if (!user) return res.status(401).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  if (res.flushHeaders) res.flushHeaders();
  res.write(': connected\n\n');
  const unsub = onMessages((p) => {
    if (p.user_ids.includes(Number(user.id))) { try { res.write('data: {"type":"message"}\n\n'); } catch { /* closed */ } }
  });
  // Floor alerts targeting me pop up live; acks flow back to me when I'm the sender.
  const unsubAlert = onAlert((a) => {
    if (alertHitsUser(a, user)) { try { res.write(`data: ${JSON.stringify({ type: 'alert', alert: a })}\n\n`); } catch { /* closed */ } }
  });
  const unsubAck = onAlertAck((k) => {
    if (Number(k.sender_id) === Number(user.id)) { try { res.write(`data: ${JSON.stringify({ type: 'alert_ack', alert_id: k.alert_id, user_id: k.user_id, user_name: k.user_name })}\n\n`); } catch { /* closed */ } }
  });
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(hb); unsub(); unsubAlert(); unsubAck(); });
});

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

// Unread count (drives the badge) — archived conversations don't count.
router.get('/unread-count', (req, res) => {
  res.json({ count: db.prepare(`SELECT COUNT(*) c FROM message_recipients WHERE user_id=? AND is_read=0 AND archived=0`).get(req.user.id).c });
});

// Inbox — one row per conversation (collapsed), showing the latest message I
// received in it. Active by default; ?archived=1 lists conversations I've filed
// away (all my copies archived). A thread's unread count + total size ride along.
router.get('/inbox', (req, res) => {
  const arch = req.query.archived === '1' ? 1 : 0;
  res.json(db.prepare(`
    WITH mine AS (
      SELECT m.id AS msg_id, COALESCE(m.thread_id, m.id) AS tid, mr.is_read, mr.archived
      FROM message_recipients mr JOIN messages m ON mr.message_id=m.id
      WHERE mr.user_id=?
    ),
    agg AS (
      SELECT tid,
             SUM(CASE WHEN is_read=0 AND archived=0 THEN 1 ELSE 0 END) AS unread,
             SUM(CASE WHEN archived=0 THEN 1 ELSE 0 END) AS active_rows,
             MAX(msg_id) AS last_recv_id
      FROM mine GROUP BY tid
    )
    SELECT a.tid AS thread_id, a.unread,
           CASE WHEN a.unread > 0 THEN 0 ELSE 1 END AS is_read,
           CASE WHEN a.active_rows = 0 THEN 1 ELSE 0 END AS archived,
           m.subject, m.body, m.audience, m.created_at,
           (SELECT COUNT(*) FROM messages t WHERE COALESCE(t.thread_id, t.id)=a.tid) AS thread_count,
           u.name AS sender_name, u.role AS sender_role
    FROM agg a
    JOIN messages m ON m.id=a.last_recv_id
    JOIN users u ON m.sender_id=u.id
    WHERE CASE WHEN ?=1 THEN a.active_rows=0 ELSE a.active_rows>0 END
    ORDER BY m.created_at DESC LIMIT 200
  `).all(req.user.id, arch));
});

// A full conversation thread I'm part of (messages I sent or received), oldest
// first. Opening it marks my unread messages in the thread as read.
router.get('/thread/:id', (req, res) => {
  const tid = parseInt(req.params.id, 10);
  if (!tid) return res.status(400).json({ error: 'Bad thread id.' });
  const msgs = db.prepare(`
    SELECT m.id, m.subject, m.body, m.audience, m.created_at, m.sender_id,
           u.name AS sender_name, u.role AS sender_role,
           (SELECT COUNT(*) FROM message_attachments a WHERE a.message_id=m.id) AS attachment_count
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

// Mark a conversation unread again (its latest message I received).
router.post('/thread/:id/unread', (req, res) => {
  const tid = parseInt(req.params.id, 10);
  const row = db.prepare(`SELECT mr.id FROM message_recipients mr JOIN messages m ON mr.message_id=m.id
    WHERE mr.user_id=? AND COALESCE(m.thread_id, m.id)=? ORDER BY m.id DESC LIMIT 1`).get(req.user.id, tid);
  if (!row) return res.status(404).json({ error: 'Not your conversation.' });
  db.prepare(`UPDATE message_recipients SET is_read=0, read_at=NULL WHERE id=?`).run(row.id);
  res.json({ success: true });
});

// Archive / unarchive a whole conversation for me (a new reply un-buries it).
function setArchived(req, res, val) {
  const tid = parseInt(req.params.id, 10);
  const r = db.prepare(`UPDATE message_recipients SET archived=?
    WHERE user_id=? AND message_id IN (SELECT id FROM messages WHERE COALESCE(thread_id, id)=?)`).run(val, req.user.id, tid);
  if (!r.changes) return res.status(404).json({ error: 'Not your conversation.' });
  res.json({ success: true });
}
router.post('/thread/:id/archive', (req, res) => setArchived(req, res, 1));
router.post('/thread/:id/unarchive', (req, res) => setArchived(req, res, 0));

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
  try { emitMessages(recips); } catch { /* live push is best-effort */ }
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

// ── Message attachments (pictures & videos) ──────────────────────────────────
// May this user see this message (its sender or a recipient)? Returns the message
// row, false if not a participant, or null if it doesn't exist.
function canSeeMessage(userId, msgId) {
  const m = db.prepare(`SELECT id, sender_id FROM messages WHERE id=?`).get(msgId);
  if (!m) return null;
  if (String(m.sender_id) === String(userId)) return m;
  return db.prepare(`SELECT 1 FROM message_recipients WHERE message_id=? AND user_id=?`).get(msgId, userId) ? m : false;
}

// Attach an image or video to a message you sent (raw bytes; Content-Type = the
// file's type). Up to MAX_ATTACH per message; images and videos have size caps.
router.post('/:id/attachment', express.raw({ type: () => true, limit: MAX_VID }), (req, res) => {
  const m = db.prepare(`SELECT id, sender_id FROM messages WHERE id=?`).get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Message not found.' });
  if (String(m.sender_id) !== String(req.user.id)) return res.status(403).json({ error: 'You can only attach to your own message.' });
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const kind = OK_IMG.test(mime) ? 'image' : OK_VID.test(mime) ? 'video' : null;
  if (!kind) return res.status(415).json({ error: 'Attach an image (JPG, PNG, WEBP, HEIC, GIF) or video (MP4, MOV, WEBM).' });
  const bytes = req.body;
  if (!Buffer.isBuffer(bytes) || !bytes.length) return res.status(400).json({ error: 'No file received.' });
  const cap = kind === 'video' ? MAX_VID : MAX_IMG;
  if (bytes.length > cap) return res.status(413).json({ error: `${kind === 'video' ? 'Video' : 'Image'} too large (max ${Math.round(cap / 1048576)} MB).` });
  const count = db.prepare(`SELECT COUNT(*) n FROM message_attachments WHERE message_id=?`).get(m.id).n;
  if (count >= MAX_ATTACH) return res.status(409).json({ error: `Up to ${MAX_ATTACH} attachments per message.` });
  const filename = String(req.query.filename || '').slice(0, 200) || null;
  const info = db.prepare(`INSERT INTO message_attachments (message_id, kind, mime, bytes, byte_size, filename) VALUES (?,?,?,?,?,?)`)
    .run(m.id, kind, mime, bytes, bytes.length, filename);
  res.json({ success: true, id: Number(info.lastInsertRowid), kind, count: count + 1, byte_size: bytes.length });
});

// List a message's attachments (metadata only). Any participant.
router.get('/:id/attachments', (req, res) => {
  const m = canSeeMessage(req.user.id, req.params.id);
  if (m === null) return res.status(404).json({ error: 'Message not found.' });
  if (!m) return res.status(403).json({ error: 'Not part of this conversation.' });
  const attachments = db.prepare(`SELECT id, kind, mime, byte_size, filename FROM message_attachments WHERE message_id=? ORDER BY id`).all(m.id);
  res.json({ id: m.id, count: attachments.length, attachments });
});

// Stream one attachment's bytes. Any participant.
router.get('/:id/attachment/:aid', (req, res) => {
  const m = canSeeMessage(req.user.id, req.params.id);
  if (m === null) return res.status(404).json({ error: 'Message not found.' });
  if (!m) return res.status(403).json({ error: 'Not part of this conversation.' });
  const a = db.prepare(`SELECT mime, bytes FROM message_attachments WHERE id=? AND message_id=?`).get(req.params.aid, m.id);
  if (!a) return res.status(404).json({ error: 'No such attachment.' });
  const buf = Buffer.from(a.bytes);
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(buf);
});

module.exports = router;
module.exports.notify = notify;
