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
const { verifyToken, requireRole, ROLES, seesAllLocations, userSeesAll, userCanAccessLocation, roleHasCap, SECRET } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const { notify } = require('./messages');
const { localDate, localTime, DEFAULT_TZ } = require('../lib/tz');
const { normSlug } = require('../lib/slug');
const { emitAlert } = require('../lib/events');
const { sendSms, smsEnabled } = require('../lib/sms');
const { POLICY: ACK_POLICY, VERSION: ACK_VERSION, normLang, ackContent, renderAckPdf, langName } = require('../lib/acknowledgments');

const router = express.Router();
const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

// ── Break rules ──────────────────────────────────────────────────────────────
const BREAK_LIMIT_MIN = parseInt(process.env.BREAK_LIMIT_MIN || '', 10) || 10;   // allowed minutes per break
// Minimum break: a staffer must stay on break at least this long before they can clock back in (they
// can't shortchange the break). Defaults to the limit, so the break is exactly ~10 min.
const BREAK_MIN_MIN = parseInt(process.env.BREAK_MIN_MIN || '', 10) || BREAK_LIMIT_MIN;
const BREAK_NUDGE_MIN = parseInt(process.env.BREAK_NUDGE_MIN || '', 10) || 5;    // re-nudge cadence once over
const BREAK_ESCALATE_OVER_MIN = parseInt(process.env.BREAK_ESCALATE_OVER_MIN || '', 10) || 20; // minutes over the limit → tell the lead
// Close any still-open break on an entry (used when a shift is clocked out while on break — e.g. a
// forced/auto clock-out). Counts the break up to `atISO`.
function closeOpenBreaks(entryId, atISO) {
  const at = atISO || new Date().toISOString();
  const rows = db.prepare(`SELECT id, break_out_at FROM time_entry_breaks WHERE time_entry_id=? AND break_in_at IS NULL`).all(entryId);
  for (const b of rows) {
    const mins = Math.max(0, Math.round((new Date(at).getTime() - new Date(b.break_out_at).getTime()) / 60000));
    db.prepare(`UPDATE time_entry_breaks SET break_in_at=?, minutes=?, over_limit_min=? WHERE id=?`).run(at, mins, Math.max(0, mins - BREAK_LIMIT_MIN), b.id);
  }
}
// Total break minutes (and over-limit minutes) a user took on a work date (by the entry's local date).
function breakMinutesFor(userId, locId, date) {
  const r = db.prepare(`SELECT COALESCE(SUM(b.minutes),0) AS total, COALESCE(SUM(b.over_limit_min),0) AS over
    FROM time_entry_breaks b JOIN time_entries te ON te.id=b.time_entry_id
    WHERE te.user_id=? AND te.location_id=? AND te.work_date=? AND b.break_in_at IS NOT NULL`).get(userId, locId, date) || { total: 0, over: 0 };
  return { total: r.total || 0, over: r.over || 0 };
}

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
  const kind = ['daily', 'weekly', 'biweekly', 'monthly'].includes(req.query.kind) ? req.query.kind : 'biweekly';
  const tz = DEFAULT_TZ, today = localDate(tz);
  const range = periodRange(kind, validDate(req.query.anchor) || today);
  res.json(Object.assign({ user: { id: u.id, name: u.name }, today, signoff_window: signoffSummary(u.id, today) }, myHoursData(u.id, range.start, range.end, kind)));
});

// My clock status for TODAY — a tiny summary the staff app shows so people remember whether
// they've clocked in / out or have no shift today. Any staff member (JWT) or the Staff app
// on their behalf (service key + ?as=email). Defined before the manager auth wall below.
router.get('/my-today', (req, res) => {
  const u = resolveMyUser(req);
  if (!u) return res.status(401).json({ error: 'Authentication required' });
  const homeTz = (db.prepare(`SELECT l.timezone FROM users usr JOIN locations l ON l.id=usr.location_id WHERE usr.id=?`).get(u.id) || {}).timezone || DEFAULT_TZ;
  const today = localDate(homeTz);
  // Today's entries at any location, plus any entry still open from a previous day (forgot to
  // clock out / overnight) so "you're still clocked in" is never hidden.
  const entries = db.prepare(`SELECT te.*, l.name AS loc_name, l.timezone AS tz
      FROM time_entries te JOIN locations l ON l.id=te.location_id
      WHERE te.user_id=? AND (te.work_date=? OR (te.clock_out IS NULL AND te.work_date < ?))
      ORDER BY te.clock_in`).all(u.id, today, today);
  const open = entries.find(e => !e.clock_out) || null;
  const doneToday = entries.filter(e => e.clock_out && e.work_date === today)
    .sort((a, b) => new Date(b.clock_out) - new Date(a.clock_out));
  const lastDone = doneToday[0] || null;
  const ob = open ? db.prepare(`SELECT break_out_at FROM time_entry_breaks WHERE time_entry_id=? AND break_in_at IS NULL ORDER BY id DESC LIMIT 1`).get(open.id) : null;
  // Today's scheduled work shift(s), any location.
  const shifts = db.prepare(`SELECT s.start_time, s.end_time, l.name AS loc_name
      FROM shifts s JOIN locations l ON l.id=s.location_id
      WHERE s.user_id=? AND s.shift_date=? AND s.kind='work' AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
      ORDER BY s.start_time`).all(u.id, today);
  const tzFor = (e) => (e && e.tz) ? e.tz : homeTz;
  let state;
  if (open && ob) state = 'on_break';
  else if (open) state = 'in';
  else if (lastDone) state = 'out';
  else if (shifts.length) state = 'not_in';
  else state = 'no_schedule';
  res.json({
    today, state,
    location: open ? open.loc_name : (lastDone ? lastDone.loc_name : (shifts[0] ? shifts[0].loc_name : null)),
    clock_in: open ? localTime(tzFor(open), new Date(open.clock_in)) : null,
    clock_out: lastDone ? localTime(tzFor(lastDone), new Date(lastDone.clock_out)) : null,
    worked_minutes: open ? liveWorked(open) : (lastDone ? (lastDone.worked_minutes || 0) : 0),
    break_since: ob ? localTime(tzFor(open), new Date(ob.break_out_at)) : null,
    shifts: shifts.map(s => ({ start: s.start_time, end: s.end_time, location: s.loc_name })),
  });
});

// Resolve the acting staff member for a self-service call — a JWT, or the Staff app
// on their behalf (service key + ?as=email). Returns { id, name } or null.
function resolveMyUser(req) {
  const key = req.headers['x-service-key'] || req.query.key;
  if (key && key === SERVICE_KEY) {
    const email = String(req.query.as || '').toLowerCase().trim();
    return email ? db.prepare(`SELECT id, name FROM users WHERE lower(email)=? AND is_active=1`).get(email) : null;
  }
  try { const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); return { id: p.id, name: p.name }; } catch { return null; }
}

// End-of-day sign-off — the staffer reviews a day's worked hours and confirms they're correct.
// Operates on every completed entry for that (staffer, date), so a day split across locations signs
// off together. Confirming clears any prior dispute (they changed their mind and it's fine now).
router.post('/my-hours/confirm', (req, res) => {
  const u = resolveMyUser(req);
  if (!u) return res.status(401).json({ error: 'Authentication required' });
  const date = validDate(req.body && req.body.date);
  if (!date) return res.status(400).json({ error: 'A valid date is required.' });
  // One-time gate: the staffer must have e-signed the current Worked-Hours
  // Acknowledgment before any daily confirm goes through.
  const signed = db.prepare(`SELECT 1 FROM staff_acknowledgments WHERE user_id=? AND policy=? AND version=? LIMIT 1`).get(u.id, ACK_POLICY, ACK_VERSION);
  if (!signed) return res.status(409).json({ error: 'Please read and sign the one-time Worked-Hours Acknowledgment before confirming your hours.', needs_ack: true });
  const entries = db.prepare(`SELECT id FROM time_entries WHERE user_id=? AND work_date=? AND clock_out IS NOT NULL`).all(u.id, date);
  if (!entries.length) return res.status(404).json({ error: 'No completed hours to confirm for that day.' });
  db.prepare(`UPDATE time_entries SET hours_confirmed=1, hours_confirmed_at=datetime('now'), hours_disputed=0, hours_disputed_at=NULL
    WHERE user_id=? AND work_date=? AND clock_out IS NOT NULL`).run(u.id, date);
  res.json({ success: true, date, status: 'confirmed' });
});

// The staffer flags a day's hours as wrong — mark it disputed and message the location's manager +
// shift lead to review and correct it (with the clocked-vs-scheduled totals and any note they left).
router.post('/my-hours/dispute', (req, res) => {
  const u = resolveMyUser(req);
  if (!u) return res.status(401).json({ error: 'Authentication required' });
  const date = validDate(req.body && req.body.date);
  if (!date) return res.status(400).json({ error: 'A valid date is required.' });
  const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
  const entries = db.prepare(`SELECT id, location_id, worked_minutes, scheduled_minutes FROM time_entries WHERE user_id=? AND work_date=? AND clock_out IS NOT NULL`).all(u.id, date);
  if (!entries.length) return res.status(404).json({ error: 'No completed hours to report for that day.' });
  db.prepare(`UPDATE time_entries SET hours_disputed=1, hours_disputed_at=datetime('now'), hours_confirmed=0, hours_confirmed_at=NULL
    WHERE user_id=? AND work_date=? AND clock_out IS NOT NULL`).run(u.id, date);
  const worked = entries.reduce((a, e) => a + (e.worked_minutes || 0), 0);
  const sched = entries.reduce((a, e) => Math.max(a, e.scheduled_minutes || 0), 0);
  const subject = 'Worked-hours correction requested';
  const body = `${u.name} flagged their worked hours for ${date} as incorrect (clocked ${fmtDurMin(worked)}${sched ? ` vs ${fmtDurMin(sched)} scheduled` : ''}).${note ? ` Note: “${note}”` : ''} Please review and correct them on the Time Clock / Timesheet.`;
  for (const lid of [...new Set(entries.map(e => e.location_id))]) notifyLeaders(lid, u.id, subject, body);
  res.json({ success: true, date, status: 'disputed' });
});

// ── One-time Worked-Hours Acknowledgment (typed-name e-signature) ─────────────
// Staff read the policy and sign it once; the signed PDF is filed in their
// document folder and the daily My Hours confirm step unlocks.
const ackLatest = (userId) => db.prepare(
  `SELECT id, version, full_name, lang, signed_at, document_id FROM staff_acknowledgments
   WHERE user_id=? AND policy=? ORDER BY id DESC LIMIT 1`).get(userId, ACK_POLICY);

function signedLabel(iso) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TZ, dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso)) + ` (${DEFAULT_TZ})`; }
  catch { return iso; }
}

// Status + the policy text (all languages) to read. `signed` is for the CURRENT version.
router.get('/my-hours/ack', (req, res) => {
  const u = resolveMyUser(req);
  if (!u) return res.status(401).json({ error: 'Authentication required' });
  const latest = ackLatest(u.id);
  const signedCurrent = !!(latest && latest.version === ACK_VERSION);
  res.json({
    content: ackContent(),
    version: ACK_VERSION,
    signed: signedCurrent,
    signed_at: latest ? latest.signed_at : null,
    signed_name: latest ? latest.full_name : null,
    signed_lang: latest ? latest.lang : null,
    signed_version: latest ? latest.version : null,
    has_document: !!(latest && latest.document_id),
  });
});

// Sign it. Idempotent for the current version (re-POST returns the existing one).
router.post('/my-hours/ack', async (req, res) => {
  const u = resolveMyUser(req);
  if (!u) return res.status(401).json({ error: 'Authentication required' });
  const agree = req.body && (req.body.agree === true || req.body.agree === 'true' || req.body.agree === 1);
  const fullName = String((req.body && req.body.full_name) || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const lang = normLang(req.body && req.body.lang);
  if (!agree) return res.status(400).json({ error: 'Please tick the box to confirm you have read and agree.' });
  if (fullName.length < 2 || !/\p{L}/u.test(fullName)) return res.status(400).json({ error: 'Please type your full name as your signature.' });

  const existing = db.prepare(`SELECT id, signed_at, document_id FROM staff_acknowledgments WHERE user_id=? AND policy=? AND version=? ORDER BY id DESC LIMIT 1`)
    .get(u.id, ACK_POLICY, ACK_VERSION);
  if (existing) return res.json({ success: true, already: true, signed_at: existing.signed_at, document_id: existing.document_id });

  const prof = db.prepare(`SELECT employee_code FROM staff_profiles WHERE user_id=?`).get(u.id) || {};
  const usr = db.prepare(`SELECT name, email FROM users WHERE id=?`).get(u.id) || {};
  const nowIso = new Date().toISOString();
  const label = signedLabel(nowIso);
  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '').slice(0, 60);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);

  // Record the signing event first (so the PDF can carry its id), then file the PDF.
  const ins = db.prepare(`INSERT INTO staff_acknowledgments (user_id, policy, version, full_name, lang, signed_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)`)
    .run(u.id, ACK_POLICY, ACK_VERSION, fullName, lang, nowIso, ip, ua);
  const ackId = Number(ins.lastInsertRowid);
  let pdf;
  try { pdf = await renderAckPdf({ fullName, employeeName: usr.name || u.name, employeeRef: prof.employee_code || usr.email || '', signedAtLabel: label, ip, userAgent: ua, ackId, lang }); }
  catch (e) { db.prepare(`DELETE FROM staff_acknowledgments WHERE id=?`).run(ackId); return res.status(500).json({ error: 'Could not generate your signed form — please try again.' }); }
  const filename = `Worked-Hours Acknowledgment (${lang}, signed ${nowIso.slice(0, 10)}).pdf`;
  const note = `Worked-Hours Review & Acknowledgment v${ACK_VERSION} (${langName(lang)}) — e-signed ${label}`;
  const docInfo = db.prepare(`INSERT INTO staff_documents (user_id, filename, mime, byte_size, note, bytes, uploaded_by) VALUES (?,?,?,?,?,?,?)`)
    .run(u.id, filename, 'application/pdf', pdf.length, note, pdf, u.id);
  const documentId = Number(docInfo.lastInsertRowid);
  db.prepare(`UPDATE staff_acknowledgments SET document_id=? WHERE id=?`).run(documentId, ackId);
  try { auditLog(req, 'hours_ack_signed', 'user', u.id, { ack_id: ackId, document_id: documentId, version: ACK_VERSION, lang }); } catch { /* best-effort */ }
  res.json({ success: true, signed_at: nowIso, document_id: documentId, lang });
});

// Stream the staffer's own most-recent signed acknowledgment PDF (self-view; the
// staff_documents folder itself stays manager-gated).
router.get('/my-hours/ack/document', (req, res) => {
  const u = resolveMyUser(req);
  if (!u) return res.status(401).json({ error: 'Authentication required' });
  const latest = ackLatest(u.id);
  if (!latest || !latest.document_id) return res.status(404).json({ error: 'No signed acknowledgment on file.' });
  const doc = db.prepare(`SELECT filename, mime, bytes FROM staff_documents WHERE id=? AND user_id=?`).get(latest.document_id, u.id);
  if (!doc) return res.status(404).json({ error: 'No signed acknowledgment on file.' });
  const buf = Buffer.from(doc.bytes);
  res.setHeader('Content-Type', doc.mime || 'application/pdf');
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Content-Disposition', `inline; filename="${(doc.filename || 'acknowledgment.pdf').replace(/[^\w.\-]+/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.end(buf);
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
const validCode = (c) => /^[A-Za-z0-9-]{4,20}$/.test(c);
const hhmmToMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
// Max minutes a staffer may clock in BEFORE their shift start (a hard block past this).
const EARLY_CLOCKIN_MAX_MIN = parseInt(process.env.EARLY_CLOCKIN_MAX_MIN || '', 10) || 15;
const fmt12h = (m) => { m = ((m % 1440) + 1440) % 1440; const h = Math.floor(m / 60), mm = m % 60, ap = h < 12 ? 'a' : 'p', hh = (h % 12) || 12; return mm ? `${hh}:${String(mm).padStart(2, '0')}${ap}` : `${hh}${ap}`; };
// Clock-in reminder to confirm unconfirmed prior-day hours. OFF for now (staff are being trained on
// the app; clock-in is never blocked on it) — set HOURS_SIGNOFF_REMINDER=1 to turn the nudge back on.
const REMIND_UNCONFIRMED_HOURS = /^(1|true|on|yes)$/i.test(process.env.HOURS_SIGNOFF_REMINDER || '');
// The people who lead a location: any active staffer assigned there whose role
// carries the 'manage' cap — managers, assistant/kitchen managers AND shift leads
// (or any custom manage-capable role). Falls back to org leadership if a store has
// none on file. Used for every leader alert (missed / unscheduled clock-in, etc.).
function locationLeaders(locId) {
  let ids = db.prepare(`SELECT id, role FROM users WHERE is_active=1 AND location_id=?`).all(locId)
    .filter(u => roleHasCap(u.role, 'manage')).map(u => u.id);
  if (!ids.length) ids = db.prepare(`SELECT id FROM users WHERE is_active=1 AND role IN ('owner','admin','general_manager')`).all().map(r => r.id);
  return ids;
}
// The central operations contact (Nha Le) gets a copy of every manager-facing alert — matching
// the waitlist/distribution pattern. Looked up by name so it survives re-seeds / id changes.
function centralContact() {
  return db.prepare(`SELECT id FROM users WHERE is_active=1 AND name LIKE 'Nha Le%' ORDER BY id LIMIT 1`).get();
}
// In-app message to the location's leaders PLUS the central contact (Nha Le), deduped.
// App message only for now — no SMS (owner's request 2026-11-21).
function notifyLeaders(locId, staffId, subject, body) {
  const ids = new Set(locationLeaders(locId).map(String));
  const central = centralContact(); if (central) ids.add(String(central.id));
  for (const lid of ids) if (String(lid) !== String(staffId)) {
    try { notify(staffId, lid, subject, body); } catch { /* best effort */ }
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
  const openBreak = open ? db.prepare(`SELECT * FROM time_entry_breaks WHERE time_entry_id=? AND break_in_at IS NULL ORDER BY id DESC LIMIT 1`).get(open.id) : null;
  return {
    loc, staff, tz, date, open, openBreak,
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
  const clockedIn = !!ctx.open, onBreak = !!ctx.openBreak;
  res.json({
    ok: true, name: ctx.staff.name,
    greeting: `${greetingWord(ctx.tz)} ${ctx.staff.name}, welcome to ${locDisplay(ctx.loc.name)}`,
    clocked_in: clockedIn, on_break: onBreak,
    since: clockedIn ? localTime(ctx.tz, new Date(ctx.open.clock_in)) : null,
    break_since: onBreak ? localTime(ctx.tz, new Date(ctx.openBreak.break_out_at)) : null,
    break_limit_min: BREAK_LIMIT_MIN, break_min_min: BREAK_MIN_MIN,
    // While on break, how long is left before they can clock in (minimum break), and whether it's done.
    break_min_left: onBreak ? Math.max(0, Math.ceil((BREAK_MIN_MIN * 60000 - (Date.now() - new Date(ctx.openBreak.break_out_at).getTime())) / 60000)) : null,
    break_ready: onBreak ? (Date.now() - new Date(ctx.openBreak.break_out_at).getTime()) >= BREAK_MIN_MIN * 60000 : null,
    // On break → the only action is to clock back in; on the clock → can clock out (break or end shift).
    can_in: !clockedIn || onBreak, can_out: clockedIn && !onBreak,
  });
});

// Clock in / out (send {action:'in'|'out', confirm:true} to accept a warning).
// Store a punch photo (data URL from the kiosk camera) against a time entry. Best-effort:
// never throws into the punch flow — a shift is recorded even if the photo can't be saved.
function savePunchPhoto(entryId, kind, dataUrl) {
  try {
    if (!entryId || !dataUrl || typeof dataUrl !== 'string') return;
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) return;
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length || bytes.length > 900000) return;   // sanity cap ~0.9MB
    db.prepare(`DELETE FROM time_entry_photos WHERE entry_id=? AND kind=?`).run(entryId, kind);
    db.prepare(`INSERT INTO time_entry_photos (entry_id, kind, mime, bytes, byte_size) VALUES (?,?,?,?,?)`)
      .run(entryId, kind, m[1], bytes, bytes.length);
  } catch { /* best-effort — the punch is already recorded */ }
}

router.post('/kiosk/:slug/punch', kioskThrottle, (req, res) => {
  const ctx = clockContext(req.params.slug, req.body && req.body.employee_code);
  if (ctx.err === 404) return res.status(404).json({ error: ctx.msg });
  if (ctx.err === 'format') return res.status(400).json({ error: 'That employee code doesn’t look right — please check it and try again.' });
  if (ctx.err === 'notfound') return res.status(404).json({ error: 'Employee code not found. Please check again, or ask your manager.' });
  const { loc, staff, tz, date } = ctx, confirm = !!(req.body && req.body.confirm), now = new Date();

  if ((req.body && req.body.action) === 'in') {
    // Returning from a break → close the open break, not a new shift. "Welcome back" + over-limit notice.
    if (ctx.openBreak) {
      const b = ctx.openBreak;
      const elapsedMs = now.getTime() - new Date(b.break_out_at).getTime();
      // Minimum break: block clock-in until the full break has been taken; tell them how long is left.
      if (elapsedMs < BREAK_MIN_MIN * 60000) {
        const minLeft = Math.max(1, Math.ceil((BREAK_MIN_MIN * 60000 - elapsedMs) / 60000));
        return res.json({
          break_wait: true, name: staff.name, min_left: minLeft, break_min_min: BREAK_MIN_MIN,
          message: `Please finish your break first, ${staff.name} — ${minLeft} more minute${minLeft === 1 ? '' : 's'} to go before you can clock back in.`,
          at: localTime(tz, now),
        });
      }
      const mins = Math.max(0, Math.round(elapsedMs / 60000));
      const over = Math.max(0, mins - BREAK_LIMIT_MIN);
      db.prepare(`UPDATE time_entry_breaks SET break_in_at=?, minutes=?, over_limit_min=? WHERE id=?`).run(now.toISOString(), mins, over, b.id);
      savePunchPhoto(ctx.open.id, 'break_in', req.body && req.body.photo);
      return res.json({
        success: true, action: 'break_in', welcome: true, name: staff.name,
        break_minutes: mins, over_limit_min: over, break_limit_min: BREAK_LIMIT_MIN,
        message: over > 0
          ? `Welcome back, ${staff.name}! Your break was ${mins} min — ${over} over the ${BREAK_LIMIT_MIN}-minute limit.`
          : `Welcome back, ${staff.name}!`,
        at: localTime(tz, now),
      });
    }
    // Already clocked in at a DIFFERENT location → clock out there first (you can't be on the
    // clock at two stores at once). A stale entry elsewhere is cleaned up by the auto clock-out
    // sweep or a manager.
    const openElsewhere = db.prepare(`SELECT l.name AS loc_name FROM time_entries te JOIN locations l ON l.id=te.location_id
      WHERE te.user_id=? AND te.clock_out IS NULL AND te.location_id<>? ORDER BY te.id DESC LIMIT 1`).get(staff.id, loc.id);
    if (openElsewhere) return res.status(409).json({ error: `You’re still clocked in at ${locDisplay(openElsewhere.loc_name)}. Please clock out there before clocking in here.` });
    if (ctx.open) {
      // Split shifts: if this punch is for a LATER shift block but an EARLIER block is
      // still open (they forgot to clock out of it) and that earlier block has already
      // ended, auto-close it at its scheduled end — never paying the gap — so they can
      // clock in for the next shift. Otherwise it's a genuine "already clocked in".
      const openInMin = localMinutesOfDay(tz, new Date(ctx.open.clock_in));
      const nowMin = localMinutesOfDay(tz, now);
      const openBlk = shiftBlockForPunch(staff.id, loc.id, date, openInMin);
      const nowBlk = shiftBlockForPunch(staff.id, loc.id, date, nowMin);
      const staleOver = openBlk && nowBlk && openBlk.sMin !== nowBlk.sMin
        && openBlk.eMin != null && nowMin >= openBlk.eMin;
      if (!staleOver) {
        return res.status(409).json({ error: `You’re already clocked in (since ${localTime(tz, new Date(ctx.open.clock_in))}).` });
      }
      const workedToEnd = workedToScheduledEnd(openBlk, openInMin);
      const priorOut = new Date(new Date(ctx.open.clock_in).getTime() + workedToEnd * 60000);
      const rr = db.prepare(`UPDATE time_entries SET clock_out=?, worked_minutes=?, overrun_decision='auto', overrun_decided_at=datetime('now') WHERE id=? AND clock_out IS NULL`)
        .run(priorOut.toISOString(), workedToEnd, ctx.open.id);
      if (rr.changes) {
        closeOpenBreaks(ctx.open.id, priorOut.toISOString());
        notifyLeaders(loc.id, staff.id, 'Auto clock-out', `${staff.name} didn’t clock out of their earlier shift at ${locDisplay(loc.name)} (ended ${openBlk.eRaw}); the system closed it at its scheduled end when they clocked in for their next shift. Adjust their hours if they actually worked later.`);
      }
      ctx.open = null; // fall through and record a fresh clock-in for the next shift
    }
    // Hard block: no clocking in more than EARLY_CLOCKIN_MAX_MIN before the shift they're arriving for
    // (the block that contains or next follows "now"). E.g. a 10:00 shift can't be clocked before 9:45.
    if (ctx.here) {
      const nMin = localMinutesOfDay(tz, now);
      const tgt = shiftBlockForPunch(staff.id, loc.id, date, nMin);
      if (tgt && tgt.sMin != null && tgt.sMin - nMin > EARLY_CLOCKIN_MAX_MIN) {
        return res.status(409).json({ too_early: true, name: staff.name,
          error: `Too early, ${staff.name} — your shift starts at ${fmt12h(tgt.sMin)}. You can clock in from ${fmt12h(tgt.sMin - EARLY_CLOCKIN_MAX_MIN)} (up to ${EARLY_CLOCKIN_MAX_MIN} minutes early).` });
      }
    }
    let reason = null, warn = null;
    if (ctx.here) {
      // Within the allowed window (≤ EARLY_CLOCKIN_MAX_MIN early, on time, or late) — nothing to confirm.
    } else if (ctx.elsewhere) { reason = 'wrong_location'; warn = `You’re scheduled at another location today, not ${locDisplay(loc.name)}. Clock in here anyway?`; }
    else if (ctx.isHome) { reason = 'no_schedule'; warn = `You aren’t scheduled to work today. Clock in anyway?`; }
    else { reason = 'no_schedule_wrong_location'; warn = `You aren’t scheduled to work today, and this isn’t your usual location. Clock in here anyway?`; }
    if (reason && !confirm) return res.json({ confirm: true, reason, message: warn });
    const sched = scheduledMinutes(staff.id, loc.id, date), late = lateMinutesFor(staff.id, loc.id, date, tz, now);
    const info = db.prepare(`INSERT INTO time_entries (user_id, location_id, work_date, clock_in, scheduled_minutes, late_minutes, opened_by) VALUES (?,?,?,?,?,?,?)`)
      .run(staff.id, loc.id, date, now.toISOString(), sched, late, staff.id);
    savePunchPhoto(info.lastInsertRowid, 'in', req.body && req.body.photo);
    if (late > 0) db.prepare(`INSERT INTO staff_alerts (location_id, user_id, kind, message, time_entry_id) VALUES (?,?,?,?,?)`).run(loc.id, staff.id, 'late', `${staff.name} clocked in ${fmtDurMin(late)} late.`, info.lastInsertRowid);
    if (reason) {
      const why = { early: 'more than 30 minutes early', wrong_location: 'at a location they’re not scheduled at today', no_schedule: 'without being scheduled today', no_schedule_wrong_location: 'without being scheduled today, and at an unusual location' }[reason];
      notifyLeaders(loc.id, staff.id, 'Clock-in to review', `${staff.name} clocked in at ${locDisplay(loc.name)} ${why} (${localTime(tz, now)}). Please review it for their timesheet.`);
    }
    // Still-pending sign-off from an earlier day → remind them to review it (never blocks clock-in).
    // Suppressed during training (REMIND_UNCONFIRMED_HOURS off) so staff aren't nagged while they learn.
    const pend = REMIND_UNCONFIRMED_HOURS ? db.prepare(`SELECT work_date FROM time_entries WHERE user_id=? AND clock_out IS NOT NULL
      AND hours_confirmed=0 AND hours_disputed=0 AND work_date < ? ORDER BY work_date DESC`).all(staff.id, date) : [];
    const hoursPending = pend.length ? { date: pend[0].work_date, count: new Set(pend.map(p => p.work_date)).size } : null;
    return res.json({ success: true, action: 'in', message: `You’re clocked in — have a great shift, ${staff.name}!`,
      hours_review_pending: hoursPending,
      hours_prompt: hoursPending ? `Before your shift: please open My Hours and confirm your worked hours for ${hoursPending.date}${hoursPending.count > 1 ? ` and ${hoursPending.count - 1} earlier day${hoursPending.count > 2 ? 's' : ''}` : ''}.` : null,
      at: localTime(tz, now) });
  }

  if ((req.body && req.body.action) === 'out') {
    if (!ctx.open) return res.status(409).json({ error: 'You’re not clocked in here.' });
    // On break → they must clock back IN before ending the shift.
    if (ctx.openBreak) return res.status(409).json({ error: 'You’re on a break — tap Clock in to return before you end your shift.' });
    // Clocking out means one of two things — ask which unless the kiosk already told us.
    const kind = req.body && req.body.kind;
    if (kind !== 'break' && kind !== 'shift') {
      return res.json({ choose: true, message: 'Are you taking a break, or ending your shift?', options: ['break', 'shift'] });
    }
    if (kind === 'break') {
      db.prepare(`INSERT INTO time_entry_breaks (time_entry_id, user_id, location_id, break_out_at) VALUES (?,?,?,?)`)
        .run(ctx.open.id, staff.id, loc.id, now.toISOString());
      savePunchPhoto(ctx.open.id, 'break_out', req.body && req.body.photo);
      return res.json({ success: true, action: 'break_out', message: `On break, ${staff.name} — take your full ${BREAK_MIN_MIN}-minute break, then clock back in.`, break_limit_min: BREAK_LIMIT_MIN, break_min_min: BREAK_MIN_MIN, at: localTime(tz, now) });
    }
    // kind === 'shift' → end the shift (same early-out confirm as before).
    let reason = null;
    if (ctx.endHere) { const early = hhmmToMin(ctx.endHere) - localMinutesOfDay(tz, now); if (early > 30) reason = 'out_early'; }
    if (reason && !confirm) return res.json({ confirm: true, reason, message: `You’re clocking out more than 30 minutes before your ${ctx.endHere} end time. Clock out anyway?` });
    const worked = Math.max(0, Math.round((now.getTime() - new Date(ctx.open.clock_in).getTime()) / 60000));
    db.prepare(`UPDATE time_entries SET clock_out=?, worked_minutes=? WHERE id=?`).run(now.toISOString(), worked, ctx.open.id);
    savePunchPhoto(ctx.open.id, 'out', req.body && req.body.photo);
    if (reason) notifyLeaders(loc.id, staff.id, 'Early clock-out', `${staff.name} clocked out early at ${locDisplay(loc.name)} (${localTime(tz, now)}, worked ${fmtDurMin(worked)}). Please review it for their timesheet.`);
    const brk = breakMinutesFor(staff.id, loc.id, date);
    return res.json({ success: true, action: 'out', message: `Goodbye ${staff.name}! You worked ${fmtDurMin(worked)} today.${brk.total ? ` (Breaks: ${brk.total} min${brk.over ? `, ${brk.over} over` : ''}.)` : ''}`,
      // Remind them to sign off today's hours in their own app (this kiosk is a shared tablet).
      remind_hours: true, hours_prompt: 'Please open My Hours in your app and confirm your worked hours for today are correct.',
      at: localTime(tz, now) });
  }
  return res.status(400).json({ error: 'Unknown action.' });
});

// Pair a punch (clock-in minute-of-day) to one of a staff member's WORK shift blocks
// for the day at a location: the block that contains the punch, else the next upcoming
// block, else the last block. Returns {sRaw,eRaw,sMin,eMin} or null when nothing is
// scheduled with times. This is what makes split shifts (two blocks the same day, e.g.
// 10a–12p then 1p–4p) enforce each block's OWN end separately, instead of the day's
// latest end — so a forgotten first-shift clock-out closes at 12p, not 4p.
function shiftBlockForPunch(userId, locationId, workDate, clockInMin) {
  const blocks = db.prepare(
    `SELECT start_time s, end_time e FROM shifts
       WHERE user_id=? AND location_id=? AND shift_date=? AND kind='work'
         AND start_time IS NOT NULL AND end_time IS NOT NULL`
  ).all(userId, locationId, workDate)
    .map(b => ({ sRaw: b.s, eRaw: b.e, sMin: hhmmToMin(b.s), eMin: hhmmToMin(b.e) }))
    .filter(b => b.sMin != null && b.eMin != null)
    .sort((a, b) => a.sMin - b.sMin);
  if (!blocks.length) return null;
  if (clockInMin == null) return blocks[blocks.length - 1];
  // Block containing the punch (end<=start means the block crosses midnight).
  const inside = blocks.find(b => {
    const end = b.eMin <= b.sMin ? b.eMin + 1440 : b.eMin;
    return clockInMin >= b.sMin && clockInMin <= end;
  });
  if (inside) return inside;
  // Else the next block that starts at/after the punch, else the last block of the day.
  return blocks.find(b => b.sMin >= clockInMin) || blocks[blocks.length - 1];
}

// Minutes from a clock-in (its minute-of-day) to the SCHEDULED END of the block it belongs to,
// for an auto clock-out. Handles a genuine overnight shift (ends after midnight) but deliberately
// NOT a punch that landed AFTER a daytime block ended — an unscheduled / second late punch. For
// that it returns 0, so the auto clock-out never invents a ~20-hour overnight phantom for someone
// who clocked in after their shift and forgot to punch out (a manager reviews/adjusts instead).
function workedToScheduledEnd(blk, clockInMin, extraMin = 0) {
  if (!blk || blk.eMin == null || blk.sMin == null) return 0;
  let m = blk.eMin + (Number(extraMin) || 0) - clockInMin;
  if (m < 0) {
    const overnight = blk.eMin <= blk.sMin;                 // block end is on the next day
    if (overnight && clockInMin >= blk.sMin) m += 1440;     // genuine overnight shift the punch sits in
    else return 0;                                          // unscheduled / late punch — no phantom
  }
  return Math.max(0, m);
}

// Missed clock-out sweep. When a still-clocked-in staff member passes the end of the
// shift block they're on (+ any manager-added extra), we first nudge them and the
// location leaders (once). Then, once they're the location's grace window past that
// block's end and no one approved the extra hours, the system auto-clocks them out at
// that block's scheduled end — unless the location turned auto clock-out off (then it's
// just the nudge and managers handle it from the Time Clock board). Each shift block is
// enforced independently, so split shifts auto-close at the right time per block.
function sweepMissedClockOuts() {
  try {
    const open = db.prepare(`SELECT te.id, te.user_id, te.location_id, te.work_date, te.clock_in,
        COALESCE(te.overrun_notified,0) AS notified, te.overrun_decision AS decision, COALESCE(te.overrun_extra_min,0) AS extra,
        u.name, l.timezone, COALESCE(l.clock_out_grace_min,30) AS grace, COALESCE(l.auto_clock_out,1) AS auto_out, l.name AS loc_name
      FROM time_entries te JOIN users u ON u.id=te.user_id JOIN locations l ON l.id=te.location_id
      WHERE te.clock_out IS NULL`).all();
    for (const e of open) {
      const tz = e.timezone || DEFAULT_TZ;
      // Enforce the END OF THE BLOCK THIS PUNCH BELONGS TO (not the day's latest end), so
      // a forgotten clock-out on an earlier split-shift block closes at that block's end.
      const blk = shiftBlockForPunch(e.user_id, e.location_id, e.work_date, localMinutesOfDay(tz, new Date(e.clock_in)));
      const end = blk ? blk.eRaw : null;
      if (!end) continue; // no scheduled end → nothing to enforce
      const todayLocal = localDate(tz);
      const allowedEndMin = hhmmToMin(end) + (Number(e.extra) || 0);
      const overBy = (e.work_date < todayLocal ? 1440 : 0) + (localMinutesOfDay(tz, new Date()) - allowedEndMin);
      if (overBy < 0) continue; // not past their (extended) end yet
      const disp = locDisplay(e.loc_name);
      // Staff-facing notices must come from a real sender (a leader) — the messaging
      // layer drops self-messages, so notify(user→same user) would never arrive.
      const sysSender = locationLeaders(e.location_id).find(id => String(id) !== String(e.user_id)) || null;
      // 1) One-time nudge as soon as they're past their end.
      if (!e.notified) {
        try { if (sysSender) notify(sysSender, e.user_id, 'Don’t forget to clock out', `Your shift at ${disp} ended around ${end} and you’re still clocked in. Please clock out — otherwise a manager will review your extra hours.`); } catch { /* */ }
        notifyLeaders(e.location_id, e.user_id, 'Missed clock-out', `${e.name} is still clocked in at ${disp} past their ${end} end time. Approve extra hours, add hours, or clock them out from the Time Clock board.`);
        db.prepare(`UPDATE time_entries SET overrun_notified=1 WHERE id=?`).run(e.id);
      }
      // 2) Auto clock-out once past the grace window, unless a lead approved keep-working.
      if (e.auto_out && e.decision !== 'approved' && overBy >= Number(e.grace)) {
        const clockIn = new Date(e.clock_in);
        const workedToEnd = workedToScheduledEnd(blk, localMinutesOfDay(tz, clockIn), e.extra);
        const clockOut = new Date(clockIn.getTime() + workedToEnd * 60000);
        const r = db.prepare(`UPDATE time_entries SET clock_out=?, worked_minutes=?, overrun_decision='auto', overrun_decided_at=datetime('now') WHERE id=? AND clock_out IS NULL`)
          .run(clockOut.toISOString(), workedToEnd, e.id);
        if (r.changes) {
          closeOpenBreaks(e.id, clockOut.toISOString());   // if they left while on break, close it
          try { if (sysSender) notify(sysSender, e.user_id, 'Automatically clocked out', `You didn’t clock out after your shift at ${disp}, so the system clocked you out at your scheduled end (${end}). If you worked later, ask a manager to adjust your hours.`); } catch { /* */ }
          notifyLeaders(e.location_id, e.user_id, 'Auto clock-out', `${e.name} was automatically clocked out at ${disp} — ${e.grace} min past their ${end} end with no approval. Adjust their hours if they actually worked later.`);
        }
      }
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

// Minutes a scheduled break must be past before a day-over sweep will count it as missed.
const BREAK_MISS_GRACE_MIN = parseInt(process.env.BREAK_MISS_GRACE_MIN || '', 10) || 15;
// Record MISSED scheduled breaks for performance review. The live Shift Board flags a missed break
// while the day is in progress, but nothing persisted it. This runs once a staffer's work day is OVER
// (all their entries clocked out AND the last scheduled shift end has passed, or it's a prior day) and
// writes a durable missed_breaks row for every scheduled break beyond the number they actually took.
// Idempotent: INSERT OR IGNORE against the UNIQUE(user, date, shift_break) key, so re-runs don't dup.
function sweepMissedBreaks() {
  try {
    const now = new Date();
    // Scheduled break slots on recent work shifts (today + a couple of days back to catch late closes).
    const slots = db.prepare(`
      SELECT sb.id AS break_id, sb.start_time, s.user_id, s.location_id, s.shift_date, l.timezone
      FROM shift_breaks sb
      JOIN shifts s ON s.id=sb.shift_id AND s.kind='work'
      JOIN users u ON u.id=s.user_id AND u.is_active=1
      JOIN locations l ON l.id=s.location_id
      WHERE sb.start_time IS NOT NULL AND sb.start_time<>'' AND s.shift_date >= date('now','-3 days')`).all();
    const groups = new Map();
    for (const r of slots) {
      const key = `${r.user_id}|${r.location_id}|${r.shift_date}`;
      if (!groups.has(key)) groups.set(key, { user_id: r.user_id, location_id: r.location_id, work_date: r.shift_date, tz: r.timezone || DEFAULT_TZ, slots: [] });
      groups.get(key).slots.push({ break_id: r.break_id, start: r.start_time });
    }
    for (const g of groups.values()) {
      // Only finalize a day that's OVER for this person: ≥1 closed entry, 0 open entries.
      const open = db.prepare(`SELECT COUNT(*) c FROM time_entries WHERE user_id=? AND location_id=? AND work_date=? AND clock_out IS NULL`).get(g.user_id, g.location_id, g.work_date).c;
      const closed = db.prepare(`SELECT COUNT(*) c FROM time_entries WHERE user_id=? AND location_id=? AND work_date=? AND clock_out IS NOT NULL`).get(g.user_id, g.location_id, g.work_date).c;
      if (open > 0 || closed === 0) continue;        // still on the clock, or never clocked in
      // And the whole day's scheduled work has ended (so split shifts aren't finalized at a mid-day gap).
      const todayLocal = localDate(g.tz);
      let dayOver;
      if (g.work_date < todayLocal) dayOver = true;
      else if (g.work_date > todayLocal) dayOver = false;
      else {
        const endRow = db.prepare(`SELECT MAX(end_time) e FROM shifts WHERE user_id=? AND location_id=? AND shift_date=? AND kind='work'`).get(g.user_id, g.location_id, g.work_date);
        dayOver = endRow && endRow.e ? localMinutesOfDay(g.tz, now) > hhmmToMin(endRow.e) : false;
      }
      if (!dayOver) continue;
      // Slots already past the miss grace (all of them once the day is over). Sorted by time.
      const nowMin = localMinutesOfDay(g.tz, now);
      const pastSlots = g.slots
        .filter(s => g.work_date < todayLocal || (nowMin - hhmmToMin(s.start)) > BREAK_MISS_GRACE_MIN)
        .sort((a, b) => hhmmToMin(a.start) - hhmmToMin(b.start));
      if (!pastSlots.length) continue;
      const taken = db.prepare(`SELECT COUNT(*) c FROM time_entry_breaks b JOIN time_entries te ON te.id=b.time_entry_id
        WHERE te.user_id=? AND te.location_id=? AND te.work_date=? AND b.break_in_at IS NOT NULL`).get(g.user_id, g.location_id, g.work_date).c;
      const missedCount = Math.max(0, pastSlots.length - taken);
      if (!missedCount) continue;
      // Attribute the misses to the latest scheduled slots (the ones left uncovered).
      const missedSlots = pastSlots.slice(pastSlots.length - missedCount);
      const anyEntry = db.prepare(`SELECT id FROM time_entries WHERE user_id=? AND location_id=? AND work_date=? ORDER BY id LIMIT 1`).get(g.user_id, g.location_id, g.work_date);
      const ins = db.prepare(`INSERT OR IGNORE INTO missed_breaks (user_id, location_id, work_date, shift_break_id, scheduled_time, time_entry_id) VALUES (?,?,?,?,?,?)`);
      for (const s of missedSlots) ins.run(g.user_id, g.location_id, g.work_date, s.break_id, s.start, anyEntry ? anyEntry.id : null);
    }
  } catch (err) { console.error('missed-break sweep failed:', err.message); }
}

// No-shows: a scheduled WORK shift the staffer never worked. Once the shift window has fully
// elapsed (end + grace) and no clock-in fell within the shift, record a durable no_shows row and
// message the location's leaders. Hours are never counted for it — there's simply no time_entry, so
// the timesheet already pays nothing. Grace is measured past the shift END so we only ever flag a
// shift that was COMPLETELY missed (no false alarms for someone merely running late — that's the
// separate "late" signal). Idempotent via UNIQUE(user, date, shift_id).
const NO_SHOW_GRACE_MIN = parseInt(process.env.NO_SHOW_GRACE_MIN || '', 10) || 30;
const NO_SHOW_EARLY_MIN = parseInt(process.env.NO_SHOW_EARLY_MIN || '', 10) || 120;
function sweepNoShows() {
  try {
    const now = new Date();
    const shifts = db.prepare(`
      SELECT s.id shift_id, s.user_id, s.location_id, s.shift_date, s.start_time, s.end_time,
             u.name, l.timezone, l.name loc_name
      FROM shifts s
      JOIN users u ON u.id=s.user_id AND u.is_active=1
      JOIN locations l ON l.id=s.location_id
      WHERE s.kind='work' AND s.start_time IS NOT NULL AND s.start_time<>''
        AND s.end_time IS NOT NULL AND s.end_time<>'' AND s.shift_date >= date('now','-2 days')`).all();
    for (const s of shifts) {
      const tz = s.timezone || DEFAULT_TZ;
      const sMin = hhmmToMin(s.start_time), eRaw = hhmmToMin(s.end_time);
      if (sMin == null || eRaw == null) continue;
      const eMin = eRaw <= sMin ? eRaw + 1440 : eRaw;    // overnight shift crosses midnight
      const todayLocal = localDate(tz);
      if (s.shift_date > todayLocal) continue;           // future day — not due yet
      const pastEnd = (s.shift_date < todayLocal ? 1440 : 0) + localMinutesOfDay(tz, now) - eMin;
      if (pastEnd < NO_SHOW_GRACE_MIN) continue;         // shift window not fully over + grace yet
      if (db.prepare(`SELECT 1 FROM no_shows WHERE user_id=? AND work_date=? AND shift_id=?`).get(s.user_id, s.shift_date, s.shift_id)) continue;
      // Did any clock-in that day fall within this shift (from a bit early through the end)?
      const entries = db.prepare(`SELECT clock_in FROM time_entries WHERE user_id=? AND location_id=? AND work_date=?`).all(s.user_id, s.location_id, s.shift_date);
      const attended = entries.some(e => {
        let ci = localMinutesOfDay(tz, new Date(e.clock_in));
        if (eMin > 1440 && ci < sMin - NO_SHOW_EARLY_MIN) ci += 1440;   // overnight punch
        return ci >= sMin - NO_SHOW_EARLY_MIN && ci <= eMin;
      });
      if (attended) continue;
      const r = db.prepare(`INSERT OR IGNORE INTO no_shows (user_id, location_id, work_date, shift_id, start_time, end_time, scheduled_minutes) VALUES (?,?,?,?,?,?,?)`)
        .run(s.user_id, s.location_id, s.shift_date, s.shift_id, s.start_time, s.end_time, eMin - sMin);
      if (r.changes) {
        notifyLeaders(s.location_id, s.user_id, 'No-show', `${s.name} did not show up for their ${s.start_time}–${s.end_time} shift at ${locDisplay(s.loc_name)} on ${s.shift_date}. No hours are counted for it — please follow up and adjust if needed.`);
      }
    }
  } catch (err) { console.error('no-show sweep failed:', err.message); }
}

// Remind the assigned staff member ~5 minutes before a timed day task is due to START — a live in-app
// alert AND a text to their phone. Fires once per task (guarded by task_assignments.reminded_at, which
// is reset when the task's time or assignee changes). Only for today's timed, not-yet-done tasks.
const TASK_REMIND_LEAD = parseInt(process.env.TASK_REMINDER_LEAD_MIN || '', 10) || 5;
function sweepTaskReminders() {
  try {
    const rows = db.prepare(`SELECT ta.id, ta.task_time, ta.user_id, ta.location_id, ta.task_date,
        j.name AS task_name, l.timezone, u.phone AS user_phone
      FROM task_assignments ta
      JOIN jobs j ON j.id=ta.job_id
      JOIN users u ON u.id=ta.user_id AND u.is_active=1
      JOIN locations l ON l.id=ta.location_id
      WHERE ta.reminded_at IS NULL AND ta.task_time IS NOT NULL AND ta.task_time<>'' AND ta.done=0`).all();
    const now = new Date();
    for (const r of rows) {
      const tz = r.timezone || DEFAULT_TZ;
      if (r.task_date !== localDate(tz)) continue;                     // only today's tasks
      const until = hhmmToMin(r.task_time) - localMinutesOfDay(tz, now);
      if (until == null || until > TASK_REMIND_LEAD || until < 0) continue;   // fire inside the lead window
      const sender = locationLeaders(r.location_id)[0] || r.user_id;
      const body = `Task reminder: "${r.task_name}" starts at ${r.task_time} — in about ${until} minute${until === 1 ? '' : 's'}.`;
      // Live in-app notification (floor alert) to the assignee.
      const ins = db.prepare(`INSERT INTO floor_alerts (location_id, sender_id, target_type, target_user_id, body, priority) VALUES (?,?, 'user', ?, ?, 'normal')`)
        .run(r.location_id, sender, r.user_id, body);
      const alertId = Number(ins.lastInsertRowid);
      try { emitAlert({ id: alertId, location_id: r.location_id, target_type: 'user', target_user_id: r.user_id, target_role: null, body, priority: 'normal', sender_name: 'Task reminder', created_at: new Date().toISOString() }); } catch { /* live push best-effort */ }
      db.prepare(`UPDATE task_assignments SET reminded_at=datetime('now') WHERE id=?`).run(r.id);
      // Text their phone (best-effort; log-only until a provider is set).
      if (smsEnabled() && r.user_phone) { try { sendSms(r.user_phone, body).catch(() => {}); } catch { /* */ } }
    }
  } catch (err) { console.error('task reminder sweep failed:', err.message); }
}

router.use(verifyToken);

const ownsLocation = (req, locId) => userCanAccessLocation(req, locId);
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
function lateMinutesFor(userId, locId, date, tz, clockIn) {
  const ci = localMinutesOfDay(tz, clockIn);
  // Measure lateness against the start of the shift BLOCK this punch belongs to — NOT the day's
  // earliest start. Otherwise a split/double-shift worker who clocks into their 2nd (e.g. evening)
  // shift on time is wrongly flagged hours late versus their morning start.
  const blk = shiftBlockForPunch(userId, locId, date, ci);
  if (!blk || blk.sMin == null) return 0;
  const blkEnd = blk.eMin <= blk.sMin ? blk.eMin + 1440 : blk.eMin;
  if (ci > blkEnd) return 0;                 // punch after the block ended → unscheduled, not "late"
  const late = ci - blk.sMin;
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
    if (open) return res.status(409).json({ error: `${staff.name} is already clocked in (since ${localTime(tz, new Date(open.clock_in))}).` });
    const openElse = db.prepare(`SELECT l.name AS loc_name FROM time_entries te JOIN locations l ON l.id=te.location_id
      WHERE te.user_id=? AND te.clock_out IS NULL AND te.location_id<>? ORDER BY te.id DESC LIMIT 1`).get(staff.id, locId);
    if (openElse) return res.status(409).json({ error: `${staff.name} is still clocked in at ${locDisplay(openElse.loc_name)} — clock them out there first.` });
    const sched = scheduledMinutes(staff.id, locId, date);
    const now = new Date();
    const late = lateMinutesFor(staff.id, locId, date, tz, now);
    const info = db.prepare(`INSERT INTO time_entries (user_id, location_id, work_date, clock_in, scheduled_minutes, late_minutes, opened_by) VALUES (?,?,?,?,?,?,?)`)
      .run(staff.id, locId, date, now.toISOString(), sched, late, req.user.id);
    if (late > 0) {
      db.prepare(`INSERT INTO staff_alerts (location_id, user_id, kind, message, time_entry_id) VALUES (?,?,?,?,?)`)
        .run(locId, staff.id, 'late', `${staff.name} clocked in ${fmtDurMin(late)} late.`, info.lastInsertRowid);
    }
    auditLog(req, 'clock_in', 'user', staff.id, { location_id: locId, scheduled_minutes: sched, late_minutes: late });
    return res.json({ success: true, action: 'in', staff: staff.name, at: localTime(tz, now), scheduled_minutes: sched, late_minutes: late });
  }

  // check-out
  if (!open) return res.status(409).json({ error: `${staff.name} is not clocked in.` });
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
  closeOpenBreaks(open.id, now.toISOString());   // a manager clocking out someone on break closes it
  if (isShort) {
    const msg = `${staff.name} clocked out ${fmtDurMin(shortBy)} early — worked ${fmtDurMin(worked)} of ${fmtDurMin(sched)} scheduled.`;
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
  const loc = db.prepare(`SELECT COALESCE(clock_out_grace_min,30) AS grace, COALESCE(auto_clock_out,1) AS auto_out FROM locations WHERE id=?`).get(locId) || { grace: 30, auto_out: 1 };
  const open = db.prepare(`SELECT te.*, u.name, u.employee_code FROM time_entries te JOIN users u ON u.id=te.user_id
    WHERE te.location_id=? AND te.clock_out IS NULL ORDER BY te.clock_in`).all(locId);
  const rows = [];
  for (const e of open) {
    // Per shift block (not the day's latest end) so a forgotten EARLIER split-shift
    // shows as overdue at its own block's end, matching the auto clock-out.
    const blk = shiftBlockForPunch(e.user_id, e.location_id, e.work_date, localMinutesOfDay(tz, new Date(e.clock_in)));
    const end = blk ? blk.eRaw : null;
    if (!end) continue;
    const extra = Number(e.overrun_extra_min) || 0;
    const over = (e.work_date < today ? 1440 : 0) + (nowMin - hhmmToMin(end));
    if (over <= 0) continue; // not past their scheduled end yet
    // Minutes until the system auto-clocks them out (past the extended end + grace).
    const overExtended = over - extra;
    const autoOutIn = (loc.auto_out && e.overrun_decision !== 'approved') ? Math.max(0, loc.grace - overExtended) : null;
    rows.push({
      id: e.id, user_id: e.user_id, name: e.name, employee_code: e.employee_code,
      clock_in: localTime(tz, new Date(e.clock_in)), scheduled_end: end,
      worked_minutes: Math.max(0, Math.round((Date.now() - new Date(e.clock_in).getTime()) / 60000)),
      over_minutes: over, extra_min: extra, decision: e.overrun_decision || null, auto_out_in: autoOutIn,
    });
  }
  res.json({ overruns: rows, grace_min: loc.grace, auto_clock_out: !!loc.auto_out });
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
  closeOpenBreaks(e.id, now.toISOString());   // if forced out while on break, close it
  auditLog(req, 'overrun_forced_out', 'user', e.user_id, { time_entry_id: e.id, worked_minutes: worked });
  try { notify(req.user.id, e.user_id, 'Clocked out by a manager', `You didn’t clock out after your shift, so a manager clocked you out. Please check with them about the extra time for your timesheet.`); } catch { /* */ }
  res.json({ success: true, worked_minutes: worked });
});

// Add extra hours — let them keep working past their scheduled end for a set
// amount before the auto clock-out applies again. Accepts { hours } or { minutes }.
router.post('/overrun/:id/extend', requireRole(ROLES.MANAGE), (req, res) => {
  const e = db.prepare(`SELECT * FROM time_entries WHERE id=?`).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Time entry not found.' });
  if (!ownsLocation(req, e.location_id)) return res.status(403).json({ error: 'Not your location.' });
  if (e.clock_out) return res.status(409).json({ error: 'This person is already clocked out.' });
  const mins = Math.round((parseFloat(req.body.minutes) || (parseFloat(req.body.hours) || 0) * 60));
  if (!(mins > 0) || mins > 720) return res.status(400).json({ error: 'Add between 1 minute and 12 hours.' });
  const extra = (Number(e.overrun_extra_min) || 0) + mins;
  // Reset the nudge flag so they get a fresh reminder near the new end time.
  db.prepare(`UPDATE time_entries SET overrun_extra_min=?, overrun_notified=0 WHERE id=?`).run(extra, e.id);
  auditLog(req, 'overrun_extended', 'user', e.user_id, { time_entry_id: e.id, added_minutes: mins, total_extra_minutes: extra });
  try { notify(req.user.id, e.user_id, 'Extra time added to your shift', `Your manager added ${fmtDurMin(mins)} to today’s shift — please clock out by the new end time.`); } catch { /* */ }
  res.json({ success: true, added_minutes: mins, extra_min: extra });
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
  const loc = db.prepare(`SELECT id, name, timezone, COALESCE(clock_out_grace_min,30) AS clock_out_grace_min, COALESCE(auto_clock_out,1) AS auto_clock_out FROM locations WHERE id=?`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  loc.auto_clock_out = !!loc.auto_clock_out;
  const tz = loc.timezone || DEFAULT_TZ;
  const today = localDate(tz);
  const date = validDate(req.query.date) || today;

  // Entries for the chosen day, PLUS anyone still on the clock from an earlier day
  // (an overnight shift, or a forgotten clock-out) so a currently-open entry never
  // disappears from the board at midnight — leaders can always see (and close) it.
  const entries = db.prepare(`SELECT te.*, u.name, u.employee_code FROM time_entries te JOIN users u ON u.id=te.user_id
    WHERE te.location_id=? AND (te.work_date=? OR (te.clock_out IS NULL AND te.work_date < ?)) ORDER BY te.clock_out IS NULL DESC, te.clock_in`).all(locId, date, date);
  // Whose work shift(s) exist for this day/location (to flag unscheduled clock-ins).
  const shiftBy = {};
  for (const s of db.prepare(`SELECT user_id, MIN(start_time) AS start_time, MAX(end_time) AS end_time FROM shifts WHERE location_id=? AND shift_date=? AND kind='work' GROUP BY user_id`).all(locId, date)) shiftBy[s.user_id] = s;
  const hhmm = (iso) => { const d = new Date(iso); return `${String(localMinutesOfDay(tz, d) / 60 | 0).padStart(2, '0')}:${String(localMinutesOfDay(tz, d) % 60).padStart(2, '0')}`; };
  const shiftFor = db.prepare(`SELECT MIN(start_time) AS start_time, MAX(end_time) AS end_time FROM shifts WHERE user_id=? AND location_id=? AND shift_date=? AND kind='work'`);
  // The role a person is scheduled for that day (first job of their work shift) —
  // drives the colour chip on the board so it matches the schedule's colours.
  const jobForStmt = db.prepare(`SELECT j.name FROM shifts s JOIN shift_jobs sj ON sj.shift_id=s.id JOIN jobs j ON j.id=sj.job_id
    WHERE s.user_id=? AND s.location_id=? AND s.shift_date=? AND s.kind='work' ORDER BY s.start_time IS NULL, s.start_time, j.name LIMIT 1`);
  const jobFor = (uid, d) => (jobForStmt.get(uid, locId, d) || {}).name || null;
  // Punch photos captured on the kiosk (best-effort), by entry + kind.
  const photoStmt = db.prepare(`SELECT kind, id FROM time_entry_photos WHERE entry_id=?`);
  const photosFor = (entryId) => { const o = { in: null, out: null }; for (const p of photoStmt.all(entryId)) o[p.kind] = p.id; return o; };
  // Is a still-open entry currently on a break? (an open time_entry_breaks row — out, not yet back in.)
  const openBreakStmt = db.prepare(`SELECT break_out_at FROM time_entry_breaks WHERE time_entry_id=? AND break_in_at IS NULL ORDER BY id DESC LIMIT 1`);
  // Completed breaks taken on this entry (minutes + over-limit + count), for the Break column.
  const breakStmt = db.prepare(`SELECT COALESCE(SUM(minutes),0) AS min, COALESCE(SUM(over_limit_min),0) AS over_min, COUNT(*) AS cnt FROM time_entry_breaks WHERE time_entry_id=? AND break_in_at IS NOT NULL`);
  // Each completed break's start time + over-limit, so the board can show break TIMES with "(b)".
  const breakTimesStmt = db.prepare(`SELECT break_out_at, COALESCE(over_limit_min,0) AS over_min FROM time_entry_breaks WHERE time_entry_id=? AND break_in_at IS NOT NULL ORDER BY break_out_at`);
  // Scheduled breaks on the person's shift(s) that day (so the Adjust modal can show + manage them).
  const schedBreaksStmt = db.prepare(`SELECT sb.id, sb.start_time, sb.end_time FROM shift_breaks sb
    JOIN shifts s ON s.id=sb.shift_id WHERE s.user_id=? AND s.location_id=? AND s.shift_date=? AND s.kind='work' ORDER BY sb.start_time`);
  // Completed ACTUAL breaks on this entry (time_entry_breaks) with their times, so the Adjust modal can
  // edit them / a manager can add a break the staffer took but forgot to punch.
  const takenBreaksStmt = db.prepare(`SELECT id, break_out_at, break_in_at, minutes, COALESCE(over_limit_min,0) AS over_min FROM time_entry_breaks WHERE time_entry_id=? AND break_in_at IS NOT NULL ORDER BY break_out_at`);
  const byUser = {};
  const punchedStarts = {}; // user_id -> Set of scheduled block-start HH:MM they've already punched today
  const rows = entries.map(e => {
    const worked = liveWorked(e);
    byUser[e.user_id] = true;
    const ph = photosFor(e.id);
    const ob = e.clock_out ? null : openBreakStmt.get(e.id);
    const br = breakStmt.get(e.id);
    // The specific scheduled shift BLOCK this punch belongs to (so a split-shift day shows each shift).
    const blk = shiftBlockForPunch(e.user_id, e.location_id, e.work_date, localMinutesOfDay(tz, new Date(e.clock_in)));
    // Remember which scheduled block this same-day punch covers, so the block isn't ALSO listed as
    // "not clocked in" below — while any OTHER block of theirs that day still is (split-shift visibility).
    if (e.work_date === date && blk) (punchedStarts[e.user_id] || (punchedStarts[e.user_id] = new Set())).add(blk.sRaw);
    // Their shift on the entry's OWN day (carryover entries look up their prior day).
    const rawSh = e.work_date === date ? shiftBy[e.user_id] : shiftFor.get(e.user_id, locId, e.work_date);
    const sh = rawSh && rawSh.start_time ? rawSh : null;
    return {
      id: e.id, user_id: e.user_id, name: e.name, employee_code: e.employee_code,
      clock_in: localTime(tz, new Date(e.clock_in)), clock_out: e.clock_out ? localTime(tz, new Date(e.clock_out)) : null,
      clock_in_hhmm: hhmm(e.clock_in), clock_out_hhmm: e.clock_out ? hhmm(e.clock_out) : null,
      status: e.clock_out ? 'out' : 'in',
      on_break: ob ? 1 : 0,
      break_since: ob ? localTime(tz, new Date(ob.break_out_at)) : null,
      on_break_min: ob ? Math.max(0, Math.round((Date.now() - new Date(ob.break_out_at).getTime()) / 60000)) : 0,
      break_min: br.min, break_over: br.over_min, breaks_count: br.cnt,
      break_times: breakTimesStmt.all(e.id).map(b => ({ time: localTime(tz, new Date(b.break_out_at)), over: b.over_min })),
      sched_breaks: schedBreaksStmt.all(e.user_id, locId, e.work_date).map(b => ({ id: b.id, start: b.start_time, end: b.end_time })),
      taken_breaks: takenBreaksStmt.all(e.id).map(b => ({ id: b.id, start: hhmm(b.break_out_at), end: hhmm(b.break_in_at), minutes: b.minutes, over_min: b.over_min })),
      block_start: blk ? blk.sRaw : null, block_end: blk ? blk.eRaw : null,
      scheduled_minutes: e.scheduled_minutes, worked_minutes: worked,
      overtime_minutes: Math.max(0, worked - (e.scheduled_minutes || 0)),
      short: e.short_confirmed ? 1 : 0,
      // A forgotten clock-out: the system auto-closed it at the scheduled end ('auto'),
      // or a manager closed it from the board ('forced'). Either way the person didn't
      // punch out — flag it so leaders can review/adjust their hours.
      auto_closed: e.overrun_decision === 'auto' ? 1 : 0,
      forced_out: e.overrun_decision === 'forced' ? 1 : 0,
      unscheduled: sh ? 0 : 1,
      shift_start: sh ? sh.start_time : null, shift_end: sh ? sh.end_time : null,
      work_date: e.work_date, carryover: e.work_date !== date ? 1 : 0,
      job: jobFor(e.user_id, e.work_date),
      photo_in: ph.in, photo_out: ph.out,
    };
  });
  // Scheduled today but no punch yet → "not in". Keep each person's individual shift BLOCKS so a
  // multi-shift day shows a line per shift here too (not just one merged span).
  const schedRows = db.prepare(`SELECT u.id, u.name, u.employee_code, s.start_time, s.end_time
    FROM shifts s JOIN users u ON u.id=s.user_id
    WHERE s.location_id=? AND s.shift_date=? AND s.kind='work' AND s.start_time IS NOT NULL
    ORDER BY u.name, s.start_time`).all(locId, date);
  const schedByUser = new Map();
  for (const s of schedRows) {
    if (!schedByUser.has(s.id)) schedByUser.set(s.id, { user_id: s.id, name: s.name, employee_code: s.employee_code, blocks: [] });
    schedByUser.get(s.id).blocks.push({ start: s.start_time, end: s.end_time });
  }
  // "Not clocked in" = each person's scheduled work BLOCKS that have no punch yet. This now keeps the
  // still-unpunched block(s) of someone who HAS clocked into another block today — a split shift where
  // they've punched one shift but not the other — so the second shift never disappears from the board.
  const notIn = [...schedByUser.values()].map(s => {
    const punched = punchedStarts[s.user_id];
    const blocks = punched ? s.blocks.filter(b => !punched.has(b.start)) : s.blocks;
    return { s, blocks };
  }).filter(x => x.blocks.length).map(({ s, blocks }) => ({
    user_id: s.user_id, name: s.name, employee_code: s.employee_code, blocks,
    scheduled_minutes: blocks.reduce((a, b) => a + spanMin(b.start, b.end), 0),
    start_time: blocks[0].start, end_time: blocks[blocks.length - 1].end,
    job: jobFor(s.user_id, date),
    has_entry: !!byUser[s.user_id], // already punched another block today (manager "Enter hours" adds a 2nd entry)
  }));
  res.json({
    location: loc, date, today, timezone: tz, entries: rows, not_in: notIn,
    summary: {
      on_clock: rows.filter(r => r.status === 'in').length,
      on_break: rows.filter(r => r.on_break).length,
      done: rows.filter(r => r.status === 'out').length,
      not_in: notIn.length,
      short: rows.filter(r => r.short).length,
      overtime: rows.filter(r => r.overtime_minutes > 0).length,
      missed_out: rows.filter(r => r.auto_closed || r.forced_out).length,
    },
  });
});

// Serve a punch photo (manager, scoped to their location). Returns the raw image bytes.
router.get('/photo/:photoId', requireRole(ROLES.MANAGE), (req, res) => {
  const p = db.prepare(`SELECT tp.mime, tp.bytes, te.location_id FROM time_entry_photos tp
    JOIN time_entries te ON te.id=tp.entry_id WHERE tp.id=?`).get(req.params.photoId);
  if (!p) return res.status(404).end();
  if (!ownsLocation(req, p.location_id)) return res.status(403).end();
  res.set('Content-Type', p.mime || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(Buffer.from(p.bytes));
});

// A staff member's punch photos over a date range (for the timesheet report drill-in).
router.get('/punch-photos', requireRole(ROLES.MANAGE), (req, res) => {
  const userId = parseInt(req.query.user_id, 10);
  if (!userId) return res.status(400).json({ error: 'user_id is required.' });
  const start = validDate(req.query.start) || localDate(DEFAULT_TZ);
  const end = validDate(req.query.end) || start;
  const locId = req.query.location_id ? parseInt(req.query.location_id, 10) : null;
  const conds = ['te.user_id=?', 'te.work_date>=?', 'te.work_date<=?'], args = [userId, start, end];
  if (locId) { conds.push('te.location_id=?'); args.push(locId); }
  else if (!userSeesAll(req)) { conds.push('te.location_id=?'); args.push(req.user.location_id); }
  const rows = db.prepare(`SELECT tp.id photo_id, tp.kind, te.id entry_id, te.work_date, te.clock_in, te.clock_out, te.location_id, l.name location, l.timezone
    FROM time_entry_photos tp JOIN time_entries te ON te.id=tp.entry_id LEFT JOIN locations l ON l.id=te.location_id
    WHERE ${conds.join(' AND ')} ORDER BY te.work_date DESC, tp.kind`).all(...args)
    .filter(r => userSeesAll(req) || String(r.location_id) === String(req.user.location_id))
    .map(r => ({
      photo_id: r.photo_id, kind: r.kind, work_date: r.work_date, location: r.location,
      at: localTime(r.timezone || DEFAULT_TZ, new Date(r.kind === 'out' && r.clock_out ? r.clock_out : r.clock_in)),
    }));
  res.json({ user_id: userId, start, end, photos: rows });
});

// Convert a local wall-clock HH:MM on a date to a UTC instant in the given tz.
function localWallToInstant(tz, dateStr, hhmm) {
  const [Y, Mo, D] = String(dateStr).split('-').map(Number);
  const [h, mi] = String(hhmm).split(':').map(Number);
  const guess = Date.UTC(Y, Mo - 1, D, h, mi);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess - (asUTC - guess));
}

// Manager / shift-lead: assign work hours to (and/or correct the punch times of)
// one time-clock entry — the fix for a substitute who clocks in unscheduled, or any
// punch that needs correcting. Assigning hours writes/replaces the day's work shift
// (so the scheduled end drives the 30-min auto clock-out) and sets the entry's
// scheduled minutes; editing times rewrites clock-in / clock-out. Notifies the staffer.
router.put('/entry/:id', requireRole(ROLES.MANAGE), (req, res) => {
  const e = db.prepare(`SELECT * FROM time_entries WHERE id=?`).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Time entry not found.' });
  if (!ownsLocation(req, e.location_id)) return res.status(403).json({ error: 'Not your location.' });
  const tz = locTz(e.location_id);
  const hhmmRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  const b = req.body || {};
  const hasHours = b.start_time !== undefined || b.end_time !== undefined;
  const start = b.start_time ? String(b.start_time).slice(0, 5) : null;
  const end = b.end_time ? String(b.end_time).slice(0, 5) : null;
  if (hasHours) {
    if (!hhmmRe.test(start || '') || !hhmmRe.test(end || '')) return res.status(400).json({ error: 'Scheduled start and end must both be HH:MM (24-hour).' });
    if (spanMin(start, end) <= 0) return res.status(400).json({ error: 'Scheduled end must be after the start.' });
  }
  let clockInISO = e.clock_in, clockOutISO = e.clock_out;
  if (b.clock_in !== undefined) {
    if (!hhmmRe.test(String(b.clock_in))) return res.status(400).json({ error: 'Clock-in must be HH:MM (24-hour).' });
    clockInISO = localWallToInstant(tz, e.work_date, b.clock_in).toISOString();
  }
  if (b.clock_out !== undefined) {
    if (b.clock_out === null || b.clock_out === '') clockOutISO = null;
    else {
      if (!hhmmRe.test(String(b.clock_out))) return res.status(400).json({ error: 'Clock-out must be HH:MM (24-hour).' });
      let outD = localWallToInstant(tz, e.work_date, b.clock_out);
      if (outD.getTime() <= new Date(clockInISO).getTime()) outD = new Date(outD.getTime() + 86400000); // past midnight
      clockOutISO = outD.toISOString();
    }
  }
  if (!hasHours && b.clock_in === undefined && b.clock_out === undefined) return res.status(400).json({ error: 'Nothing to update.' });

  db.exec('BEGIN');
  try {
    if (hasHours) {
      // Adjust the ONE shift block this punch belongs to — never collapse a split shift into one, and
      // keep its job (role). Only when the person has NO scheduled shift (an unscheduled clock-in) do we
      // create one. (Previously this deleted EVERY work shift that day and made a single job-less shift,
      // which wrecked split shifts + dropped the role.)
      const dayShifts = db.prepare(`SELECT id, start_time, end_time FROM shifts WHERE user_id=? AND location_id=? AND shift_date=? AND kind='work'`).all(e.user_id, e.location_id, e.work_date);
      const ciMin = localMinutesOfDay(tz, new Date(clockInISO));
      const blk = shiftBlockForPunch(e.user_id, e.location_id, e.work_date, ciMin);
      const target = (blk && dayShifts.find(s => s.start_time === blk.sRaw && s.end_time === blk.eRaw)) || null;
      if (target) {
        db.prepare(`UPDATE shifts SET start_time=?, end_time=?, updated_at=datetime('now') WHERE id=?`).run(start, end, target.id);   // keep shift_jobs + shift_breaks
      } else {
        const sid = db.prepare(`INSERT INTO shifts (user_id,location_id,shift_date,start_time,end_time,notes,created_by,kind,all_day,leave_hours) VALUES (?,?,?,?,?,?,?, 'work',0,NULL)`)
          .run(e.user_id, e.location_id, e.work_date, start, end, 'Assigned from time clock', req.user.id).lastInsertRowid;
        // Inherit a role from another of the day's shifts, so a newly-assigned block isn't job-less.
        const jobRow = dayShifts.length ? db.prepare(`SELECT sj.job_id FROM shift_jobs sj JOIN shifts s ON s.id=sj.shift_id WHERE s.user_id=? AND s.location_id=? AND s.shift_date=? AND s.kind='work' LIMIT 1`).get(e.user_id, e.location_id, e.work_date) : null;
        if (jobRow) db.prepare(`INSERT INTO shift_jobs (shift_id, job_id) VALUES (?,?)`).run(Number(sid), jobRow.job_id);
      }
      // Re-apply the day's scheduled minutes to its entries + let the auto clock-out re-evaluate.
      const schedMin = scheduledMinutes(e.user_id, e.location_id, e.work_date);
      db.prepare(`UPDATE time_entries SET scheduled_minutes=?, overrun_notified=0, overrun_extra_min=0, overrun_decision=NULL, overrun_decided_by=NULL, overrun_decided_at=NULL WHERE user_id=? AND location_id=? AND work_date=?`)
        .run(schedMin, e.user_id, e.location_id, e.work_date);
    }
    const worked = clockOutISO ? Math.max(0, Math.round((new Date(clockOutISO).getTime() - new Date(clockInISO).getTime()) / 60000)) : null;
    db.prepare(`UPDATE time_entries SET clock_in=?, clock_out=?, worked_minutes=? WHERE id=?`).run(clockInISO, clockOutISO, worked, e.id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'Could not update the entry.' }); }

  auditLog(req, 'time_entry_edit', 'user', e.user_id, { time_entry_id: e.id, assigned_hours: hasHours ? `${start}-${end}` : undefined, clock_in: b.clock_in, clock_out: b.clock_out });
  try {
    const parts = [];
    if (hasHours) parts.push(`your hours were set to ${start}–${end}`);
    if (b.clock_in !== undefined || b.clock_out !== undefined) parts.push('your clock times were adjusted');
    if (parts.length) notify(req.user.id, e.user_id, 'Your time entry was updated', `A manager updated today’s time entry at your store — ${parts.join(' and ')}. Check My Hours.`);
  } catch { /* */ }
  res.json({ success: true });
});

// Manually CREATE a time entry for a scheduled staffer who never clocked in (forgot, or didn't
// know how). A manager / shift-lead enters their clock-in (and usually clock-out) and it lands on
// the board + timesheet exactly like a punched entry — so people who "Not clocked in" on the board
// can still be given their hours. A split-shift day may hold more than one entry (one per shift block),
// so a 2nd entry is allowed as long as it doesn't overlap an existing one (else Adjust that entry).
router.post('/entry', requireRole(ROLES.MANAGE), (req, res) => {
  const b = req.body || {};
  const locId = parseInt(b.location_id, 10);
  const userId = parseInt(b.user_id, 10);
  const date = validDate(b.work_date);
  if (!locId || !userId || !date) return res.status(400).json({ error: 'location_id, user_id and work_date are required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const staff = db.prepare(`SELECT id, name FROM users WHERE id=? AND is_active=1`).get(userId);
  if (!staff) return res.status(404).json({ error: 'Staff member not found.' });
  const hhmmRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  const inHHMM = String(b.clock_in || '').slice(0, 5);
  if (!hhmmRe.test(inHHMM)) return res.status(400).json({ error: 'Clock-in must be HH:MM (24-hour).' });
  const hasOut = b.clock_out !== undefined && b.clock_out !== null && b.clock_out !== '';
  const outHHMM = hasOut ? String(b.clock_out).slice(0, 5) : null;
  if (hasOut && !hhmmRe.test(outHHMM)) return res.status(400).json({ error: 'Clock-out must be HH:MM (24-hour).' });
  const tz = locTz(locId);
  const clockInD = localWallToInstant(tz, date, inHHMM);
  let clockOutISO = null, worked = null, outD = null;
  if (hasOut) {
    outD = localWallToInstant(tz, date, outHHMM);
    if (outD.getTime() <= clockInD.getTime()) outD = new Date(outD.getTime() + 86400000); // crossed midnight
    clockOutISO = outD.toISOString();
    worked = Math.max(0, Math.round((outD.getTime() - clockInD.getTime()) / 60000));
  }
  // A split-shift day can legitimately have more than one entry (one per shift block), so only reject a
  // NEW entry that OVERLAPS one they already have — this lets a manager record a missed MORNING shift for
  // someone who punched their evening shift. An entry covering the same time → Adjust that one instead.
  const newS = clockInD.getTime(), newE = outD ? outD.getTime() : clockInD.getTime();
  for (const ex of db.prepare(`SELECT clock_in, clock_out FROM time_entries WHERE user_id=? AND location_id=? AND work_date=?`).all(userId, locId, date)) {
    const exS = new Date(ex.clock_in).getTime();
    const exE = ex.clock_out ? new Date(ex.clock_out).getTime() : exS;
    if (newS <= exE && exS <= newE) return res.status(409).json({ error: 'This overlaps a time entry they already have for this day — use Adjust on that entry instead.' });
  }
  const sched = scheduledMinutes(userId, locId, date);
  const late = lateMinutesFor(userId, locId, date, tz, clockInD);
  const info = db.prepare(`INSERT INTO time_entries (user_id, location_id, work_date, clock_in, clock_out, scheduled_minutes, worked_minutes, late_minutes, opened_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(userId, locId, date, clockInD.toISOString(), clockOutISO, sched, worked, late, req.user.id);
  auditLog(req, 'time_entry_create', 'user', userId, { time_entry_id: Number(info.lastInsertRowid), location_id: locId, work_date: date, clock_in: inHHMM, clock_out: outHHMM });
  try { notify(req.user.id, userId, 'Hours entered for you', `You weren’t clocked in for ${date} at your store, so a manager entered your clock in/out. Check My Hours and let them know if anything’s off.`); } catch { /* */ }
  res.json({ success: true, id: Number(info.lastInsertRowid) });
});

// Add a scheduled break to a staffer's shift for a day (manager / shift-lead). Managers sometimes
// forget to set a break when building the schedule and need to add it on the working day; this drops
// a 10-minute break onto the shift block that contains the given time, so the break reminder fires
// and it counts for break-compliance like any scheduled break. Used from the Time Clock Adjust modal.
const BREAK_LEN_MIN = 10;
router.post('/break', requireRole(ROLES.MANAGE), (req, res) => {
  const b = req.body || {};
  const locId = parseInt(b.location_id, 10);
  const userId = parseInt(b.user_id, 10);
  const date = validDate(b.work_date);
  const start = String(b.start_time || '').slice(0, 5);
  if (!locId || !userId || !date) return res.status(400).json({ error: 'location_id, user_id and work_date are required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) return res.status(400).json({ error: 'Break time must be HH:MM (24-hour).' });
  const staff = db.prepare(`SELECT id, name FROM users WHERE id=?`).get(userId);
  if (!staff) return res.status(404).json({ error: 'Staff member not found.' });
  // Find the work shift block that contains the break (with room for the 10-minute break to fit).
  const shifts = db.prepare(`SELECT id, start_time, end_time FROM shifts WHERE user_id=? AND location_id=? AND shift_date=? AND kind='work' AND start_time IS NOT NULL AND end_time IS NOT NULL ORDER BY start_time`).all(userId, locId, date);
  if (!shifts.length) return res.status(409).json({ error: 'This staffer has no scheduled shift that day to add a break to.' });
  const bm = hhmmToMin(start);
  const fits = shifts.find(s => { const sm = hhmmToMin(s.start_time); let em = hhmmToMin(s.end_time); if (em <= sm) em += 1440; let x = bm; if (x < sm) x += 1440; return x >= sm && x + BREAK_LEN_MIN <= em; });
  if (!fits) return res.status(400).json({ error: 'That time is outside the staffer’s scheduled shift(s) — pick a time inside a shift, leaving room for a 10-minute break.' });
  if (db.prepare(`SELECT 1 FROM shift_breaks WHERE shift_id=? AND start_time=?`).get(fits.id, start)) return res.status(409).json({ error: 'A break is already scheduled at that time.' });
  const em = (bm + BREAK_LEN_MIN) % 1440;
  const endStr = `${String(em / 60 | 0).padStart(2, '0')}:${String(em % 60).padStart(2, '0')}`;
  const info = db.prepare(`INSERT INTO shift_breaks (shift_id, start_time, end_time, label) VALUES (?,?,?,NULL)`).run(fits.id, start, endStr);
  auditLog(req, 'shift_break_add', 'user', userId, { location_id: locId, work_date: date, start_time: start });
  try { notify(req.user.id, userId, 'A break was added to your shift', `A manager added a ${fmt12h(bm)} break to your shift today. You’ll get a reminder when it’s time — clock out for your break, then clock back in.`); } catch { /* */ }
  res.json({ success: true, id: Number(info.lastInsertRowid), start_time: start, end_time: endStr });
});

// Remove a scheduled break (manager / shift-lead) — e.g. one added by mistake.
router.delete('/break/:id', requireRole(ROLES.MANAGE), (req, res) => {
  const row = db.prepare(`SELECT sb.id, sb.start_time, s.location_id, s.user_id, s.shift_date FROM shift_breaks sb JOIN shifts s ON s.id=sb.shift_id WHERE sb.id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Break not found.' });
  if (!ownsLocation(req, row.location_id)) return res.status(403).json({ error: 'Not your location.' });
  db.prepare(`DELETE FROM shift_breaks WHERE id=?`).run(row.id);
  auditLog(req, 'shift_break_remove', 'user', row.user_id, { location_id: row.location_id, work_date: row.shift_date, start_time: row.start_time });
  res.json({ success: true });
});

// ── ACTUAL breaks taken (time_entry_breaks) on one time entry ─────────────────────────────────────
// A manager records (or edits) a break a staffer actually took but forgot to punch — clock out for
// break / clock back in. Recorded for the board + break-compliance so it isn't flagged as a MISSED
// break; worked hours are NOT changed (breaks are paid under the current policy, same as a punched
// break). Distinct from the SCHEDULED-break endpoints above (shift_breaks). Used from the Adjust modal.
const toHHMM = (tz, iso) => { const m = localMinutesOfDay(tz, new Date(iso)); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
function computeBreakTimes(entry, tz, startHHMM, endHHMM) {
  const hhmmRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hhmmRe.test(startHHMM) || !hhmmRe.test(endHHMM)) return { error: 'Break start and end must both be HH:MM (24-hour).' };
  const outD = localWallToInstant(tz, entry.work_date, startHHMM);
  let inD = localWallToInstant(tz, entry.work_date, endHHMM);
  if (inD.getTime() <= outD.getTime()) inD = new Date(inD.getTime() + 86400000);   // crossed midnight
  const minutes = Math.round((inD.getTime() - outD.getTime()) / 60000);
  if (minutes <= 0) return { error: 'Break end must be after the start.' };
  if (minutes > 12 * 60) return { error: 'That break is longer than 12 hours — check the times.' };
  if (outD.getTime() < new Date(entry.clock_in).getTime()) return { error: 'The break starts before they clocked in.' };
  if (entry.clock_out && inD.getTime() > new Date(entry.clock_out).getTime()) return { error: 'The break ends after they clocked out.' };
  return { break_out_at: outD.toISOString(), break_in_at: inD.toISOString(), minutes, over_limit_min: Math.max(0, minutes - BREAK_LIMIT_MIN) };
}
router.post('/entry/:id/break', requireRole(ROLES.MANAGE), (req, res) => {
  const e = db.prepare(`SELECT * FROM time_entries WHERE id=?`).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Time entry not found.' });
  if (!ownsLocation(req, e.location_id)) return res.status(403).json({ error: 'Not your location.' });
  const tz = locTz(e.location_id);
  const c = computeBreakTimes(e, tz, String((req.body || {}).start || '').slice(0, 5), String((req.body || {}).end || '').slice(0, 5));
  if (c.error) return res.status(400).json({ error: c.error });
  const info = db.prepare(`INSERT INTO time_entry_breaks (time_entry_id, user_id, location_id, break_out_at, break_in_at, minutes, over_limit_min) VALUES (?,?,?,?,?,?,?)`)
    .run(e.id, e.user_id, e.location_id, c.break_out_at, c.break_in_at, c.minutes, c.over_limit_min);
  auditLog(req, 'break_record_add', 'user', e.user_id, { time_entry_id: e.id, start: toHHMM(tz, c.break_out_at), end: toHHMM(tz, c.break_in_at), minutes: c.minutes });
  try { notify(req.user.id, e.user_id, 'A break was recorded on your hours', `A manager recorded a ${c.minutes}-minute break on your ${e.work_date} shift (you didn’t punch out for it). Your worked hours are unchanged.`); } catch { /* */ }
  res.json({ success: true, id: Number(info.lastInsertRowid), start: toHHMM(tz, c.break_out_at), end: toHHMM(tz, c.break_in_at), minutes: c.minutes, over_min: c.over_limit_min });
});
router.put('/entry/:id/break/:bid', requireRole(ROLES.MANAGE), (req, res) => {
  const e = db.prepare(`SELECT * FROM time_entries WHERE id=?`).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Time entry not found.' });
  if (!ownsLocation(req, e.location_id)) return res.status(403).json({ error: 'Not your location.' });
  const b = db.prepare(`SELECT id FROM time_entry_breaks WHERE id=? AND time_entry_id=?`).get(req.params.bid, e.id);
  if (!b) return res.status(404).json({ error: 'Break not found on this entry.' });
  const tz = locTz(e.location_id);
  const c = computeBreakTimes(e, tz, String((req.body || {}).start || '').slice(0, 5), String((req.body || {}).end || '').slice(0, 5));
  if (c.error) return res.status(400).json({ error: c.error });
  db.prepare(`UPDATE time_entry_breaks SET break_out_at=?, break_in_at=?, minutes=?, over_limit_min=? WHERE id=?`).run(c.break_out_at, c.break_in_at, c.minutes, c.over_limit_min, b.id);
  auditLog(req, 'break_record_edit', 'user', e.user_id, { time_entry_id: e.id, break_id: b.id, minutes: c.minutes });
  res.json({ success: true, id: b.id, start: toHHMM(tz, c.break_out_at), end: toHHMM(tz, c.break_in_at), minutes: c.minutes, over_min: c.over_limit_min });
});
router.delete('/entry/:id/break/:bid', requireRole(ROLES.MANAGE), (req, res) => {
  const e = db.prepare(`SELECT id, location_id, user_id FROM time_entries WHERE id=?`).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Time entry not found.' });
  if (!ownsLocation(req, e.location_id)) return res.status(403).json({ error: 'Not your location.' });
  const b = db.prepare(`SELECT id FROM time_entry_breaks WHERE id=? AND time_entry_id=?`).get(req.params.bid, e.id);
  if (!b) return res.status(404).json({ error: 'Break not found on this entry.' });
  db.prepare(`DELETE FROM time_entry_breaks WHERE id=?`).run(b.id);
  auditLog(req, 'break_record_remove', 'user', e.user_id, { time_entry_id: e.id, break_id: b.id });
  res.json({ success: true });
});

// ── Payroll / overtime export for a pay period ───────────────────────────────
// Overtime is derived from clocked hours per California's daily rule:
//   regular ≤ 8h/day, overtime (1.5×) for 8–12h/day, double-time (2×) beyond 12h/day.
const OT_AFTER_MIN = 8 * 60, DT_AFTER_MIN = 12 * 60, OT_MULT = 1.5, DT_MULT = 2;
const OT_EDIT_ROLES = ['owner', 'advanced_admin', 'ceo', 'president', 'admin', 'hr', 'general_manager']; // may change approved OT later
const addDaysIso = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Start of the pay/work week (Saturday) containing `iso`. The work week runs Saturday → Friday.
const weekStartOf = (iso) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 1) % 7)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const BIWEEKLY_EPOCH = '2024-01-06'; // a Saturday — fixes the 14-day bi-weekly pay cycle (matches the frontend)
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
  if (kind === 'biweekly') {
    // Two Sat–Fri weeks, anchored to a fixed Saturday epoch so the 14-day cycle
    // is stable. Must match the frontend (biweeklyRange in public/app.js).
    const ws = weekStartOf(anchor);
    const weeks = Math.round((new Date(ws + 'T00:00:00') - new Date(BIWEEKLY_EPOCH + 'T00:00:00')) / (7 * 86400000));
    const start = (weeks % 2 === 0) ? ws : addDaysIso(ws, -7);
    return { start, end: addDaysIso(start, 13) };
  }
  const start = weekStartOf(anchor); return { start, end: addDaysIso(start, 6) };
}

const FULL_DAY_HOURS = 8; // an "all day" leave entry counts as a standard workday
// One person's own hours for a period, across whatever location(s) they worked.
function myHoursData(userId, start, end, kind) {
  const byDate = {};
  // Completed breaks on an entry, so the My Hours day-detail popup can show each shift's break times.
  const myBreaksStmt = db.prepare(`SELECT break_out_at, break_in_at, minutes, COALESCE(over_limit_min,0) AS over FROM time_entry_breaks WHERE time_entry_id=? AND break_in_at IS NOT NULL ORDER BY break_out_at`);
  for (const r of db.prepare(`SELECT te.id, te.work_date, te.clock_in, te.clock_out, te.worked_minutes, te.late_minutes,
      te.hours_confirmed, te.hours_disputed, l.name AS loc_name, l.timezone AS tz
    FROM time_entries te JOIN locations l ON l.id=te.location_id
    WHERE te.user_id=? AND te.work_date BETWEEN ? AND ? AND te.clock_out IS NOT NULL
    ORDER BY te.clock_in`).all(userId, start, end)) {
    const d = byDate[r.work_date] || (byDate[r.work_date] = { worked: 0, late: 0, n: 0, conf: 0, disp: 0, items: [] });
    d.worked += r.worked_minutes || 0; d.late = Math.max(d.late, r.late_minutes || 0);
    d.n++; if (r.hours_confirmed) d.conf++; if (r.hours_disputed) d.disp++;
    const tz = r.tz || DEFAULT_TZ;
    d.items.push({
      location: r.loc_name,
      clock_in: r.clock_in ? localTime(tz, new Date(r.clock_in)) : null,
      clock_out: r.clock_out ? localTime(tz, new Date(r.clock_out)) : null,
      worked_min: r.worked_minutes || 0,
      late_min: r.late_minutes || 0,
      confirmed: !!r.hours_confirmed,
      disputed: !!r.hours_disputed,
      breaks: myBreaksStmt.all(r.id).map(b => ({ out: localTime(tz, new Date(b.break_out_at)), in: localTime(tz, new Date(b.break_in_at)), minutes: b.minutes, over: b.over })),
    });
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
  let totalMin = 0, reg = 0, otAppr = 0, dtAppr = 0, otPend = 0, dtPend = 0, lateMin = 0, lateDays = 0, shortDays = 0, signoffPending = 0;
  const days = Object.entries(byDate).sort().map(([date, d]) => {
    const adj = adjByDate[date]; const eff = adj != null ? adj : d.worked;
    totalMin += eff; const sp = daySplit(eff); reg += sp.reg;
    const a = otByDate[date]; const ok = a && a.approved;
    if (sp.ot > 0 || sp.dt > 0) { if (ok) { otAppr += a.ot_minutes; dtAppr += a.dt_minutes; } else { otPend += sp.ot; dtPend += sp.dt; } }
    const sched = schedByDate[date] || 0; const shortM = sched > eff ? sched - eff : 0;
    if (d.late > 0) { lateMin += d.late; lateDays++; } if (shortM > 0) shortDays++;
    const otStatus = sp.ot <= 0 && sp.dt <= 0 ? 'none' : (a && a.approved ? 'approved' : (a && a.rejected ? 'rejected' : (a && a.escalated ? 'escalated' : 'pending')));
    const reviewStatus = d.disp > 0 ? 'disputed' : (d.n > 0 && d.conf === d.n ? 'confirmed' : 'pending');
    if (reviewStatus === 'pending') signoffPending++;
    return { date, scheduled_min: sched, worked_min: d.worked, effective_min: eff, adjusted: adj != null, late_min: d.late, short_min: shortM, ot_min: sp.ot, dt_min: sp.dt, ot_status: otStatus, review_status: reviewStatus, entries: d.items };
  });
  return {
    kind, start, end, days,
    totals: { scheduled_hours: h(Object.values(schedByDate).reduce((t, m) => t + m, 0)), total_hours: h(totalMin), regular_hours: h(reg), ot_hours: h(otAppr), ot_pending_hours: h(otPend), dt_hours: h(dtAppr), dt_pending_hours: h(dtPend), late_days: lateDays, late_minutes: lateMin, short_days: shortDays, sick_hours: round2(leave.sick), vacation_hours: round2(leave.vacation), leave_hours: round2(leave.leave) },
    approved: tsAppr ? 1 : 0, approved_by: tsAppr ? (userName(tsAppr.approved_by) || null) : null,
    signoff: { pending: signoffPending },
    rules: { ot_after_h: OT_AFTER_MIN / 60, ot_mult: OT_MULT, late_grace_min: LATE_GRACE_MIN },
  };
}

// Unconfirmed worked-days across a lookback window (independent of the selected period) so the
// My Hours page can open on the right view: Daily when nothing/one day is outstanding, else widen
// to Weekly or Bi-weekly to surface everything that still needs the staffer's sign-off.
function signoffSummary(userId, today, lookbackDays = 30) {
  const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - lookbackDays);
  const start = d.toISOString().slice(0, 10);
  const byDate = {};
  for (const r of db.prepare(`SELECT work_date, hours_confirmed, hours_disputed FROM time_entries
      WHERE user_id=? AND work_date BETWEEN ? AND ? AND clock_out IS NOT NULL`).all(userId, start, today)) {
    const x = byDate[r.work_date] || (byDate[r.work_date] = { n: 0, conf: 0, disp: 0 });
    x.n++; if (r.hours_confirmed) x.conf++; if (r.hours_disputed) x.disp++;
  }
  const pendingDates = Object.entries(byDate)
    .filter(([, x]) => x.disp === 0 && x.conf < x.n)   // still needs sign-off
    .map(([date]) => date).sort();
  const oldest = pendingDates[0] || null;
  let span_days = 0;
  if (oldest) span_days = Math.round((Date.parse(today) - Date.parse(oldest)) / 86400000) + 1;
  return { pending: pendingDates.length, oldest, span_days, lookback_days: lookbackDays };
}

router.get('/payroll', requireRole(ROLES.MANAGE), (req, res) => {
  const locId = parseInt(req.query.location_id, 10);
  if (!locId) return res.status(400).json({ error: 'location_id is required.' });
  if (!ownsLocation(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const loc = db.prepare(`SELECT id, name, timezone FROM locations WHERE id=?`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Location not found.' });
  const tz = loc.timezone || DEFAULT_TZ;
  const today = localDate(tz);
  const kind = ['daily', 'weekly', 'biweekly', 'monthly'].includes(req.query.kind) ? req.query.kind : 'biweekly';
  // The client normally passes an explicit start/end (from payRange); otherwise
  // derive the default window from the pay-period kind.
  const def = periodRange(kind, today);
  const start = validDate(req.query.start) || def.start;
  const end = validDate(req.query.end) || def.end;

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
  const kind = ['daily', 'weekly', 'biweekly', 'monthly'].includes(req.body.period_kind) ? req.body.period_kind : null;
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
router.get('/ot-requests', requireRole('owner', 'ceo', 'president', 'admin', 'hr', 'general_manager'), (req, res) => {
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

// Auto-purge old punch photos so image bytes don't accumulate forever. Retention defaults
// to 90 days (override with PUNCH_PHOTO_RETENTION_DAYS). Deletes the photo rows only — the
// time entries (hours) are kept for payroll history.
const PHOTO_RETENTION_DAYS = Math.max(1, parseInt(process.env.PUNCH_PHOTO_RETENTION_DAYS, 10) || 90);
function purgePunchPhotos() {
  try {
    const info = db.prepare(`DELETE FROM time_entry_photos WHERE created_at < datetime('now', ?)`).run(`-${PHOTO_RETENTION_DAYS} days`);
    if (info.changes) console.log(`[punch-photos] purged ${info.changes} photo(s) older than ${PHOTO_RETENTION_DAYS} days`);
    return info.changes;
  } catch (e) { console.error('purgePunchPhotos failed:', e.message); return 0; }
}

module.exports = router;
module.exports.sweepMissedClockOuts = sweepMissedClockOuts; // exported for tests/manual runs
module.exports.purgePunchPhotos = purgePunchPhotos;
// Purge punch photos past the retention window: once at startup, then daily.
module.exports.startPunchPhotoPurge = function startPunchPhotoPurge() {
  purgePunchPhotos();
  const t = setInterval(purgePunchPhotos, 24 * 60 * 60 * 1000);
  if (t.unref) t.unref();
  return t;
};
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
module.exports.sweepMissedBreaks = sweepMissedBreaks;   // exported for tests/manual runs
// Record missed scheduled breaks once a staffer's day is over: at startup, then every 15 min.
module.exports.startMissedBreakSweep = function startMissedBreakSweep() {
  sweepMissedBreaks();
  const t = setInterval(sweepMissedBreaks, 15 * 60 * 1000);
  if (t.unref) t.unref();
  return t;
};
module.exports.sweepNoShows = sweepNoShows;   // exported for tests/manual runs
// Record no-shows once a scheduled shift's window is fully over: at startup, then every 15 min.
module.exports.startNoShowSweep = function startNoShowSweep() {
  sweepNoShows();
  const t = setInterval(sweepNoShows, 15 * 60 * 1000);
  if (t.unref) t.unref();
  return t;
};

// Raise a live in-app alert to one staffer (same channel as break reminders).
function raiseStaffAlert(locId, userId, body, senderName) {
  const sender = locationLeaders(locId)[0] || userId;
  const ins = db.prepare(`INSERT INTO floor_alerts (location_id, sender_id, target_type, target_user_id, body, priority) VALUES (?,?, 'user', ?, ?, 'normal')`).run(locId, sender, userId, body);
  try { emitAlert({ id: Number(ins.lastInsertRowid), location_id: locId, target_type: 'user', target_user_id: userId, target_role: null, body, priority: 'normal', sender_name: senderName || 'Reminder', created_at: new Date().toISOString() }); } catch { /* best-effort */ }
}
// Break-return reminders: once a break passes the limit, nudge the staffer (in-app + SMS) to clock back
// in, repeating every BREAK_NUDGE_MIN; escalate to the shift lead once well over; stop at the shift end.
function sweepBreakReturnReminders({ breakId = null } = {}) {
  try {
    // breakId scopes the run to one break (for isolated verification); otherwise all open breaks.
    const open = db.prepare(`SELECT b.id, b.break_out_at, b.reminded_10, b.last_nudge_at, b.escalated,
        te.user_id, te.location_id, te.work_date, u.name, u.phone, l.timezone
      FROM time_entry_breaks b
      JOIN time_entries te ON te.id=b.time_entry_id AND te.clock_out IS NULL
      JOIN users u ON u.id=te.user_id AND u.is_active=1
      JOIN locations l ON l.id=te.location_id
      WHERE b.break_in_at IS NULL${breakId ? ' AND b.id=?' : ''}`).all(...(breakId ? [breakId] : []));
    const now = Date.now();
    for (const b of open) {
      const tz = b.timezone || DEFAULT_TZ;
      const elapsed = Math.floor((now - new Date(b.break_out_at).getTime()) / 60000);
      if (elapsed < BREAK_MIN_MIN) continue;   // not done with the minimum break yet
      // Stop nudging the staffer once the shift's scheduled end has passed (a leader handles it then).
      const endRow = db.prepare(`SELECT MAX(end_time) AS e FROM shifts WHERE user_id=? AND location_id=? AND shift_date=? AND kind='work'`).get(b.user_id, b.location_id, b.work_date);
      const pastEnd = endRow && endRow.e ? localMinutesOfDay(tz, new Date(now)) > hhmmToMin(endRow.e) : elapsed > 90;
      if (!pastEnd) {
        const sinceNudge = b.last_nudge_at ? (now - new Date(b.last_nudge_at).getTime()) / 60000 : Infinity;
        if (!b.reminded_10 || sinceNudge >= BREAK_NUDGE_MIN) {
          // First nudge (right at the minimum) = "your break is finished, clock in"; repeats if they linger.
          const body = b.reminded_10
            ? `You're still on break (${elapsed} min) — please clock back in.`
            : `Your ${BREAK_MIN_MIN}-minute break is finished — please clock back in now.`;
          raiseStaffAlert(b.location_id, b.user_id, body, b.reminded_10 ? 'Break over' : 'Break finished');
          if (smsEnabled() && b.phone) { try { sendSms(b.phone, body).catch(() => {}); } catch { /* */ } }
          db.prepare(`UPDATE time_entry_breaks SET reminded_10=1, last_nudge_at=datetime('now') WHERE id=?`).run(b.id);
        }
      }
      // Escalate to the location's manager/shift lead once, when well over the limit.
      if (!b.escalated && elapsed >= BREAK_LIMIT_MIN + BREAK_ESCALATE_OVER_MIN) {
        notifyLeaders(b.location_id, b.user_id, 'Staff still on break', `${b.name} has been on break ${elapsed} min (limit ${BREAK_LIMIT_MIN}) and hasn’t clocked back in. Please check in with them.`);
        db.prepare(`UPDATE time_entry_breaks SET escalated=1 WHERE id=?`).run(b.id);
      }
    }
  } catch (err) { console.error('break-return sweep failed:', err.message); }
}
module.exports.sweepBreakReturnReminders = sweepBreakReturnReminders;   // exported for tests
module.exports.startBreakReturnSweep = function startBreakReturnSweep() {
  sweepBreakReturnReminders();
  const t = setInterval(sweepBreakReturnReminders, 60 * 1000);   // 1-min granularity for the 5-min cadence
  if (t.unref) t.unref();
  return t;
};
// End-of-day (9 PM location-local) nudge to a location's manager + shift lead to VERIFY the day's
// tasks. Sent once per location per day (daily_reminders UNIQUE guard), and only when there are tasks
// assigned today that still need verifying — if nothing was assigned (or all are already verified),
// no message goes out. Both an app message (notify → inbox + push) and an SMS (≤140 chars).
const VERIFY_REMIND_HOUR = parseInt(process.env.DAYTASK_VERIFY_REMIND_HOUR || '', 10) || 21;
function verifyReminderSms(short, pending, assigned) {
  const s = `PHN ${short}: ${pending}/${assigned} day tasks still need verifying today. Review on the Day Tasks board.`;
  return s.length > 140 ? s.slice(0, 139) + '…' : s;
}
function reminderSender(leaders) {
  const admin = db.prepare(`SELECT id FROM users WHERE role IN ('owner','admin','ceo','president','hr') AND is_active=1 ORDER BY id LIMIT 1`).get();
  return (admin && admin.id) || leaders[0] || null;   // a sender distinct from the recipients so notify() won't self-drop
}
function sweepDayTaskVerifyReminders({ force = false, locationId = null } = {}) {
  try {
    // locationId scopes the run to one location (for isolated verification); otherwise all active ones.
    const locs = locationId
      ? db.prepare(`SELECT id, name, timezone FROM locations WHERE id=? AND is_active=1`).all(locationId)
      : db.prepare(`SELECT id, name, timezone FROM locations WHERE is_active=1`).all();
    const now = new Date();
    for (const loc of locs) {
      const tz = loc.timezone || DEFAULT_TZ;
      const hour = Math.floor(localMinutesOfDay(tz, now) / 60);
      if (!force && hour < VERIFY_REMIND_HOUR) continue;               // evening only
      const date = localDate(tz);
      const row = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN verified=0 THEN 1 ELSE 0 END) AS pending
        FROM task_assignments WHERE location_id=? AND task_date=? AND user_id IS NOT NULL`).get(loc.id, date);
      const assigned = row.total || 0, pending = row.pending || 0;
      if (!assigned || !pending) continue;                            // nothing assigned, or all verified → no message
      const ins = db.prepare(`INSERT OR IGNORE INTO daily_reminders (location_id, kind, remind_date) VALUES (?, 'daytask_verify', ?)`).run(loc.id, date);
      if (!ins.changes) continue;                                     // already sent today
      const leaders = locationLeaders(loc.id);
      if (!leaders.length) continue;
      const sender = reminderSender(leaders);
      const short = String(loc.name).replace(/^Pho Ha Noi — /, '');
      const subject = 'Verify today’s day tasks';
      const appBody = `${pending} of ${assigned} day task${assigned === 1 ? '' : 's'} assigned at ${short} today still need your verification. Please review and confirm them on the Day Tasks board.`;
      const recips = new Set(leaders.map(String));
      const central = centralContact(); if (central) recips.add(String(central.id));
      for (const lid of recips) {
        try { if (sender) notify(sender, lid, subject, appBody); } catch { /* */ }   // app message only (no SMS)
      }
    }
  } catch (err) { console.error('verify-reminder sweep failed:', err.message); }
}
module.exports.sweepDayTaskVerifyReminders = sweepDayTaskVerifyReminders;   // exported for tests
module.exports.verifyReminderSms = verifyReminderSms;

// Morning (≈7 AM location-local) safety net for tasks assigned IN ADVANCE. A task set up days earlier
// assumes the assignee will be working that day — but people call in sick or get rescheduled. On the
// task's own morning, remind the location's manager + shift lead to re-check every pre-assigned task
// (created before today) and confirm the staff are in and can do it — flagging any whose assignee has
// no shift today. One app message + SMS per location per day; skipped when nothing was pre-assigned.
const MORNING_RECHECK_HOUR = parseInt(process.env.DAYTASK_MORNING_RECHECK_HOUR || '', 10) || 7;
const MORNING_RECHECK_END_HOUR = parseInt(process.env.DAYTASK_MORNING_RECHECK_END_HOUR || '', 10) || 12;
function morningRecheckSms(short, n, noShift) {
  const tail = noShift ? `, ${noShift} w/ no shift` : '';
  const s = `PHN ${short}: ${n} task${n === 1 ? '' : 's'} pre-assigned today${tail} — recheck staff & reassign if out. Day Tasks board.`;
  return s.length > 140 ? s.slice(0, 139) + '…' : s;
}
function sweepDayTaskMorningRecheck({ force = false, locationId = null } = {}) {
  try {
    const locs = locationId
      ? db.prepare(`SELECT id, name, timezone FROM locations WHERE id=? AND is_active=1`).all(locationId)
      : db.prepare(`SELECT id, name, timezone FROM locations WHERE is_active=1`).all();
    const now = new Date();
    for (const loc of locs) {
      const tz = loc.timezone || DEFAULT_TZ;
      const hour = Math.floor(localMinutesOfDay(tz, now) / 60);
      if (!force && (hour < MORNING_RECHECK_HOUR || hour >= MORNING_RECHECK_END_HOUR)) continue;  // morning window only
      const date = localDate(tz);
      const rows = db.prepare(`SELECT ta.id, ta.user_id, ta.created_at, j.name AS task_name, u.name AS staff_name,
          (SELECT COUNT(*) FROM shifts s WHERE s.user_id=ta.user_id AND s.location_id=ta.location_id AND s.shift_date=? AND s.kind='work') AS shifts_today
        FROM task_assignments ta
        JOIN jobs j ON j.id=ta.job_id
        JOIN users u ON u.id=ta.user_id AND u.is_active=1
        WHERE ta.location_id=? AND ta.task_date=? AND ta.user_id IS NOT NULL AND ta.done=0`).all(date, loc.id, date);
      // Keep only tasks assigned on an earlier local day than today (set up in advance).
      const advance = rows.filter(r => {
        if (!r.created_at) return false;
        let cd; try { cd = localDate(tz, new Date(String(r.created_at).replace(' ', 'T') + 'Z')); } catch { return false; }
        return cd < date;
      });
      if (!advance.length) continue;                                  // nothing pre-assigned → no message
      const ins = db.prepare(`INSERT OR IGNORE INTO daily_reminders (location_id, kind, remind_date) VALUES (?, 'daytask_morning', ?)`).run(loc.id, date);
      if (!ins.changes) continue;                                     // already sent today
      const leaders = locationLeaders(loc.id);
      if (!leaders.length) continue;
      const sender = reminderSender(leaders);
      const short = String(loc.name).replace(/^Pho Ha Noi — /, '');
      const n = advance.length;
      const noShift = advance.filter(r => !r.shifts_today).length;
      const lines = advance.map(r => `• ${r.task_name} — ${r.staff_name}${r.shifts_today ? '' : ' (no shift today!)'}`).join('\n');
      const subject = 'Check today’s pre-assigned tasks';
      const appBody = `${n} task${n === 1 ? ' was' : 's were'} assigned in advance for ${short} today. Please confirm the assigned staff are working today and can complete them — reassign any whose person is out${noShift ? ` (${noShift} ${noShift === 1 ? 'has' : 'have'} no shift scheduled today)` : ''}:\n${lines}\nReview on the Day Tasks board.`;
      const recips = new Set(leaders.map(String));
      const central = centralContact(); if (central) recips.add(String(central.id));
      for (const lid of recips) {
        try { if (sender) notify(sender, lid, subject, appBody); } catch { /* */ }   // app message only (no SMS)
      }
    }
  } catch (err) { console.error('morning-recheck sweep failed:', err.message); }
}
module.exports.sweepDayTaskMorningRecheck = sweepDayTaskMorningRecheck;   // exported for tests
module.exports.morningRecheckSms = morningRecheckSms;
module.exports.startDayTaskMorningRecheckSweep = function startDayTaskMorningRecheckSweep() {
  sweepDayTaskMorningRecheck();
  const t = setInterval(sweepDayTaskMorningRecheck, 15 * 60 * 1000);   // every 15 min; fires once in the morning window
  if (t.unref) t.unref();
  return t;
};

// Worked-hours sign-off reminder: a staffer who finished a day but hasn't confirmed (or disputed) their
// hours gets ONE in-app nudge. A PRIOR day reminds as soon as the sweep runs; TODAY's entry waits until
// the evening so we don't nag right after clock-out (the clock-out popup already prompted them). This is
// the backstop behind the clock-out and next-morning clock-in popups — in-app message only (not SMS), so
// a routine daily confirmation doesn't text every staffer. `hours_reminded_at` makes it one-shot.
const HOURS_SIGNOFF_EVENING_HOUR = parseInt(process.env.HOURS_SIGNOFF_EVENING_HOUR || '', 10) || 20;
function sweepHoursSignoffReminders({ force = false } = {}) {
  try {
    const rows = db.prepare(`SELECT te.id, te.user_id, te.work_date, u.name, l.timezone
      FROM time_entries te JOIN users u ON u.id=te.user_id AND u.is_active=1 JOIN locations l ON l.id=te.location_id
      WHERE te.clock_out IS NOT NULL AND te.hours_confirmed=0 AND te.hours_disputed=0 AND te.hours_reminded_at IS NULL`).all();
    const now = new Date();
    const admin = (db.prepare(`SELECT id FROM users WHERE role IN ('owner','admin','ceo','president','hr') AND is_active=1 ORDER BY id LIMIT 1`).get() || {}).id;
    const groups = {};
    for (const r of rows) {
      if (!force) {
        const tz = r.timezone || DEFAULT_TZ, today = localDate(tz);
        const hour = Math.floor(localMinutesOfDay(tz, now) / 60);
        if (!(r.work_date < today || (r.work_date === today && hour >= HOURS_SIGNOFF_EVENING_HOUR))) continue;
      }
      const k = r.user_id + '|' + r.work_date;
      (groups[k] = groups[k] || { user_id: r.user_id, name: r.name, date: r.work_date, ids: [] }).ids.push(r.id);
    }
    for (const k in groups) {
      const g = groups[k];
      const sender = admin && admin !== g.user_id ? admin : null;
      try { if (sender) notify(sender, g.user_id, 'Confirm your worked hours', `Please review and confirm your worked hours for ${g.date} in My Hours. If anything looks off, tap “Report issue” and your manager will review it.`); } catch { /* best-effort */ }
      db.prepare(`UPDATE time_entries SET hours_reminded_at=datetime('now') WHERE id IN (${g.ids.map(() => '?').join(',')})`).run(...g.ids);
    }
  } catch (err) { console.error('hours sign-off reminder sweep failed:', err.message); }
}
module.exports.sweepHoursSignoffReminders = sweepHoursSignoffReminders;   // exported for tests
module.exports.startHoursSignoffReminderSweep = function startHoursSignoffReminderSweep() {
  sweepHoursSignoffReminders();
  const t = setInterval(sweepHoursSignoffReminders, 30 * 60 * 1000);   // every 30 min
  if (t.unref) t.unref();
  return t;
};
module.exports.startDayTaskVerifyReminderSweep = function startDayTaskVerifyReminderSweep() {
  sweepDayTaskVerifyReminders();
  const t = setInterval(sweepDayTaskVerifyReminders, 15 * 60 * 1000);   // every 15 min; fires once after 9 PM local
  if (t.unref) t.unref();
  return t;
};
module.exports.sweepTaskReminders = sweepTaskReminders;   // exported for tests / manual runs
// Day-task start reminders need to land ~5 min ahead, so sweep every minute.
module.exports.startTaskReminderSweep = function startTaskReminderSweep() {
  sweepTaskReminders();
  const t = setInterval(sweepTaskReminders, 60 * 1000);
  if (t.unref) t.unref();
  return t;
};
