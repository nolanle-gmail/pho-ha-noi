// Scheduling module — the job/task catalog plus the weekly staff schedule.
// Managers build shifts (with assigned jobs) for staff at their own location;
// owner/admin can schedule any location and curate the job catalog.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations, roleScope } = require('../lib/auth');
const { auditLog } = require('../lib/audit');

const router = express.Router();
router.use(verifyToken);

const ownsLocation = (req, locId) => seesAllLocations(req.user.role) || String(req.user.location_id) === String(locId);
const COMPLEXITY = ['low', 'medium', 'high'];

// Local-date ISO (YYYY-MM-DD) — avoids the UTC shift that toISOString() causes
// in negative-offset timezones (e.g. US Pacific).
function fmtLocal(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
// Monday (ISO) of the week containing `dateStr` (defaults to today).
function weekStart(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  if (isNaN(d)) return weekStart(null);
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - day);
  return fmtLocal(d);
}
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return fmtLocal(d); }

// ── Job/task catalog ─────────────────────────────────────────────────────────
router.get('/jobs', requireRole(...ROLES.MANAGE), (req, res) => {
  const activeOnly = req.query.active === '1';
  res.json(db.prepare(`SELECT * FROM jobs ${activeOnly ? 'WHERE is_active=1' : ''}
    ORDER BY department, code, name`).all());
});

const JOB_FIELDS = ['code', 'name', 'description', 'department', 'complexity', 'est_minutes', 'notes'];
// Managers can grow the shared catalog too, not just owner/admin.
router.post('/jobs', requireRole(...ROLES.MANAGE), (req, res) => {
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Job name is required.' });
  const code = (req.body.code || '').toString().trim() || null;
  if (code && db.prepare(`SELECT id FROM jobs WHERE code=?`).get(code)) return res.status(409).json({ error: 'That Job ID is already in use.' });
  const complexity = COMPLEXITY.includes(req.body.complexity) ? req.body.complexity : 'medium';
  const r = db.prepare(`INSERT INTO jobs (code,name,description,department,complexity,est_minutes,notes) VALUES (?,?,?,?,?,?,?)`)
    .run(code, name, req.body.description || null, req.body.department || null, complexity,
      req.body.est_minutes ? parseInt(req.body.est_minutes, 10) : null, req.body.notes || null);
  auditLog(req, 'job_create', 'job', r.lastInsertRowid, { name, code });
  res.json({ success: true, id: r.lastInsertRowid });
});

router.put('/jobs/:id', requireRole(...ROLES.MANAGE), (req, res) => {
  const job = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (req.body.code !== undefined && req.body.code !== job.code) {
    const dup = db.prepare(`SELECT id FROM jobs WHERE code=? AND id<>?`).get(req.body.code, job.id);
    if (dup) return res.status(409).json({ error: 'That Job ID is already in use.' });
  }
  const fields = [], vals = [];
  JOB_FIELDS.forEach(k => {
    if (req.body[k] === undefined) return;
    if (k === 'complexity' && !COMPLEXITY.includes(req.body[k])) return;
    if (k === 'est_minutes') { fields.push('est_minutes=?'); vals.push(req.body[k] === '' || req.body[k] == null ? null : parseInt(req.body[k], 10)); return; }
    fields.push(`${k}=?`); vals.push(req.body[k] === '' ? null : req.body[k]);
  });
  if (req.body.is_active !== undefined) { fields.push('is_active=?'); vals.push(req.body.is_active ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  vals.push(job.id);
  db.prepare(`UPDATE jobs SET ${fields.join(',')} WHERE id=?`).run(...vals);
  auditLog(req, 'job_update', 'job', job.id, { name: job.name });
  res.json({ success: true });
});

// Soft-delete (retire) a job so historical shift assignments stay intact.
router.delete('/jobs/:id', requireRole(...ROLES.MANAGE), (req, res) => {
  const job = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  db.prepare(`UPDATE jobs SET is_active=0 WHERE id=?`).run(job.id);
  auditLog(req, 'job_retire', 'job', job.id, { name: job.name });
  res.json({ success: true });
});

// ── Weekly schedule ──────────────────────────────────────────────────────────
// Staff schedulable at a location: home location OR an "also works at" location.
function locationStaff(locId) {
  return db.prepare(`
    SELECT DISTINCT u.id, u.name, u.role, u.location_id AS home_location_id
    FROM users u
    LEFT JOIN staff_locations sl ON sl.user_id = u.id
    WHERE u.is_active=1 AND u.role IN ('manager','support','employee')
      AND (u.location_id = ? OR sl.location_id = ?)
    ORDER BY CASE u.role WHEN 'manager' THEN 0 WHEN 'support' THEN 1 ELSE 2 END, u.name
  `).all(locId, locId);
}
function shiftsForUsers(userIds, weekStartIso) {
  if (!userIds.length) return {};
  const end = addDays(weekStartIso, 6);
  const ph = userIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT s.*, l.name AS location_name
    FROM shifts s JOIN locations l ON l.id = s.location_id
    WHERE s.user_id IN (${ph}) AND s.shift_date BETWEEN ? AND ?
    ORDER BY s.shift_date, s.start_time
  `).all(...userIds, weekStartIso, end);
  const jobsBy = db.prepare(`SELECT sj.shift_id, j.id, j.code, j.name, j.complexity, j.department
    FROM shift_jobs sj JOIN jobs j ON j.id = sj.job_id WHERE sj.shift_id = ?`);
  const byUser = {};
  for (const s of rows) {
    s.jobs = jobsBy.all(s.id);
    (byUser[s.user_id] = byUser[s.user_id] || []).push(s);
  }
  return byUser;
}

router.get('/week', requireRole(...ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const loc = db.prepare(`SELECT id, name FROM locations WHERE id=?`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const ws = weekStart(req.query.week);
  const staff = locationStaff(locId);
  const byUser = shiftsForUsers(staff.map(s => s.id), ws);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  res.json({
    location: loc,
    week_start: ws,
    days,
    staff: staff.map(s => ({ ...s, shifts: byUser[s.id] || [] })),
  });
});

// Any signed-in staff member can see their own week (all locations they work).
router.get('/my-week', (req, res) => {
  const ws = weekStart(req.query.week);
  const byUser = shiftsForUsers([req.user.id], ws);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  res.json({ week_start: ws, days, shifts: byUser[req.user.id] || [] });
});

// Validate + normalize a shift body against a location the requester owns.
function prepareShift(req, res) {
  const locId = parseInt(req.body.location_id, 10);
  const userId = parseInt(req.body.user_id, 10);
  if (!locId || !userId || !req.body.shift_date) { res.status(400).json({ error: 'user_id, location_id and shift_date are required.' }); return null; }
  if (!ownsLocation(req, locId)) { res.status(403).json({ error: 'You can only schedule your own location.' }); return null; }
  const user = db.prepare(`SELECT id, role FROM users WHERE id=? AND is_active=1`).get(userId);
  if (!user) { res.status(404).json({ error: 'Staff member not found.' }); return null; }
  if (roleScope(user.role) === 'all') { res.status(400).json({ error: 'This access level is not shift-scheduled.' }); return null; }
  // The person must actually belong to this location (home or also-works).
  const linked = db.prepare(`SELECT 1 FROM users WHERE id=? AND location_id=?
    UNION SELECT 1 FROM staff_locations WHERE user_id=? AND location_id=?`).get(userId, locId, userId, locId);
  if (!linked) { res.status(400).json({ error: 'That staff member is not assigned to this location.' }); return null; }
  const jobIds = Array.isArray(req.body.job_ids) ? [...new Set(req.body.job_ids.map(n => parseInt(n, 10)).filter(Boolean))] : [];
  return { locId, userId, jobIds };
}
function setShiftJobs(shiftId, jobIds) {
  db.prepare(`DELETE FROM shift_jobs WHERE shift_id=?`).run(shiftId);
  if (!jobIds.length) return;
  const ins = db.prepare(`INSERT OR IGNORE INTO shift_jobs (shift_id, job_id) VALUES (?,?)`);
  const valid = db.prepare(`SELECT id FROM jobs WHERE id=?`);
  for (const jid of jobIds) if (valid.get(jid)) ins.run(shiftId, jid);
}

router.post('/shifts', requireRole(...ROLES.MANAGE), (req, res) => {
  const p = prepareShift(req, res);
  if (!p) return;
  const r = db.prepare(`INSERT INTO shifts (user_id,location_id,shift_date,start_time,end_time,notes,created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(p.userId, p.locId, req.body.shift_date, req.body.start_time || null, req.body.end_time || null, req.body.notes || null, req.user.id);
  setShiftJobs(Number(r.lastInsertRowid), p.jobIds);
  auditLog(req, 'shift_create', 'shift', r.lastInsertRowid, { user_id: p.userId, location_id: p.locId, date: req.body.shift_date });
  res.json({ success: true, id: r.lastInsertRowid });
});

router.put('/shifts/:id', requireRole(...ROLES.MANAGE), (req, res) => {
  const shift = db.prepare(`SELECT * FROM shifts WHERE id=?`).get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  if (!ownsLocation(req, shift.location_id)) return res.status(403).json({ error: 'Not your location.' });
  const fields = [], vals = [];
  ['shift_date', 'start_time', 'end_time', 'notes'].forEach(k => {
    if (req.body[k] !== undefined) { fields.push(`${k}=?`); vals.push(req.body[k] === '' ? null : req.body[k]); }
  });
  if (fields.length) { vals.push(shift.id); db.prepare(`UPDATE shifts SET ${fields.join(',')} WHERE id=?`).run(...vals); }
  if (Array.isArray(req.body.job_ids)) setShiftJobs(shift.id, [...new Set(req.body.job_ids.map(n => parseInt(n, 10)).filter(Boolean))]);
  auditLog(req, 'shift_update', 'shift', shift.id, { date: shift.shift_date });
  res.json({ success: true });
});

router.delete('/shifts/:id', requireRole(...ROLES.MANAGE), (req, res) => {
  const shift = db.prepare(`SELECT * FROM shifts WHERE id=?`).get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  if (!ownsLocation(req, shift.location_id)) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`DELETE FROM shift_jobs WHERE shift_id=?`).run(shift.id);
  db.prepare(`DELETE FROM shifts WHERE id=?`).run(shift.id);
  auditLog(req, 'shift_delete', 'shift', shift.id, { date: shift.shift_date });
  res.json({ success: true });
});

module.exports = router;
