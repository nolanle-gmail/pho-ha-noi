// Menu & Recipes module. Menu items belong to categories; each item has a
// recipe (inventory ingredients + per-serving quantity). Costing multiplies
// recipe quantities by each ingredient's average inventory unit cost.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES } = require('../lib/auth');
const { auditLog } = require('../lib/audit');

const router = express.Router();
router.use(verifyToken);

// Average inventory unit cost per ingredient name (across active locations).
function ingredientCosts() {
  const rows = db.prepare(`
    SELECT item_name, ROUND(AVG(unit_cost), 4) AS avg_cost, MAX(unit) AS unit
    FROM inventory WHERE is_active=1 GROUP BY item_name
  `).all();
  const map = {};
  rows.forEach(r => { map[r.item_name] = { avg_cost: r.avg_cost || 0, unit: r.unit || '' }; });
  return map;
}

function withCost(item, costs) {
  const ings = db.prepare(`SELECT item_name, quantity FROM recipe_ingredients WHERE menu_item_id=?`).all(item.id);
  const cost = ings.reduce((s, i) => s + i.quantity * ((costs[i.item_name] || {}).avg_cost || 0), 0);
  return {
    ...item,
    recipe_cost: Math.round(cost * 100) / 100,
    food_cost_pct: item.price > 0 ? Math.round((cost / item.price) * 1000) / 10 : null,
    margin: Math.round((item.price - cost) * 100) / 100,
    ingredient_count: ings.length,
  };
}

// ── Categories ──────────────────────────────────────────────────────────────
router.get('/categories', requireRole(ROLES.MANAGE), (req, res) => {
  res.json(db.prepare(`SELECT * FROM menu_categories ORDER BY sort_order, name`).all());
});
router.post('/categories', requireRole(ROLES.MANAGE), (req, res) => {
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Category name required.' });
  const r = db.prepare(`INSERT INTO menu_categories (name, sort_order) VALUES (?,?)`).run(name, parseInt(req.body.sort_order) || 0);
  res.json({ success: true, id: r.lastInsertRowid });
});

// Ingredient picker — distinct inventory items with average cost + unit.
router.get('/ingredients', requireRole(ROLES.MANAGE), (req, res) => {
  const costs = ingredientCosts();
  res.json(Object.entries(costs)
    .map(([item_name, c]) => ({ item_name, unit: c.unit, avg_cost: c.avg_cost }))
    .sort((a, b) => a.item_name.localeCompare(b.item_name)));
});

// ── Menu items ──────────────────────────────────────────────────────────────
router.get('/items', requireRole(ROLES.MANAGE), (req, res) => {
  const costs = ingredientCosts();
  const rows = db.prepare(`
    SELECT m.*, c.name AS category_name, c.sort_order AS cat_sort
    FROM menu_items m LEFT JOIN menu_categories c ON m.category_id=c.id
    ORDER BY c.sort_order, m.name
  `).all();
  res.json(rows.map(r => withCost(r, costs)));
});

router.post('/items', requireRole(ROLES.MANAGE), (req, res) => {
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Item name required.' });
  const r = db.prepare(`INSERT INTO menu_items (category_id, name, description, price) VALUES (?,?,?,?)`)
    .run(req.body.category_id || null, name, req.body.description || null, Math.max(0, parseFloat(req.body.price) || 0));
  auditLog(req, 'menu_item_create', 'menu', r.lastInsertRowid, { name });
  res.json({ success: true, id: r.lastInsertRowid });
});

router.put('/items/:id', requireRole(ROLES.MANAGE), (req, res) => {
  const it = db.prepare(`SELECT * FROM menu_items WHERE id=?`).get(req.params.id);
  if (!it) return res.status(404).json({ error: 'Menu item not found' });
  const fields = [], vals = [];
  ['name', 'description'].forEach(k => { if (req.body[k] !== undefined) { fields.push(`${k}=?`); vals.push(req.body[k] || null); } });
  if (req.body.category_id !== undefined) { fields.push('category_id=?'); vals.push(req.body.category_id || null); }
  if (req.body.price !== undefined) { fields.push('price=?'); vals.push(Math.max(0, parseFloat(req.body.price) || 0)); }
  if (req.body.is_active !== undefined) { fields.push('is_active=?'); vals.push(req.body.is_active ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(it.id);
  db.prepare(`UPDATE menu_items SET ${fields.join(',')} WHERE id=?`).run(...vals);
  auditLog(req, 'menu_item_update', 'menu', it.id, { name: it.name });
  res.json({ success: true });
});

router.delete('/items/:id', requireRole(ROLES.MANAGE), (req, res) => {
  const it = db.prepare(`SELECT * FROM menu_items WHERE id=?`).get(req.params.id);
  if (!it) return res.status(404).json({ error: 'Menu item not found' });
  db.prepare(`DELETE FROM recipe_ingredients WHERE menu_item_id=?`).run(it.id);
  db.prepare(`DELETE FROM menu_items WHERE id=?`).run(it.id);
  auditLog(req, 'menu_item_delete', 'menu', it.id, { name: it.name });
  res.json({ success: true });
});

// ── Recipe for one item ─────────────────────────────────────────────────────
router.get('/items/:id/recipe', requireRole(ROLES.MANAGE), (req, res) => {
  const it = db.prepare(`SELECT * FROM menu_items WHERE id=?`).get(req.params.id);
  if (!it) return res.status(404).json({ error: 'Menu item not found' });
  const costs = ingredientCosts();
  const ings = db.prepare(`SELECT id, item_name, quantity FROM recipe_ingredients WHERE menu_item_id=? ORDER BY id`).all(it.id).map(i => {
    const c = costs[i.item_name] || { avg_cost: 0, unit: '' };
    return { ...i, unit: c.unit, unit_cost: c.avg_cost, line_cost: Math.round(i.quantity * c.avg_cost * 100) / 100 };
  });
  const cost = ings.reduce((s, i) => s + i.line_cost, 0);
  res.json({
    item: { id: it.id, name: it.name, price: it.price },
    ingredients: ings,
    recipe_cost: Math.round(cost * 100) / 100,
    food_cost_pct: it.price > 0 ? Math.round((cost / it.price) * 1000) / 10 : null,
    margin: Math.round((it.price - cost) * 100) / 100,
  });
});

// Replace a recipe's ingredient list.
router.put('/items/:id/recipe', requireRole(ROLES.MANAGE), (req, res) => {
  const it = db.prepare(`SELECT * FROM menu_items WHERE id=?`).get(req.params.id);
  if (!it) return res.status(404).json({ error: 'Menu item not found' });
  const ings = Array.isArray(req.body.ingredients) ? req.body.ingredients : [];
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM recipe_ingredients WHERE menu_item_id=?`).run(it.id);
    const ins = db.prepare(`INSERT INTO recipe_ingredients (menu_item_id, item_name, quantity) VALUES (?,?,?)`);
    ings.forEach(i => { const q = parseFloat(i.quantity) || 0; if (i.item_name && q > 0) ins.run(it.id, String(i.item_name), q); });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  auditLog(req, 'recipe_update', 'menu', it.id, { item: it.name, count: ings.length });
  res.json({ success: true });
});

// ── Costing report ──────────────────────────────────────────────────────────
router.get('/costing', requireRole(ROLES.MANAGE), (req, res) => {
  const costs = ingredientCosts();
  const rows = db.prepare(`
    SELECT m.*, c.name AS category_name FROM menu_items m LEFT JOIN menu_categories c ON m.category_id=c.id
    WHERE m.is_active=1 ORDER BY c.sort_order, m.name
  `).all().map(r => withCost(r, costs));
  const priced = rows.filter(r => r.price > 0 && r.recipe_cost > 0 && r.food_cost_pct != null);
  const avgFood = priced.length ? Math.round(priced.reduce((s, r) => s + r.food_cost_pct, 0) / priced.length * 10) / 10 : null;
  res.json({ items: rows, avg_food_cost_pct: avgFood, priced_count: priced.length });
});

module.exports = router;
