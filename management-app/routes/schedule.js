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

const JOB_KINDS = ['standard', 'specific'];
const JOB_FIELDS = ['code', 'name', 'description', 'department', 'complexity', 'est_minutes', 'notes', 'kind'];
// Managers can grow the shared catalog too, not just owner/admin.
router.post('/jobs', requireRole(...ROLES.MANAGE), (req, res) => {
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Job name is required.' });
  const code = (req.body.code || '').toString().trim() || null;
  if (code && db.prepare(`SELECT id FROM jobs WHERE code=?`).get(code)) return res.status(409).json({ error: 'That Job ID is already in use.' });
  const complexity = COMPLEXITY.includes(req.body.complexity) ? req.body.complexity : 'medium';
  const kind = JOB_KINDS.includes(req.body.kind) ? req.body.kind : 'standard';
  const r = db.prepare(`INSERT INTO jobs (code,name,description,department,complexity,est_minutes,notes,kind) VALUES (?,?,?,?,?,?,?,?)`)
    .run(code, name, req.body.description || null, req.body.department || null, complexity,
      req.body.est_minutes ? parseInt(req.body.est_minutes, 10) : null, req.body.notes || null, kind);
  auditLog(req, 'job_create', 'job', r.lastInsertRowid, { name, code, kind });
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
    if (k === 'kind' && !JOB_KINDS.includes(req.body[k])) return;
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

// ── Day tasks — assign specific tasks to that day's working staff ────────────
router.get('/day-tasks', requireRole(...ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const loc = db.prepare(`SELECT id, name FROM locations WHERE id=?`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : fmtLocal(new Date());
  // Each working person's shift hours that day, so the manager can pick a task time inside them.
  const shiftRows = db.prepare(`SELECT u.id, u.name, u.role, s.start_time, s.end_time
    FROM shifts s JOIN users u ON u.id=s.user_id
    WHERE s.location_id=? AND s.shift_date=? ORDER BY u.name, s.start_time`).all(locId, date);
  const workingBy = {};
  for (const r of shiftRows) {
    const w = workingBy[r.id] || (workingBy[r.id] = { id: r.id, name: r.name, role: r.role, hours: [] });
    w.hours.push({ start_time: r.start_time, end_time: r.end_time });
  }
  const working = Object.values(workingBy).map(w => ({
    ...w,
    start_time: w.hours.reduce((a, h) => a < h.start_time ? a : h.start_time, w.hours[0].start_time),
    end_time: w.hours.reduce((a, h) => a > h.end_time ? a : h.end_time, w.hours[0].end_time),
  }));
  const tasks = db.prepare(`
    SELECT j.id AS job_id, j.code, j.name, j.description, j.department, j.complexity, j.est_minutes,
           ta.user_id, ta.task_time, ta.done, u.name AS assignee_name
    FROM jobs j
    LEFT JOIN task_assignments ta ON ta.job_id=j.id AND ta.location_id=? AND ta.task_date=?
    LEFT JOIN users u ON u.id=ta.user_id
    WHERE j.kind='specific' AND j.is_active=1
    ORDER BY j.department, j.name`).all(locId, date);
  const assigned = tasks.filter(t => t.user_id).length;
  res.json({ location: loc, date, working, tasks, summary: { total: tasks.length, assigned, unassigned: tasks.length - assigned } });
});

// Assign / unassign / complete a specific task for a location + date.
router.put('/day-tasks', requireRole(...ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.body.location_id, 10);
  const jobId = parseInt(req.body.job_id, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : null;
  if (!locId || !jobId || !date) return res.status(400).json({ error: 'location_id, job_id and date are required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const job = db.prepare(`SELECT id, kind FROM jobs WHERE id=? AND is_active=1`).get(jobId);
  if (!job || job.kind !== 'specific') return res.status(400).json({ error: 'That is not an assignable day task.' });
  const hasUser = Object.prototype.hasOwnProperty.call(req.body, 'user_id');
  const userId = hasUser ? (req.body.user_id ? parseInt(req.body.user_id, 10) : null) : undefined;
  const shiftsFor = (uid) => db.prepare(`SELECT start_time, end_time FROM shifts WHERE user_id=? AND location_id=? AND shift_date=?`).all(uid, locId, date);
  if (hasUser && userId && !shiftsFor(userId).length) {
    return res.status(400).json({ error: 'Assign the task to someone working that day.' });
  }
  const hasTime = Object.prototype.hasOwnProperty.call(req.body, 'time');
  let time = undefined;
  if (hasTime) {
    time = req.body.time ? String(req.body.time).trim() : null;
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ error: 'Time must be HH:MM (24-hour).' });
  }
  const done = req.body.done !== undefined ? (req.body.done ? 1 : 0) : null;
  const existing = db.prepare(`SELECT id, user_id, task_time, done FROM task_assignments WHERE location_id=? AND task_date=? AND job_id=?`).get(locId, date, jobId);
  const nu = hasUser ? userId : (existing ? existing.user_id : null);
  let nt = hasTime ? time : (existing ? existing.task_time : null);
  // A task time must fall inside one of the assignee's shifts that day.
  if (nt) {
    if (!nu) return res.status(400).json({ error: 'Assign the task to someone before setting a time.' });
    const spans = shiftsFor(nu);
    const inHours = spans.some(s => nt >= s.start_time && nt <= s.end_time);
    if (!inHours) {
      if (hasTime) {
        const hrs = spans.map(s => `${s.start_time}–${s.end_time}`).join(', ');
        return res.status(400).json({ error: `Pick a time within the staff's working hours (${hrs}).` });
      }
      nt = null; // reassigned to someone whose hours don't cover the old time — drop it
    }
  }
  if (existing) {
    const nd = done !== null ? done : existing.done;
    db.prepare(`UPDATE task_assignments SET user_id=?, task_time=?, done=?, updated_at=datetime('now') WHERE id=?`).run(nu, nt, nd, existing.id);
  } else {
    db.prepare(`INSERT INTO task_assignments (location_id, task_date, job_id, user_id, task_time, done, created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(locId, date, jobId, nu, nt, done || 0, req.user.id);
  }
  auditLog(req, 'day_task_assign', 'job', jobId, { location_id: locId, date, user_id: hasUser ? userId : undefined, time: hasTime ? time : undefined, done });
  res.json({ success: true });
});

// ── Weekly schedule ──────────────────────────────────────────────────────────
// Staff schedulable at a location: home location OR an "also works at" location.
// Any shift-scheduled role (manager/support/driver and all job-title positions —
// i.e. everyone whose scope isn't "all locations").
function locationStaff(locId) {
  const roles = ROLES.SCHEDULED;
  const ph = roles.map(() => '?').join(',');
  return db.prepare(`
    SELECT DISTINCT u.id, u.name, u.role, u.location_id AS home_location_id
    FROM users u
    LEFT JOIN staff_locations sl ON sl.user_id = u.id
    WHERE u.is_active=1 AND u.role IN (${ph})
      AND (u.location_id = ? OR sl.location_id = ?)
    ORDER BY u.name
  `).all(...roles, locId, locId);
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
  const breaksBy = db.prepare(`SELECT id, start_time, end_time, label FROM shift_breaks WHERE shift_id=? ORDER BY start_time`);
  // Specific day-tasks assigned to this person for the shift's date + location.
  const tasksBy = db.prepare(`SELECT j.id, j.code, j.name, j.complexity, ta.task_time, ta.done
    FROM task_assignments ta JOIN jobs j ON j.id = ta.job_id
    WHERE ta.user_id = ? AND ta.task_date = ? AND ta.location_id = ? ORDER BY ta.task_time IS NULL, ta.task_time, j.name`);
  const byUser = {};
  for (const s of rows) {
    s.jobs = jobsBy.all(s.id);
    s.breaks = breaksBy.all(s.id);
    s.tasks = tasksBy.all(s.user_id, s.shift_date, s.location_id);
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
// Replace a shift's breaks. Rules: 10 min each (end auto-computed from start);
// only within the shift; a break needs the shift to be 3.5h+; and a staff member
// gets at most 2 breaks per DAY (across all their shifts that day) unless the day
// totals more than 10 hours worked, in which case there's no per-day limit.
const BREAK_MIN = 10;
const MIN_BREAK_HOURS = 3.5;
const DAY_BREAK_CAP = 2;
const LONG_DAY_HOURS = 10;
const MAX_SHIFT_BREAKS = 24; // sanity ceiling
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const spanHours = (a, b) => { let s = toMin(a), e = toMin(b); if (e <= s) e += 1440; return (e - s) / 60; };
const fmtMin = (m) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
function setShiftBreaks(shiftId, userId, shiftDate, breaks, shiftStart, shiftEnd) {
  db.prepare(`DELETE FROM shift_breaks WHERE shift_id=?`).run(shiftId);
  const valid = (t) => /^\d{2}:\d{2}$/.test(t);
  if (!Array.isArray(breaks) || !valid(shiftStart) || !valid(shiftEnd)) return;
  const st = toMin(shiftStart); let en = toMin(shiftEnd); if (en <= st) en += 1440;
  const thisH = (en - st) / 60;
  if (thisH < MIN_BREAK_HOURS) return;                       // per-shift gate
  // Day totals from the person's OTHER shifts that day (this shift's breaks were just cleared).
  const others = db.prepare(`SELECT s.start_time, s.end_time,
      (SELECT COUNT(*) FROM shift_breaks b WHERE b.shift_id=s.id) AS bc
    FROM shifts s WHERE s.user_id=? AND s.shift_date=? AND s.id<>?`).all(userId, shiftDate, shiftId);
  let otherH = 0, otherBreaks = 0;
  for (const o of others) { if (valid(o.start_time) && valid(o.end_time)) otherH += spanHours(o.start_time, o.end_time); otherBreaks += o.bc; }
  const dayHours = otherH + thisH;
  const dayAllowed = dayHours > LONG_DAY_HOURS ? MAX_SHIFT_BREAKS : Math.max(0, DAY_BREAK_CAP - otherBreaks);
  if (dayAllowed <= 0) return;
  const ins = db.prepare(`INSERT INTO shift_breaks (shift_id, start_time, end_time, label) VALUES (?,?,?,?)`);
  let count = 0;
  for (const b of breaks) {
    if (count >= dayAllowed) break;
    const s = String(b.start_time || '').slice(0, 5);
    if (!valid(s)) continue;
    let bs = toMin(s); if (bs < st) bs += 1440;              // normalize into the shift window
    if (bs < st || bs + BREAK_MIN > en) continue;            // must fit inside the shift
    ins.run(shiftId, s, fmtMin(toMin(s) + BREAK_MIN), (b.label ? String(b.label).slice(0, 40) : null));
    count++;
  }
}

router.post('/shifts', requireRole(...ROLES.MANAGE), (req, res) => {
  const p = prepareShift(req, res);
  if (!p) return;
  const r = db.prepare(`INSERT INTO shifts (user_id,location_id,shift_date,start_time,end_time,notes,created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(p.userId, p.locId, req.body.shift_date, req.body.start_time || null, req.body.end_time || null, req.body.notes || null, req.user.id);
  setShiftJobs(Number(r.lastInsertRowid), p.jobIds);
  setShiftBreaks(Number(r.lastInsertRowid), p.userId, req.body.shift_date, req.body.breaks, req.body.start_time, req.body.end_time);
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
  if (Array.isArray(req.body.breaks)) {
    const es = req.body.start_time !== undefined ? req.body.start_time : shift.start_time;
    const ee = req.body.end_time !== undefined ? req.body.end_time : shift.end_time;
    const ed = req.body.shift_date !== undefined ? req.body.shift_date : shift.shift_date;
    setShiftBreaks(shift.id, shift.user_id, ed, req.body.breaks, es, ee);
  }
  auditLog(req, 'shift_update', 'shift', shift.id, { date: shift.shift_date });
  res.json({ success: true });
});

router.delete('/shifts/:id', requireRole(...ROLES.MANAGE), (req, res) => {
  const shift = db.prepare(`SELECT * FROM shifts WHERE id=?`).get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  if (!ownsLocation(req, shift.location_id)) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`DELETE FROM shift_jobs WHERE shift_id=?`).run(shift.id);
  db.prepare(`DELETE FROM shift_breaks WHERE shift_id=?`).run(shift.id);
  db.prepare(`DELETE FROM shifts WHERE id=?`).run(shift.id);
  auditLog(req, 'shift_delete', 'shift', shift.id, { date: shift.shift_date });
  res.json({ success: true });
});

module.exports = router;
