// Full-screen Shift Board (/shiftboard/<slug>) — a no-login, always-on TV display for the back
// office / break room that shows TODAY's scheduled staff for ONE store and, at a glance, who is
// on time, who clocked in late, who's on a break (and whether it ran long), and who forgot/owes a
// break. It's READ-ONLY (a wall screen mutates nothing) and pinned to a store by its URL slug,
// like the clock kiosk and the Floor Board. The point is visibility: when everyone can see that a
// punch was late or a break ran long, the issue tends not to repeat.
const express = require('express');
const db = require('../db/database');
const { normSlug } = require('../lib/slug');
const { localDate, localTime, DEFAULT_TZ } = require('../lib/tz');

const router = express.Router();

// Thresholds (env-tunable, with the same defaults the clock kiosk uses).
const LATE_GRACE_MIN = parseInt(process.env.LATE_GRACE_MIN || '', 10) || 5;       // minutes past start before "late"
const BREAK_LIMIT_MIN = parseInt(process.env.BREAK_LIMIT_MIN || '', 10) || 10;     // a break over this is "long"
const BREAK_SOON_LEAD_MIN = parseInt(process.env.BREAK_SOON_LEAD_MIN || '', 10) || 10; // flash + flag an upcoming break this early
const BREAK_MISS_GRACE_MIN = parseInt(process.env.BREAK_MISS_GRACE_MIN || '', 10) || 15; // scheduled break this overdue → "missed"
const BREAK_DUE_AFTER_MIN = parseInt(process.env.BREAK_DUE_AFTER_MIN || '', 10) || 240;  // earns a rest break per this many worked minutes (CA ~4h)

// Light per-IP abuse guard (a TV polls on a timer; allow generous headroom).
const rate = new Map();
router.use((req, res, next) => {
  const ip = req.ip || 'x', now = Date.now(), e = rate.get(ip);
  if (!e || now - e.t > 60000) { rate.set(ip, { n: 1, t: now }); return next(); }
  if (e.n >= 240) return res.status(429).json({ ok: false, error: 'Too many requests — please wait a moment.' });
  e.n++; next();
});

const locBySlug = (slug) => db.prepare(`SELECT id, name, slug, timezone FROM locations WHERE is_active=1`).all()
  .find(l => normSlug(l.slug || '') === normSlug(slug) || normSlug(l.name) === normSlug(slug)) || null;

const hhmmToMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
function localMinOfDay(tz, d) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  return (Number(p.find(x => x.type === 'hour').value) % 24) * 60 + Number(p.find(x => x.type === 'minute').value);
}
const hhmm = (s) => (s ? String(s).slice(0, 5) : null);

// The picker (bare /shiftboard): every active location.
router.get('/locations', (req, res) => {
  const rows = db.prepare(`SELECT id, name, slug FROM locations WHERE is_active=1 ORDER BY name`).all();
  res.json({ ok: true, locations: rows.map(r => ({ id: r.id, name: r.name, slug: r.slug || normSlug(r.name) })) });
});

// The board: today's scheduled staff + live clock / break status for one store.
router.get('/board', (req, res) => {
  const loc = locBySlug(req.query.slug);
  if (!loc) return res.status(404).json({ ok: false, error: 'Unknown Shift Board link.' });
  const tz = loc.timezone || DEFAULT_TZ;
  const date = localDate(tz);
  const now = new Date();
  const nowMin = localMinOfDay(tz, now);

  // Everyone scheduled to work here today: their shift span + first job + profile title.
  const scheduled = db.prepare(`
    SELECT u.id AS user_id, u.name,
           MIN(s.start_time) AS shift_start, MAX(s.end_time) AS shift_end,
           sp.job_title AS job_title
    FROM shifts s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN staff_profiles sp ON sp.user_id = u.id
    WHERE s.location_id=? AND s.shift_date=? AND s.kind='work'
    GROUP BY u.id ORDER BY u.name`).all(loc.id, date);

  // Today's entries here, plus anyone still on the clock from an earlier day (overnight / forgot).
  const entries = db.prepare(`SELECT te.*, u.name, (SELECT sp.job_title FROM staff_profiles sp WHERE sp.user_id=te.user_id) AS job_title
    FROM time_entries te JOIN users u ON u.id=te.user_id
    WHERE te.location_id=? AND (te.work_date=? OR (te.clock_out IS NULL AND te.work_date < ?))
    ORDER BY te.id`).all(loc.id, date, date);

  // First scheduled job name (for the position chip) — matches the schedule's job.
  const jobForStmt = db.prepare(`SELECT j.name FROM shifts s JOIN shift_jobs sj ON sj.shift_id=s.id JOIN jobs j ON j.id=sj.job_id
    WHERE s.user_id=? AND s.location_id=? AND s.shift_date=? AND s.kind='work' ORDER BY s.start_time IS NULL, s.start_time, j.name LIMIT 1`);
  const jobFor = (uid) => (jobForStmt.get(uid, loc.id, date) || {}).name || null;

  // Scheduled break times for a user today (manager-set breaks that trigger reminders).
  const schedBreaksStmt = db.prepare(`SELECT sb.start_time FROM shift_breaks sb
    JOIN shifts s ON s.id=sb.shift_id AND s.kind='work'
    WHERE s.user_id=? AND s.location_id=? AND s.shift_date=? AND sb.start_time IS NOT NULL AND sb.start_time<>''`);
  // All break punches for a time entry.
  const breaksStmt = db.prepare(`SELECT break_out_at, break_in_at, minutes, over_limit_min FROM time_entry_breaks WHERE time_entry_id=? ORDER BY id`);

  // One entry per user (prefer the one still open, else the latest).
  const entryByUser = {};
  for (const e of entries) {
    const cur = entryByUser[e.user_id];
    if (!cur) { entryByUser[e.user_id] = e; continue; }
    if (cur.clock_out && !e.clock_out) entryByUser[e.user_id] = e;       // open beats closed
    else if ((cur.clock_out ? 1 : 0) === (e.clock_out ? 1 : 0) && e.id > cur.id) entryByUser[e.user_id] = e;
  }

  // Union: everyone scheduled, plus anyone who punched here but wasn't scheduled (flagged).
  const byId = {};
  for (const s of scheduled) byId[s.user_id] = { user_id: s.user_id, name: s.name, job_title: s.job_title, shift_start: hhmm(s.shift_start), shift_end: hhmm(s.shift_end), scheduled: true };
  for (const e of entries) if (!byId[e.user_id]) byId[e.user_id] = { user_id: e.user_id, name: e.name, job_title: e.job_title, shift_start: null, shift_end: null, scheduled: false };

  const staff = Object.values(byId).map(p => {
    const e = entryByUser[p.user_id] || null;
    const job = jobFor(p.user_id) || p.job_title || null;
    const startMin = hhmmToMin(p.shift_start);

    // Clock status.
    let status = 'not_in';
    let clock_in = null, clock_out = null, worked_min = 0, late_min = 0;
    let on_break = false, break_elapsed_min = 0, break_over_now = 0;
    let breaks_taken = 0, break_total_min = 0, break_over_total = 0;
    const flags = [];

    if (e) {
      clock_in = localTime(tz, new Date(e.clock_in));
      late_min = e.late_minutes || 0;
      if (e.clock_out) {
        status = 'out';
        clock_out = localTime(tz, new Date(e.clock_out));
        worked_min = e.worked_minutes || 0;
      } else {
        status = 'in';
        worked_min = Math.max(0, Math.round((now.getTime() - new Date(e.clock_in).getTime()) / 60000));
      }
      // Breaks on this entry.
      for (const b of breaksStmt.all(e.id)) {
        if (b.break_in_at) { breaks_taken++; break_total_min += (b.minutes || 0); break_over_total += (b.over_limit_min || 0); }
        else {
          on_break = true; status = 'on_break';
          break_elapsed_min = Math.max(0, Math.round((now.getTime() - new Date(b.break_out_at).getTime()) / 60000));
          break_over_now = Math.max(0, break_elapsed_min - BREAK_LIMIT_MIN);
        }
      }
    }

    // Late — either clocked in late (stored on the entry, persists all day), or scheduled,
    // still not in, and already past their start (so a no-show reads as late right away).
    let not_in_late = 0;
    if (status === 'not_in' && startMin != null) {
      const over = nowMin - startMin;
      if (over > LATE_GRACE_MIN) { not_in_late = over; late_min = over; }
    }

    // Scheduled break times the manager set (shown on the board; drive the 10-min flash,
    // the "break in N" heads-up, and "break missed"). Sorted HH:MM list + minutes.
    const sched_breaks = schedBreaksStmt.all(p.user_id, loc.id, date).map(r => hhmm(r.start_time)).filter(Boolean).sort();
    const schedMins = sched_breaks.map(hhmmToMin);
    let break_soon_min = null, break_missed = false, next_break = null;
    const upcoming = schedMins.filter(m => m >= nowMin).sort((a, b) => a - b)[0];
    if (upcoming != null) next_break = sched_breaks[schedMins.indexOf(upcoming)];
    if (status === 'in' && !on_break) {
      // Flash/flag the next scheduled break only if they still owe one up to that slot.
      const dueBySlot = schedMins.filter(m => m <= (upcoming != null ? upcoming : -1)).length;
      if (upcoming != null && upcoming - nowMin <= BREAK_SOON_LEAD_MIN && breaks_taken < dueBySlot) break_soon_min = upcoming - nowMin;
      const overdueCount = schedMins.filter(m => nowMin - m > BREAK_MISS_GRACE_MIN).length;
      if (overdueCount > breaks_taken) break_missed = true;
    }

    // "Due a break" heuristic — works even when no break times were scheduled: a rest break
    // is earned per ~4 worked hours, so flag anyone on the clock who's earned more than they've
    // taken (and isn't already on break, about to take one, or flagged as having missed one).
    const breaks_earned = Math.floor(worked_min / BREAK_DUE_AFTER_MIN);
    const break_due = status === 'in' && !on_break && breaks_earned > breaks_taken && !break_missed && break_soon_min == null;

    const long_break = break_over_now > 0 || break_over_total > 0;

    // Flags, most-severe first (the frontend tints the row by the top flag).
    if (late_min > 0) flags.push({ kind: 'late', sev: 'red', min: late_min });
    if (long_break) flags.push({ kind: 'long_break', sev: 'red', min: break_over_now || break_over_total });
    if (break_missed) flags.push({ kind: 'break_missed', sev: 'red' });
    if (break_soon_min != null) flags.push({ kind: 'break_soon', sev: 'amber', min: break_soon_min });
    if (break_due) flags.push({ kind: 'break_due', sev: 'amber' });
    if (on_break && !long_break) flags.push({ kind: 'on_break', sev: 'blue', min: break_elapsed_min });
    if (!p.scheduled) flags.push({ kind: 'unscheduled', sev: 'amber' });

    return {
      user_id: p.user_id, name: p.name, job, scheduled: p.scheduled,
      shift_start: p.shift_start, shift_end: p.shift_end,
      clock_in, clock_out, status, worked_min,
      late_min, not_in_late: not_in_late > 0 ? not_in_late : 0,
      on_break, break_elapsed_min, break_over_now,
      breaks_taken, break_total_min, break_over_total,
      sched_breaks, next_break, break_soon_min, break_missed, break_due, long_break,
      flags,
      // Top severity for row tint / sort: 0 none, 1 blue, 2 amber, 3 red.
      sev: flags.some(f => f.sev === 'red') ? 3 : flags.some(f => f.sev === 'amber') ? 2 : flags.some(f => f.sev === 'blue') ? 1 : 0,
    };
  });

  // Sort: on-the-clock first, then by severity (problems bubble up), then start time, then name.
  const statusRank = { on_break: 0, in: 0, not_in: 1, out: 2 };
  staff.sort((a, b) =>
    (statusRank[a.status] - statusRank[b.status])
    || (b.sev - a.sev)
    || String(a.shift_start || '~').localeCompare(String(b.shift_start || '~'))
    || a.name.localeCompare(b.name));

  const summary = {
    total: staff.length,
    on_clock: staff.filter(s => s.status === 'in' || s.status === 'on_break').length,
    on_break: staff.filter(s => s.status === 'on_break').length,
    not_in: staff.filter(s => s.status === 'not_in').length,
    done: staff.filter(s => s.status === 'out').length,
    late: staff.filter(s => s.late_min > 0).length,
    long_break: staff.filter(s => s.long_break).length,
    break_missed: staff.filter(s => s.break_missed).length,
    break_due: staff.filter(s => s.break_due).length,
  };

  res.json({
    ok: true,
    location: { id: loc.id, name: loc.name, slug: loc.slug || normSlug(loc.name) },
    date, timezone: tz, now_hhmm: localTime(tz, now), now_min: nowMin,
    thresholds: { break_limit_min: BREAK_LIMIT_MIN, late_grace_min: LATE_GRACE_MIN },
    staff, summary,
  });
});

module.exports = router;
