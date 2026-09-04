// Time clock — staff check-in / check-out from the location Front-Desk kiosk.
//
// A manager (or opener) signs in on the tablet to "open the station" for their
// location; the kiosk then lets staff punch in/out with their employee code +
// password. The opener's login authorizes the station (and pins the location);
// each punch also verifies the staff credentials server-side. Staff can only
// punch at a location they're assigned to — so they must physically be at the
// restaurant whose station a manager opened.
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations, SECRET } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const { notify } = require('./messages');
const { localDate, localTime, DEFAULT_TZ } = require('../lib/tz');
const { normSlug } = require('../lib/slug');
const { emitAlert } = require('../lib/events');
const { sendSms, smsEnabled } = require('../lib/sms');

const router = express.Router();
const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

// My own hours — any staff member (JWT), or the Staff app on their behalf
// (service key + ?as=email). Defined before the manager auth wall below.
router.get('/my-hours', (req, res) => {
  let u;
  const key = req.headers['x-service-key'] || req.query.key;
  if (key && key === SERVICE_KEY) {
    const email = String(req.query.as || '').toLowerCase().trim();
    u = email && db.prepare(`SELECT id, name FROM users WHERE lower(email)=? AND is_active=1`).get(email);
    if (!u) return res.status(401).json({ error: 'Unknown staff member.' });
  } else {
    try { u = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); } catch { return res.status(401).json({ error: 'Authentication required' }); }
  }
  const kind = ['daily', 'weekly', 'monthly'].includes(req.query.kind) ? req.query.kind : 'weekly';
  const tz = DEFAULT_TZ, today = localDate(tz);
  const range = periodRange(kind, validDate(req.query.anchor) || today);
  res.json(Object.assign({ user: { id: u.id, name: u.name }, today }, myHoursData(u.id, range.start, range.end, kind)));
});

// ── Public per-location clock kiosk (/clock/<slug>) — no login ────────────────
// A tablet at a store opens its own URL; staff clock in/out with just an employee
// code. The physical location + code is the trust model (like the guest kiosk).
const clockRate = new Map(); // ip -> { n, t } — light abuse guard
function kioskThrottle(req, res, next) {
  const ip = req.ip || 'x', now = Date.now(), e = clockRate.get(ip);
  if (!e || now - e.t > 60000) { clockRate.set(ip, { n: 1, t: now }); return next(); }
  if (e.n >= 60) return res.status(429).json({ error: 'Too many attempts — please wait a moment.' });
  e.n++; next();
}
const locDisplay = (name) => String(name || '').replace(/\s*[—–-]\s*/, ' ');
const locBySlug = (slug) => db.prepare(`SELECT id, name, slug, timezone FROM locations WHERE is_active=1`).all()
  .find(l => normSlug(l.slug || '') === normSlug(slug) || normSlug(l.name) === normSlug(slug));
function greetingWord(tz) { const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit' }).format(new Date())) % 24; return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
const validCode = (c) => /^[A-Za-z0-9-]{6,20}$/.test(c);
const hhmmToMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
function locationLeaders(locId) {
  let ids = db.prepare(`SELECT id FROM users WHERE is_active=1 AND location_id=? AND role IN ('manager','assistant_manager','kitchen_manager')`).all(locId).map(r => r.id);
  if (!ids.length) ids = db.prepare(`SELECT id FROM users WHERE is_active=1 AND role IN ('owner','admin','general_manager')`).all().map(r => r.id);
  return ids;
}
function notifyLeaders(locId, staffId, subject, body) {
  for (const lid of locationLeaders(locId)) if (String(lid) !== String(staffId)) {
    try { notify(staffId, lid, subject, body); } catch { /* best effort */ }
    // Also text the leader's phone (best-effort; log-only until a provider is set).
    if (smsEnabled()) { try { const l = db.prepare(`SELECT phone FROM users WHERE id=?`).get(lid); if (l && l.phone) sendSms(l.phone, `${subject}: ${body}`).catch(() => {}); } catch { /* */ } }
  }
}
// Resolve location + staff + today's schedule + any open entry for a kiosk request.
function clockContext(slug, code) {
  const loc = locBySlug(slug); if (!loc) return { err: 404, msg: 'Unknown location.' };
  const c = String(code || '').trim();
  if (!validCode(c)) return { loc, err: 'format' };
  const staff = db.prepare(`SELECT id, name, role, location_id FROM users WHERE employee_code=? AND is_active=1`).get(c);
  if (!staff) return { loc, err: 'notfound' };
  const tz = loc.timezone || DEFAULT_TZ, date = localDate(tz);
  const rows = db.prepare(`SELECT location_id, start_time, end_time FROM shifts WHERE user_id=? AND shift_date=? AND kind='work'`).all(staff.id, date);
  const here = rows.filter(r => String(r.location_id) === String(loc.id));
  const elsewhere = rows.filter(r => String(r.location_id) !== String(loc.id));
  const open = db.prepare(`SELECT * FROM time_entries WHERE user_id=? AND location_id=? AND work_date=? AND clock_out IS NULL ORDER BY id DESC LIMIT 1`).get(staff.id, loc.id, date);
  return {
    loc, staff, tz, date, open,
    here: here.length > 0, elsewhere: elsewhere.length > 0,
    isHome: String(staff.location_id) === String(loc.id),
    startHere: here.map(r => r.start_time).filter(Boolean).sort()[0] || null,
    endHere: here.map(r => r.end_time).filter(Boolean).sort().slice(-1)[0] || null,
  };
}

// Active locations for the bare /clock location picker (public).
router.get('/kiosk-locations', (req, res) => {
  const locs = db.prepare(`SELECT id, name, slug FROM locations WHERE is_active=1 ORDER BY name`).all();
  res.json(locs.map(l => ({ slug: l.slug || normSlug(l.name), display: locDisplay(l.name) })));
});

// Location header for the kiosk page.
router.get('/kiosk/:slug', (req, res) => {
  const loc = locBySlug(req.params.slug);
  if (!loc) return res.status(404).json({ error: 'Unknown location.' });
  res.json({ id: loc.id, name: loc.name, display: locDisplay(loc.name) });
});

// Enter an employee code → greeting + current clock state (button setup).
router.post('/kiosk/:slug/state', kioskThrottle, (req, res) => {
  const ctx = clockContext(req.params.slug, req.body && req.body.employee_code);
  if (ctx.err === 404) return res.status(404).json({ error: ctx.msg });
  if (ctx.err === 'format') return res.json({ ok: false, kind: 'format', message: 'That employee code doesn’t look right — please check it and try again.' });
  if (ctx.err === 'notfound') return res.json({ ok: false, kind: 'notfound', message: 'Employee code not found. Please check again, or ask your manager for the correct one.' });
  const clockedIn = !!ctx.open;
  res.json({
    ok: true, name: ctx.staff.name,
    greeting: `${greetingWord(ctx.tz)} ${ctx.staff.name}, welcome to ${locDisplay(ctx.loc.name)}`,
    clocked_in: clockedIn, since: clockedIn ? localTime(ctx.tz, new Date(ctx.open.clock_in)) : null,
    can_in: !clockedIn, can_out: clockedIn,
  });
});

// Clock in / out (send {action:'in'|'out', confirm:true} to accept a warning).
router.post('/kiosk/:slug/punch', kioskThrottle, (req, res) => {
  const ctx = clockContext(req.params.slug, req.body && req.body.employee_code);
  if (ctx.err === 404) return res.status(404).json({ error: ctx.msg });
  if (ctx.err === 'format') return res.status(400).json({ error: 'That employee code doesn’t look right — please check it and try again.' });
  if (ctx.err === 'notfound') return res.status(404).json({ error: 'Employee code not found. Please check again, or ask your manager.' });
  const { loc, staff, tz, date } = ctx, confirm = !!(req.body && req.body.confirm), now = new Date();

  if ((req.body && req.body.action) === 'in') {
    if (ctx.open) return res.status(409).json({ error: `You’re already clocked in (since ${localTime(tz, new Date(ctx.open.clock_in))}).` });
    let reason = null, warn = null;
    if (ctx.here) {
      if (ctx.startHere) { const early = hhmmToMin(ctx.startHere) - localMinutesOfDay(tz, now); if (early > 30) { reason = 'early'; warn = `You’re clocking in more than 30 minutes before your ${ctx.startHere} shift. Clock in anyway?`; } }
    } else if (ctx.elsewhere) { reason = 'wrong_location'; warn = `You’re scheduled at another location today, not ${locDisplay(loc.name)}. Clock in here anyway?`; }
    else if (ctx.isHome) { reason = 'no_schedule'; warn = `You aren’t scheduled to work today. Clock in anyway?`; }
    else { reason = 'no_schedule_wrong_location'; warn = `You aren’t scheduled to work today, and this isn’t your usual location. Clock in here anyway?`; }
    if (reason && !confirm) return res.json({ confirm: true, reason, message: warn });
    const sched = scheduledMinutes(staff.id, loc.id, date), late = lateMinutesFor(staff.id, loc.id, date, tz, now);
    const info = db.prepare(`INSERT INTO time_entries (user_id, location_id, work_date, clock_in, scheduled_minutes, late_minutes, opened_by) VALUES (?,?,?,?,?,?,?)`)
      .run(staff.id, loc.id, date, now.toISOString(), sched, late, staff.id);
    if (late > 0) db.prepare(`INSERT INTO staff_alerts (location_id, user_id, kind, message, time_entry_id) VALUES (?,?,?,?,?)`).run(loc.id, staff.id, 'late', `${staff.name} checked in ${fmtDurMin(late)} late.`, info.lastInsertRowid);
    if (reason) {
      const why = { early: 'more than 30 minutes early', wrong_location: 'at a location they’re not scheduled at today', no_schedule: 'without being scheduled today', no_schedule_wrong_location: 'without being scheduled today, and at an unusual location' }[reason];
      notifyLeaders(loc.id, staff.id, 'Clock-in to review', `${staff.name} clocked in at ${locDisplay(loc.name)} ${why} (${localTime(tz, now)}). Please review it for their timesheet.`);
    }
    return res.json({ success: true, action: 'in', message: `You’re clocked in — have a great shift, ${staff.name}!`, at: localTime(tz, now) });
  }

  if ((req.body && req.body.action) === 'out') {
    if (!ctx.open) return res.status(409).json({ error: 'You’re not clocked in here.' });
    let reason = null;
    if (ctx.endHere) { const early = hhmmToMin(ctx.endHere) - localMinutesOfDay(tz, now); if (early > 30) reason = 'out_early'; }
    if (reason && !confirm) return res.json({ confirm: true, reason, message: `You’re clocking out more than 30 minutes before your ${ctx.endHere} end time. Clock out anyway?` });
    const worked = Math.max(0, Math.round((now.getTime() - new Date(ctx.open.clock_in).getTime()) / 60000));
    db.prepare(`UPDATE time_entries SET clock_out=?, worked_minutes=? WHERE id=?`).run(now.toISOString(), worked, ctx.open.id);
    if (reason) notifyLeaders(loc.id, staff.id, 'Early clock-out', `${staff.name} clocked out early at ${locDisplay(loc.name)} (${localTime(tz, now)}, worked ${fmtDurMin(worked)}). Please review it for their timesheet.`);
    return res.json({ success: true, action: 'out', message: `Goodbye ${staff.name}! You worked ${fmtDurMin(worked)} today.`, at: localTime(tz, now) });
  }
  return res.status(400).json({ error: 'Unknown action.' });
});

// Missed clock-out sweep: 30 min past a scheduled end and still clocked in →
// remind the staff member and message the location leaders (once per entry).
function sweepMissedClockOuts() {
  try {
    const open = db.prepare(`SELECT te.id, te.user_id, te.location_id, te.work_date, te.clock_in, u.name
      FROM time_entries te JOIN users u ON u.id=te.user_id WHERE te.clock_out IS NULL AND COALESCE(te.overrun_notified,0)=0`).all();
    for (const e of open) {
      const tz = locTz(e.location_id);
      const end = (db.prepare(`SELECT MAX(end_time) e FROM shifts WHERE user_id=? AND location_id=? AND shift_date=? AND kind='work'`).get(e.user_id, e.location_id, e.work_date) || {}).e;
      if (!end) continue;
      const todayLocal = localDate(tz), overBy = localMinutesOfDay(tz, new Date()) - hhmmToMin(end);
      if (e.work_date >= todayLocal && overBy < 30) continue; // not yet 30 min past today's end
      const disp = locDisplay((db.prepare(`SELECT name FROM locations WHERE id=?`).get(e.location_id) || {}).name);
      try { notify(e.user_id, e.user_id, 'Don’t forget to clock out', `Your shift at ${disp} ended around ${end} and you’re still clocked in. Please clock out — otherwise a manager will review your extra hours.`); } catch { /* */ }
      notifyLeaders(e.location_id, e.user_id, 'Missed clock-out', `${e.name} is still clocked in at ${disp} past their ${end} end time. Confirm whether they should keep working; otherwise clock them out from the Time Clock board.`);
      db.prepare(`UPDATE time_entries SET overrun_notified=1 WHERE id=?`).run(e.id);
    }
  } catch (err) { console.error('clock sweep failed:', err.message); }
}

// Break reminders: ~10 minutes before a scheduled break, pop a live alert to the
// staff member (they acknowledge it) and archive it in break_reminders for audit.
function sweepBreakReminders() {
  try {
    const rows = db.prepare(`SELECT sb.id AS break_id, sb.start_time, s.user_id, s.location_id, s.shift_date, l.timezone, l.break_reminder_lead_min AS lead_min, u.phone AS user_phone
      FROM shift_breaks sb
      JOIN shifts s ON s.id=sb.shift_id AND s.kind='work'
      JOIN users u ON u.id=s.user_id AND u.is_active=1
      JOIN locations l ON l.id=s.location_id
      WHERE sb.reminded_at IS NULL AND sb.start_time IS NOT NULL AND sb.start_time<>''`).all();
    const now = new Date();
    for (const r of rows) {
      const tz = r.timezone || DEFAULT_TZ;
      if (r.shift_date !== localDate(tz)) continue;                 // only today's breaks
      const lead = Number(r.lead_min) > 0 ? Number(r.lead_min) : 10; // per-location lead (default 10)
      const until = hhmmToMin(r.start_time) - localMinutesOfDay(tz, now);
      if (until == null || until > lead || until < 0) continue;     // fire inside the lead window
      const sender = locationLeaders(r.location_id)[0] || r.user_id;
      const body = `Break reminder: your break is at ${r.start_time} — please take your break in about ${until} minute${until === 1 ? '' : 's'}.`;
      const ins = db.prepare(`INSERT INTO floor_alerts (location_id, sender_id, target_type, target_user_id, body, priority) VALUES (?,?, 'user', ?, ?, 'normal')`)
        .run(r.location_id, sender, r.user_id, body);
      const alertId = Number(ins.lastInsertRowid);
      try { emitAlert({ id: alertId, location_id: r.location_id, target_type: 'user', target_user_id: r.user_id, target_role: null, body, priority: 'normal', sender_name: 'Break reminder', created_at: new Date().toISOString() }); } catch { /* live push best-effort */ }
      db.prepare(`INSERT INTO break_reminders (user_id, location_id, shift_break_id, work_date, break_time, alert_id) VALUES (?,?,?,?,?,?)`)
        .run(r.user_id, r.location_id, r.break_id, r.shift_date, r.start_time, alertId);
      db.prepare(`UPDATE shift_breaks SET reminded_at=datetime('now') WHERE id=?`).run(r.break_id);
      // Also text the staff member (best-effort; log-only until a provider is set).
      if (smsEnabled() && r.user_phone) { try { sendSms(r.user_phone, body).catch(() => {}); } catch { /* */ } }
    }
  } catch (err) { console.error('break sweep failed:', err.message); }
}

router.use(verifyToken);

const ownsLocation = (req, locId) => seesAllLocations(req.user.role) || String(req.user.location_id) === String(locId);
const locTz = (locId) => (db.prepare(`SELECT timezone FROM locations WHERE id=?`).get(locId) || {}).timezone || DEFAULT_TZ;
const validDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
const spanMin = (a, b) => { if (!a || !b) return 0; const [ah, am] = a.split(':').map(Number), [bh, bm] = b.split(':').map(Number); let s = ah * 60 + am, e = bh * 60 + bm; if (e <= s) e += 1440; return e - s; };
const fmtDurMin = (m) => { m = Math.max(0, Math.round(m)); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`; };

// Minutes a staff member is scheduled to work at a location on a date.
function scheduledMinutes(userId, locId, date) {
  return db.prepare(`SELECT start_time, end_time FROM shifts WHERE user_id=? AND location_id=? AND shift_date=? AND kind='work'`)
    .all(userId, locId, date).reduce((m, s) => m + spanMin(s.start_time, s.end_time), 0);
}
// Live worked minutes for an entry (uses now if still on the clock).
const liveWorked = (e) => e.worked_minutes != null ? e.worked_minutes
  : Math.max(0, Math.round((Date.now() - new Date(e.clock_in).getTime()) / 60000));

// Late arrival: minutes a check-in is past the earliest scheduled start (grace applied).
const LATE_GRACE_MIN = 5;
function localMinutesOfDay(tz, d) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  return (Number(p.find(x => x.type === 'hour').value) % 24) * 60 + Number(p.find(x => x.type === 'minute').value);
}
const earliestShiftStart = (userId, locId, date) =>
  (db.prepare(`SELECT MIN(start_time) s FROM shifts WHERE user_id=? AND location_id=? AND shift_date=? AND kind='work'`).get(userId, locId, date) || {}).s || null;
function lateMinutesFor(userId, locId, date, tz, clockIn) {
  const start = earliestShiftStart(userId, locId, date);
  if (!start) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const late = localMinutesOfDay(tz, clockIn) - (sh * 60 + sm);
  return late > LATE_GRACE_MIN ? late : 0;
}

// ── Staff punch (check-in / check-out) ───────────────────────────────────────
// Authorized by an opener (manager+) whose session pins the station's location.
router.post('/punch', requireRole(ROLES.MANAGE), (req, res) => {
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
    const late = lateMinutesFor(staff.id, locId, date, tz, now);
    const info = db.prepare(`INSERT INTO time_entries (user_id, location_id, work_date, clock_in, scheduled_minutes, late_minutes, opened_by) VALUES (?,?,?,?,?,?,?)`)
      .run(staff.id, locId, date, now.toISOString(), sched, late, req.user.id);
    if (late > 0) {
      db.prepare(`INSERT INTO staff_alerts (location_id, user_id, kind, message, time_entry_id) VALUES (?,?,?,?,?)`)
        .run(locId, staff.id, 'late', `${staff.name} checked in ${fmtDurMin(late)} late.`, info.lastInsertRowid);
    }
    auditLog(req, 'clock_in', 'user', staff.id, { location_id: locId, scheduled_minutes: sched, late_minutes: late });
    return res.json({ success: true, action: 'in', staff: staff.name, at: localTime(tz, now), scheduled_minutes: sched, late_minutes: late });
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

// ── Missed clock-outs: manager approve (keep working) / force clock-out ───────
// Staff still on the clock past their scheduled end at this location.
router.get('/overruns', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const tz = locTz(locId), today = localDate(tz), nowMin = localMinutesOfDay(tz, new Date());
  const open = db.prepare(`SELECT te.*, u.name, u.employee_code FROM time_entries te JOIN users u ON u.id=te.user_id
    WHERE te.location_id=? AND te.clock_out IS NULL ORDER BY te.clock_in`).all(locId);
  const rows = [];
  for (const e of open) {
    const end = (db.prepare(`SELECT MAX(end_time) e FROM shifts WHERE user_id=? AND location_id=? AND shift_date=? AND kind='work'`).get(e.user_id, e.location_id, e.work_date) || {}).e;
    if (!end) continue;
    const over = (e.work_date < today ? 1440 : 0) + (nowMin - hhmmToMin(end));
    if (over <= 0) continue; // not past their scheduled end yet
    rows.push({
      id: e.id, user_id: e.user_id, name: e.name, employee_code: e.employee_code,
      clock_in: localTime(tz, new Date(e.clock_in)), scheduled_end: end,
      worked_minutes: Math.max(0, Math.round((Date.now() - new Date(e.clock_in).getTime()) / 60000)),
      over_minutes: over, decision: e.overrun_decision || null,
    });
  }
  res.json({ overruns: rows });
});

// Approve the extra hours — they keep working (recorded for audit/timesheet).
router.post('/overrun/:id/approve', requireRole(ROLES.MANAGE), (req, res) => {
  const e = db.prepare(`SELECT * FROM time_entries WHERE id=?`).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Time entry not found.' });
  if (!ownsLocation(req, e.location_id)) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`UPDATE time_entries SET overrun_decision='approved', overrun_decided_by=?, overrun_decided_at=datetime('now') WHERE id=?`).run(req.user.id, e.id);
  auditLog(req, 'overrun_approved', 'user', e.user_id, { time_entry_id: e.id });
  try { notify(req.user.id, e.user_id, 'Extra hours approved', `Your manager approved you to keep working past your scheduled end. Please clock out when you finish.`); } catch { /* */ }
  res.json({ success: true });
});

// Decline the extra hours — clock them out now (they never clocked out).
router.post('/overrun/:id/force-out', requireRole(ROLES.MANAGE), (req, res) => {
  const e = db.prepare(`SELECT * FROM time_entries WHERE id=?`).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Time entry not found.' });
  if (!ownsLocation(req, e.location_id)) return res.status(403).json({ error: 'Not your location.' });
  if (e.clock_out) return res.status(409).json({ error: 'This person is already clocked out.' });
  const now = new Date(), worked = Math.max(0, Math.round((now.getTime() - new Date(e.clock_in).getTime()) / 60000));
  db.prepare(`UPDATE time_entries SET clock_out=?, worked_minutes=?, overrun_decision='forced', overrun_decided_by=?, overrun_decided_at=datetime('now') WHERE id=?`)
    .run(now.toISOString(), worked, req.user.id, e.id);
  auditLog(req, 'overrun_forced_out', 'user', e.user_id, { time_entry_id: e.id, worked_minutes: worked });
  try { notify(req.user.id, e.user_id, 'Clocked out by a manager', `You didn’t clock out after your shift, so a manager clocked you out. Please check with them about the extra time for your timesheet.`); } catch { /* */ }
  res.json({ success: true, worked_minutes: worked });
});

// Break-reminder audit archive for a location/day (proof staff were reminded).
router.get('/break-reminders', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const tz = locTz(locId), date = validDate(req.query.date) || localDate(tz);
  const fmt = (ts) => ts ? localTime(tz, new Date(ts.replace(' ', 'T') + 'Z')) : null;
  const rows = db.prepare(`SELECT br.id, br.break_time, br.sent_at, br.acknowledged_at, u.name, u.employee_code
    FROM break_reminders br JOIN users u ON u.id=br.user_id WHERE br.location_id=? AND br.work_date=? ORDER BY br.break_time, u.name`).all(locId, date);
  res.json({ reminders: rows.map(r => ({ id: r.id, name: r.name, employee_code: r.employee_code, break_time: r.break_time, sent_at: fmt(r.sent_at), acknowledged_at: fmt(r.acknowledged_at) })) });
});

// ── Manager / GM / Owner: today's clock board for a location ──────────────────
router.get('/board', requireRole(ROLES.MANAGE), (req, res) => {
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
    WHERE s.location_id=? AND s.shift_date=? AND s.kind='work' GROUP BY u.id ORDER BY u.name`).all(locId, date);
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
const OT_EDIT_ROLES = ['owner', 'admin', 'hr', 'general_manager']; // may change approved OT later
const addDaysIso = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const mondayOf = (iso) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const round2 = (n) => Math.round(n * 100) / 100;
// California daily split of a day's clocked minutes.
const daySplit = (m) => ({ reg: Math.min(m, OT_AFTER_MIN), ot: Math.min(Math.max(m - OT_AFTER_MIN, 0), DT_AFTER_MIN - OT_AFTER_MIN), dt: Math.max(m - DT_AFTER_MIN, 0) });
const dayWorkedMin = (locId, userId, date) => db.prepare(`SELECT COALESCE(SUM(worked_minutes),0) AS m FROM time_entries WHERE location_id=? AND user_id=? AND work_date=? AND clock_out IS NOT NULL`).get(locId, userId, date).m;
// Minutes that count for a day = the manager's rounding adjustment if set, else clocked.
const effectiveDayMin = (locId, userId, date) => {
  const adj = db.prepare(`SELECT adjusted_minutes FROM time_adjustments WHERE location_id=? AND user_id=? AND work_date=?`).get(locId, userId, date);
  return adj ? adj.adjusted_minutes : dayWorkedMin(locId, userId, date);
};
const userName = (id) => (db.prepare(`SELECT name FROM users WHERE id=?`).get(id) || {}).name || 'staff';

// Server-side period window for a kind + anchor date.
function periodRange(kind, anchor) {
  const p2 = (n) => String(n).padStart(2, '0');
  if (kind === 'daily') return { start: anchor, end: anchor };
  if (kind === 'monthly') { const d = new Date(anchor + 'T00:00:00'); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0); return { start: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-01`, end: `${last.getFullYear()}-${p2(last.getMonth() + 1)}-${p2(last.getDate())}` }; }
  const start = mondayOf(anchor); return { start, end: addDaysIso(start, 6) };
}

const FULL_DAY_HOURS = 8; // an "all day" leave entry counts as a standard workday
// One person's own hours for a period, across whatever location(s) they worked.
function myHoursData(userId, start, end, kind) {
  const byDate = {};
  for (const r of db.prepare(`SELECT work_date, worked_minutes, late_minutes FROM time_entries WHERE user_id=? AND work_date BETWEEN ? AND ? AND clock_out IS NOT NULL`).all(userId, start, end)) {
    const d = byDate[r.work_date] || (byDate[r.work_date] = { worked: 0, late: 0 });
    d.worked += r.worked_minutes || 0; d.late = Math.max(d.late, r.late_minutes || 0);
  }
  const schedByDate = {};
  for (const s of db.prepare(`SELECT shift_date, start_time, end_time FROM shifts WHERE user_id=? AND shift_date BETWEEN ? AND ? AND kind='work'`).all(userId, start, end)) {
    schedByDate[s.shift_date] = (schedByDate[s.shift_date] || 0) + spanMin(s.start_time, s.end_time);
  }
  // Scheduled leave (sick / vacation / on-leave) — hours by kind, for the timesheet.
  const leave = { sick: 0, vacation: 0, leave: 0 };
  for (const s of db.prepare(`SELECT kind, all_day, leave_hours, start_time, end_time FROM shifts WHERE user_id=? AND shift_date BETWEEN ? AND ? AND kind<>'work'`).all(userId, start, end)) {
    const hrs = s.leave_hours != null ? s.leave_hours : (s.all_day ? FULL_DAY_HOURS : spanMin(s.start_time, s.end_time) / 60);
    if (leave[s.kind] != null) leave[s.kind] += hrs;
  }
  const adjByDate = {};
  for (const a of db.prepare(`SELECT work_date, adjusted_minutes FROM time_adjustments WHERE user_id=? AND work_date BETWEEN ? AND ?`).all(userId, start, end)) adjByDate[a.work_date] = a.adjusted_minutes;
  const otByDate = {};
  for (const a of db.prepare(`SELECT work_date, approved, rejected, escalated, ot_minutes, dt_minutes FROM ot_approvals WHERE user_id=? AND work_date BETWEEN ? AND ?`).all(userId, start, end)) otByDate[a.work_date] = a;
  const tsAppr = db.prepare(`SELECT * FROM timesheet_approvals WHERE user_id=? AND period_kind=? AND period_start=?`).get(userId, kind, start);
  const h = (m) => round2(m / 60);
  let totalMin = 0, reg = 0, otAppr = 0, dtAppr = 0, otPend = 0, dtPend = 0, lateMin = 0, lateDays = 0, shortDays = 0;
  const days = Object.entries(byDate).sort().map(([date, d]) => {
    const adj = adjByDate[date]; const eff = adj != null ? adj : d.worked;
    totalMin += eff; const sp = daySplit(eff); reg += sp.reg;
    const a = otByDate[date]; const ok = a && a.approved;
    if (sp.ot > 0 || sp.dt > 0) { if (ok) { otAppr += a.ot_minutes; dtAppr += a.dt_minutes; } else { otPend += sp.ot; dtPend += sp.dt; } }
    const sched = schedByDate[date] || 0; const shortM = sched > eff ? sched - eff : 0;
    if (d.late > 0) { lateMin += d.late; lateDays++; } if (shortM > 0) shortDays++;
    const otStatus = sp.ot <= 0 && sp.dt <= 0 ? 'none' : (a && a.approved ? 'approved' : (a && a.rejected ? 'rejected' : (a && a.escalated ? 'escalated' : 'pending')));
    return { date, scheduled_min: sched, worked_min: d.worked, effective_min: eff, adjusted: adj != null, late_min: d.late, short_min: shortM, ot_min: sp.ot, dt_min: sp.dt, ot_status: otStatus };
  });
  return {
    kind, start, end, days,
    totals: { scheduled_hours: h(Object.values(schedByDate).reduce((t, m) => t + m, 0)), total_hours: h(totalMin), regular_hours: h(reg), ot_hours: h(otAppr), ot_pending_hours: h(otPend), dt_hours: h(dtAppr), late_days: lateDays, late_minutes: lateMin, short_days: shortDays, sick_hours: round2(leave.sick), vacation_hours: round2(leave.vacation), leave_hours: round2(leave.leave) },
    approved: tsAppr ? 1 : 0, approved_by: tsAppr ? (userName(tsAppr.approved_by) || null) : null,
    rules: { ot_after_h: OT_AFTER_MIN / 60, ot_mult: OT_MULT, late_grace_min: LATE_GRACE_MIN },
  };
}

router.get('/payroll', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const loc = db.prepare(`SELECT id, name, timezone FROM locations WHERE id=?`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const tz = loc.timezone || DEFAULT_TZ;
  const today = localDate(tz);
  const start = validDate(req.query.start) || mondayOf(today);
  const end = validDate(req.query.end) || addDaysIso(start, 6);
  const kind = ['daily', 'weekly', 'monthly'].includes(req.query.kind) ? req.query.kind : 'weekly';

  // Clocked minutes + late per person per day (completed punches — the time clock).
  const rows = db.prepare(`SELECT te.user_id, u.name, u.employee_code, u.role, u.hourly_rate,
      te.work_date, te.worked_minutes, te.late_minutes
    FROM time_entries te JOIN users u ON u.id=te.user_id
    WHERE te.location_id=? AND te.work_date BETWEEN ? AND ? AND te.clock_out IS NOT NULL`).all(locId, start, end);
  const byUser = {};
  for (const r of rows) {
    const u = byUser[r.user_id] || (byUser[r.user_id] = { user_id: r.user_id, name: r.name, employee_code: r.employee_code, role: r.role, rate: r.hourly_rate || 0, days: {}, late: {} });
    u.days[r.work_date] = (u.days[r.work_date] || 0) + (r.worked_minutes || 0);
    u.late[r.work_date] = Math.max(u.late[r.work_date] || 0, r.late_minutes || 0);
  }
  // Scheduled minutes per person (total) and per person+day.
  const schedByUser = {}, schedByDay = {};
  for (const s of db.prepare(`SELECT user_id, shift_date, start_time, end_time FROM shifts WHERE location_id=? AND shift_date BETWEEN ? AND ? AND kind='work'`).all(locId, start, end)) {
    const m = spanMin(s.start_time, s.end_time);
    schedByUser[s.user_id] = (schedByUser[s.user_id] || 0) + m;
    schedByDay[s.user_id + '|' + s.shift_date] = (schedByDay[s.user_id + '|' + s.shift_date] || 0) + m;
  }
  // Scheduled leave (sick / vacation / on-leave) hours per person, by kind. Someone
  // on leave with no clocked time still belongs on the payroll.
  const leaveByUser = {};
  for (const s of db.prepare(`SELECT s.user_id, u.name, u.employee_code, u.role, u.hourly_rate, s.kind, s.all_day, s.leave_hours, s.start_time, s.end_time
      FROM shifts s JOIN users u ON u.id=s.user_id
      WHERE s.location_id=? AND s.shift_date BETWEEN ? AND ? AND s.kind<>'work'`).all(locId, start, end)) {
    const l = leaveByUser[s.user_id] || (leaveByUser[s.user_id] = { sick: 0, vacation: 0, leave: 0 });
    const hrs = s.leave_hours != null ? s.leave_hours : (s.all_day ? FULL_DAY_HOURS : spanMin(s.start_time, s.end_time) / 60);
    if (l[s.kind] != null) l[s.kind] += hrs;
    if (!byUser[s.user_id]) byUser[s.user_id] = { user_id: s.user_id, name: s.name, employee_code: s.employee_code, role: s.role, rate: s.hourly_rate || 0, days: {}, late: {} };
  }
  // Manager rounding adjustments per person+day (override the clocked total).
  const adjBy = {};
  for (const a of db.prepare(`SELECT user_id, work_date, adjusted_minutes FROM time_adjustments WHERE location_id=? AND work_date BETWEEN ? AND ?`).all(locId, start, end)) {
    adjBy[a.user_id + '|' + a.work_date] = a.adjusted_minutes;
  }
  // OT approvals / escalations in range.
  const apprBy = {};
  for (const a of db.prepare(`SELECT oa.*, ub.name AS approver, ue.name AS escalator FROM ot_approvals oa
      LEFT JOIN users ub ON ub.id=oa.approved_by LEFT JOIN users ue ON ue.id=oa.escalated_by
      WHERE oa.location_id=? AND oa.work_date BETWEEN ? AND ?`).all(locId, start, end)) {
    apprBy[a.user_id + '|' + a.work_date] = a;
  }
  // Period total sign-offs (this exact period).
  const tsApprBy = {};
  for (const a of db.prepare(`SELECT ta.*, ub.name AS approver FROM timesheet_approvals ta LEFT JOIN users ub ON ub.id=ta.approved_by
      WHERE ta.location_id=? AND ta.period_kind=? AND ta.period_start=?`).all(locId, kind, start)) {
    tsApprBy[a.user_id] = a;
  }
  const otStatus = (a, hasOt) => !hasOt ? 'none' : (a && a.approved ? 'approved' : (a && a.rejected ? 'rejected' : (a && a.escalated ? 'escalated' : 'pending')));

  const h = (min) => round2(min / 60);
  const otDays = []; // every OT occurrence (for the approvals UI)
  const staff = Object.values(byUser).map(u => {
    let reg = 0, otAppr = 0, dtAppr = 0, otPend = 0, dtPend = 0, total = 0, lateMin = 0, lateDays = 0, shortDays = 0;
    const days = [];
    for (const [date, clocked] of Object.entries(u.days).sort()) {
      const adj = adjBy[u.user_id + '|' + date];
      const eff = adj != null ? adj : clocked;
      total += eff;
      const sp = daySplit(eff);
      reg += sp.reg;
      const a = apprBy[u.user_id + '|' + date];
      const hasOt = sp.ot > 0 || sp.dt > 0;
      const ok = a && a.approved;
      if (hasOt) {
        if (ok) { otAppr += a.ot_minutes; dtAppr += a.dt_minutes; } else { otPend += sp.ot; dtPend += sp.dt; }
        otDays.push({
          user_id: u.user_id, name: u.name, employee_code: u.employee_code, work_date: date,
          worked_minutes: eff, computed_ot_minutes: sp.ot, computed_dt_minutes: sp.dt,
          ot_minutes: ok ? a.ot_minutes : sp.ot, dt_minutes: ok ? a.dt_minutes : sp.dt,
          approved: ok ? 1 : 0, note: a ? a.note : null, approver: a ? a.approver : null,
          status: otStatus(a, hasOt), escalated_by: a ? a.escalator : null,
        });
      }
      const lateD = u.late[date] || 0;
      if (lateD > 0) { lateMin += lateD; lateDays++; }
      const schedM = schedByDay[u.user_id + '|' + date] || 0;
      const shortM = schedM > eff ? schedM - eff : 0;
      if (shortM > 0) shortDays++;
      days.push({ date, scheduled_min: schedM, worked_min: clocked, effective_min: eff, adjusted: adj != null,
        late_min: lateD, short_min: shortM, ot_min: sp.ot, dt_min: sp.dt, ot_status: otStatus(a, hasOt), ot_note: a ? a.note : null });
    }
    const rate = u.rate || 0;
    const gross = rate ? round2(h(reg) * rate + h(otAppr) * rate * OT_MULT + h(dtAppr) * rate * DT_MULT) : null;
    const ts = tsApprBy[u.user_id];
    return {
      user_id: u.user_id, name: u.name, employee_code: u.employee_code, role: u.role,
      scheduled_hours: h(schedByUser[u.user_id] || 0), days_count: Object.keys(u.days).length,
      total_hours: h(total), regular_hours: h(reg),
      ot_hours: h(otAppr), dt_hours: h(dtAppr), ot_pending_hours: h(otPend), dt_pending_hours: h(dtPend),
      late_days: lateDays, late_minutes: lateMin, short_days: shortDays,
      sick_hours: round2((leaveByUser[u.user_id] || {}).sick || 0),
      vacation_hours: round2((leaveByUser[u.user_id] || {}).vacation || 0),
      leave_hours: round2((leaveByUser[u.user_id] || {}).leave || 0),
      approved: ts ? 1 : 0, approved_by: ts ? ts.approver : null, approved_total_hours: ts ? h(ts.total_minutes) : null,
      rate: rate || null, gross_pay: gross, days,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  otDays.sort((a, b) => a.work_date.localeCompare(b.work_date) || a.name.localeCompare(b.name));
  const sum = (k) => round2(staff.reduce((t, s) => t + (s[k] || 0), 0));
  res.json({
    location: loc, start, end, kind, timezone: tz, today,
    can_edit_ot: OT_EDIT_ROLES.includes(req.user.role),
    is_leadership: OT_EDIT_ROLES.includes(req.user.role),
    rules: { ot_after_h: OT_AFTER_MIN / 60, dt_after_h: DT_AFTER_MIN / 60, ot_mult: OT_MULT, dt_mult: DT_MULT, late_grace_min: LATE_GRACE_MIN },
    staff, ot_days: otDays,
    totals: {
      staff: staff.length, scheduled_hours: sum('scheduled_hours'), total_hours: sum('total_hours'), regular_hours: sum('regular_hours'),
      ot_hours: sum('ot_hours'), dt_hours: sum('dt_hours'), ot_pending_hours: sum('ot_pending_hours'), dt_pending_hours: sum('dt_pending_hours'),
      sick_hours: sum('sick_hours'), vacation_hours: sum('vacation_hours'), leave_hours: sum('leave_hours'),
      late_minutes: sum('late_minutes'), gross_pay: sum('gross_pay'),
    },
  });
});

// Approve (or revoke) a staff member's overtime for a day. A note is required to
// approve; only Owner / General Manager may change the approved OT/DT amount.
router.put('/ot-approval', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.body.location_id, 10);
  const userId = parseInt(req.body.user_id, 10);
  const date = validDate(req.body.work_date);
  if (!locId || !userId || !date) return res.status(400).json({ error: 'location_id, user_id and work_date are required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const sp = daySplit(effectiveDayMin(locId, userId, date));
  if (sp.ot <= 0 && sp.dt <= 0) return res.status(400).json({ error: 'No overtime on that day to approve.' });
  const reject = req.body.reject === true;
  const approved = reject ? 0 : (req.body.approved === false ? 0 : 1);
  const note = (req.body.note || '').toString().trim();
  if (approved && !note) return res.status(400).json({ error: 'An approval note is required.' });
  const existing = db.prepare(`SELECT * FROM ot_approvals WHERE location_id=? AND user_id=? AND work_date=?`).get(locId, userId, date);
  let otMin = existing ? existing.ot_minutes : sp.ot;
  let dtMin = existing ? existing.dt_minutes : sp.dt;
  if (req.body.ot_minutes !== undefined || req.body.dt_minutes !== undefined) {
    if (!OT_EDIT_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Only an Owner or General Manager can change the overtime amount.' });
    if (req.body.ot_minutes !== undefined) otMin = Math.max(0, Math.min(parseInt(req.body.ot_minutes, 10) || 0, sp.ot));
    if (req.body.dt_minutes !== undefined) dtMin = Math.max(0, Math.min(parseInt(req.body.dt_minutes, 10) || 0, sp.dt));
  }
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(`UPDATE ot_approvals SET approved=?, rejected=?, escalated=0, ot_minutes=?, dt_minutes=?, note=?, approved_by=?, approved_at=?, updated_at=datetime('now') WHERE id=?`)
      .run(approved, reject ? 1 : 0, otMin, dtMin, note || existing.note, (approved || reject) ? req.user.id : existing.approved_by, (approved || reject) ? now : existing.approved_at, existing.id);
  } else {
    db.prepare(`INSERT INTO ot_approvals (location_id, user_id, work_date, approved, rejected, ot_minutes, dt_minutes, note, approved_by, approved_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(locId, userId, date, approved, reject ? 1 : 0, otMin, dtMin, note || null, (approved || reject) ? req.user.id : null, (approved || reject) ? now : null);
  }
  auditLog(req, reject ? 'ot_reject' : (approved ? 'ot_approve' : 'ot_revoke'), 'user', userId, { location_id: locId, work_date: date, ot_minutes: otMin, dt_minutes: dtMin });
  // Tell the staff member the outcome; if leadership decided an escalated one, tell the manager too.
  if (approved || reject) {
    const verb = approved ? 'approved' : 'declined';
    notify(req.user.id, userId, `Overtime ${verb}`, `Your overtime on ${date} was ${verb}${note ? ` — "${note}"` : ''}.`);
    if (existing && existing.escalated && existing.escalated_by && existing.escalated_by !== req.user.id) {
      notify(req.user.id, existing.escalated_by, `OT request ${verb}`, `${userName(userId)}'s overtime on ${date} was ${verb} by ${userName(req.user.id)}.`);
    }
  }
  res.json({ success: true, approved, rejected: reject ? 1 : 0, ot_minutes: otMin, dt_minutes: dtMin });
});

// Round a day's worked minutes (e.g. 7.5h→8h, or +30m→1h OT). Overtime is then
// re-derived from the adjusted total. Set adjusted_minutes to clear (=clocked).
router.put('/adjust', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.body.location_id, 10);
  const userId = parseInt(req.body.user_id, 10);
  const date = validDate(req.body.work_date);
  if (!locId || !userId || !date) return res.status(400).json({ error: 'location_id, user_id and work_date are required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const clear = req.body.adjusted_minutes === null || req.body.adjusted_minutes === '';
  if (clear) {
    db.prepare(`DELETE FROM time_adjustments WHERE location_id=? AND user_id=? AND work_date=?`).run(locId, userId, date);
    auditLog(req, 'time_adjust_clear', 'user', userId, { location_id: locId, work_date: date });
    return res.json({ success: true, cleared: true });
  }
  const mins = Math.max(0, Math.min(24 * 60, parseInt(req.body.adjusted_minutes, 10) || 0));
  const note = (req.body.note || '').toString().trim() || null;
  db.prepare(`INSERT INTO time_adjustments (location_id, user_id, work_date, adjusted_minutes, note, adjusted_by)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(location_id, user_id, work_date) DO UPDATE SET adjusted_minutes=excluded.adjusted_minutes, note=excluded.note, adjusted_by=excluded.adjusted_by, adjusted_at=datetime('now')`)
    .run(locId, userId, date, mins, note, req.user.id);
  auditLog(req, 'time_adjust', 'user', userId, { location_id: locId, work_date: date, adjusted_minutes: mins });
  res.json({ success: true, adjusted_minutes: mins });
});

// Sign off a person's total hours for a period (day / week / month).
router.post('/approve-total', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.body.location_id, 10);
  const userId = parseInt(req.body.user_id, 10);
  const kind = ['daily', 'weekly', 'monthly'].includes(req.body.period_kind) ? req.body.period_kind : null;
  const start = validDate(req.body.period_start), end = validDate(req.body.period_end);
  if (!locId || !userId || !kind || !start || !end) return res.status(400).json({ error: 'location_id, user_id, period_kind, period_start and period_end are required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  // Effective total for the period = adjusted-or-clocked minutes across days worked.
  let totalMin = 0;
  for (const r of db.prepare(`SELECT DISTINCT work_date FROM time_entries WHERE location_id=? AND user_id=? AND work_date BETWEEN ? AND ? AND clock_out IS NOT NULL`).all(locId, userId, start, end)) {
    totalMin += effectiveDayMin(locId, userId, r.work_date);
  }
  const note = (req.body.note || '').toString().trim() || null;
  db.prepare(`INSERT INTO timesheet_approvals (location_id, user_id, period_kind, period_start, period_end, total_minutes, note, approved_by)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(location_id, user_id, period_kind, period_start) DO UPDATE SET period_end=excluded.period_end, total_minutes=excluded.total_minutes, note=excluded.note, approved_by=excluded.approved_by, approved_at=datetime('now')`)
    .run(locId, userId, kind, start, end, totalMin, note, req.user.id);
  auditLog(req, 'timesheet_approve', 'user', userId, { location_id: locId, period_kind: kind, period_start: start, total_minutes: totalMin });
  res.json({ success: true, total_minutes: totalMin });
});

// Un-approve a period total.
router.post('/approve-total/undo', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.body.location_id, 10);
  const userId = parseInt(req.body.user_id, 10);
  const kind = req.body.period_kind, start = validDate(req.body.period_start);
  if (!locId || !userId || !kind || !start) return res.status(400).json({ error: 'Missing fields.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`DELETE FROM timesheet_approvals WHERE location_id=? AND user_id=? AND period_kind=? AND period_start=?`).run(locId, userId, kind, start);
  res.json({ success: true });
});

// Manager escalates a day's overtime to Owner / GM / Admin for sign-off.
router.post('/ot-escalate', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.body.location_id, 10);
  const userId = parseInt(req.body.user_id, 10);
  const date = validDate(req.body.work_date);
  if (!locId || !userId || !date) return res.status(400).json({ error: 'location_id, user_id and work_date are required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const sp = daySplit(effectiveDayMin(locId, userId, date));
  if (sp.ot <= 0 && sp.dt <= 0) return res.status(400).json({ error: 'No overtime on that day to escalate.' });
  const note = (req.body.note || '').toString().trim() || null;
  const existing = db.prepare(`SELECT id FROM ot_approvals WHERE location_id=? AND user_id=? AND work_date=?`).get(locId, userId, date);
  if (existing) {
    db.prepare(`UPDATE ot_approvals SET escalated=1, escalated_by=?, escalated_at=datetime('now'), approved=0, rejected=0, ot_minutes=?, dt_minutes=?, note=COALESCE(?,note), updated_at=datetime('now') WHERE id=?`)
      .run(req.user.id, sp.ot, sp.dt, note, existing.id);
  } else {
    db.prepare(`INSERT INTO ot_approvals (location_id, user_id, work_date, escalated, escalated_by, escalated_at, ot_minutes, dt_minutes, note) VALUES (?,?,?,1,?,datetime('now'),?,?,?)`)
      .run(locId, userId, date, req.user.id, sp.ot, sp.dt, note);
  }
  auditLog(req, 'ot_escalate', 'user', userId, { location_id: locId, work_date: date });
  // Notify leadership (owner / admin / general_manager) who can decide.
  const leaders = db.prepare(`SELECT id FROM users WHERE is_active=1 AND role IN ('owner','admin','hr','general_manager')`).all().map(r => r.id);
  const loc = (db.prepare(`SELECT name FROM locations WHERE id=?`).get(locId) || {}).name || 'a location';
  leaders.forEach(lid => notify(req.user.id, lid, 'Overtime approval requested',
    `${userName(req.user.id)} is requesting sign-off on ${userName(userId)}'s overtime on ${date} at ${loc}${note ? ` — "${note}"` : ''}. Review it under Time Clock.`));
  res.json({ success: true, escalated_to: leaders.length });
});

// Leadership: overtime escalated to me for a decision, across my locations.
router.get('/ot-requests', requireRole('owner', 'admin', 'hr', 'general_manager'), (req, res) => {
  const rows = db.prepare(`SELECT oa.location_id, oa.user_id, oa.work_date, oa.ot_minutes, oa.dt_minutes, oa.note, oa.escalated_at,
      u.name AS staff_name, ue.name AS escalated_by, l.name AS location_name
    FROM ot_approvals oa JOIN users u ON u.id=oa.user_id LEFT JOIN users ue ON ue.id=oa.escalated_by LEFT JOIN locations l ON l.id=oa.location_id
    WHERE oa.escalated=1 AND oa.approved=0 AND oa.rejected=0 ORDER BY oa.escalated_at DESC`).all();
  res.json({ requests: rows });
});

// Performance / attendance history for a location over a range (default 90 days):
// per-staff tallies of late, short, and overtime for reviews. Owner/admin any loc.
router.get('/performance', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const loc = db.prepare(`SELECT id, name, timezone FROM locations WHERE id=?`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const tz = loc.timezone || DEFAULT_TZ;
  const end = validDate(req.query.end) || localDate(tz);
  const start = validDate(req.query.start) || addDaysIso(end, -89);
  const adj = {}; for (const a of db.prepare(`SELECT user_id, work_date, adjusted_minutes FROM time_adjustments WHERE location_id=? AND work_date BETWEEN ? AND ?`).all(locId, start, end)) adj[a.user_id + '|' + a.work_date] = a.adjusted_minutes;
  const schedByDay = {}; for (const s of db.prepare(`SELECT user_id, shift_date, start_time, end_time FROM shifts WHERE location_id=? AND shift_date BETWEEN ? AND ? AND kind='work'`).all(locId, start, end)) schedByDay[s.user_id + '|' + s.shift_date] = (schedByDay[s.user_id + '|' + s.shift_date] || 0) + spanMin(s.start_time, s.end_time);
  const otBy = {}; for (const a of db.prepare(`SELECT user_id, work_date, approved, ot_minutes, dt_minutes FROM ot_approvals WHERE location_id=? AND work_date BETWEEN ? AND ?`).all(locId, start, end)) otBy[a.user_id + '|' + a.work_date] = a;
  // Collapse multiple punches per user+day.
  const perUserDate = {};
  for (const r of db.prepare(`SELECT te.user_id, u.name, u.employee_code, u.role, te.work_date, te.worked_minutes, te.late_minutes
      FROM time_entries te JOIN users u ON u.id=te.user_id
      WHERE te.location_id=? AND te.work_date BETWEEN ? AND ? AND te.clock_out IS NOT NULL`).all(locId, start, end)) {
    const k = r.user_id + '|' + r.work_date;
    const pu = perUserDate[k] || (perUserDate[k] = { worked: 0, late: 0, user_id: r.user_id, name: r.name, code: r.employee_code, role: r.role, date: r.work_date });
    pu.worked += r.worked_minutes || 0; pu.late = Math.max(pu.late, r.late_minutes || 0);
  }
  const h = (m) => round2(m / 60);
  const byUser = {};
  for (const pu of Object.values(perUserDate)) {
    const u = byUser[pu.user_id] || (byUser[pu.user_id] = { user_id: pu.user_id, name: pu.name, employee_code: pu.code, role: pu.role, days: 0, late_days: 0, late_minutes: 0, short_days: 0, ot_min: 0, ot_appr_min: 0, total_min: 0 });
    const eff = adj[pu.user_id + '|' + pu.date] != null ? adj[pu.user_id + '|' + pu.date] : pu.worked;
    u.days++; u.total_min += eff;
    if (pu.late > 0) { u.late_days++; u.late_minutes += pu.late; }
    if ((schedByDay[pu.user_id + '|' + pu.date] || 0) > eff) u.short_days++;
    const sp = daySplit(eff); u.ot_min += sp.ot + sp.dt;
    const a = otBy[pu.user_id + '|' + pu.date]; if (a && a.approved) u.ot_appr_min += (a.ot_minutes || 0) + (a.dt_minutes || 0);
  }
  const staff = Object.values(byUser).map(u => ({
    user_id: u.user_id, name: u.name, employee_code: u.employee_code, role: u.role,
    days: u.days, total_hours: h(u.total_min), late_days: u.late_days, late_minutes: u.late_minutes,
    short_days: u.short_days, ot_hours: h(u.ot_min), ot_approved_hours: h(u.ot_appr_min),
    on_time_rate: u.days ? round2((u.days - u.late_days) / u.days * 100) : null,
  })).sort((a, b) => b.late_days - a.late_days || a.name.localeCompare(b.name));
  res.json({ location: loc, start, end, staff });
});

// ── Short-shift alerts for a location ─────────────────────────────────────────
router.get('/alerts', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const rows = db.prepare(`SELECT sa.id, sa.kind, sa.message, sa.created_at, sa.user_id, u.name
    FROM staff_alerts sa LEFT JOIN users u ON u.id=sa.user_id
    WHERE sa.location_id=? AND sa.resolved=0 ORDER BY sa.created_at DESC`).all(locId);
  res.json({ alerts: rows });
});

router.post('/alerts/:id/resolve', requireRole(ROLES.MANAGE), (req, res) => {
  const a = db.prepare(`SELECT * FROM staff_alerts WHERE id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Alert not found.' });
  if (!ownsLocation(req, a.location_id)) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`UPDATE staff_alerts SET resolved=1 WHERE id=?`).run(a.id);
  auditLog(req, 'alert_resolve', 'staff_alert', a.id, { location_id: a.location_id });
  res.json({ success: true });
});

module.exports = router;
// Start the missed-clock-out sweep (called by server.js when it's the entry point).
module.exports.startClockSweep = function startClockSweep() {
  const t = setInterval(sweepMissedClockOuts, 10 * 60 * 1000);
  if (t.unref) t.unref();
  return t;
};
// Break reminders need finer granularity to land ~10 min before a break.
module.exports.startBreakSweep = function startBreakSweep() {
  sweepBreakReminders();
  const t = setInterval(sweepBreakReminders, 2 * 60 * 1000);
  if (t.unref) t.unref();
  return t;
};
