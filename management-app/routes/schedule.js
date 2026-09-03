// Scheduling module — the job/task catalog plus the weekly staff schedule.
// Managers build shifts (with assigned jobs) for staff at their own location;
// owner/admin can schedule any location and curate the job catalog.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations, roleScope } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const { notify } = require('./messages');
const { localDate, DEFAULT_TZ } = require('../lib/tz');
const locTz = (locId) => (db.prepare(`SELECT timezone FROM locations WHERE id=?`).get(locId) || {}).timezone || DEFAULT_TZ;

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
router.get('/jobs', requireRole(ROLES.MANAGE), (req, res) => {
  const activeOnly = req.query.active === '1';
  res.json(db.prepare(`SELECT * FROM jobs ${activeOnly ? 'WHERE is_active=1' : ''}
    ORDER BY department, code, name`).all());
});

const JOB_KINDS = ['standard', 'specific'];
const JOB_FIELDS = ['code', 'name', 'description', 'department', 'complexity', 'est_minutes', 'notes', 'kind'];
// Managers can grow the shared catalog too, not just owner/admin.
router.post('/jobs', requireRole(ROLES.MANAGE), (req, res) => {
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Job name is required.' });
  const code = (req.body.code || '').toString().trim() || null;
  if (code && db.prepare(`SELECT id FROM jobs WHERE code=?`).get(code)) return res.status(409).json({ error: 'That Job ID is already in use.' });
  const complexity = COMPLEXITY.includes(req.body.complexity) ? req.body.complexity : 'medium';
  const kind = JOB_KINDS.includes(req.body.kind) ? req.body.kind : 'standard';
  const estNum = req.body.est_minutes === '' || req.body.est_minutes == null ? null : parseInt(req.body.est_minutes, 10);
  // A day task (specific) must carry an estimate so the manager can plan when to assign it.
  if (kind === 'specific' && (!Number.isFinite(estNum) || estNum <= 0)) {
    return res.status(400).json({ error: 'Estimated minutes is required for a task (a positive number).' });
  }
  const r = db.prepare(`INSERT INTO jobs (code,name,description,department,complexity,est_minutes,notes,kind) VALUES (?,?,?,?,?,?,?,?)`)
    .run(code, name, req.body.description || null, req.body.department || null, complexity,
      estNum, req.body.notes || null, kind);
  auditLog(req, 'job_create', 'job', r.lastInsertRowid, { name, code, kind });
  res.json({ success: true, id: r.lastInsertRowid });
});

router.put('/jobs/:id', requireRole(ROLES.MANAGE), (req, res) => {
  const job = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (req.body.code !== undefined && req.body.code !== job.code) {
    const dup = db.prepare(`SELECT id FROM jobs WHERE code=? AND id<>?`).get(req.body.code, job.id);
    if (dup) return res.status(409).json({ error: 'That Job ID is already in use.' });
  }
  // Keep the "task has an estimate" invariant: don't let an edit leave a specific task without one.
  const resultKind = req.body.kind !== undefined && JOB_KINDS.includes(req.body.kind) ? req.body.kind : job.kind;
  if (resultKind === 'specific') {
    const estIn = req.body.est_minutes;
    const estNum = estIn === undefined ? job.est_minutes : (estIn === '' || estIn == null ? null : parseInt(estIn, 10));
    if (!Number.isFinite(estNum) || estNum <= 0) return res.status(400).json({ error: 'Estimated minutes is required for a task (a positive number).' });
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
router.delete('/jobs/:id', requireRole(ROLES.MANAGE), (req, res) => {
  const job = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  db.prepare(`UPDATE jobs SET is_active=0 WHERE id=?`).run(job.id);
  auditLog(req, 'job_retire', 'job', job.id, { name: job.name });
  res.json({ success: true });
});

// ── Day tasks — assign specific tasks to that day's working staff ────────────
router.get('/day-tasks', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const loc = db.prepare(`SELECT id, name FROM locations WHERE id=?`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const tz = locTz(locId);
  const today = localDate(tz);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today;
  // Each working person's shift hours + breaks that day, so the manager can pick a
  // task time inside their hours but not during a break.
  const shiftRows = db.prepare(`SELECT u.id, u.name, u.role, s.id AS shift_id, s.start_time, s.end_time
    FROM shifts s JOIN users u ON u.id=s.user_id
    WHERE s.location_id=? AND s.shift_date=? AND s.kind='work' ORDER BY u.name, s.start_time`).all(locId, date);
  const breaksForShift = db.prepare(`SELECT start_time, end_time FROM shift_breaks WHERE shift_id=? ORDER BY start_time`);
  const workingBy = {};
  for (const r of shiftRows) {
    const w = workingBy[r.id] || (workingBy[r.id] = { id: r.id, name: r.name, role: r.role, hours: [], breaks: [] });
    w.hours.push({ start_time: r.start_time, end_time: r.end_time });
    for (const b of breaksForShift.all(r.shift_id)) w.breaks.push(b);
  }
  const working = Object.values(workingBy).map(w => ({
    ...w,
    breaks: w.breaks.sort((a, b) => a.start_time < b.start_time ? -1 : 1),
    start_time: w.hours.reduce((a, h) => a < h.start_time ? a : h.start_time, w.hours[0].start_time),
    end_time: w.hours.reduce((a, h) => a > h.end_time ? a : h.end_time, w.hours[0].end_time),
  }));
  const tasks = db.prepare(`
    SELECT j.id AS job_id, j.code, j.name, j.description, j.department, j.complexity, j.est_minutes,
           ta.id AS assignment_id, ta.user_id, ta.task_time, ta.done, ta.started_at, ta.done_at,
           (SELECT COUNT(*) FROM task_photos tp WHERE tp.task_id=ta.id) AS photo_count,
           (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id=ta.id) AS comment_count, u.name AS assignee_name
    FROM location_tasks lt
    JOIN jobs j ON j.id = lt.job_id
    LEFT JOIN task_assignments ta ON ta.job_id=j.id AND ta.location_id=lt.location_id AND ta.task_date=?
    LEFT JOIN users u ON u.id=ta.user_id
    WHERE lt.location_id=? AND j.kind='specific' AND j.is_active=1
    ORDER BY j.department, j.name`).all(date, locId).map(t => ({ ...t, photo_count: t.photo_count || 0, comment_count: t.comment_count || 0, has_photo: (t.photo_count || 0) > 0 }));
  const assigned = tasks.filter(t => t.user_id).length;
  res.json({ location: loc, date, today, timezone: tz, working, tasks, summary: { total: tasks.length, assigned, unassigned: tasks.length - assigned } });
});

// Assign / unassign / complete a specific task for a location + date.
router.put('/day-tasks', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.body.location_id, 10);
  const jobId = parseInt(req.body.job_id, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : null;
  if (!locId || !jobId || !date) return res.status(400).json({ error: 'location_id, job_id and date are required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const job = db.prepare(`SELECT id, name, kind, est_minutes FROM jobs WHERE id=? AND is_active=1`).get(jobId);
  if (!job || job.kind !== 'specific') return res.status(400).json({ error: 'That is not an assignable day task.' });
  if (!db.prepare(`SELECT 1 FROM location_tasks WHERE location_id=? AND job_id=?`).get(locId, jobId)) {
    return res.status(400).json({ error: "That task isn't on this location's list." });
  }
  const hasUser = Object.prototype.hasOwnProperty.call(req.body, 'user_id');
  const userId = hasUser ? (req.body.user_id ? parseInt(req.body.user_id, 10) : null) : undefined;
  const breaksForShift = db.prepare(`SELECT start_time, end_time FROM shift_breaks WHERE shift_id=? ORDER BY start_time`);
  const shiftsFor = (uid) => {
    const rows = db.prepare(`SELECT id, start_time, end_time FROM shifts WHERE user_id=? AND location_id=? AND shift_date=? AND kind='work'`).all(uid, locId, date);
    rows.forEach(s => { s.breaks = breaksForShift.all(s.id); });
    return rows;
  };
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
  if (!nu) nt = null; // an unassigned task has no owner, so it has no scheduled time either
  // A task time must fall inside one of the assignee's shifts that day, and not during a break.
  if (nt) {
    if (!nu) return res.status(400).json({ error: 'Assign the task to someone before setting a time.' });
    const spans = shiftsFor(nu);
    const inHours = spans.some(s => nt >= s.start_time && nt <= s.end_time
      && !s.breaks.some(b => nt >= b.start_time && nt < b.end_time));
    if (!inHours) {
      if (hasTime) {
        const hrs = spans.map(s => {
          const br = s.breaks.map(b => `${b.start_time}–${b.end_time}`).join(', ');
          return `${s.start_time}–${s.end_time}${br ? ` excl. break ${br}` : ''}`;
        }).join(', ');
        return res.status(400).json({ error: `Pick a time within the staff's working hours (${hrs}).` });
      }
      nt = null; // reassigned to someone whose hours don't cover the old time — drop it
    }
  }
  // Two day tasks for the same person must not overlap in time.
  if (nt && nu) {
    const dur = taskDuration(job.est_minutes);
    const s0 = toMin(nt), e0 = s0 + dur;
    const others = db.prepare(`SELECT j.name, ta.task_time, j.est_minutes FROM task_assignments ta
      JOIN jobs j ON j.id = ta.job_id
      WHERE ta.location_id=? AND ta.task_date=? AND ta.user_id=? AND ta.job_id<>? AND ta.task_time IS NOT NULL`).all(locId, date, nu, jobId);
    for (const o of others) {
      const os = toMin(o.task_time), oe = os + taskDuration(o.est_minutes);
      if (s0 < oe && os < e0) return res.status(400).json({ error: `That overlaps “${o.name}” at ${o.task_time}. Pick a free time.` });
    }
  }
  if (!nu) {
    // Unassigned ⇒ no assignment at all. Delete the row so nothing is left behind:
    // a done flag or time on a task with no owner is meaningless (and would show a
    // stale "done" tick on the board).
    if (existing) db.prepare(`DELETE FROM task_assignments WHERE id=?`).run(existing.id);
  } else if (existing) {
    const nd = done !== null ? done : existing.done;
    db.prepare(`UPDATE task_assignments SET user_id=?, task_time=?, done=?, updated_at=datetime('now') WHERE id=?`).run(nu, nt, nd, existing.id);
  } else {
    db.prepare(`INSERT INTO task_assignments (location_id, task_date, job_id, user_id, task_time, done, created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(locId, date, jobId, nu, nt, done || 0, req.user.id);
  }
  auditLog(req, 'day_task_assign', 'job', jobId, { location_id: locId, date, user_id: hasUser ? userId : undefined, time: hasTime ? time : undefined, done });
  // Notify the assignee when a task is newly assigned or handed to someone else.
  if (nu && (!existing || existing.user_id !== nu)) {
    notify(req.user.id, nu, 'New task assigned',
      `You've been assigned "${job.name}"${nt ? ` at ${nt}` : ''} on ${date}.`);
  }
  res.json({ success: true });
});

// ── Per-location task lists — which specific tasks apply at a location ────────
// The full specific-task catalog with an `enabled` flag for this location.
router.get('/location-tasks', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const loc = db.prepare(`SELECT id, name FROM locations WHERE id=?`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const catalog = db.prepare(`
    SELECT j.id AS job_id, j.code, j.name, j.description, j.department, j.complexity, j.est_minutes,
           CASE WHEN lt.job_id IS NULL THEN 0 ELSE 1 END AS enabled
    FROM jobs j
    LEFT JOIN location_tasks lt ON lt.job_id=j.id AND lt.location_id=?
    WHERE j.kind='specific' AND j.is_active=1
    ORDER BY enabled DESC, j.department, j.name`).all(locId);
  res.json({ location: loc, catalog, enabled: catalog.filter(t => t.enabled).length });
});

// Add or remove a specific task from a location's list.
router.put('/location-tasks', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.body.location_id, 10);
  const jobId = parseInt(req.body.job_id, 10);
  if (!locId || !jobId) return res.status(400).json({ error: 'location_id and job_id are required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const job = db.prepare(`SELECT id, kind FROM jobs WHERE id=? AND is_active=1`).get(jobId);
  if (!job || job.kind !== 'specific') return res.status(400).json({ error: 'That is not a specific task.' });
  const enabled = req.body.enabled === true || req.body.enabled === 1 || req.body.enabled === 'true';
  if (enabled) {
    db.prepare(`INSERT OR IGNORE INTO location_tasks (location_id, job_id, created_by) VALUES (?,?,?)`).run(locId, jobId, req.user.id);
  } else {
    db.prepare(`DELETE FROM location_tasks WHERE location_id=? AND job_id=?`).run(locId, jobId);
  }
  auditLog(req, enabled ? 'location_task_add' : 'location_task_remove', 'job', jobId, { location_id: locId });
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
  const jobsBy = db.prepare(`SELECT sj.shift_id, j.id, j.code, j.name, j.complexity, j.department, j.description, j.est_minutes
    FROM shift_jobs sj JOIN jobs j ON j.id = sj.job_id WHERE sj.shift_id = ?`);
  const breaksBy = db.prepare(`SELECT id, start_time, end_time, label FROM shift_breaks WHERE shift_id=? ORDER BY start_time`);
  // Specific day-tasks assigned to this person for the shift's date + location.
  const tasksBy = db.prepare(`SELECT j.id, j.code, j.name, j.complexity, j.description, j.est_minutes, ta.task_time, ta.done
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

router.get('/week', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const loc = db.prepare(`SELECT id, name, timezone FROM locations WHERE id=?`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const ws = weekStart(req.query.week);
  const staff = locationStaff(locId);
  const byUser = shiftsForUsers(staff.map(s => s.id), ws);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  res.json({
    location: loc,
    week_start: ws,
    days,
    today: localDate(loc.timezone || DEFAULT_TZ), // location-local "today" for the grid highlight
    timezone: loc.timezone || DEFAULT_TZ,
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

// A leave entry (sick / vacation / on-leave) carries its own hours: a full day,
// a number of hours, or a from–to span. Returns {kind, allDay, leaveHours[, error]}.
const LEAVE_KINDS = ['sick', 'vacation', 'leave'];
const SHIFT_KINDS = ['work', ...LEAVE_KINDS];
const FULL_DAY_HOURS = 8;
function leaveSpec(body) {
  const kind = SHIFT_KINDS.includes(body.kind) ? body.kind : 'work';
  if (kind === 'work') return { kind, allDay: 0, leaveHours: null };
  const allDay = body.all_day ? 1 : 0;
  let leaveHours = null;
  if (allDay) leaveHours = FULL_DAY_HOURS;
  else if (body.start_time && body.end_time) leaveHours = Math.round(spanHours(body.start_time, body.end_time) * 100) / 100;
  else { const n = parseFloat(body.leave_hours); if (Number.isFinite(n) && n > 0) leaveHours = Math.round(n * 100) / 100; }
  return { kind, allDay, leaveHours, error: leaveHours ? null : 'Leave needs a duration — all day, a number of hours, or a from–to time.' };
}

// Validate + normalize a shift body against a location the requester owns.
function prepareShift(req, res) {
  const locId = parseInt(req.body.location_id, 10);
  const userId = parseInt(req.body.user_id, 10);
  if (!locId || !userId || !req.body.shift_date) { res.status(400).json({ error: 'user_id, location_id and shift_date are required.' }); return null; }
  if (!ownsLocation(req, locId)) { res.status(403).json({ error: 'You can only schedule your own location.' }); return null; }
  const user = db.prepare(`SELECT id, role FROM users WHERE id=? AND is_active=1`).get(userId);
  if (!user) { res.status(404).json({ error: 'Staff member not found.' }); return null; }
  if (roleScope(user.role) === 'all') { res.status(400).json({ error: 'This role is not shift-scheduled.' }); return null; }
  // The person must actually belong to this location (home or also-works).
  const linked = db.prepare(`SELECT 1 FROM users WHERE id=? AND location_id=?
    UNION SELECT 1 FROM staff_locations WHERE user_id=? AND location_id=?`).get(userId, locId, userId, locId);
  if (!linked) { res.status(400).json({ error: 'That staff member is not assigned to this location.' }); return null; }
  const spec = leaveSpec(req.body);
  if (spec.error) { res.status(400).json({ error: spec.error }); return null; }
  const jobIds = spec.kind === 'work' && Array.isArray(req.body.job_ids)
    ? [...new Set(req.body.job_ids.map(n => parseInt(n, 10)).filter(Boolean))] : [];
  return { locId, userId, jobIds, ...spec };
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
// A day task occupies at least one 15-min slot, rounded up to the slot grid.
const TASK_SLOT_MIN = 15;
const taskDuration = (est) => Math.max(TASK_SLOT_MIN, Math.ceil((Number(est) || 0) / TASK_SLOT_MIN) * TASK_SLOT_MIN);
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

router.post('/shifts', requireRole(ROLES.MANAGE), (req, res) => {
  const p = prepareShift(req, res);
  if (!p) return;
  const isLeave = p.kind !== 'work';
  // Leave stores its hours; a work shift keeps start/end. From–to leave keeps its span too.
  const start = isLeave && p.allDay ? null : (req.body.start_time || null);
  const end = isLeave && p.allDay ? null : (req.body.end_time || null);
  const r = db.prepare(`INSERT INTO shifts (user_id,location_id,shift_date,start_time,end_time,notes,created_by,kind,all_day,leave_hours) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(p.userId, p.locId, req.body.shift_date, start, end, req.body.notes || null, req.user.id, p.kind, p.allDay, p.leaveHours);
  setShiftJobs(Number(r.lastInsertRowid), p.jobIds);
  if (!isLeave) setShiftBreaks(Number(r.lastInsertRowid), p.userId, req.body.shift_date, req.body.breaks, start, end);
  auditLog(req, 'shift_create', 'shift', r.lastInsertRowid, { user_id: p.userId, location_id: p.locId, date: req.body.shift_date, kind: p.kind });
  res.json({ success: true, id: r.lastInsertRowid });
});

router.put('/shifts/:id', requireRole(ROLES.MANAGE), (req, res) => {
  const shift = db.prepare(`SELECT * FROM shifts WHERE id=?`).get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found.' });
  if (!ownsLocation(req, shift.location_id)) return res.status(403).json({ error: 'Not your location.' });
  const spec = leaveSpec(req.body.kind !== undefined ? req.body : { ...req.body, kind: shift.kind || 'work' });
  if (spec.error) return res.status(400).json({ error: spec.error });
  const isLeave = spec.kind !== 'work';
  const start = isLeave && spec.allDay ? null : (req.body.start_time !== undefined ? (req.body.start_time || null) : shift.start_time);
  const end = isLeave && spec.allDay ? null : (req.body.end_time !== undefined ? (req.body.end_time || null) : shift.end_time);
  const date = req.body.shift_date !== undefined ? req.body.shift_date : shift.shift_date;
  const notes = req.body.notes !== undefined ? (req.body.notes || null) : shift.notes;
  db.prepare(`UPDATE shifts SET shift_date=?, start_time=?, end_time=?, notes=?, kind=?, all_day=?, leave_hours=? WHERE id=?`)
    .run(date, start, end, notes, spec.kind, spec.allDay, spec.leaveHours, shift.id);
  // Leave has no jobs or breaks; a work shift keeps them.
  if (isLeave) { db.prepare(`DELETE FROM shift_jobs WHERE shift_id=?`).run(shift.id); db.prepare(`DELETE FROM shift_breaks WHERE shift_id=?`).run(shift.id); }
  else {
    if (Array.isArray(req.body.job_ids)) setShiftJobs(shift.id, [...new Set(req.body.job_ids.map(n => parseInt(n, 10)).filter(Boolean))]);
    if (Array.isArray(req.body.breaks)) setShiftBreaks(shift.id, shift.user_id, date, req.body.breaks, start, end);
  }
  auditLog(req, 'shift_update', 'shift', shift.id, { date, kind: spec.kind });
  res.json({ success: true });
});

router.delete('/shifts/:id', requireRole(ROLES.MANAGE), (req, res) => {
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
