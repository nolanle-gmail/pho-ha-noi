// Central Kitchen — production & supply hub. Aggregates store demand, scales
// master-recipe batches with yield/shrinkage control, plans production against
// safety stock, generates fulfillment pick-lists/manifests, and runs CK HR
// (staff, tasks, schedule, PIN time clock). Owner/admin only.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES } = require('../lib/auth');
const { auditLog } = require('../lib/audit');

const router = express.Router();
router.use(verifyToken);
const A = ROLES.ADMIN; // owner/admin

const today = () => new Date().toISOString().slice(0, 10);
function ckLoc() { return db.prepare(`SELECT * FROM locations WHERE type='central_kitchen' LIMIT 1`).get(); }
function ingredientCosts() {
  const map = {};
  db.prepare(`SELECT item_name, ROUND(AVG(unit_cost),4) c FROM inventory WHERE is_active=1 GROUP BY item_name`).all()
    .forEach(r => map[r.item_name] = r.c || 0);
  return map;
}
// Usable output per batch after shrinkage.
const usablePerBatch = (p) => p.batch_yield * (1 - p.shrinkage_pct);

// Product with recipe + per-batch cost.
function productDetail(p, costs) {
  const ings = db.prepare(`SELECT item_name, quantity FROM ck_recipe_ingredients WHERE product_id=?`).all(p.id);
  const batchCost = ings.reduce((s, i) => s + i.quantity * (costs[i.item_name] || 0), 0);
  return { ...p, ingredients: ings, batch_cost: Math.round(batchCost * 100) / 100, usable_per_batch: Math.round(usablePerBatch(p) * 100) / 100 };
}

// ── Overview ─────────────────────────────────────────────────────────────────
router.get('/summary', requireRole(...A), (req, res) => {
  const ck = ckLoc();
  const products = db.prepare(`SELECT COUNT(*) c FROM ck_products`).get().c;
  const low = db.prepare(`SELECT COUNT(*) c FROM ck_products WHERE on_hand < safety_stock`).get().c;
  const pending = db.prepare(`SELECT COUNT(DISTINCT location_id) c FROM store_requests WHERE request_date=? AND status='requested'`).get(today()).c;
  const producedToday = db.prepare(`SELECT COUNT(*) c FROM ck_production_runs WHERE date(produced_at)=date('now')`).get().c;
  const staff = ck ? db.prepare(`SELECT COUNT(*) c FROM users WHERE location_id=? AND is_active=1`).get(ck.id).c : 0;
  const openTasks = db.prepare(`SELECT COUNT(*) c FROM ck_tasks WHERE status='assigned'`).get().c;
  res.json({ location: ck, products, low_stock: low, pending_stores: pending, produced_today: producedToday, staff, open_tasks: openTasks });
});

// ── 1. Demand aggregation ────────────────────────────────────────────────────
router.get('/demand', requireRole(...A), (req, res) => {
  const date = req.query.date || today();
  const products = db.prepare(`
    SELECT p.id, p.name, p.unit, p.on_hand, p.safety_stock,
           COALESCE(SUM(sr.quantity),0) AS total_requested,
           COUNT(DISTINCT sr.location_id) AS store_count
    FROM ck_products p
    LEFT JOIN store_requests sr ON sr.product_id=p.id AND sr.request_date=?
    GROUP BY p.id ORDER BY total_requested DESC, p.name
  `).all(date);
  const withStores = products.map(p => ({
    ...p,
    by_store: db.prepare(`SELECT l.name location, sr.quantity FROM store_requests sr JOIN locations l ON sr.location_id=l.id
      WHERE sr.product_id=? AND sr.request_date=? ORDER BY sr.quantity DESC`).all(p.id, date),
  }));
  res.json({ date, products: withStores });
});

// ── 2. Products / master recipes ─────────────────────────────────────────────
router.get('/products', requireRole(...A), (req, res) => {
  const costs = ingredientCosts();
  res.json(db.prepare(`SELECT * FROM ck_products ORDER BY name`).all().map(p => productDetail(p, costs)));
});
router.get('/ingredients', requireRole(...A), (req, res) => {
  const costs = ingredientCosts();
  res.json(Object.keys(costs).sort().map(name => ({ item_name: name, avg_cost: costs[name] })));
});
router.put('/products/:id/recipe', requireRole(...A), (req, res) => {
  const p = db.prepare(`SELECT * FROM ck_products WHERE id=?`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const ings = Array.isArray(req.body.ingredients) ? req.body.ingredients : [];
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM ck_recipe_ingredients WHERE product_id=?`).run(p.id);
    const ins = db.prepare(`INSERT INTO ck_recipe_ingredients (product_id,item_name,quantity) VALUES (?,?,?)`);
    ings.forEach(i => { const q = parseFloat(i.quantity) || 0; if (i.item_name && q > 0) ins.run(p.id, String(i.item_name), q); });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ success: true });
});

// ── 3. Batch planning (scaling + yield + low-stock alerts) ───────────────────
router.get('/batch-plan', requireRole(...A), (req, res) => {
  const date = req.query.date || today();
  const costs = ingredientCosts();
  const products = db.prepare(`SELECT * FROM ck_products`).all();
  const sheets = [];
  for (const p of products) {
    const demand = db.prepare(`SELECT COALESCE(SUM(quantity),0) q FROM store_requests WHERE product_id=? AND request_date=? AND status='requested'`).get(p.id, date).q;
    // Produce enough to cover demand and restore safety stock, net of what's on hand.
    const target = Math.max(demand, p.safety_stock);
    const need = Math.max(0, target - p.on_hand);
    const usable = usablePerBatch(p);
    const batches = need > 0 && usable > 0 ? Math.ceil(need / usable) : 0;
    const grossOutput = Math.round(batches * p.batch_yield * 100) / 100;
    const usableOutput = Math.round(batches * usable * 100) / 100;
    const shrinkLoss = Math.round((grossOutput - usableOutput) * 100) / 100;
    const ings = db.prepare(`SELECT item_name, quantity FROM ck_recipe_ingredients WHERE product_id=?`).all(p.id)
      .map(i => ({ item_name: i.item_name, per_batch: i.quantity, total: Math.round(i.quantity * batches * 1000) / 1000, cost: Math.round(i.quantity * batches * (costs[i.item_name] || 0) * 100) / 100 }));
    const batchCost = ings.reduce((s, i) => s + i.cost, 0);
    sheets.push({
      product_id: p.id, name: p.name, unit: p.unit, on_hand: p.on_hand, safety_stock: p.safety_stock,
      demand, low_stock: p.on_hand < p.safety_stock, batches, gross_output: grossOutput, usable_output: usableOutput,
      shrinkage_loss: shrinkLoss, shrinkage_pct: p.shrinkage_pct, ingredients: ings, est_cost: Math.round(batchCost * 100) / 100,
    });
  }
  const alerts = sheets.filter(s => s.low_stock).map(s => ({ name: s.name, on_hand: s.on_hand, safety_stock: s.safety_stock, unit: s.unit }));
  res.json({ date, sheets: sheets.sort((a, b) => b.batches - a.batches), alerts });
});

// Record a production run (updates on-hand, logs yield/shrinkage).
router.post('/production', requireRole(...A), (req, res) => {
  const p = db.prepare(`SELECT * FROM ck_products WHERE id=?`).get(req.body.product_id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const batches = Math.max(0, parseFloat(req.body.batches) || 0);
  if (batches <= 0) return res.status(400).json({ error: 'Batches must be greater than 0.' });
  const planned = Math.round(batches * usablePerBatch(p) * 100) / 100;
  const actual = req.body.actual_output != null && req.body.actual_output !== '' ? Math.max(0, parseFloat(req.body.actual_output)) : planned;
  const gross = batches * p.batch_yield;
  const loss = Math.round((gross - actual) * 100) / 100;
  db.prepare(`INSERT INTO ck_production_runs (product_id,batches,planned_output,actual_output,shrinkage_loss,produced_by) VALUES (?,?,?,?,?,?)`)
    .run(p.id, batches, planned, actual, loss, req.user.id);
  db.prepare(`UPDATE ck_products SET on_hand = on_hand + ? WHERE id=?`).run(actual, p.id);
  auditLog(req, 'ck_production', 'ck_product', p.id, { product: p.name, batches, actual });
  res.json({ success: true, produced: actual });
});
router.get('/production', requireRole(...A), (req, res) => {
  res.json(db.prepare(`SELECT r.*, p.name product_name, p.unit, u.name produced_by_name
    FROM ck_production_runs r JOIN ck_products p ON r.product_id=p.id LEFT JOIN users u ON r.produced_by=u.id
    ORDER BY r.produced_at DESC LIMIT 50`).all());
});

// ── 4. Fulfillment & logistics ───────────────────────────────────────────────
// Delivery routes group stores for the trucks servicing them.
const ROUTES = {
  'North Bay': ['Berkeley', 'Oakland'],
  'Peninsula': ['Palo Alto', 'Fremont'],
  'South Bay': ['San Jose', 'Santa Clara', 'Sunnyvale', 'Cupertino', 'Milpitas'],
  'SoCal': ['Fountain Valley'],
};
router.get('/fulfillment', requireRole(...A), (req, res) => {
  const date = req.query.date || today();
  const rows = db.prepare(`
    SELECT sr.location_id, l.name location, p.name product, p.unit, sr.quantity, sr.status
    FROM store_requests sr JOIN locations l ON sr.location_id=l.id JOIN ck_products p ON sr.product_id=p.id
    WHERE sr.request_date=? ORDER BY l.name, p.name`).all(date);
  const byStore = {};
  rows.forEach(r => {
    const key = r.location.replace('Pho Ha Noi — ', '');
    (byStore[key] = byStore[key] || { location_id: r.location_id, location: r.location, short: key, lines: [], status: 'fulfilled' }).lines.push({ product: r.product, unit: r.unit, quantity: r.quantity, status: r.status });
    if (r.status === 'requested') byStore[key].status = 'requested';
  });
  const stores = Object.values(byStore);
  // Total pick per product across all stores.
  const pickTotals = {};
  rows.forEach(r => { pickTotals[r.product] = (pickTotals[r.product] || { product: r.product, unit: r.unit, quantity: 0 }); pickTotals[r.product].quantity += r.quantity; });
  // Manifests grouped by delivery route.
  const manifests = Object.entries(ROUTES).map(([route, cities]) => ({
    route, stops: stores.filter(s => cities.includes(s.short)),
  })).filter(m => m.stops.length);
  res.json({ date, stores, pick_list: Object.values(pickTotals).sort((a, b) => a.product.localeCompare(b.product)), manifests });
});
router.post('/fulfill/:locationId', requireRole(...A), (req, res) => {
  const date = req.body.date || today();
  const reqs = db.prepare(`SELECT sr.*, p.on_hand FROM store_requests sr JOIN ck_products p ON sr.product_id=p.id
    WHERE sr.location_id=? AND sr.request_date=? AND sr.status='requested'`).all(req.params.locationId, date);
  if (!reqs.length) return res.status(400).json({ error: 'Nothing to fulfill for this store.' });
  reqs.forEach(r => {
    db.prepare(`UPDATE store_requests SET status='fulfilled' WHERE id=?`).run(r.id);
    db.prepare(`UPDATE ck_products SET on_hand = MAX(0, on_hand - ?) WHERE id=?`).run(r.quantity, r.product_id);
  });
  auditLog(req, 'ck_fulfill', 'location', Number(req.params.locationId), { lines: reqs.length });
  res.json({ success: true, fulfilled: reqs.length });
});

// ── 5. CK HR: staff, tasks, schedule, PIN time clock ─────────────────────────
router.get('/staff', requireRole(...A), (req, res) => {
  const ck = ckLoc(); if (!ck) return res.json([]);
  res.json(db.prepare(`SELECT id, name, email, role, hourly_rate, (pin IS NOT NULL) AS has_pin, is_active
    FROM users WHERE location_id=? AND is_active=1 ORDER BY CASE role WHEN 'manager' THEN 0 WHEN 'support' THEN 1 ELSE 2 END, name`).all(ck.id));
});
router.get('/tasks', requireRole(...A), (req, res) => {
  res.json(db.prepare(`SELECT t.*, u.name assigned_name FROM ck_tasks t LEFT JOIN users u ON t.assigned_to=u.id
    ORDER BY t.status, t.due, t.id DESC LIMIT 100`).all());
});
router.post('/tasks', requireRole(...A), (req, res) => {
  const title = (req.body.title || '').toString().trim();
  if (!title) return res.status(400).json({ error: 'Task title required.' });
  const r = db.prepare(`INSERT INTO ck_tasks (title, assigned_to, requires_photo, due) VALUES (?,?,?,?)`)
    .run(title, req.body.assigned_to || null, req.body.requires_photo ? 1 : 0, req.body.due || null);
  res.json({ success: true, id: r.lastInsertRowid });
});
router.put('/tasks/:id/complete', requireRole(...A), (req, res) => {
  const t = db.prepare(`SELECT * FROM ck_tasks WHERE id=?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (t.requires_photo && !req.body.photo_url) return res.status(400).json({ error: 'This task requires a verification photo.' });
  db.prepare(`UPDATE ck_tasks SET status='done', photo_url=?, completed_at=datetime('now') WHERE id=?`).run(req.body.photo_url || null, t.id);
  res.json({ success: true });
});
router.get('/schedule', requireRole(...A), (req, res) => {
  const start = req.query.week_start || today();
  res.json(db.prepare(`SELECT s.*, u.name FROM ck_shifts s JOIN users u ON s.user_id=u.id
    WHERE s.shift_date >= ? AND s.shift_date < date(?, '+7 days') ORDER BY s.shift_date, s.start_time`).all(start, start));
});
router.post('/schedule', requireRole(...A), (req, res) => {
  const { user_id, shift_date, start_time, end_time } = req.body || {};
  if (!user_id || !shift_date) return res.status(400).json({ error: 'Staff and date required.' });
  const r = db.prepare(`INSERT INTO ck_shifts (user_id, shift_date, start_time, end_time) VALUES (?,?,?,?)`).run(user_id, shift_date, start_time || null, end_time || null);
  res.json({ success: true, id: r.lastInsertRowid });
});

// PIN time clock (represents a terminal): clock in, or clock out an open shift.
router.post('/clock', requireRole(...A), (req, res) => {
  const ck = ckLoc(); if (!ck) return res.status(400).json({ error: 'No central kitchen configured.' });
  const pin = (req.body.pin || '').toString().trim();
  const u = db.prepare(`SELECT * FROM users WHERE pin=? AND location_id=? AND is_active=1`).get(pin, ck.id);
  if (!u) return res.status(404).json({ error: 'PIN not recognized.' });
  const open = db.prepare(`SELECT * FROM timesheets WHERE user_id=? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`).get(u.id);
  if (open) {
    const hrs = Math.round((Date.now() - new Date(open.clock_in.replace(' ', 'T') + 'Z').getTime()) / 36e5 * 100) / 100;
    db.prepare(`UPDATE timesheets SET clock_out=datetime('now'), hours=? WHERE id=?`).run(Math.max(0, hrs), open.id);
    return res.json({ success: true, action: 'clock_out', name: u.name, hours: Math.max(0, hrs) });
  }
  db.prepare(`INSERT INTO timesheets (user_id, location_id, clock_in) VALUES (?,?, datetime('now'))`).run(u.id, ck.id);
  res.json({ success: true, action: 'clock_in', name: u.name });
});
router.get('/timeclock', requireRole(...A), (req, res) => {
  const ck = ckLoc(); if (!ck) return res.json([]);
  res.json(db.prepare(`SELECT t.id, u.name, t.clock_in, t.clock_out, t.hours FROM timesheets t JOIN users u ON t.user_id=u.id
    WHERE t.location_id=? ORDER BY t.clock_in DESC LIMIT 30`).all(ck.id));
});

module.exports = router;
