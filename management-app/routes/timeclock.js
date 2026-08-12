// Time clock — staff check-in / check-out from the location Front-Desk kiosk.
//
// A manager (or opener) signs in on the tablet to "open the station" for their
// location; the kiosk then lets staff punch in/out with their employee code +
// password. The opener's login authorizes the station (and pins the location);
// each punch also verifies the staff credentials server-side. Staff can only
// punch at a location they're assigned to — so they must physically be at the
// restaurant whose station a manager opened.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const { localDate, localTime, DEFAULT_TZ } = require('../lib/tz');

const router = express.Router();
router.use(verifyToken);

const ownsLocation = (req, locId) => seesAllLocations(req.user.role) || String(req.user.location_id) === String(locId);
const locTz = (locId) => (db.prepare(`SELECT timezone FROM locations WHERE id=?`).get(locId) || {}).timezone || DEFAULT_TZ;
const validDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
const spanMin = (a, b) => { if (!a || !b) return 0; const [ah, am] = a.split(':').map(Number), [bh, bm] = b.split(':').map(Number); let s = ah * 60 + am, e = bh * 60 + bm; if (e <= s) e += 1440; return e - s; };
const fmtDurMin = (m) => { m = Math.max(0, Math.round(m)); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`; };

// Minutes a staff member is scheduled to work at a location on a date.
function scheduledMinutes(userId, locId, date) {
  return db.prepare(`SELECT start_time, end_time FROM shifts WHERE user_id=? AND location_id=? AND shift_date=?`)
    .all(userId, locId, date).reduce((m, s) => m + spanMin(s.start_time, s.end_time), 0);
}
// Live worked minutes for an entry (uses now if still on the clock).
const liveWorked = (e) => e.worked_minutes != null ? e.worked_minutes
  : Math.max(0, Math.round((Date.now() - new Date(e.clock_in).getTime()) / 60000));

// ── Staff punch (check-in / check-out) ───────────────────────────────────────
// Authorized by an opener (manager+) whose session pins the station's location.
router.post('/punch', requireRole(...ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.body.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'This station is not your location.' });
  const code = String(req.body.employee_code || '').trim();
  const password = String(req.body.password || '');
  const action = req.body.action;
  if (!code || !password) return res.status(400).json({ error: 'Employee code and password are required.' });
  if (!['in', 'out'].includes(action)) return res.status(400).json({ error: 'action must be "in" or "out".' });

  const staff = db.prepare(`SELECT id, name, role, password_hash FROM users WHERE (employee_code=? OR lower(email)=?) AND is_active=1`).get(code, code.toLowerCase());
  if (!staff || !bcrypt.compareSync(password, staff.password_hash)) {
    auditLog(req, 'clock_denied', 'user', null, { location_id: locId, code });
    return res.status(401).json({ error: 'Invalid employee code or password.' });
  }
  const linked = db.prepare(`SELECT 1 FROM users WHERE id=? AND location_id=?
    UNION SELECT 1 FROM staff_locations WHERE user_id=? AND location_id=?`).get(staff.id, locId, staff.id, locId);
  if (!linked) return res.status(403).json({ error: `${staff.name} is not assigned to this location.` });

  const tz = locTz(locId);
  const date = localDate(tz); // "today" in the location's local timezone
  const open = db.prepare(`SELECT * FROM time_entries WHERE user_id=? AND location_id=? AND work_date=? AND clock_out IS NULL ORDER BY id DESC LIMIT 1`).get(staff.id, locId, date);

  if (action === 'in') {
    if (open) return res.status(409).json({ error: `${staff.name} is already checked in (since ${localTime(tz, new Date(open.clock_in))}).` });
    const sched = scheduledMinutes(staff.id, locId, date);
    const now = new Date();
    db.prepare(`INSERT INTO time_entries (user_id, location_id, work_date, clock_in, scheduled_minutes, opened_by) VALUES (?,?,?,?,?,?)`)
      .run(staff.id, locId, date, now.toISOString(), sched, req.user.id);
    auditLog(req, 'clock_in', 'user', staff.id, { location_id: locId, scheduled_minutes: sched });
    return res.json({ success: true, action: 'in', staff: staff.name, at: localTime(tz, now), scheduled_minutes: sched });
  }

  // check-out
  if (!open) return res.status(409).json({ error: `${staff.name} is not checked in.` });
  const now = new Date();
  const worked = Math.max(0, Math.round((now.getTime() - new Date(open.clock_in).getTime()) / 60000));
  const sched = open.scheduled_minutes || 0;
  const shortBy = sched - worked;
  const isShort = sched > 0 && worked < sched;
  if (isShort && !req.body.confirm_short) {
    return res.json({ success: false, warning: 'short_shift', staff: staff.name, worked_minutes: worked, scheduled_minutes: sched, short_by: shortBy,
      message: `${staff.name} has worked ${fmtDurMin(worked)} of ${fmtDurMin(sched)} scheduled — ${fmtDurMin(shortBy)} short. Check out anyway?` });
  }
  db.prepare(`UPDATE time_entries SET clock_out=?, worked_minutes=?, short_confirmed=? WHERE id=?`).run(now.toISOString(), worked, isShort ? 1 : 0, open.id);
  if (isShort) {
    const msg = `${staff.name} checked out ${fmtDurMin(shortBy)} early — worked ${fmtDurMin(worked)} of ${fmtDurMin(sched)} scheduled.`;
    db.prepare(`INSERT INTO staff_alerts (location_id, user_id, kind, message, time_entry_id) VALUES (?,?,?,?,?)`).run(locId, staff.id, 'short_shift', msg, open.id);
  }
  auditLog(req, 'clock_out', 'user', staff.id, { location_id: locId, worked_minutes: worked, short: isShort ? 1 : 0 });
  return res.json({ success: true, action: 'out', staff: staff.name, at: localTime(tz, now), worked_minutes: worked, scheduled_minutes: sched,
    overtime_minutes: Math.max(0, worked - sched), short: isShort });
});

// ── Manager / GM / Owner: today's clock board for a location ──────────────────
router.get('/board', requireRole(...ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const loc = db.prepare(`SELECT id, name, timezone FROM locations WHERE id=?`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const tz = loc.timezone || DEFAULT_TZ;
  const today = localDate(tz);
  const date = validDate(req.query.date) || today;

  const entries = db.prepare(`SELECT te.*, u.name, u.employee_code FROM time_entries te JOIN users u ON u.id=te.user_id
    WHERE te.location_id=? AND te.work_date=? ORDER BY te.clock_in`).all(locId, date);
  const byUser = {};
  const rows = entries.map(e => {
    const worked = liveWorked(e);
    byUser[e.user_id] = true;
    return {
      user_id: e.user_id, name: e.name, employee_code: e.employee_code,
      clock_in: localTime(tz, new Date(e.clock_in)), clock_out: e.clock_out ? localTime(tz, new Date(e.clock_out)) : null,
      status: e.clock_out ? 'out' : 'in',
      scheduled_minutes: e.scheduled_minutes, worked_minutes: worked,
      overtime_minutes: Math.max(0, worked - (e.scheduled_minutes || 0)),
      short: e.short_confirmed ? 1 : 0,
    };
  });
  // Scheduled today but no punch yet → "not in".
  const scheduled = db.prepare(`SELECT DISTINCT u.id, u.name, u.employee_code,
      MIN(s.start_time) AS start_time, MAX(s.end_time) AS end_time
    FROM shifts s JOIN users u ON u.id=s.user_id
    WHERE s.location_id=? AND s.shift_date=? GROUP BY u.id ORDER BY u.name`).all(locId, date);
  const notIn = scheduled.filter(s => !byUser[s.id]).map(s => ({
    user_id: s.id, name: s.name, employee_code: s.employee_code,
    scheduled_minutes: spanMin(s.start_time, s.end_time), start_time: s.start_time, end_time: s.end_time,
  }));
  res.json({
    location: loc, date, today, timezone: tz, entries: rows, not_in: notIn,
    summary: {
      on_clock: rows.filter(r => r.status === 'in').length,
      done: rows.filter(r => r.status === 'out').length,
      not_in: notIn.length,
      short: rows.filter(r => r.short).length,
      overtime: rows.filter(r => r.overtime_minutes > 0).length,
    },
  });
});

// ── Payroll / overtime export for a pay period ───────────────────────────────
// Overtime is derived from clocked hours per California's daily rule:
//   regular ≤ 8h/day, overtime (1.5×) for 8–12h/day, double-time (2×) beyond 12h/day.
const OT_AFTER_MIN = 8 * 60, DT_AFTER_MIN = 12 * 60, OT_MULT = 1.5, DT_MULT = 2;
const addDaysIso = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const mondayOf = (iso) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const round2 = (n) => Math.round(n * 100) / 100;

router.get('/payroll', requireRole(...ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const loc = db.prepare(`SELECT id, name, timezone FROM locations WHERE id=?`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const tz = loc.timezone || DEFAULT_TZ;
  const today = localDate(tz);
  const start = validDate(req.query.start) || mondayOf(today);
  const end = validDate(req.query.end) || addDaysIso(start, 6);

  // Completed punches in range → sum worked minutes per person per day, then apply
  // the daily overtime split.
  const rows = db.prepare(`SELECT te.user_id, u.name, u.employee_code, u.role, u.hourly_rate,
      te.work_date, te.worked_minutes
    FROM time_entries te JOIN users u ON u.id=te.user_id
    WHERE te.location_id=? AND te.work_date BETWEEN ? AND ? AND te.clock_out IS NOT NULL`).all(locId, start, end);
  const byUser = {};
  for (const r of rows) {
    const u = byUser[r.user_id] || (byUser[r.user_id] = { user_id: r.user_id, name: r.name, employee_code: r.employee_code, role: r.role, rate: r.hourly_rate || 0, days: {} });
    u.days[r.work_date] = (u.days[r.work_date] || 0) + (r.worked_minutes || 0);
  }
  const staff = Object.values(byUser).map(u => {
    let reg = 0, ot = 0, dt = 0, total = 0;
    const days = Object.values(u.days);
    for (const m of days) {
      total += m;
      reg += Math.min(m, OT_AFTER_MIN);
      ot += Math.min(Math.max(m - OT_AFTER_MIN, 0), DT_AFTER_MIN - OT_AFTER_MIN);
      dt += Math.max(m - DT_AFTER_MIN, 0);
    }
    const h = (min) => round2(min / 60);
    const rate = u.rate || 0;
    const gross = rate ? round2(h(reg) * rate + h(ot) * rate * OT_MULT + h(dt) * rate * DT_MULT) : null;
    return {
      user_id: u.user_id, name: u.name, employee_code: u.employee_code, role: u.role,
      days: days.length, total_hours: h(total), regular_hours: h(reg), ot_hours: h(ot), dt_hours: h(dt),
      rate: rate || null, gross_pay: gross,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const sum = (k) => round2(staff.reduce((t, s) => t + (s[k] || 0), 0));
  res.json({
    location: loc, start, end, timezone: tz,
    rules: { ot_after_h: OT_AFTER_MIN / 60, dt_after_h: DT_AFTER_MIN / 60, ot_mult: OT_MULT, dt_mult: DT_MULT },
    staff,
    totals: { staff: staff.length, total_hours: sum('total_hours'), regular_hours: sum('regular_hours'), ot_hours: sum('ot_hours'), dt_hours: sum('dt_hours'), gross_pay: sum('gross_pay') },
  });
});

// ── Short-shift alerts for a location ─────────────────────────────────────────
router.get('/alerts', requireRole(...ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const rows = db.prepare(`SELECT sa.id, sa.kind, sa.message, sa.created_at, sa.user_id, u.name
    FROM staff_alerts sa LEFT JOIN users u ON u.id=sa.user_id
    WHERE sa.location_id=? AND sa.resolved=0 ORDER BY sa.created_at DESC`).all(locId);
  res.json({ alerts: rows });
});

router.post('/alerts/:id/resolve', requireRole(...ROLES.MANAGE), (req, res) => {
  const a = db.prepare(`SELECT * FROM staff_alerts WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Alert not found.' });
  if (!ownsLocation(req, a.location_id)) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`UPDATE staff_alerts SET resolved=1 WHERE id=?`).run(a.id);
  auditLog(req, 'alert_resolve', 'staff_alert', a.id, { location_id: a.location_id });
  res.json({ success: true });
});

module.exports = router;
