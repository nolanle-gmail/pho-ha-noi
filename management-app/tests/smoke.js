// End-to-end smoke test for the inventory API. Starts the app on a test port
// and exercises the main flows. Run: node tests/smoke.js
process.env.DB_PATH = process.env.DB_PATH || require('path').join(__dirname, '..', 'db', 'phohanoi_management.db');
const app = require('../server');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  ' + detail); }
};

(async () => {
  const server = app.listen(4099);
  const base = 'http://localhost:4099';
  const H = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  const j = (r) => r.json();

  try {
    // Login
    let r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'harry@phohanoi.com', password: 'Harry123!' }) });
    check('owner login', r.status === 200);
    const { token } = await j(r);
    check('got token', !!token);

    r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'harry@phohanoi.com', password: 'wrong' }) });
    check('bad password rejected', r.status === 401);

    // Locations
    const locs = await j(await fetch(base + '/api/inventory/locations', { headers: H(token) }));
    check('ten locations', locs.length === 10, JSON.stringify(locs.length));
    // Resolve by name — /locations returns alphabetical order, not seed order.
    const byName = Object.fromEntries(locs.map(l => [l.name, l.id]));
    const loc1 = byName['Pho Ha Noi — San Jose'];    // full stock, has manager1
    const loc2 = byName['Pho Ha Noi — Milpitas'];     // seeded below-min items

    // Dashboard
    const dash = await j(await fetch(base + `/api/inventory/dashboard?location_id=${loc1}`, { headers: H(token) }));
    check('dashboard totals', dash.item_count >= 48 && dash.total_value > 0, JSON.stringify(dash));

    // Stock levels
    const stock = await j(await fetch(base + `/api/inventory/?location_id=${loc1}`, { headers: H(token) }));
    check('stock list', stock.length >= 48);
    const beef = stock.find(s => s.item_name === 'Beef Brisket');
    check('has Beef Brisket', !!beef);

    // Create a new item
    r = await fetch(base + '/api/inventory/', { method: 'POST', headers: H(token),
      body: JSON.stringify({ location_id: loc1, item_name: 'Test Chili Oil', category: 'Pantry', unit: 'bottle', quantity: 10, min_quantity: 4, par_level: 20, unit_cost: 3.5 }) });
    check('create item', r.status === 200, await r.text());

    // Receive by item_id (adds a lot)
    r = await fetch(base + '/api/inventory/receive', { method: 'POST', headers: H(token),
      body: JSON.stringify({ item_id: beef.id, quantity: 20, expiry_date: '2030-01-01', lot_code: 'SMOKE1' }) });
    check('receive stock', r.status === 200, await r.text());

    // Waste
    r = await fetch(base + '/api/inventory/waste', { method: 'POST', headers: H(token),
      body: JSON.stringify({ item_id: beef.id, quantity: 2, reason: 'trim loss' }) });
    check('log waste', r.status === 200, await r.text());

    // Cycle count
    r = await fetch(base + '/api/inventory/count', { method: 'POST', headers: H(token),
      body: JSON.stringify({ item_id: beef.id, counted_quantity: 100 }) });
    const cc = await j(r);
    check('cycle count variance', r.status === 200 && 'variance' in cc, JSON.stringify(cc));

    // Vendors
    const vendors = await j(await fetch(base + '/api/inventory/vendors', { headers: H(token) }));
    check('vendors seeded', vendors.length >= 4);

    // Reorder suggestions (loc2 has forced-low items)
    const sugg = await j(await fetch(base + `/api/inventory/reorder-suggestions?location_id=${loc2}`, { headers: H(token) }));
    check('reorder suggestions', Array.isArray(sugg) && sugg.length >= 1, JSON.stringify(sugg.length));

    // Create PO from suggestions
    r = await fetch(base + '/api/inventory/reorder/create', { method: 'POST', headers: H(token),
      body: JSON.stringify({ location_id: loc2, items: sugg.slice(0, 2).map(s => ({ item_id: s.id, quantity: s.suggested_qty })) }) });
    check('create reorder PO', r.status === 200, await r.text());

    // Supply orders list + receive one
    const orders = await j(await fetch(base + `/api/inventory/supply-orders?location_id=${loc2}`, { headers: H(token) }));
    check('supply orders exist', orders.length >= 1);
    const pending = orders.find(o => o.status === 'pending');
    if (pending) {
      r = await fetch(base + `/api/inventory/order/${pending.id}`, { method: 'PUT', headers: H(token), body: JSON.stringify({ status: 'received' }) });
      check('receive PO -> stock', r.status === 200, await r.text());
    } else check('receive PO -> stock', false, 'no pending order');

    // Direct transfer loc1 -> loc2
    r = await fetch(base + '/api/inventory/transfer', { method: 'POST', headers: H(token),
      body: JSON.stringify({ item_id: beef.id, from_location_id: loc1, to_location_id: loc2, quantity: 5 }) });
    check('direct transfer', r.status === 200, await r.text());

    // Transactions ledger
    const txns = await j(await fetch(base + `/api/inventory/transactions?location_id=${loc1}`, { headers: H(token) }));
    check('transaction ledger', txns.length >= 3);

    // Lots + expiring
    const lots = await j(await fetch(base + `/api/inventory/lots?location_id=${loc1}`, { headers: H(token) }));
    check('active lots', lots.length >= 1);
    const exp = await j(await fetch(base + `/api/inventory/expiring?location_id=${loc1}&days=7`, { headers: H(token) }));
    check('expiring view', 'expired' in exp && Array.isArray(exp.lots), JSON.stringify(Object.keys(exp)));
    check('has expired lot', exp.expired >= 1, 'expired=' + exp.expired);

    // Discard the expired lot
    const expiredLot = exp.lots.find(l => l.days_left < 0);
    if (expiredLot) {
      r = await fetch(base + `/api/inventory/lots/${expiredLot.id}/discard`, { method: 'POST', headers: H(token), body: JSON.stringify({ reason: 'expired' }) });
      check('discard expired lot', r.status === 200, await r.text());
    } else check('discard expired lot', false, 'no expired lot found');

    // Valuation
    const val = await j(await fetch(base + `/api/inventory/valuation?location_id=${loc1}`, { headers: H(token) }));
    check('valuation + COGS', val.total_value > 0 && Array.isArray(val.by_category), JSON.stringify(val).slice(0, 80));

    // Warehouse view
    const wh = await j(await fetch(base + '/api/inventory/warehouse', { headers: H(token) }));
    check('warehouse view', wh.locations.length === 10 && wh.items.length >= 48, 'locs=' + wh.locations.length);

    // ── Glossary: descriptions/notes, edit, delete ─────────────
    const glossary = await j(await fetch(base + `/api/inventory/?location_id=${loc1}`, { headers: H(token) }));
    check('glossary items have descriptions', glossary.some(i => i.description), 'no descriptions');
    const fish = glossary.find(i => i.item_name === 'Fish Sauce');
    check('item carries notes', fish && !!fish.notes, JSON.stringify(fish && fish.notes));

    r = await fetch(base + '/api/inventory/' + fish.id, { method: 'PUT', headers: H(token), body: JSON.stringify({ description: 'Updated desc', notes: 'Updated note' }) });
    check('edit item desc/notes', r.status === 200, await r.text());
    const after = (await j(await fetch(base + `/api/inventory/?location_id=${loc1}`, { headers: H(token) }))).find(i => i.id === fish.id);
    check('desc/notes persisted', after.description === 'Updated desc' && after.notes === 'Updated note', JSON.stringify(after.description));

    // Soft-delete: create a throwaway item then remove it
    const tmp = await j(await fetch(base + '/api/inventory/', { method: 'POST', headers: H(token), body: JSON.stringify({ location_id: loc1, item_name: 'Delete Me', category: 'Other', unit: 'each' }) }));
    r = await fetch(base + '/api/inventory/' + tmp.id, { method: 'DELETE', headers: H(token) });
    check('remove item (soft delete)', r.status === 200, await r.text());
    const stillThere = (await j(await fetch(base + `/api/inventory/?location_id=${loc1}`, { headers: H(token) }))).some(i => i.id === tmp.id);
    check('removed item hidden from glossary', !stillThere);

    // ── Order from an item (as from stock/glossary) ────────────
    r = await fetch(base + '/api/inventory/order', { method: 'POST', headers: H(token), body: JSON.stringify({ location_id: loc1, item_id: beef.id, quantity: 40, vendor_id: vendors[0].id, notes: 'from stock hover' }) });
    check('create order for existing item', r.status === 200, await r.text());

    // Order with a brand-new item (create item then order)
    const newItem = await j(await fetch(base + '/api/inventory/', { method: 'POST', headers: H(token), body: JSON.stringify({ location_id: loc1, item_name: 'Chili Oil', category: 'Pantry', unit: 'bottle', unit_cost: 3.5, quantity: 0, min_quantity: 0 }) }));
    r = await fetch(base + '/api/inventory/order', { method: 'POST', headers: H(token), body: JSON.stringify({ location_id: loc1, item_id: newItem.id, quantity: 24 }) });
    check('order a newly-added item', r.status === 200, await r.text());

    // ── Audit: who did what ────────────────────────────────────
    const audit = await j(await fetch(base + '/api/inventory/audit', { headers: H(token) }));
    check('audit log populated', Array.isArray(audit) && audit.length >= 5, 'len=' + (audit && audit.length));
    check('audit records order_create', audit.some(a => a.action === 'order_create'), 'no order_create');
    check('audit records the actor', audit.every(a => 'user_name' in a) && audit.some(a => a.user_name === 'Harry Nguyen'), 'no user_name');
    check('audit records receive', audit.some(a => a.action === 'stock_received'), 'no stock_received');
    check('audit records transfer', audit.some(a => a.action === 'transfer'), 'no transfer');

    // ── Menu & Recipes module ──────────────────────────────────
    const cats = await j(await fetch(base + '/api/menu/categories', { headers: H(token) }));
    check('menu categories seeded', cats.length >= 4, 'len=' + cats.length);
    const menuItems = await j(await fetch(base + '/api/menu/items', { headers: H(token) }));
    check('menu items seeded', menuItems.length >= 8, 'len=' + menuItems.length);
    const pho = menuItems.find(m => m.name.includes('Đặc Biệt')) || menuItems[0];
    check('menu item has recipe cost + food %', pho.recipe_cost > 0 && pho.food_cost_pct > 0, JSON.stringify({ c: pho.recipe_cost, p: pho.food_cost_pct }));

    const ings = await j(await fetch(base + '/api/menu/ingredients', { headers: H(token) }));
    check('ingredient picker from inventory', Array.isArray(ings) && ings.length >= 40, 'len=' + (ings && ings.length));

    const recipe = await j(await fetch(base + `/api/menu/items/${pho.id}/recipe`, { headers: H(token) }));
    check('recipe returns ingredients + cost', recipe.ingredients.length >= 3 && recipe.recipe_cost > 0, JSON.stringify(recipe.recipe_cost));

    // Create an item, set a recipe, verify costing reflects it
    const created = await j(await fetch(base + '/api/menu/items', { method: 'POST', headers: H(token),
      body: JSON.stringify({ category_id: cats[0].id, name: 'Test Bowl', price: 10 }) }));
    r = await fetch(base + `/api/menu/items/${created.id}/recipe`, { method: 'PUT', headers: H(token),
      body: JSON.stringify({ ingredients: [{ item_name: 'Rice Noodles (bánh phở)', quantity: 0.5 }, { item_name: 'Beef Brisket', quantity: 0.3 }] }) });
    check('set recipe', r.status === 200, await r.text());
    const rc = await j(await fetch(base + `/api/menu/items/${created.id}/recipe`, { headers: H(token) }));
    check('recipe cost computed from inventory', rc.recipe_cost > 0 && rc.ingredients.length === 2, JSON.stringify(rc.recipe_cost));

    const costing = await j(await fetch(base + '/api/menu/costing', { headers: H(token) }));
    check('costing report', costing.items.length >= 8 && costing.avg_food_cost_pct > 0, JSON.stringify(costing.avg_food_cost_pct));

    // RBAC: employee cannot access menu module (owner/admin/manager only)
    const emp = await j(await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'employee@phohanoi.com', password: 'Employee123!' }) }));
    r = await fetch(base + '/api/menu/items', { headers: H(emp.token) });
    check('employee BLOCKED from menu (403)', r.status === 403, 'status=' + r.status);

    // RBAC: manager sees only their location
    const mgr = await j(await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'manager1@phohanoi.com', password: 'Manager123!' }) }));
    r = await fetch(base + '/api/inventory/', { headers: H(mgr.token) });
    const mgrStock = await j(r);
    check('manager sees only their location', mgrStock.every(s => s.location_id === loc1), 'mixed locations');
    // manager CAN access the menu module
    r = await fetch(base + '/api/menu/items', { headers: H(mgr.token) });
    check('manager can access menu (200)', r.status === 200, 'status=' + r.status);

    // ── Staff management ───────────────────────────────────────
    const newStaff = await j(await fetch(base + '/api/staff', { method: 'POST', headers: H(token),
      body: JSON.stringify({ name: 'Test Support', email: 'teststaff@phohanoi.com', password: 'TestPass123!', role: 'support', location_id: loc1 }) }));
    check('create staff account', newStaff.success === true && !!newStaff.id, JSON.stringify(newStaff));
    r = await fetch(base + '/api/staff', { method: 'POST', headers: H(token),
      body: JSON.stringify({ name: 'Dup', email: 'teststaff@phohanoi.com', password: 'TestPass123!', role: 'employee', location_id: loc1 }) });
    check('duplicate email rejected (409)', r.status === 409, 'status=' + r.status);
    r = await fetch(base + '/api/staff', { method: 'POST', headers: H(token),
      body: JSON.stringify({ name: 'NoLoc', email: 'noloc@phohanoi.com', password: 'TestPass123!', role: 'employee' }) });
    check('non-admin role requires location (400)', r.status === 400, 'status=' + r.status);

    r = await fetch(base + `/api/staff/${newStaff.id}`, { method: 'PUT', headers: H(token), body: JSON.stringify({ name: 'Renamed Support', role: 'manager', location_id: loc1 }) });
    check('edit staff (name + role)', r.status === 200, await r.text());
    r = await fetch(base + `/api/staff/${newStaff.id}/reset-password`, { method: 'POST', headers: H(token), body: JSON.stringify({ new_password: 'ResetPass123!' }) });
    check('reset staff password', r.status === 200);
    const relog = await j(await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'teststaff@phohanoi.com', password: 'ResetPass123!' }) }));
    check('login with reset password', !!relog.token);

    r = await fetch(base + `/api/staff/${newStaff.id}`, { method: 'PUT', headers: H(token), body: JSON.stringify({ is_active: false }) });
    check('deactivate staff', r.status === 200);
    r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'teststaff@phohanoi.com', password: 'ResetPass123!' }) });
    check('deactivated account cannot log in (401)', r.status === 401, 'status=' + r.status);

    const meId = (await j(await fetch(base + '/api/auth/me', { headers: H(token) }))).id;
    r = await fetch(base + `/api/staff/${meId}`, { method: 'PUT', headers: H(token), body: JSON.stringify({ is_active: false }) });
    check('cannot deactivate self (400)', r.status === 400, 'status=' + r.status);

    const adminTok = (await j(await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@phohanoi.com', password: 'Admin123!' }) }))).token;
    r = await fetch(base + '/api/staff', { method: 'POST', headers: H(adminTok), body: JSON.stringify({ name: 'X', email: 'x@phohanoi.com', password: 'Password123!', role: 'owner' }) });
    check('admin cannot create owner (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + '/api/staff', { method: 'POST', headers: H(mgr.token), body: JSON.stringify({ name: 'Y', email: 'y@phohanoi.com', password: 'Password123!', role: 'employee', location_id: loc1 }) });
    check('manager cannot manage staff (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + '/api/staff', { headers: H(emp.token) });
    check('employee blocked from staff directory (403)', r.status === 403, 'status=' + r.status);
  } catch (e) {
    fail++; console.log('  FAIL  exception: ' + e.message);
  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
