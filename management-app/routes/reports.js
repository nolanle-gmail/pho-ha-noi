// Reports module — inventory, sales, analytics, timesheets, payments, breaks.
// Owner/admin can report on any/all locations; managers are scoped to theirs.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations } = require('../lib/auth');
const { localTime, localDate, DEFAULT_TZ } = require('../lib/tz');
const { auditLog } = require('../lib/audit');
const gsheets = require('../lib/gsheets');
const { VERSION: ACK_VERSION } = require('../lib/acknowledgments');

const router = express.Router();
router.use(verifyToken);

function scope(req) {
  return { locId: seesAllLocations(req.user.role) ? (req.query.location_id || null) : req.user.location_id };
}
function dateRange(req) {
  const end = req.query.end || new Date().toISOString().slice(0, 10);
  const start = req.query.start || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  return { start, end };
}

// ── Items / inventory report ───────────────────────────────────────────────
router.get('/inventory', requireRole(ROLES.REPORTS), (req, res) => {
  const { locId } = scope(req);
  // Org-wide (no location filter) counts everything the group holds, including the
  // Central Kitchen warehouse; a specific location scopes to just that location.
  const cond = locId ? 'WHERE i.is_active=1 AND i.location_id=?' : 'WHERE i.is_active=1';
  const args = locId ? [locId] : [];
  const totals = db.prepare(`SELECT ROUND(COALESCE(SUM(quantity*unit_cost),0),2) value, COUNT(*) items,
    SUM(CASE WHEN quantity<min_quantity THEN 1 ELSE 0 END) low FROM inventory i ${cond}`).get(...args);
  const byCategory = db.prepare(`SELECT COALESCE(category,'Other') category, ROUND(SUM(quantity*unit_cost),2) value
    FROM inventory i ${cond} GROUP BY category ORDER BY value DESC`).all(...args);
  const byLocation = db.prepare(`SELECT l.name location, ROUND(SUM(i.quantity*i.unit_cost),2) value
    FROM inventory i JOIN locations l ON i.location_id=l.id ${cond} GROUP BY l.id ORDER BY value DESC`).all(...args);
  const topItems = db.prepare(`SELECT i.item_name, l.name location, i.quantity, i.unit, ROUND(i.quantity*i.unit_cost,2) value
    FROM inventory i JOIN locations l ON i.location_id=l.id ${cond} ORDER BY value DESC LIMIT 10`).all(...args);
  const cogs = db.prepare(`SELECT ROUND(COALESCE(SUM(t.quantity*i.unit_cost),0),2) cost FROM inventory_transactions t
    JOIN inventory i ON t.item_id=i.id WHERE t.type='out' AND date(t.created_at)>=date('now','-30 days')
    ${locId ? 'AND t.from_location_id=?' : ''}`).get(...(locId ? [locId] : [])).cost;
  res.json({ total_value: totals.value, item_count: totals.items, low_stock: totals.low, consumed_cost_30d: cogs,
    by_category: byCategory, by_location: byLocation, top_items: topItems });
});

// ── Sales report ────────────────────────────────────────────────────────────
router.get('/sales', requireRole(ROLES.REPORTS), (req, res) => {
  const { locId } = scope(req); const { start, end } = dateRange(req);
  const conds = ['date(sale_date)>=?', 'date(sale_date)<=?'], args = [start, end];
  if (locId) { conds.push('location_id=?'); args.push(locId); }
  const where = 'WHERE ' + conds.join(' AND ');
  const byDay = db.prepare(`SELECT sale_date day, ROUND(SUM(total_revenue),2) revenue, SUM(cover_count) covers,
    ROUND(SUM(food_sales),2) food, ROUND(SUM(beverage_sales),2) beverage FROM daily_sales ${where} GROUP BY sale_date ORDER BY sale_date`).all(...args);
  const lconds = ['date(d.sale_date)>=?', 'date(d.sale_date)<=?'], largs = [start, end];
  if (locId) { lconds.push('d.location_id=?'); largs.push(locId); }
  const byLocation = db.prepare(`SELECT l.name location, ROUND(SUM(d.total_revenue),2) revenue, SUM(d.cover_count) covers
    FROM daily_sales d JOIN locations l ON d.location_id=l.id WHERE ${lconds.join(' AND ')} GROUP BY l.id ORDER BY revenue DESC`).all(...largs);
  const t = db.prepare(`SELECT ROUND(SUM(total_revenue),2) revenue, SUM(cover_count) covers FROM daily_sales ${where}`).get(...args);
  const days = byDay.length || 1;
  res.json({ start, end, total_revenue: t.revenue || 0, total_covers: t.covers || 0,
    avg_check: t.covers ? Math.round((t.revenue / t.covers) * 100) / 100 : 0,
    avg_daily: Math.round((t.revenue || 0) / days * 100) / 100, by_day: byDay, by_location: byLocation });
});

// ── Payments report (method breakdown) ──────────────────────────────────────
router.get('/payments', requireRole(ROLES.REPORTS), (req, res) => {
  const { locId } = scope(req); const { start, end } = dateRange(req);
  const conds = ['date(sale_date)>=?', 'date(sale_date)<=?'], args = [start, end];
  if (locId) { conds.push('location_id=?'); args.push(locId); }
  const totals = db.prepare(`SELECT ROUND(SUM(cash_revenue),2) cash, ROUND(SUM(card_revenue),2) card,
    ROUND(SUM(online_revenue),2) online, ROUND(SUM(total_revenue),2) total FROM daily_sales WHERE ${conds.join(' AND ')}`).get(...args);
  const lconds = ['date(d.sale_date)>=?', 'date(d.sale_date)<=?'], largs = [start, end];
  if (locId) { lconds.push('d.location_id=?'); largs.push(locId); }
  const byLocation = db.prepare(`SELECT l.name location, ROUND(SUM(d.cash_revenue),2) cash, ROUND(SUM(d.card_revenue),2) card,
    ROUND(SUM(d.online_revenue),2) online, ROUND(SUM(d.total_revenue),2) total
    FROM daily_sales d JOIN locations l ON d.location_id=l.id WHERE ${lconds.join(' AND ')} GROUP BY l.id ORDER BY total DESC`).all(...largs);
  res.json({ start, end, totals, by_location: byLocation });
});

// ── Timesheets report (hours, overtime & labor cost, for payroll) ───────────
// Reads clocked time from `time_entries` (the live time-clock ledger). Only
// completed shifts (clocked out → worked_minutes set) count toward pay. Overtime
// follows the platform's California daily rule (same as the Time Clock payroll
// export): regular ≤ 8h/day, OT 1.5× for 8–12h, double-time 2× beyond 12h — so
// it must split per day, then roll up per staff member and per location.
const TS_OT_AFTER = 8 * 60, TS_DT_AFTER = 12 * 60, TS_OT_MULT = 1.5, TS_DT_MULT = 2;
const tsDaySplit = (m) => ({
  reg: Math.min(m, TS_OT_AFTER),
  ot: Math.min(Math.max(m - TS_OT_AFTER, 0), TS_DT_AFTER - TS_OT_AFTER),
  dt: Math.max(m - TS_DT_AFTER, 0),
});
const tsHrs = (m) => Math.round(m / 60 * 100) / 100;

// Compute the payroll timesheet (per-staff + per-location roll-ups) for the request's scope &
// date range. Shared by the GET report and the Google-Sheet export.
function timesheetReport(req) {
  const { locId } = scope(req); const { start, end } = dateRange(req);
  const conds = ['t.work_date>=?', 't.work_date<=?', 't.worked_minutes IS NOT NULL'], args = [start, end];
  if (locId) { conds.push('t.location_id=?'); args.push(locId); }
  const rows = db.prepare(`SELECT t.id, t.user_id, t.work_date, t.worked_minutes, t.location_id,
      (SELECT COALESCE(SUM(b.minutes),0) FROM time_entry_breaks b WHERE b.time_entry_id=t.id AND b.break_in_at IS NOT NULL) AS break_min,
      (SELECT COALESCE(SUM(b.over_limit_min),0) FROM time_entry_breaks b WHERE b.time_entry_id=t.id AND b.break_in_at IS NOT NULL) AS break_over,
      (SELECT COUNT(*) FROM time_entry_breaks b WHERE b.time_entry_id=t.id AND b.break_in_at IS NOT NULL AND b.over_limit_min>0) AS long_breaks,
      u.name, u.role, u.employee_code, u.hourly_rate, l.name location
    FROM time_entries t JOIN users u ON u.id=t.user_id LEFT JOIN locations l ON l.id=t.location_id
    WHERE ${conds.join(' AND ')}`).all(...args);

  // Missed scheduled breaks per staffer in the same scope/range (durable record, for review).
  const mbConds = ['mb.work_date>=?', 'mb.work_date<=?'], mbArgs = [start, end];
  if (locId) { mbConds.push('mb.location_id=?'); mbArgs.push(locId); }
  const missedByUser = {};
  db.prepare(`SELECT user_id, COUNT(*) c FROM missed_breaks mb WHERE ${mbConds.join(' AND ')} GROUP BY user_id`).all(...mbArgs)
    .forEach(r => { missedByUser[r.user_id] = r.c; });

  const byUser = new Map(), byLoc = new Map();
  const locName = {};
  // California daily OT (≤8h reg, 8–12h OT, >12h double-time) must be computed on each calendar
  // DAY's TOTAL, not per punch — otherwise a split shift (two entries the same day) mis-splits OT.
  // So first roll every entry up into per-(staff, work_date) days, then split each day once. The
  // "Days" column then counts distinct calendar dates worked, not the number of punches.
  const dayAgg = new Map();   // `${user_id}|${work_date}` -> { user_id, date, min, locMin:{} }
  const umeta = new Map();    // user_id -> metadata + break totals over the whole range
  for (const r of rows) {
    if (r.location_id != null) locName[r.location_id] = r.location;
    let um = umeta.get(r.user_id);
    if (!um) { um = { name: r.name, role: r.role, employee_code: r.employee_code, rate: r.hourly_rate || 0, breakMin: 0, breakOver: 0, longBreaks: 0 }; umeta.set(r.user_id, um); }
    um.breakMin += r.break_min || 0; um.breakOver += r.break_over || 0; um.longBreaks += r.long_breaks || 0;
    const k = r.user_id + '|' + r.work_date;
    let day = dayAgg.get(k);
    if (!day) { day = { user_id: r.user_id, date: r.work_date, min: 0, locMin: {} }; dayAgg.set(k, day); }
    day.min += r.worked_minutes || 0;
    day.locMin[r.location_id] = (day.locMin[r.location_id] || 0) + (r.worked_minutes || 0);
  }
  for (const day of dayAgg.values()) {
    const um = umeta.get(day.user_id);
    const rate = um.rate || 0;
    const sp = tsDaySplit(day.min);   // split this DAY's total once
    const dayGross = tsHrs(sp.reg) * rate + tsHrs(sp.ot) * rate * TS_OT_MULT + tsHrs(sp.dt) * rate * TS_DT_MULT;
    let u = byUser.get(day.user_id);
    if (!u) { u = { user_id: day.user_id, name: um.name, role: um.role, employee_code: um.employee_code, hourly_rate: rate, shifts: 0, min: 0, reg: 0, ot: 0, dt: 0, gross: 0, breakMin: um.breakMin, breakOver: um.breakOver, longBreaks: um.longBreaks, locMin: {} }; byUser.set(day.user_id, u); }
    u.shifts++;   // one per distinct calendar day worked (shown as "Days")
    u.min += day.min; u.reg += sp.reg; u.ot += sp.ot; u.dt += sp.dt; u.gross += dayGross;
    for (const [lid, m] of Object.entries(day.locMin)) u.locMin[lid] = (u.locMin[lid] || 0) + m;
    // Per-location roll-up: attribute the day's hours/OT/pay to the location where most of the day
    // was worked (a day split across locations is rare; this keeps each day counted once).
    let domLid = null, domMax = -1;
    for (const [lid, m] of Object.entries(day.locMin)) if (m > domMax) { domMax = m; domLid = lid; }
    let L = byLoc.get(domLid);
    if (!L) { L = { location_id: domLid, staff: new Set(), min: 0, ot: 0, dt: 0, gross: 0 }; byLoc.set(domLid, L); }
    L.staff.add(day.user_id); L.min += day.min; L.ot += sp.ot; L.dt += sp.dt; L.gross += dayGross;
  }

  const by_staff = [...byUser.values()].map(u => {
    // Show the location where this person worked the most hours in range.
    let plId = null, mx = -1;
    for (const [lid, m] of Object.entries(u.locMin)) if (m > mx) { mx = m; plId = lid; }
    return {
      user_id: u.user_id, name: u.name, role: u.role, employee_code: u.employee_code,
      location: locName[plId] || null, location_id: plId != null ? Number(plId) : null,
      shifts: u.shifts, hours: tsHrs(u.min), reg_hours: tsHrs(u.reg),
      ot_hours: tsHrs(u.ot + u.dt), dt_hours: tsHrs(u.dt),
      break_minutes: u.breakMin, break_over_minutes: u.breakOver,   // total break min in range + minutes over the per-break limit (not deducted from hours yet)
      long_breaks: u.longBreaks, missed_breaks: missedByUser[u.user_id] || 0,   // break-compliance counts (for performance review)
      hourly_rate: u.hourly_rate, labor_cost: Math.round(u.gross * 100) / 100,
    };
  }).sort((a, b) => b.hours - a.hours);

  const by_location = [...byLoc.values()].map(L => ({
    location: locName[L.location_id] || '—', location_id: L.location_id != null ? Number(L.location_id) : null,
    headcount: L.staff.size, hours: tsHrs(L.min), ot_hours: tsHrs(L.ot + L.dt),
    labor_cost: Math.round(L.gross * 100) / 100,
  })).sort((a, b) => b.labor_cost - a.labor_cost);

  const tot = by_staff.reduce((a, r) => ({ hours: a.hours + r.hours, ot: a.ot + r.ot_hours, labor: a.labor + r.labor_cost }), { hours: 0, ot: 0, labor: 0 });
  return {
    start, end, location_id: locId ? Number(locId) : null,
    ot_rule: { ot_after_h: 8, dt_after_h: 12, ot_mult: TS_OT_MULT, dt_mult: TS_DT_MULT },
    total_hours: Math.round(tot.hours * 100) / 100, total_ot_hours: Math.round(tot.ot * 100) / 100,
    total_break_minutes: by_staff.reduce((a, r) => a + (r.break_minutes || 0), 0),
    total_break_over_minutes: by_staff.reduce((a, r) => a + (r.break_over_minutes || 0), 0),
    total_long_breaks: by_staff.reduce((a, r) => a + (r.long_breaks || 0), 0),
    total_missed_breaks: by_staff.reduce((a, r) => a + (r.missed_breaks || 0), 0),
    total_labor_cost: Math.round(tot.labor * 100) / 100, headcount: by_staff.length,
    by_staff, by_location,
  };
}

router.get('/timesheets', requireRole(ROLES.REPORTS), (req, res) => {
  // `gsheet` tells the client whether the "Create live Google Sheet" button is available.
  res.json({ ...timesheetReport(req), gsheet: gsheets.isConfigured() });
});

// Create a live Google Sheet of the timesheet and return its shareable link. Needs a Google
// service account configured on the server (GOOGLE_SA_KEY_B64); shares per GSHEET_* env vars.
router.post('/timesheets/gsheet', requireRole(ROLES.REPORTS), async (req, res) => {
  if (!gsheets.isConfigured()) return res.status(501).json({ error: 'Google Sheets export isn’t set up yet — a Google service account needs to be configured on the server.' });
  const d = timesheetReport(req);
  if (!d.by_staff.length) return res.status(400).json({ error: 'Nothing to export — run a range with clocked hours first.' });
  const roleLabels = Object.fromEntries(db.prepare('SELECT key, label FROM roles').all().map(r => [r.key, r.label]));
  const rl = (k) => roleLabels[k] || k;
  const shortLoc = (s) => (s || '').replace('Pho Ha Noi — ', '');
  const locName = d.location_id ? shortLoc((db.prepare('SELECT name FROM locations WHERE id=?').get(d.location_id) || {}).name || 'Selected location') : 'All locations';
  const cols = ['Staff', 'Employee code', 'Role', 'Location', 'Days', 'Total hours', 'Regular hrs', 'OT hrs', 'Double-time hrs', 'Break min', 'Break over-limit min', 'Long breaks', 'Missed breaks', 'Hourly rate', 'Gross pay'];
  const staffRows = d.by_staff.map(s => [s.name, s.employee_code || '', rl(s.role), shortLoc(s.location) || '', s.shifts, s.hours, s.reg_hours, s.ot_hours, s.dt_hours, s.break_minutes || 0, s.break_over_minutes || 0, s.long_breaks || 0, s.missed_breaks || 0, s.hourly_rate, s.labor_cost]);
  const staffTotal = ['TOTAL', '', '', '', '', d.total_hours, '', d.total_ot_hours, '', d.total_break_minutes || 0, d.total_break_over_minutes || 0, d.total_long_breaks || 0, d.total_missed_breaks || 0, '', d.total_labor_cost];
  const locCols = ['Location', 'Staff', 'Hours', 'OT hrs', 'Gross pay'];
  const locRows = (d.by_location || []).map(l => [shortLoc(l.location) || '—', l.headcount, l.hours, l.ot_hours, l.labor_cost]);
  const locTotal = ['All locations', d.headcount, d.total_hours, d.total_ot_hours, d.total_labor_cost];
  const title = `Phở Hà Nội — Timesheet · ${locName} · ${d.start} to ${d.end}`;
  const note = 'OT: California daily — over 8h/day at 1.5×, over 12h/day at 2× (double-time included in OT hrs & gross).';
  const values = [], boldRows = [];
  const push = (row, bold) => { if (bold) boldRows.push(values.length); values.push(row); };
  push([title], true); push([note]); push([]); push(cols, true);
  staffRows.forEach(r => push(r)); push([]); push(staffTotal, true); push([]);
  push(['Gross pay by location'], true); push(locCols, true); locRows.forEach(r => push(r)); push(locTotal, true);
  try {
    const { url } = await gsheets.createSheet({ title, sheetTitle: 'Timesheet', values, boldRows });
    try { auditLog(req, 'timesheet_gsheet_export', 'location', d.location_id || null, { start: d.start, end: d.end, staff: d.by_staff.length }); } catch { /* best-effort */ }
    res.json({ success: true, url, staff: d.by_staff.length });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Could not create the Google Sheet.' });
  }
});

// ── Analytics report (executive summary) ────────────────────────────────────
router.get('/analytics', requireRole(ROLES.REPORTS), (req, res) => {
  const { locId } = scope(req); const { start, end } = dateRange(req);
  const sconds = ['date(sale_date)>=?', 'date(sale_date)<=?'], sargs = [start, end];
  if (locId) { sconds.push('location_id=?'); sargs.push(locId); }
  const swhere = 'WHERE ' + sconds.join(' AND ');
  const rev = db.prepare(`SELECT ROUND(SUM(total_revenue),2) revenue, SUM(cover_count) covers FROM daily_sales ${swhere}`).get(...sargs);
  const trend = db.prepare(`SELECT sale_date day, ROUND(SUM(total_revenue),2) revenue FROM daily_sales ${swhere} GROUP BY sale_date ORDER BY sale_date`).all(...sargs);
  const lconds = ['date(d.sale_date)>=?', 'date(d.sale_date)<=?'], largs = [start, end];
  if (locId) { lconds.push('d.location_id=?'); largs.push(locId); }
  const byLocation = db.prepare(`SELECT l.name location, ROUND(SUM(d.total_revenue),2) revenue FROM daily_sales d
    JOIN locations l ON d.location_id=l.id WHERE ${lconds.join(' AND ')} GROUP BY l.id ORDER BY revenue DESC`).all(...largs);
  const tconds = ['t.work_date>=?', 't.work_date<=?', 't.worked_minutes IS NOT NULL'], targs = [start, end];
  if (locId) { tconds.push('t.location_id=?'); targs.push(locId); }
  const labor = db.prepare(`SELECT ROUND(COALESCE(SUM(t.worked_minutes / 60.0 * u.hourly_rate),0),2) cost FROM time_entries t
    JOIN users u ON t.user_id=u.id WHERE ${tconds.join(' AND ')}`).get(...targs).cost;
  // Menu food-cost % (average across priced items). Menus are per-location, so scope to the
  // selected location's menu + inventory costs; with no location, average across all stores.
  const costs = {}; db.prepare(`SELECT item_name, AVG(unit_cost) c FROM inventory WHERE is_active=1 ${locId ? 'AND location_id=?' : ''} GROUP BY item_name`).all(...(locId ? [locId] : [])).forEach(r => costs[r.item_name] = r.c || 0);
  const fps = [];
  db.prepare(`SELECT id, price FROM menu_items WHERE is_active=1 AND price>0 ${locId ? 'AND location_id=?' : ''}`).all(...(locId ? [locId] : [])).forEach(it => {
    const c = db.prepare(`SELECT item_name, quantity FROM recipe_ingredients WHERE menu_item_id=?`).all(it.id)
      .reduce((s, i) => s + i.quantity * (costs[i.item_name] || 0), 0);
    if (c > 0) fps.push(c / it.price * 100);
  });
  const foodPct = fps.length ? Math.round(fps.reduce((a, b) => a + b, 0) / fps.length * 10) / 10 : null;
  const invVal = db.prepare(`SELECT ROUND(COALESCE(SUM(quantity*unit_cost),0),2) v FROM inventory
    ${locId ? 'WHERE is_active=1 AND location_id=?' : 'WHERE is_active=1'}`).get(...(locId ? [locId] : [])).v;
  const revenue = rev.revenue || 0, days = trend.length || 1;
  res.json({
    start, end, revenue, covers: rev.covers || 0,
    avg_daily: Math.round(revenue / days * 100) / 100,
    avg_check: rev.covers ? Math.round(revenue / rev.covers * 100) / 100 : 0,
    best_location: byLocation[0] ? byLocation[0].location : null,
    lowest_location: byLocation.length > 1 ? byLocation[byLocation.length - 1].location : null,
    labor_cost: labor, labor_cost_pct: revenue ? Math.round(labor / revenue * 1000) / 10 : null,
    food_cost_pct: foodPct, inventory_value: invVal,
    revenue_trend: trend, by_location: byLocation,
  });
});

// ── Break-reminders report (compliance archive across locations) ────────────
// A cross-location roll-up of the break reminders staff were sent — proof, for
// audit, that everyone was reminded to take their breaks. Owner/admin/GM see
// every location; a single-store manager sees only their own.
router.get('/break-reminders', requireRole(ROLES.REPORTS), (req, res) => {
  const { locId } = scope(req); const { start, end } = dateRange(req);
  const conds = ['br.work_date>=?', 'br.work_date<=?'], args = [start, end];
  if (locId) { conds.push('br.location_id=?'); args.push(locId); }
  const rows = db.prepare(`SELECT br.id, br.work_date, br.break_time, br.sent_at, br.acknowledged_at,
    u.name, u.employee_code, l.name location, l.timezone
    FROM break_reminders br JOIN users u ON u.id=br.user_id JOIN locations l ON l.id=br.location_id
    WHERE ${conds.join(' AND ')} ORDER BY br.work_date DESC, l.name, br.break_time, u.name`).all(...args);
  const fmt = (tz, ts) => ts ? localTime(tz || DEFAULT_TZ, new Date(ts.replace(' ', 'T') + 'Z')) : null;
  const reminders = rows.map(r => ({
    id: r.id, work_date: r.work_date, location: r.location, name: r.name,
    employee_code: r.employee_code, break_time: r.break_time,
    sent_at: fmt(r.timezone, r.sent_at), acknowledged_at: fmt(r.timezone, r.acknowledged_at),
  }));
  res.json({
    start, end,
    total: reminders.length,
    acknowledged: reminders.filter(r => r.acknowledged_at).length,
    pending: reminders.filter(r => !r.acknowledged_at).length,
    reminders,
  });
});

// ── Break-compliance report (missed + over-limit breaks, for performance review) ──
// The durable history a manager pulls for a review: every SCHEDULED break a staffer
// never took (missed_breaks, written by the end-of-day sweep) and every break that
// ran over the 10-min limit (time_entry_breaks.over_limit_min). Per-staff counts plus
// a flat, dated per-incident list. Owner/admin/GM see all locations; a manager theirs.
router.get('/break-compliance', requireRole(ROLES.REPORTS), (req, res) => {
  const { locId } = scope(req); const { start, end } = dateRange(req);

  const mConds = ['mb.work_date>=?', 'mb.work_date<=?'], mArgs = [start, end];
  if (locId) { mConds.push('mb.location_id=?'); mArgs.push(locId); }
  const missed = db.prepare(`SELECT mb.work_date, mb.scheduled_time, u.id user_id, u.name, u.employee_code, u.role, l.name location
    FROM missed_breaks mb JOIN users u ON u.id=mb.user_id JOIN locations l ON l.id=mb.location_id
    WHERE ${mConds.join(' AND ')}`).all(...mArgs);

  const lConds = ['te.work_date>=?', 'te.work_date<=?', 'b.break_in_at IS NOT NULL', 'b.over_limit_min>0'], lArgs = [start, end];
  if (locId) { lConds.push('te.location_id=?'); lArgs.push(locId); }
  const long = db.prepare(`SELECT te.work_date, b.break_out_at, b.minutes, b.over_limit_min,
      u.id user_id, u.name, u.employee_code, u.role, l.name location, l.timezone
    FROM time_entry_breaks b JOIN time_entries te ON te.id=b.time_entry_id
    JOIN users u ON u.id=te.user_id JOIN locations l ON l.id=te.location_id
    WHERE ${lConds.join(' AND ')}`).all(...lArgs);

  const byUser = new Map();
  const staffOf = (r) => {
    let u = byUser.get(r.user_id);
    if (!u) { u = { user_id: r.user_id, name: r.name, employee_code: r.employee_code, role: r.role, location: r.location, missed: 0, long: 0 }; byUser.set(r.user_id, u); }
    return u;
  };
  const incidents = [];
  for (const r of missed) {
    staffOf(r).missed++;
    incidents.push({ work_date: r.work_date, type: 'missed', user_id: r.user_id, name: r.name, employee_code: r.employee_code, location: r.location,
      time: r.scheduled_time || null, detail: `Scheduled ${r.scheduled_time || ''} break not taken` });
  }
  for (const r of long) {
    staffOf(r).long++;
    const at = r.break_out_at ? localTime(r.timezone || DEFAULT_TZ, new Date(r.break_out_at)) : null;
    incidents.push({ work_date: r.work_date, type: 'long', user_id: r.user_id, name: r.name, employee_code: r.employee_code, location: r.location,
      time: at, detail: `${r.minutes} min break — ${r.over_limit_min} over the limit` });
  }
  incidents.sort((a, b) => (a.work_date < b.work_date ? 1 : a.work_date > b.work_date ? -1 : a.name.localeCompare(b.name)));
  const by_staff = [...byUser.values()].sort((a, b) => (b.missed + b.long) - (a.missed + a.long) || a.name.localeCompare(b.name));

  res.json({
    start, end, location_id: locId ? Number(locId) : null,
    total_missed: missed.length, total_long: long.length,
    staff_affected: by_staff.length,
    by_staff, incidents,
  });
});

// ── Worked-Hours Acknowledgment status (who has / hasn't signed) ─────────────
// Current-state report (no date range): every active staff member and whether
// they've e-signed the CURRENT version of the one-time acknowledgment.
router.get('/hours-ack', requireRole(ROLES.REPORTS), (req, res) => {
  const { locId } = scope(req);
  const conds = ['u.is_active=1'], args = [];
  if (locId) { conds.push('u.location_id=?'); args.push(locId); }
  const rows = db.prepare(`
    SELECT u.id user_id, u.name, u.role, u.location_id, l.name location,
           sp.employee_code, sp.job_title,
           a.version signed_version, a.lang, a.signed_at, a.document_id
    FROM users u
    LEFT JOIN locations l ON l.id=u.location_id
    LEFT JOIN staff_profiles sp ON sp.user_id=u.id
    LEFT JOIN staff_acknowledgments a ON a.id=(
      SELECT z.id FROM staff_acknowledgments z WHERE z.user_id=u.id AND z.policy='worked_hours' ORDER BY z.id DESC LIMIT 1)
    WHERE ${conds.join(' AND ')}
    ORDER BY u.name COLLATE NOCASE`).all(...args);
  const staff = rows.map(r => ({
    user_id: r.user_id, name: r.name, role: r.role,
    employee_code: r.employee_code || null, job_title: r.job_title || null,
    location: r.location || null, location_id: r.location_id || null,
    status: r.signed_version === ACK_VERSION ? 'signed' : (r.signed_version ? 'outdated' : 'unsigned'),
    signed_at: r.signed_at || null, lang: r.lang || null, signed_version: r.signed_version || null,
    has_document: !!r.document_id,
  }));
  const signed = staff.filter(s => s.status === 'signed').length;
  const unsigned = staff.filter(s => s.status === 'unsigned').length;
  const outdated = staff.filter(s => s.status === 'outdated').length;
  res.json({ version: ACK_VERSION, location_id: locId ? Number(locId) : null, total: staff.length, signed, unsigned, outdated, staff });
});

// ── Cross-location schedule conflicts (who's double-booked right now) ─────────
// Read-only scan: staff with overlapping WORK shifts at DIFFERENT locations on the
// same day, from today forward. Mirrors the scheduling guard in routes/schedule.js
// so managers can find and clean up conflicts that predate that control.
router.get('/schedule-conflicts', requireRole(ROLES.REPORTS), (req, res) => {
  const { locId } = scope(req);
  const today = localDate(DEFAULT_TZ);
  const rows = db.prepare(`
    SELECT s.user_id, u.name, u.role, sp.employee_code, s.shift_date,
           s.location_id, l.name AS loc, s.start_time, s.end_time
    FROM shifts s JOIN users u ON u.id=s.user_id JOIN locations l ON l.id=s.location_id
    LEFT JOIN staff_profiles sp ON sp.user_id=u.id
    WHERE s.kind='work' AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL AND s.shift_date>=?
    ORDER BY s.user_id, s.shift_date, s.start_time`).all(today);
  const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  const byKey = new Map();
  for (const r of rows) { const k = r.user_id + '|' + r.shift_date; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(r); }
  const conflicts = [];
  for (const arr of byKey.values()) {
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j];
      if (a.location_id === b.location_id) continue;
      let as = toMin(a.start_time), ae = toMin(a.end_time); if (ae <= as) ae += 1440;
      let bs = toMin(b.start_time), be = toMin(b.end_time); if (be <= bs) be += 1440;
      if (as < be && bs < ae) {
        if (locId && String(a.location_id) !== String(locId) && String(b.location_id) !== String(locId)) continue;
        conflicts.push({
          user_id: a.user_id, name: a.name, role: a.role, employee_code: a.employee_code || null, date: a.shift_date,
          a: { location: a.loc, location_id: a.location_id, start: a.start_time, end: a.end_time },
          b: { location: b.loc, location_id: b.location_id, start: b.start_time, end: b.end_time },
        });
      }
    }
  }
  conflicts.sort((x, y) => x.date.localeCompare(y.date) || x.name.localeCompare(y.name));
  res.json({ as_of: today, location_id: locId ? Number(locId) : null, total: conflicts.length, staff_count: new Set(conflicts.map(c => c.user_id)).size, conflicts });
});

// ── Attendance exceptions (all locations) ────────────────────────────────────
// One list of the punch/break incidents leaders review for a date range, across
// every location (a location manager sees only their store): forgotten clock-OUTS
// (auto-closed at the scheduled end, or manager-closed), forgotten clock-INS (a
// manager had to punch them in), LATE clock-ins, MISSED breaks, and LONG (over-limit)
// breaks. Each incident row carries its type; totals + per-staff counts summarise them.
router.get('/attendance-exceptions', requireRole(ROLES.REPORTS), (req, res) => {
  const { locId } = scope(req); const { start, end } = dateRange(req);
  const sel = `u.id user_id, u.name, u.employee_code, u.role, l.name location, l.id location_id, l.timezone`;
  const teWhere = (extra) => {
    const conds = ['te.work_date>=?', 'te.work_date<=?', ...extra], args = [start, end];
    if (locId) { conds.push('te.location_id=?'); args.push(locId); }
    return { sql: conds.join(' AND '), args };
  };

  const fo = teWhere([`te.overrun_decision IN ('auto','forced')`, 'te.clock_out IS NOT NULL']);
  const forgotOut = db.prepare(`SELECT te.work_date, te.clock_out, te.overrun_decision, ${sel}
    FROM time_entries te JOIN users u ON u.id=te.user_id JOIN locations l ON l.id=te.location_id
    WHERE ${fo.sql}`).all(...fo.args);

  // A manager/lead punched them in (they didn't self-clock-in on the kiosk).
  const fi = teWhere(['te.opened_by IS NOT NULL', 'te.opened_by<>te.user_id']);
  const forgotIn = db.prepare(`SELECT te.work_date, te.clock_in, ${sel}
    FROM time_entries te JOIN users u ON u.id=te.user_id JOIN locations l ON l.id=te.location_id
    WHERE ${fi.sql}`).all(...fi.args);

  const la = teWhere(['COALESCE(te.late_minutes,0)>0']);
  const lates = db.prepare(`SELECT te.work_date, te.clock_in, te.late_minutes, ${sel}
    FROM time_entries te JOIN users u ON u.id=te.user_id JOIN locations l ON l.id=te.location_id
    WHERE ${la.sql}`).all(...la.args);

  const mConds = ['mb.work_date>=?', 'mb.work_date<=?'], mArgs = [start, end];
  if (locId) { mConds.push('mb.location_id=?'); mArgs.push(locId); }
  const missed = db.prepare(`SELECT mb.work_date, mb.scheduled_time, u.id user_id, u.name, u.employee_code, u.role, l.name location, l.id location_id
    FROM missed_breaks mb JOIN users u ON u.id=mb.user_id JOIN locations l ON l.id=mb.location_id
    WHERE ${mConds.join(' AND ')}`).all(...mArgs);

  const lConds = ['te.work_date>=?', 'te.work_date<=?', 'b.break_in_at IS NOT NULL', 'b.over_limit_min>0'], lArgs = [start, end];
  if (locId) { lConds.push('te.location_id=?'); lArgs.push(locId); }
  const long = db.prepare(`SELECT te.work_date, b.break_out_at, b.minutes, b.over_limit_min, ${sel}
    FROM time_entry_breaks b JOIN time_entries te ON te.id=b.time_entry_id
    JOIN users u ON u.id=te.user_id JOIN locations l ON l.id=te.location_id
    WHERE ${lConds.join(' AND ')}`).all(...lArgs);

  // No-shows: a scheduled shift the staffer never worked (the no_shows sweep records these).
  const nsConds = ['ns.work_date>=?', 'ns.work_date<=?'], nsArgs = [start, end];
  if (locId) { nsConds.push('ns.location_id=?'); nsArgs.push(locId); }
  const noshow = db.prepare(`SELECT ns.work_date, ns.start_time, ns.end_time, u.id user_id, u.name, u.employee_code, u.role, l.name location, l.id location_id
    FROM no_shows ns JOIN users u ON u.id=ns.user_id JOIN locations l ON l.id=ns.location_id
    WHERE ${nsConds.join(' AND ')}`).all(...nsArgs);

  const T = (tz, iso) => iso ? localTime(tz || DEFAULT_TZ, new Date(iso)) : null;
  const byUser = new Map();
  const bump = (r, key) => {
    let u = byUser.get(r.user_id);
    if (!u) { u = { user_id: r.user_id, name: r.name, employee_code: r.employee_code || null, role: r.role, location: r.location, no_show: 0, forgot_out: 0, forgot_in: 0, late: 0, missed_break: 0, long_break: 0 }; byUser.set(r.user_id, u); }
    u[key]++; return u;
  };
  const mk = (r, type, time, detail) => ({ work_date: r.work_date, type, user_id: r.user_id, name: r.name, employee_code: r.employee_code || null, role: r.role, location: r.location, location_id: r.location_id, time, detail });
  const incidents = [];
  for (const r of noshow) { bump(r, 'no_show'); incidents.push(mk(r, 'no_show', r.start_time || null, `No-show — scheduled ${r.start_time || ''}–${r.end_time || ''} shift, never clocked in`)); }
  for (const r of forgotOut) { bump(r, 'forgot_out'); const t = T(r.timezone, r.clock_out); incidents.push(mk(r, 'forgot_out', t, r.overrun_decision === 'forced' ? `Didn’t clock out — a manager closed the shift at ${t}` : `Didn’t clock out — auto-closed at the scheduled end (${t})`)); }
  for (const r of forgotIn) { bump(r, 'forgot_in'); const t = T(r.timezone, r.clock_in); incidents.push(mk(r, 'forgot_in', t, `Didn’t clock in — a manager clocked them in at ${t}`)); }
  for (const r of lates) { bump(r, 'late'); incidents.push(mk(r, 'late', T(r.timezone, r.clock_in), `Clocked in ${r.late_minutes} min late`)); }
  for (const r of missed) { bump(r, 'missed_break'); incidents.push(mk(r, 'missed_break', r.scheduled_time || null, `Scheduled ${r.scheduled_time || ''} break not taken`.replace('  ', ' '))); }
  for (const r of long) { bump(r, 'long_break'); incidents.push(mk(r, 'long_break', T(r.timezone, r.break_out_at), `${r.minutes} min break — ${r.over_limit_min} over the limit`)); }

  incidents.sort((a, b) => (a.work_date < b.work_date ? 1 : a.work_date > b.work_date ? -1 : (a.location || '').localeCompare(b.location || '') || a.name.localeCompare(b.name)));
  const by_staff = [...byUser.values()].map(u => ({ ...u, total: u.no_show + u.forgot_out + u.forgot_in + u.late + u.missed_break + u.long_break }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const totals = { no_show: noshow.length, forgot_out: forgotOut.length, forgot_in: forgotIn.length, late: lates.length, missed_break: missed.length, long_break: long.length };
  totals.all = totals.no_show + totals.forgot_out + totals.forgot_in + totals.late + totals.missed_break + totals.long_break;
  res.json({ start, end, location_id: locId ? Number(locId) : null, totals, staff_affected: by_staff.length, by_staff, incidents });
});

// ── Shift detail (a per-shift attendance report, grouped by staff) ────────────
// Like the Time Clock board but across a date range: for every scheduled shift it pairs the
// staffer's punches to that shift and shows scheduled vs worked hours, late, long break, forgot
// clock-in / clock-out, and NO-SHOW (scheduled but never clocked in). Unscheduled punches show too.
const sdHhmm = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const sdMinOfDay = (tz, d) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: tz || DEFAULT_TZ, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(d); return (Number(p.find(x => x.type === 'hour').value) % 24) * 60 + Number(p.find(x => x.type === 'minute').value); };
const sdBlockEnd = (b) => (b.eMin <= b.sMin ? b.eMin + 1440 : b.eMin);      // minutes, overnight-aware
router.get('/shift-detail', requireRole(ROLES.REPORTS), (req, res) => {
  const { locId } = scope(req); const { start, end } = dateRange(req);
  const sConds = ["s.kind='work'", 's.start_time IS NOT NULL', 's.end_time IS NOT NULL', 's.shift_date>=?', 's.shift_date<=?'], sArgs = [start, end];
  if (locId) { sConds.push('s.location_id=?'); sArgs.push(locId); }
  const shifts = db.prepare(`SELECT s.id shift_id, s.user_id, u.name, u.employee_code, u.role, s.shift_date, s.start_time, s.end_time, s.location_id, l.name loc, l.timezone,
      (SELECT j.name FROM shift_jobs sj JOIN jobs j ON j.id=sj.job_id WHERE sj.shift_id=s.id ORDER BY j.name LIMIT 1) job
    FROM shifts s JOIN users u ON u.id=s.user_id JOIN locations l ON l.id=s.location_id
    WHERE ${sConds.join(' AND ')}`).all(...sArgs);
  const eConds = ['te.work_date>=?', 'te.work_date<=?'], eArgs = [start, end];
  if (locId) { eConds.push('te.location_id=?'); eArgs.push(locId); }
  const entries = db.prepare(`SELECT te.id, te.user_id, u.name, u.employee_code, u.role, te.work_date, te.clock_in, te.clock_out,
      te.worked_minutes, te.scheduled_minutes, te.late_minutes, te.overrun_decision, te.opened_by, te.location_id, l.name loc, l.timezone,
      (SELECT COALESCE(SUM(over_limit_min),0) FROM time_entry_breaks b WHERE b.time_entry_id=te.id AND b.break_in_at IS NOT NULL) long_break_min,
      (SELECT COALESCE(SUM(minutes),0) FROM time_entry_breaks b WHERE b.time_entry_id=te.id AND b.break_in_at IS NOT NULL) break_min,
      (SELECT COUNT(*) FROM time_entry_breaks b WHERE b.time_entry_id=te.id AND b.break_in_at IS NOT NULL) breaks_count
    FROM time_entries te JOIN users u ON u.id=te.user_id JOIN locations l ON l.id=te.location_id
    WHERE ${eConds.join(' AND ')}`).all(...eArgs);

  const blocksByUD = new Map(), entriesByUD = new Map(), umeta = new Map();
  const metaOf = (o, job) => { if (!umeta.has(o.user_id)) umeta.set(o.user_id, { user_id: o.user_id, name: o.name, employee_code: o.employee_code || null, role: o.role, location: o.loc, job: job || null }); else if (job && !umeta.get(o.user_id).job) umeta.get(o.user_id).job = job; return umeta.get(o.user_id); };
  for (const s of shifts) { metaOf(s, s.job); const k = s.user_id + '|' + s.shift_date; if (!blocksByUD.has(k)) blocksByUD.set(k, []); blocksByUD.get(k).push({ shift_id: s.shift_id, start: s.start_time, end: s.end_time, sMin: sdHhmm(s.start_time), eMin: sdHhmm(s.end_time), loc: s.loc, tz: s.timezone, entries: [] }); }
  for (const e of entries) { metaOf(e); const k = e.user_id + '|' + e.work_date; if (!entriesByUD.has(k)) entriesByUD.set(k, []); entriesByUD.get(k).push(e); }
  const pick = (blocks, ci) => { if (!blocks.length) return null; const inside = blocks.find(b => ci >= b.sMin && ci <= sdBlockEnd(b)); return inside || blocks.find(b => b.sMin >= ci) || blocks[blocks.length - 1]; };

  const now = new Date();
  const perUser = new Map();
  const ensureU = (uid) => { if (!perUser.has(uid)) { const m = umeta.get(uid); perUser.set(uid, { ...m, rows: [], totals: { scheduled_min: 0, worked_min: 0, late: 0, long_break: 0, forgot_in: 0, forgot_out: 0, no_show: 0, shifts: 0 } }); } return perUser.get(uid); };
  for (const key of new Set([...blocksByUD.keys(), ...entriesByUD.keys()])) {
    const [uidStr, date] = key.split('|'); const uid = +uidStr;
    const blocks = blocksByUD.get(key) || [];
    const es = entriesByUD.get(key) || [];
    const U = ensureU(uid);
    const used = new Set();
    for (const e of es) { const b = pick(blocks, sdMinOfDay(e.timezone, new Date(e.clock_in))); if (b) { b.entries.push(e); used.add(e.id); } }
    for (const b of blocks) {
      const tz = b.tz || DEFAULT_TZ, schedMin = sdBlockEnd(b) - b.sMin;
      U.totals.scheduled_min += schedMin; U.totals.shifts++;
      if (b.entries.length) {
        const ein = b.entries.slice().sort((x, y) => new Date(x.clock_in) - new Date(y.clock_in));
        const worked = b.entries.reduce((a, e) => a + (e.worked_minutes || 0), 0);
        const late = b.entries.reduce((a, e) => Math.max(a, e.late_minutes || 0), 0);
        const longBreak = b.entries.reduce((a, e) => a + (e.long_break_min || 0), 0);
        const breakMin = b.entries.reduce((a, e) => a + (e.break_min || 0), 0);
        const forgotOut = b.entries.some(e => ['auto', 'forced'].includes(e.overrun_decision) && e.clock_out) ? 1 : 0;
        const forgotIn = b.entries.some(e => e.opened_by != null && String(e.opened_by) !== String(uid)) ? 1 : 0;
        const open = b.entries.some(e => !e.clock_out) ? 1 : 0;
        const last = ein[ein.length - 1];
        U.rows.push({ date, loc: b.loc, block_start: b.start, block_end: b.end, scheduled_min: schedMin,
          clock_in: localTime(tz, new Date(ein[0].clock_in)), clock_out: last.clock_out ? localTime(tz, new Date(last.clock_out)) : null,
          worked_min: worked, late_min: late, long_break_min: longBreak, break_min: breakMin,
          forgot_in: forgotIn, forgot_out: forgotOut, no_show: 0, unscheduled: 0, open, status: open ? 'open' : 'worked' });
        U.totals.worked_min += worked;
        if (late > 0) U.totals.late++; if (longBreak > 0) U.totals.long_break++; if (forgotIn) U.totals.forgot_in++; if (forgotOut) U.totals.forgot_out++;
      } else {
        const todayLocal = localDate(tz);
        const past = date < todayLocal || (date === todayLocal && sdMinOfDay(tz, now) > sdBlockEnd(b));
        U.rows.push({ date, loc: b.loc, block_start: b.start, block_end: b.end, scheduled_min: schedMin,
          clock_in: null, clock_out: null, worked_min: 0, late_min: 0, long_break_min: 0, break_min: 0,
          forgot_in: 0, forgot_out: 0, no_show: past ? 1 : 0, unscheduled: 0, open: 0, status: past ? 'no_show' : 'scheduled' });
        if (past) U.totals.no_show++;
      }
    }
    for (const e of es) {
      if (used.has(e.id)) continue;
      const tz = e.timezone || DEFAULT_TZ;
      const forgotOut = ['auto', 'forced'].includes(e.overrun_decision) && e.clock_out ? 1 : 0;
      const forgotIn = e.opened_by != null && String(e.opened_by) !== String(uid) ? 1 : 0;
      U.rows.push({ date, loc: e.loc, block_start: null, block_end: null, scheduled_min: 0,
        clock_in: localTime(tz, new Date(e.clock_in)), clock_out: e.clock_out ? localTime(tz, new Date(e.clock_out)) : null,
        worked_min: e.worked_minutes || 0, late_min: e.late_minutes || 0, long_break_min: e.long_break_min || 0, break_min: e.break_min || 0,
        forgot_in: forgotIn, forgot_out: forgotOut, no_show: 0, unscheduled: 1, open: e.clock_out ? 0 : 1, status: 'unscheduled' });
      U.totals.worked_min += e.worked_minutes || 0; U.totals.shifts++;
      if ((e.late_minutes || 0) > 0) U.totals.late++; if ((e.long_break_min || 0) > 0) U.totals.long_break++; if (forgotIn) U.totals.forgot_in++; if (forgotOut) U.totals.forgot_out++;
    }
  }
  const staff = [...perUser.values()].map(u => ({ ...u, rows: u.rows.sort((a, b) => a.date.localeCompare(b.date) || String(a.block_start || '~').localeCompare(String(b.block_start || '~'))) })).sort((a, b) => a.name.localeCompare(b.name));
  const T = { staff: staff.length, scheduled_min: 0, worked_min: 0, late: 0, long_break: 0, forgot_in: 0, forgot_out: 0, no_show: 0, shifts: 0 };
  for (const u of staff) for (const k of Object.keys(T)) if (k !== 'staff') T[k] += u.totals[k];
  res.json({ start, end, location_id: locId ? Number(locId) : null, totals: T, staff });
});

module.exports = router;
