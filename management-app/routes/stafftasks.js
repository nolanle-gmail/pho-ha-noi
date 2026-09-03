// Staff-facing day tasks — a person's own "specific" task assignments for the
// day (assigned on the Management Day Tasks board). Staff tap Start when they
// begin and Done when finished, and may attach one proof photo before Done.
// Reached by the Staff app via the shared service key (scoped to the signed-in
// staff member) or directly by a Management JWT (self, or any for a manager).
const express = require('express');
const db = require('../db/database');
const { SECRET, ROLES } = require('../lib/auth');
const jwt = require('jsonwebtoken');

const router = express.Router();
const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';
const MAX_PHOTO_BYTES = parseInt(process.env.TASK_PHOTO_MAX || '', 10) || 8 * 1024 * 1024; // 8 MB
const MAX_PHOTOS_PER_TASK = parseInt(process.env.TASK_PHOTO_COUNT_MAX || '', 10) || 8;
const OK_IMAGE = /^image\/(jpeg|png|webp|heic|heif|gif)$/i;

function auth(req, res, next) {
  const key = req.headers['x-service-key'];
  if (key && key === SERVICE_KEY) { req.service = true; return next(); }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try { req.user = jwt.verify(token, SECRET); next(); } catch { return res.status(401).json({ error: 'Invalid or expired session' }); }
}
router.use(auth);

const localDate = (tz) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Los_Angeles' }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); } };
// Whose tasks: the service key names the staff member; a JWT is always self.
const actingUserId = (req) => req.service ? (req.query.user_id ? parseInt(req.query.user_id, 10) : (req.body && req.body.user_id ? parseInt(req.body.user_id, 10) : null)) : req.user.id;
const isManage = (req) => req.user && ROLES.MANAGE.includes(req.user.role);

// May this request act on (or view) the given task? Managers: any; everyone else:
// only their own task.
function canTouch(req, ta) {
  if (isManage(req)) return true;
  const uid = actingUserId(req);
  return uid != null && String(ta.user_id) === String(uid);
}

router.get('/', (req, res) => {
  const uid = actingUserId(req);
  if (!uid) return res.status(400).json({ error: 'user_id is required.' });
  const u = db.prepare(`SELECT u.id, u.name, u.location_id, l.timezone FROM users u LEFT JOIN locations l ON l.id=u.location_id WHERE u.id=?`).get(uid);
  if (!u) return res.status(404).json({ error: 'Staff member not found.' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : localDate(u.timezone);
  const tasks = db.prepare(`
    SELECT ta.id, ta.job_id, ta.task_time, ta.done, ta.started_at, ta.done_at, ta.location_id, l.name AS location_name,
           j.code, j.name, j.description, j.department, j.complexity, j.est_minutes,
           (SELECT COUNT(*) FROM task_photos tp WHERE tp.task_id=ta.id) AS photo_count,
           (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id=ta.id) AS comment_count
    FROM task_assignments ta
    JOIN jobs j ON j.id=ta.job_id
    JOIN locations l ON l.id=ta.location_id
    WHERE ta.user_id=? AND ta.task_date=? ORDER BY ta.task_time IS NULL, ta.task_time, j.name`).all(uid, date)
    .map(t => ({ ...t, done: !!t.done, photo_count: t.photo_count, comment_count: t.comment_count, has_photo: t.photo_count > 0 }));
  res.json({ user: { id: u.id, name: u.name }, date, tasks, summary: { total: tasks.length, done: tasks.filter(t => t.done).length } });
});

// Start working on a task (records started_at once; clears any done state).
router.put('/:id/start', (req, res) => {
  const ta = db.prepare(`SELECT * FROM task_assignments WHERE id=?`).get(req.params.id);
  if (!ta) return res.status(404).json({ error: 'Task not found.' });
  if (!canTouch(req, ta)) return res.status(403).json({ error: 'That is not your task.' });
  db.prepare(`UPDATE task_assignments
    SET started_at=COALESCE(started_at, datetime('now')), done=0, done_at=NULL, updated_at=datetime('now')
    WHERE id=?`).run(ta.id);
  const row = db.prepare(`SELECT started_at, done, done_at FROM task_assignments WHERE id=?`).get(ta.id);
  res.json({ success: true, id: ta.id, started_at: row.started_at, done: !!row.done });
});

// Mark done / not-done. Marking done also stamps done_at (and backfills started_at
// if the person went straight to Done); reopening clears done_at.
router.put('/:id/done', (req, res) => {
  const ta = db.prepare(`SELECT * FROM task_assignments WHERE id=?`).get(req.params.id);
  if (!ta) return res.status(404).json({ error: 'Task not found.' });
  if (!canTouch(req, ta)) return res.status(403).json({ error: 'That is not your task.' });
  const done = req.body.done === undefined ? 1 : (req.body.done ? 1 : 0);
  if (done) {
    db.prepare(`UPDATE task_assignments
      SET done=1, done_at=datetime('now'), started_at=COALESCE(started_at, datetime('now')), updated_at=datetime('now')
      WHERE id=?`).run(ta.id);
  } else {
    db.prepare(`UPDATE task_assignments SET done=0, done_at=NULL, updated_at=datetime('now') WHERE id=?`).run(ta.id);
  }
  const row = db.prepare(`SELECT done, done_at, started_at FROM task_assignments WHERE id=?`).get(ta.id);
  res.json({ success: true, id: ta.id, done: !!row.done, done_at: row.done_at, started_at: row.started_at });
});

// Append a proof photo (raw image bytes; Content-Type is the image type). Many
// photos per task, capped at MAX_PHOTOS_PER_TASK; each is stored as a row so it
// can be viewed or removed individually.
router.post('/:id/photo', express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }), (req, res) => {
  const ta = db.prepare(`SELECT * FROM task_assignments WHERE id=?`).get(req.params.id);
  if (!ta) return res.status(404).json({ error: 'Task not found.' });
  if (!canTouch(req, ta)) return res.status(403).json({ error: 'That is not your task.' });
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!OK_IMAGE.test(mime)) return res.status(415).json({ error: 'Please upload an image (JPG, PNG, WEBP or HEIC).' });
  const bytes = req.body;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return res.status(400).json({ error: 'No image received.' });
  const count = db.prepare(`SELECT COUNT(*) AS n FROM task_photos WHERE task_id=?`).get(ta.id).n;
  if (count >= MAX_PHOTOS_PER_TASK) return res.status(409).json({ error: `Up to ${MAX_PHOTOS_PER_TASK} photos per task.` });
  const uploadedBy = req.service ? (req.query.user_id ? parseInt(req.query.user_id, 10) : ta.user_id) : req.user.id;
  const info = db.prepare(`INSERT INTO task_photos (task_id, mime, bytes, byte_size, uploaded_by, uploaded_at)
    VALUES (?,?,?,?,?,datetime('now'))`).run(ta.id, mime, bytes, bytes.length, uploadedBy);
  res.json({ success: true, id: ta.id, photo_id: Number(info.lastInsertRowid), has_photo: true, count: count + 1, byte_size: bytes.length });
});

// List a task's proof photos (metadata only — no bytes). Owner or a manager.
router.get('/:id/photos', (req, res) => {
  const ta = db.prepare(`SELECT * FROM task_assignments WHERE id=?`).get(req.params.id);
  if (!ta) return res.status(404).json({ error: 'Task not found.' });
  if (!canTouch(req, ta)) return res.status(403).json({ error: 'That is not your task.' });
  const photos = db.prepare(`SELECT p.id, p.mime, p.byte_size, p.uploaded_by, p.uploaded_at, u.name AS uploaded_by_name
    FROM task_photos p LEFT JOIN users u ON u.id=p.uploaded_by
    WHERE p.task_id=? ORDER BY p.id`).all(ta.id);
  res.json({ id: ta.id, count: photos.length, photos });
});

// Stream one specific proof photo's bytes. Owner or a manager.
router.get('/:id/photo/:photoId', (req, res) => {
  const ta = db.prepare(`SELECT * FROM task_assignments WHERE id=?`).get(req.params.id);
  if (!ta) return res.status(404).json({ error: 'Task not found.' });
  if (!canTouch(req, ta)) return res.status(403).json({ error: 'That is not your task.' });
  const p = db.prepare(`SELECT mime, bytes FROM task_photos WHERE id=? AND task_id=?`).get(req.params.photoId, ta.id);
  if (!p) return res.status(404).json({ error: 'No such photo.' });
  sendPhoto(res, p);
});

// Delete one proof photo (the assigned staff member or a manager).
router.delete('/:id/photo/:photoId', (req, res) => {
  const ta = db.prepare(`SELECT * FROM task_assignments WHERE id=?`).get(req.params.id);
  if (!ta) return res.status(404).json({ error: 'Task not found.' });
  if (!canTouch(req, ta)) return res.status(403).json({ error: 'That is not your task.' });
  const info = db.prepare(`DELETE FROM task_photos WHERE id=? AND task_id=?`).run(req.params.photoId, ta.id);
  if (!info.changes) return res.status(404).json({ error: 'No such photo.' });
  const count = db.prepare(`SELECT COUNT(*) AS n FROM task_photos WHERE task_id=?`).get(ta.id).n;
  res.json({ success: true, id: ta.id, count, has_photo: count > 0 });
});

// Back-compat: fetch the task's most recent proof photo (single-photo callers).
router.get('/:id/photo', (req, res) => {
  const ta = db.prepare(`SELECT * FROM task_assignments WHERE id=?`).get(req.params.id);
  if (!ta) return res.status(404).json({ error: 'Task not found.' });
  if (!canTouch(req, ta)) return res.status(403).json({ error: 'That is not your task.' });
  const p = db.prepare(`SELECT mime, bytes FROM task_photos WHERE task_id=? ORDER BY id DESC LIMIT 1`).get(ta.id);
  if (!p) return res.status(404).json({ error: 'No photo for this task.' });
  sendPhoto(res, p);
});

// node:sqlite returns a BLOB as a Uint8Array; wrap in a Buffer so Express sends
// the raw bytes instead of JSON-serializing the typed array.
function sendPhoto(res, p) {
  const buf = Buffer.from(p.bytes);
  res.setHeader('Content-Type', p.mime);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.end(buf);
}

// ── Comments / feedback on a day task ─────────────────────────────────────────
// The assigned staff member leaves notes alongside their photos; a manager can
// reply with feedback. Everyone who can see the task (its staff or any manager)
// sees the whole thread.
const MAX_COMMENT_LEN = 1000;

// Who is writing: the acting user (staff via service key, or the signed-in manager).
function commentAuthorId(req) {
  return req.service ? (req.query.user_id ? parseInt(req.query.user_id, 10) : null) : (req.user && req.user.id) || null;
}

// Add a comment to a task.
router.post('/:id/comment', (req, res) => {
  const ta = db.prepare(`SELECT * FROM task_assignments WHERE id=?`).get(req.params.id);
  if (!ta) return res.status(404).json({ error: 'Task not found.' });
  if (!canTouch(req, ta)) return res.status(403).json({ error: 'That is not your task.' });
  const body = String(req.body && req.body.body || '').trim().slice(0, MAX_COMMENT_LEN);
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  const authorId = commentAuthorId(req);
  const info = db.prepare(`INSERT INTO task_comments (task_id, body, author_id, created_at)
    VALUES (?,?,?,datetime('now'))`).run(ta.id, body, authorId);
  const count = db.prepare(`SELECT COUNT(*) AS n FROM task_comments WHERE task_id=?`).get(ta.id).n;
  const c = db.prepare(`SELECT c.id, c.body, c.author_id, c.created_at, u.name AS author_name, u.role AS author_role
    FROM task_comments c LEFT JOIN users u ON u.id=c.author_id WHERE c.id=?`).get(Number(info.lastInsertRowid));
  res.json({ success: true, id: ta.id, count, comment: c });
});

// List a task's comments (oldest first). Owner or a manager.
router.get('/:id/comments', (req, res) => {
  const ta = db.prepare(`SELECT * FROM task_assignments WHERE id=?`).get(req.params.id);
  if (!ta) return res.status(404).json({ error: 'Task not found.' });
  if (!canTouch(req, ta)) return res.status(403).json({ error: 'That is not your task.' });
  const comments = db.prepare(`SELECT c.id, c.body, c.author_id, c.created_at, u.name AS author_name, u.role AS author_role
    FROM task_comments c LEFT JOIN users u ON u.id=c.author_id
    WHERE c.task_id=? ORDER BY c.id`).all(ta.id);
  res.json({ id: ta.id, count: comments.length, comments });
});

// Delete one comment — a manager, or the person who wrote it.
router.delete('/:id/comment/:commentId', (req, res) => {
  const ta = db.prepare(`SELECT * FROM task_assignments WHERE id=?`).get(req.params.id);
  if (!ta) return res.status(404).json({ error: 'Task not found.' });
  if (!canTouch(req, ta)) return res.status(403).json({ error: 'That is not your task.' });
  const c = db.prepare(`SELECT * FROM task_comments WHERE id=? AND task_id=?`).get(req.params.commentId, ta.id);
  if (!c) return res.status(404).json({ error: 'No such comment.' });
  const isAuthor = c.author_id != null && String(c.author_id) === String(commentAuthorId(req));
  if (!isManage(req) && !isAuthor) return res.status(403).json({ error: 'You can only remove your own comment.' });
  db.prepare(`DELETE FROM task_comments WHERE id=?`).run(c.id);
  const count = db.prepare(`SELECT COUNT(*) AS n FROM task_comments WHERE task_id=?`).get(ta.id).n;
  res.json({ success: true, id: ta.id, count });
});

module.exports = router;
