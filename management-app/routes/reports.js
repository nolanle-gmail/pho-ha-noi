// Reports module — inventory, sales, analytics, timesheets, payments.
// Owner/admin can report on any/all locations; managers are scoped to theirs.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations } = require('../lib/auth');

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
router.get('/inventory', requireRole(...ROLES.REPORTS), (req, res) => {
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
router.get('/sales', requireRole(...ROLES.REPORTS), (req, res) => {
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
router.get('/payments', requireRole(...ROLES.REPORTS), (req, res) => {
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

// ── Timesheets report (hours + labor cost) ──────────────────────────────────
router.get('/timesheets', requireRole(...ROLES.REPORTS), (req, res) => {
  const { locId } = scope(req); const { start, end } = dateRange(req);
  const conds = ['date(t.clock_in)>=?', 'date(t.clock_in)<=?'], args = [start, end];
  if (locId) { conds.push('t.location_id=?'); args.push(locId); }
  const byStaff = db.prepare(`SELECT u.name, u.role, l.name location, COUNT(*) shifts, ROUND(SUM(t.hours),1) hours,
    u.hourly_rate, ROUND(SUM(t.hours)*u.hourly_rate,2) labor_cost
    FROM timesheets t JOIN users u ON t.user_id=u.id LEFT JOIN locations l ON t.location_id=l.id
    WHERE ${conds.join(' AND ')} GROUP BY t.user_id ORDER BY hours DESC`).all(...args);
  const tot = byStaff.reduce((a, r) => ({ hours: a.hours + r.hours, labor: a.labor + r.labor_cost }), { hours: 0, labor: 0 });
  res.json({ start, end, total_hours: Math.round(tot.hours * 10) / 10, total_labor_cost: Math.round(tot.labor * 100) / 100,
    headcount: byStaff.length, by_staff: byStaff });
});

// ── Analytics report (executive summary) ────────────────────────────────────
router.get('/analytics', requireRole(...ROLES.REPORTS), (req, res) => {
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
  const tconds = ['date(t.clock_in)>=?', 'date(t.clock_in)<=?'], targs = [start, end];
  if (locId) { tconds.push('t.location_id=?'); targs.push(locId); }
  const labor = db.prepare(`SELECT ROUND(COALESCE(SUM(t.hours*u.hourly_rate),0),2) cost FROM timesheets t
    JOIN users u ON t.user_id=u.id WHERE ${tconds.join(' AND ')}`).get(...targs).cost;
  // Menu food-cost % (average across priced items; menu is global)
  const costs = {}; db.prepare(`SELECT item_name, AVG(unit_cost) c FROM inventory WHERE is_active=1 GROUP BY item_name`).all().forEach(r => costs[r.item_name] = r.c || 0);
  const fps = [];
  db.prepare(`SELECT id, price FROM menu_items WHERE is_active=1 AND price>0`).all().forEach(it => {
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

module.exports = router;
