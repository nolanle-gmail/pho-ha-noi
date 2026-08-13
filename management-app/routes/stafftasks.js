// Staff-facing day tasks — a person's own "specific" task assignments for the
// day (assigned on the Management Day Tasks board), with a one-tap done toggle.
// Reached by the Staff app via the shared service key (scoped to the signed-in
// staff member) or directly by a Management JWT (self, or any for a manager).
const express = require('express');
const db = require('../db/database');
const { SECRET, ROLES } = require('../lib/auth');
const jwt = require('jsonwebtoken');

const router = express.Router();
const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

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
const actingUserId = (req) => req.service ? (req.query.user_id ? parseInt(req.query.user_id, 10) : (req.body.user_id ? parseInt(req.body.user_id, 10) : null)) : req.user.id;
const isManage = (req) => req.user && ROLES.MANAGE.includes(req.user.role);

router.get('/', (req, res) => {
  const uid = actingUserId(req);
  if (!uid) return res.status(400).json({ error: 'user_id is required.' });
  const u = db.prepare(`SELECT u.id, u.name, u.location_id, l.timezone FROM users u LEFT JOIN locations l ON l.id=u.location_id WHERE u.id=?`).get(uid);
  if (!u) return res.status(404).json({ error: 'Staff member not found.' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : localDate(u.timezone);
  const tasks = db.prepare(`
    SELECT ta.id, ta.job_id, ta.task_time, ta.done, ta.location_id, l.name AS location_name,
           j.code, j.name, j.description, j.department, j.complexity, j.est_minutes
    FROM task_assignments ta JOIN jobs j ON j.id=ta.job_id JOIN locations l ON l.id=ta.location_id
    WHERE ta.user_id=? AND ta.task_date=? ORDER BY ta.task_time IS NULL, ta.task_time, j.name`).all(uid, date)
    .map(t => ({ ...t, done: !!t.done }));
  res.json({ user: { id: u.id, name: u.name }, date, tasks, summary: { total: tasks.length, done: tasks.filter(t => t.done).length } });
});

router.put('/:id/done', (req, res) => {
  const uid = actingUserId(req);
  const ta = db.prepare(`SELECT * FROM task_assignments WHERE id=?`).get(req.params.id);
  if (!ta) return res.status(404).json({ error: 'Task not found.' });
  if (uid && String(ta.user_id) !== String(uid) && !isManage(req)) return res.status(403).json({ error: 'That is not your task.' });
  const done = req.body.done === undefined ? 1 : (req.body.done ? 1 : 0);
  db.prepare(`UPDATE task_assignments SET done=?, updated_at=datetime('now') WHERE id=?`).run(done, ta.id);
  res.json({ success: true, id: ta.id, done: !!done });
});

module.exports = router;
