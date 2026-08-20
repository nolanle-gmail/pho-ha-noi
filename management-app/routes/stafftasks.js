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
           (tp.task_id IS NOT NULL) AS has_photo
    FROM task_assignments ta
    JOIN jobs j ON j.id=ta.job_id
    JOIN locations l ON l.id=ta.location_id
    LEFT JOIN task_photos tp ON tp.task_id=ta.id
    WHERE ta.user_id=? AND ta.task_date=? ORDER BY ta.task_time IS NULL, ta.task_time, j.name`).all(uid, date)
    .map(t => ({ ...t, done: !!t.done, has_photo: !!t.has_photo }));
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

// Upload the proof photo (raw image bytes; Content-Type is the image type). One
// photo per task — re-uploading replaces it. Kept small and stored in the DB.
router.post('/:id/photo', express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }), (req, res) => {
  const ta = db.prepare(`SELECT * FROM task_assignments WHERE id=?`).get(req.params.id);
  if (!ta) return res.status(404).json({ error: 'Task not found.' });
  if (!canTouch(req, ta)) return res.status(403).json({ error: 'That is not your task.' });
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!OK_IMAGE.test(mime)) return res.status(415).json({ error: 'Please upload an image (JPG, PNG, WEBP or HEIC).' });
  const bytes = req.body;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return res.status(400).json({ error: 'No image received.' });
  const uploadedBy = req.service ? (req.query.user_id ? parseInt(req.query.user_id, 10) : ta.user_id) : req.user.id;
  db.prepare(`INSERT INTO task_photos (task_id, mime, bytes, byte_size, uploaded_by, uploaded_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(task_id) DO UPDATE SET mime=excluded.mime, bytes=excluded.bytes, byte_size=excluded.byte_size, uploaded_by=excluded.uploaded_by, uploaded_at=excluded.uploaded_at`)
    .run(ta.id, mime, bytes, bytes.length, uploadedBy);
  res.json({ success: true, id: ta.id, has_photo: true, byte_size: bytes.length });
});

// Fetch the stored proof photo (owner or a manager).
router.get('/:id/photo', (req, res) => {
  const ta = db.prepare(`SELECT * FROM task_assignments WHERE id=?`).get(req.params.id);
  if (!ta) return res.status(404).json({ error: 'Task not found.' });
  if (!canTouch(req, ta)) return res.status(403).json({ error: 'That is not your task.' });
  const p = db.prepare(`SELECT mime, bytes FROM task_photos WHERE task_id=?`).get(ta.id);
  if (!p) return res.status(404).json({ error: 'No photo for this task.' });
  // node:sqlite returns a BLOB as a Uint8Array; wrap in a Buffer so Express sends
  // the raw bytes instead of JSON-serializing the typed array.
  const buf = Buffer.from(p.bytes);
  res.setHeader('Content-Type', p.mime);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.end(buf);
});

module.exports = router;
