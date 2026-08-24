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
    const staffList = await j(await fetch(base + '/api/staff', { headers: H(token) }));
    check('staff list exposes employee codes', Array.isArray(staffList) && staffList.length > 0 && staffList.every(s => 'employee_code' in s) && staffList.some(s => s.employee_code), JSON.stringify((staffList[0] || {}).employee_code));
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

    // ── Scheduling: job catalog ────────────────────────────────
    const jobs = await j(await fetch(base + '/api/schedule/jobs?active=1', { headers: H(token) }));
    check('job catalog seeded', Array.isArray(jobs) && jobs.length >= 20, 'count=' + (jobs || []).length);
    const jobIds = jobs.slice(0, 2).map(x => x.id);
    const newJob = await j(await fetch(base + '/api/schedule/jobs', { method: 'POST', headers: H(token),
      body: JSON.stringify({ code: 'TST-99', name: 'Smoke Test Task', department: 'Facilities', complexity: 'low', est_minutes: 10 }) }));
    check('create job (owner)', newJob.success === true && !!newJob.id, JSON.stringify(newJob));
    r = await fetch(base + '/api/schedule/jobs', { method: 'POST', headers: H(token), body: JSON.stringify({ code: 'TST-99', name: 'Dup Code' }) });
    check('duplicate Job ID rejected (409)', r.status === 409, 'status=' + r.status);
    const mgrJob = await j(await fetch(base + '/api/schedule/jobs', { method: 'POST', headers: H(mgr.token), body: JSON.stringify({ name: 'Mgr Job', department: 'Front of House' }) }));
    check('manager can add a job', mgrJob.success === true && !!mgrJob.id, JSON.stringify(mgrJob));
    // A day task (specific) requires an estimate; a standard job does not.
    r = await fetch(base + '/api/schedule/jobs', { method: 'POST', headers: H(mgr.token), body: JSON.stringify({ name: 'No-Est Task', department: 'Facilities', kind: 'specific' }) });
    check('specific task without est rejected (400)', r.status === 400, 'status=' + r.status);
    const taskJob = await j(await fetch(base + '/api/schedule/jobs', { method: 'POST', headers: H(mgr.token), body: JSON.stringify({ code: 'TST-EST', name: 'Est Task', department: 'Facilities', kind: 'specific', est_minutes: 15 }) }));
    check('specific task with est accepted', taskJob.success === true && !!taskJob.id, JSON.stringify(taskJob));
    r = await fetch(base + '/api/schedule/jobs/' + taskJob.id, { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ est_minutes: '' }) });
    check('cannot clear est on a specific task (400)', r.status === 400, 'status=' + r.status);
    r = await fetch(base + '/api/schedule/jobs', { headers: H(emp.token) });
    check('employee blocked from job catalog (403)', r.status === 403, 'status=' + r.status);

    // ── Scheduling: weekly shifts ──────────────────────────────
    const wk = await j(await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(mgr.token) }));
    check('manager gets weekly schedule', Array.isArray(wk.staff) && !!wk.week_start && wk.days.length === 7, JSON.stringify(wk).slice(0, 80));
    const schedStaff = wk.staff.find(s => s.role !== 'manager') || wk.staff[0];
    // Start this person's week from a clean slate so the break-cap checks are deterministic
    // regardless of the seed's random demo shifts. Use the owner token (scope = all) so
    // shifts at any location are removed — a leftover shift would change a day's total hours
    // and flip the ≤10h break cap. Re-fetch fresh so nothing is missed.
    {
      const fresh = await j(await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(token) }));
      const seeded = ((fresh.staff || []).find(s => s.id === schedStaff.id) || {}).shifts || [];
      for (const os of seeded) await fetch(base + `/api/schedule/shifts/${os.id}`, { method: 'DELETE', headers: H(token) });
    }
    const shiftRes = await j(await fetch(base + '/api/schedule/shifts', { method: 'POST', headers: H(mgr.token),
      body: JSON.stringify({ user_id: schedStaff.id, location_id: loc1, shift_date: wk.days[1], start_time: '09:00', end_time: '17:00', job_ids: jobIds, breaks: [{ start_time: '12:00', label: 'Lunch' }] }) }));
    check('manager creates shift with jobs', shiftRes.success === true && !!shiftRes.id, JSON.stringify(shiftRes));
    const wk2 = await j(await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(mgr.token) }));
    const savedShift = (wk2.staff.find(s => s.id === schedStaff.id) || {}).shifts.find(s => s.id === shiftRes.id);
    check('shift appears with assigned jobs', !!savedShift && savedShift.jobs.length === jobIds.length, JSON.stringify(savedShift || {}).slice(0, 80));
    check('schedule jobs carry est + description (for tooltips)', !!savedShift && savedShift.jobs.length > 0 && ('est_minutes' in savedShift.jobs[0]) && ('description' in savedShift.jobs[0]), JSON.stringify(savedShift && savedShift.jobs[0]));
    check('break is 10 min with auto end time', !!savedShift && savedShift.breaks.length === 1 && savedShift.breaks[0].start_time === '12:00' && savedShift.breaks[0].end_time === '12:10', JSON.stringify(savedShift && savedShift.breaks));
    const shortRes = await j(await fetch(base + '/api/schedule/shifts', { method: 'POST', headers: H(mgr.token),
      body: JSON.stringify({ user_id: schedStaff.id, location_id: loc1, shift_date: wk.days[2], start_time: '09:00', end_time: '11:00', breaks: [{ start_time: '10:00' }] }) }));
    const wk3 = await j(await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(mgr.token) }));
    const shortShift = (wk3.staff.find(s => s.id === schedStaff.id) || {}).shifts.find(s => s.id === shortRes.id);
    check('no break allowed on a short (<3.5h) shift', !!shortShift && shortShift.breaks.length === 0, JSON.stringify(shortShift && shortShift.breaks));
    const capRes = await j(await fetch(base + '/api/schedule/shifts', { method: 'POST', headers: H(mgr.token),
      body: JSON.stringify({ user_id: schedStaff.id, location_id: loc1, shift_date: wk.days[5], start_time: '08:00', end_time: '16:00', breaks: [{ start_time: '09:00' }, { start_time: '10:30' }, { start_time: '13:00' }] }) }));
    const wk4 = await j(await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(mgr.token) }));
    const capShift = (wk4.staff.find(s => s.id === schedStaff.id) || {}).shifts.find(s => s.id === capRes.id);
    check('day capped at 2 breaks (≤10h)', !!capShift && capShift.breaks.length === 2, 'count=' + (capShift && capShift.breaks.length));
    const longRes = await j(await fetch(base + '/api/schedule/shifts', { method: 'POST', headers: H(mgr.token),
      body: JSON.stringify({ user_id: schedStaff.id, location_id: loc1, shift_date: wk.days[6], start_time: '06:00', end_time: '18:00', breaks: [{ start_time: '08:00' }, { start_time: '10:00' }, { start_time: '12:00' }, { start_time: '14:00' }] }) }));
    const wk5 = await j(await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(mgr.token) }));
    const longShift = (wk5.staff.find(s => s.id === schedStaff.id) || {}).shifts.find(s => s.id === longRes.id);
    check('over-10h day allows more than 2 breaks', !!longShift && longShift.breaks.length === 4, 'count=' + (longShift && longShift.breaks.length));
    r = await fetch(base + `/api/schedule/shifts/${shiftRes.id}`, { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ start_time: '08:00', job_ids: [jobIds[0]] }) });
    check('manager updates shift', r.status === 200, await r.text());
    r = await fetch(base + '/api/schedule/shifts', { method: 'POST', headers: H(mgr.token),
      body: JSON.stringify({ user_id: schedStaff.id, location_id: loc2, shift_date: wk.days[1], start_time: '09:00', end_time: '17:00' }) });
    check('manager cannot schedule another location (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(emp.token) });
    check('employee blocked from location schedule (403)', r.status === 403, 'status=' + r.status);
    const myWk = await j(await fetch(base + '/api/schedule/my-week', { headers: H(emp.token) }));
    check('employee sees own schedule (my-week)', Array.isArray(myWk.shifts) && !!myWk.week_start && myWk.days.length === 7, JSON.stringify(myWk).slice(0, 60));

    // ── Day tasks (specific tasks assigned to that day's working staff) ─────
    const allJobs = await j(await fetch(base + '/api/schedule/jobs?active=1', { headers: H(mgr.token) }));
    check('catalog has specific + standard kinds', allJobs.some(x => x.kind === 'specific') && allJobs.some(x => x.kind === 'standard'), 'kinds missing');
    const dtDay = wk.days[6]; // schedStaff has a 12h shift here
    const dt = await j(await fetch(base + `/api/schedule/day-tasks?location_id=${loc1}&date=${dtDay}`, { headers: H(mgr.token) }));
    check('day-tasks lists specific tasks + working staff', dt.tasks.length > 0 && dt.working.some(w => w.id === schedStaff.id), JSON.stringify(dt.summary));
    check('day-tasks carry est_minutes (for the Est. column)', dt.tasks.every(t => 'est_minutes' in t), JSON.stringify(dt.tasks[0]));
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[0].job_id, user_id: schedStaff.id }) });
    check('assign a specific day task', r.status === 200, await r.text());
    const dt2 = await j(await fetch(base + `/api/schedule/day-tasks?location_id=${loc1}&date=${dtDay}`, { headers: H(mgr.token) }));
    check('day task shows the assignee', (dt2.tasks.find(t => t.job_id === dt.tasks[0].job_id) || {}).user_id === schedStaff.id, JSON.stringify(dt2.summary));
    const wk6 = await j(await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(mgr.token) }));
    const st6 = (wk6.staff.find(s => s.id === schedStaff.id) || {}).shifts.find(s => s.shift_date === dtDay);
    check('assigned task appears on staff schedule summary', !!st6 && (st6.tasks || []).some(t => t.id === dt.tasks[0].job_id), JSON.stringify(st6 && st6.tasks));
    check('schedule subtasks carry est + description (for tooltips)', !!st6 && (st6.tasks || []).length > 0 && ('est_minutes' in st6.tasks[0]) && ('description' in st6.tasks[0]), JSON.stringify(st6 && st6.tasks[0]));
    // Task time must fall within the assignee's shift (schedStaff works 06:00–18:00 here).
    check('day-tasks lists each worker\'s hours', (dt.working.find(w => w.id === schedStaff.id) || {}).start_time === '06:00', JSON.stringify(dt.working.find(w => w.id === schedStaff.id)));
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[0].job_id, time: '10:30' }) });
    check('set a task time within working hours', r.status === 200, await r.text());
    const dtT = await j(await fetch(base + `/api/schedule/day-tasks?location_id=${loc1}&date=${dtDay}`, { headers: H(mgr.token) }));
    check('day task shows the picked time', (dtT.tasks.find(t => t.job_id === dt.tasks[0].job_id) || {}).task_time === '10:30', JSON.stringify(dtT.tasks.find(t => t.job_id === dt.tasks[0].job_id)));
    const wkT = await j(await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(mgr.token) }));
    const stT = (wkT.staff.find(s => s.id === schedStaff.id) || {}).shifts.find(s => s.shift_date === dtDay);
    check('task time appears on staff schedule summary', !!stT && (stT.tasks || []).some(t => t.id === dt.tasks[0].job_id && t.task_time === '10:30'), JSON.stringify(stT && stT.tasks));
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[0].job_id, time: '20:00' }) });
    check('time outside working hours rejected (400)', r.status === 400, 'status=' + r.status);
    // schedStaff's 06:00–18:00 shift has 10-min breaks starting 08:00/10:00/12:00/14:00.
    check('day-tasks lists the worker\'s breaks', ((dt.working.find(w => w.id === schedStaff.id) || {}).breaks || []).length > 0, JSON.stringify((dt.working.find(w => w.id === schedStaff.id) || {}).breaks));
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[0].job_id, time: '08:05' }) });
    check('time during a break rejected (400)', r.status === 400, 'status=' + r.status);
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[0].job_id, time: '08:10' }) });
    check('time at a break\'s end is allowed', r.status === 200, await r.text());
    // Two tasks for the same person must not overlap. tasks[0] sits at 08:10.
    await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[1].job_id, user_id: schedStaff.id }) });
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[1].job_id, time: '08:10' }) });
    check('overlapping task time rejected (400)', r.status === 400, 'status=' + r.status);
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[1].job_id, time: '15:30' }) });
    check('non-overlapping free time allowed', r.status === 200, await r.text());
    // Unassigning a task clears it completely — no orphaned row, no stale done flag/time.
    await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[0].job_id, done: true }) });
    const dtDn = await j(await fetch(base + `/api/schedule/day-tasks?location_id=${loc1}&date=${dtDay}`, { headers: H(mgr.token) }));
    check('a day task can be marked done', !!(dtDn.tasks.find(t => t.job_id === dt.tasks[0].job_id) || {}).done, JSON.stringify(dtDn.tasks.find(t => t.job_id === dt.tasks[0].job_id)));
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[0].job_id, user_id: null }) });
    check('unassign a day task', r.status === 200, await r.text());
    const dtU = await j(await fetch(base + `/api/schedule/day-tasks?location_id=${loc1}&date=${dtDay}`, { headers: H(mgr.token) }));
    const un = dtU.tasks.find(t => t.job_id === dt.tasks[0].job_id) || {};
    check('unassigning clears owner, time and done', !un.user_id && !un.task_time && !un.done, JSON.stringify(un));
    // Re-assign so the later assigned-count assertions still hold.
    await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[0].job_id, user_id: schedStaff.id }) });
    const stdJob = allJobs.find(x => x.kind === 'standard');
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: stdJob.id, user_id: schedStaff.id }) });
    check('standard job rejected as a day task (400)', r.status === 400, 'status=' + r.status);
    r = await fetch(base + `/api/schedule/day-tasks?location_id=${loc1}`, { headers: H(emp.token) });
    check('employee blocked from day-tasks (403)', r.status === 403, 'status=' + r.status);

    // ── Per-location task lists ────────────────────────────────────────────
    const lt = await j(await fetch(base + `/api/schedule/location-tasks?location_id=${loc1}`, { headers: H(mgr.token) }));
    check('location-tasks lists catalog with enabled flags', Array.isArray(lt.catalog) && lt.catalog.some(t => t.enabled) && lt.catalog.some(t => !t.enabled), JSON.stringify({ n: lt.catalog.length, on: lt.enabled }));
    const offTask = lt.catalog.find(t => !t.enabled);
    // A task not on the location's list can't be assigned.
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: offTask.job_id, user_id: schedStaff.id }) });
    check('task off the location list is not assignable (400)', r.status === 400, 'status=' + r.status);
    // Enable it, then it shows on the board and becomes assignable.
    r = await fetch(base + '/api/schedule/location-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, job_id: offTask.job_id, enabled: true }) });
    check('enable a task for the location', r.status === 200, await r.text());
    const dtE = await j(await fetch(base + `/api/schedule/day-tasks?location_id=${loc1}&date=${dtDay}`, { headers: H(mgr.token) }));
    check('enabled task now on the board', dtE.tasks.some(t => t.job_id === offTask.job_id), 'not present');
    // Disable it again → gone from the board.
    await fetch(base + '/api/schedule/location-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, job_id: offTask.job_id, enabled: false }) });
    const dtD = await j(await fetch(base + `/api/schedule/day-tasks?location_id=${loc1}&date=${dtDay}`, { headers: H(mgr.token) }));
    check('disabled task removed from the board', !dtD.tasks.some(t => t.job_id === offTask.job_id), 'still present');
    // Different locations can have different lists.
    const lt2 = await j(await fetch(base + `/api/schedule/location-tasks?location_id=${loc2}`, { headers: H(token) }));
    check('per-location lists are independent', lt2.location.id === loc2 && Array.isArray(lt2.catalog), JSON.stringify(lt2.location));
    // RBAC on the list manager.
    r = await fetch(base + `/api/schedule/location-tasks?location_id=${loc1}`, { headers: H(emp.token) });
    check('employee blocked from location-tasks (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + '/api/schedule/location-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc2, job_id: offTask.job_id, enabled: true }) });
    check('manager cannot edit another location list (403)', r.status === 403, 'status=' + r.status);

    r = await fetch(base + `/api/schedule/shifts/${shiftRes.id}`, { method: 'DELETE', headers: H(mgr.token) });
    check('manager deletes shift', r.status === 200, await r.text());

    // ── Time clock (check-in / check-out) ──────────────────────────────────
    // The clock uses each location's local timezone, so read "today" from the board
    // rather than the (possibly different) server-local date.
    const board0 = await j(await fetch(base + `/api/timeclock/board?location_id=${loc1}`, { headers: H(mgr.token) }));
    check('board reports location-local today + timezone', /^\d{4}-\d{2}-\d{2}$/.test(board0.today) && !!board0.timezone, JSON.stringify({ today: board0.today, tz: board0.timezone }));
    const today = board0.today;
    // Give Employee One (code PHN-0014) an 8h shift today so scheduled time is known.
    for (const os of ((await j(await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(token) }))).staff.find(s => s.id === emp.user.id) || { shifts: [] }).shifts.filter(s => s.shift_date === today)) {
      await fetch(base + `/api/schedule/shifts/${os.id}`, { method: 'DELETE', headers: H(token) });
    }
    await fetch(base + '/api/schedule/shifts', { method: 'POST', headers: H(mgr.token), body: JSON.stringify({ user_id: emp.user.id, location_id: loc1, shift_date: today, start_time: '09:00', end_time: '17:00' }) });
    const punch = (body, tok = mgr.token) => fetch(base + '/api/timeclock/punch', { method: 'POST', headers: H(tok), body: JSON.stringify(body) });
    r = await punch({ location_id: loc1, employee_code: 'PHN-0014', password: 'Employee123!', action: 'in' });
    const inRes = await j(r);
    check('staff check-in (code + password)', r.status === 200 && inRes.action === 'in' && inRes.scheduled_minutes === 480, JSON.stringify(inRes));
    r = await punch({ location_id: loc1, employee_code: 'PHN-0014', password: 'wrong', action: 'in' });
    check('wrong password rejected (401)', r.status === 401, 'status=' + r.status);
    r = await punch({ location_id: loc1, employee_code: 'PHN-0014', password: 'Employee123!', action: 'in' });
    check('double check-in rejected (409)', r.status === 409, 'status=' + r.status);
    r = await punch({ location_id: loc2, employee_code: 'PHN-0014', password: 'Employee123!', action: 'in' }, token); // owner opens loc2
    check('cannot clock at a location you are not assigned to (403)', r.status === 403, 'status=' + r.status);
    const warn = await j(await punch({ location_id: loc1, employee_code: 'PHN-0014', password: 'Employee123!', action: 'out' }));
    check('short check-out returns a warning (no finalize)', warn.warning === 'short_shift' && warn.scheduled_minutes === 480, JSON.stringify(warn));
    const outRes = await j(await punch({ location_id: loc1, employee_code: 'PHN-0014', password: 'Employee123!', action: 'out', confirm_short: true }));
    check('confirmed short check-out finalizes + flags short', outRes.action === 'out' && outRes.short === true, JSON.stringify(outRes));
    const board = await j(await fetch(base + `/api/timeclock/board?location_id=${loc1}&date=${today}`, { headers: H(mgr.token) }));
    check('board shows the entry + summary', board.entries.some(e => e.user_id === emp.user.id && e.status === 'out') && board.summary.short >= 1, JSON.stringify(board.summary));
    const al = await j(await fetch(base + `/api/timeclock/alerts?location_id=${loc1}`, { headers: H(mgr.token) }));
    check('short check-out raised a manager alert', al.alerts.some(a => a.kind === 'short_shift'), JSON.stringify(al.alerts.length));
    r = await fetch(base + `/api/timeclock/alerts/${al.alerts[0].id}/resolve`, { method: 'POST', headers: H(mgr.token) });
    check('manager resolves an alert', r.status === 200, await r.text());
    r = await fetch(base + `/api/timeclock/board?location_id=${loc1}`, { headers: H(emp.token) });
    check('employee blocked from clock board (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + `/api/timeclock/board?location_id=${loc2}`, { headers: H(mgr.token) });
    check('manager blocked from another location board (403)', r.status === 403, 'status=' + r.status);
    r = await punch({ location_id: loc1, employee_code: 'PHN-0014', password: 'Employee123!', action: 'in' }, emp.token);
    check('non-manager cannot open a station / punch (403)', r.status === 403, 'status=' + r.status);

    // ── Payroll / overtime approval + export ───────────────────────────────
    const p2 = (x) => String(x).padStart(2, '0');
    const dOff = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
    const range = `location_id=${loc1}&start=${dOff(-8)}&end=${dOff(0)}`;
    const pr = await j(await fetch(base + `/api/timeclock/payroll?${range}`, { headers: H(mgr.token) }));
    check('payroll returns rules + scheduled + OT days', Array.isArray(pr.staff) && pr.rules.ot_after_h === 8 && pr.rules.ot_mult === 1.5 && Array.isArray(pr.ot_days) && 'scheduled_hours' in (pr.staff[0] || {}), JSON.stringify(pr.rules));
    const supName = 'Support Staff';
    const sup0 = pr.staff.find(s => s.name === supName);
    // Fixture: 10h (2h OT) + 13h (4h OT incl. 1h DT). Unapproved → pending, not counted.
    check('unapproved OT is pending and NOT counted', !!sup0 && sup0.ot_hours === 0 && sup0.dt_hours === 0 && sup0.ot_pending_hours === 6 && sup0.dt_pending_hours === 1, JSON.stringify(sup0));
    check('gross excludes unapproved OT (regular only)', !!sup0 && sup0.gross_pay === Math.round(16 * sup0.rate * 100) / 100, JSON.stringify({ gross: sup0.gross_pay, rate: sup0.rate }));
    const supDays = pr.ot_days.filter(d => d.name === supName);
    check('OT occurrences are listed for approval', supDays.length === 2 && supDays.every(d => d.approved === 0), JSON.stringify(supDays.map(d => d.work_date)));
    // Approval requires a note.
    r = await fetch(base + '/api/timeclock/ot-approval', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, user_id: supDays[0].user_id, work_date: supDays[0].work_date, approved: true }) });
    check('OT approval requires a note (400)', r.status === 400, 'status=' + r.status);
    // Manager cannot change the OT amount.
    r = await fetch(base + '/api/timeclock/ot-approval', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, user_id: supDays[0].user_id, work_date: supDays[0].work_date, approved: true, note: 'ok', ot_minutes: 30 }) });
    check('manager cannot change OT amount (403)', r.status === 403, 'status=' + r.status);
    // Manager approves both OT days (with a note).
    for (const d of supDays) {
      r = await fetch(base + '/api/timeclock/ot-approval', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, user_id: d.user_id, work_date: d.work_date, approved: true, note: 'Approved — covered a call-out' }) });
      check('manager approves an OT day', r.status === 200, await r.text());
    }
    const pr2 = await j(await fetch(base + `/api/timeclock/payroll?${range}`, { headers: H(mgr.token) }));
    const sup2 = pr2.staff.find(s => s.name === supName);
    check('approved OT now counts on payroll', sup2.ot_hours === 6 && sup2.dt_hours === 1 && sup2.ot_pending_hours === 0, JSON.stringify(sup2));
    const expectGross = Math.round((16 * sup2.rate + 6 * sup2.rate * 1.5 + 1 * sup2.rate * 2) * 100) / 100;
    check('gross now includes approved OT/DT', sup2.gross_pay === expectGross, JSON.stringify({ gross: sup2.gross_pay, expect: expectGross }));
    // Owner can change (reduce) the approved OT amount — trim one day by 1h (60 min).
    r = await fetch(base + '/api/timeclock/ot-approval', { method: 'PUT', headers: H(token), body: JSON.stringify({ location_id: loc1, user_id: supDays[0].user_id, work_date: supDays[0].work_date, approved: true, note: 'Trimmed 1h', ot_minutes: supDays[0].computed_ot_minutes - 60 }) });
    check('owner can change the approved OT amount', r.status === 200, await r.text());
    const pr3 = await j(await fetch(base + `/api/timeclock/payroll?${range}`, { headers: H(mgr.token) }));
    const sup3 = pr3.staff.find(s => s.name === supName);
    check('owner OT adjustment reflected (6h → 5h)', sup3.ot_hours === 5, JSON.stringify({ ot: sup3.ot_hours }));
    // Period ranges + RBAC.
    const mo = await j(await fetch(base + `/api/timeclock/payroll?location_id=${loc1}&start=${dOff(-8).slice(0, 8)}01&end=${dOff(0)}`, { headers: H(mgr.token) }));
    check('payroll accepts an arbitrary (monthly) range', !!mo.start && !!mo.end, JSON.stringify({ start: mo.start, end: mo.end }));
    r = await fetch(base + `/api/timeclock/payroll?location_id=${loc1}`, { headers: H(emp.token) });
    check('employee blocked from payroll (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + '/api/timeclock/ot-approval', { method: 'PUT', headers: H(emp.token), body: JSON.stringify({ location_id: loc1, user_id: supDays[0].user_id, work_date: supDays[0].work_date, approved: true, note: 'x' }) });
    check('employee blocked from approving OT (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + `/api/timeclock/payroll?location_id=${loc2}`, { headers: H(mgr.token) });
    check('manager blocked from another location payroll (403)', r.status === 403, 'status=' + r.status);

    // ── Floor plan (shared with the Waitlist Front Desk) ───────────────────
    const svc = (extra) => ({ 'Content-Type': 'application/json', 'X-Service-Key': 'dev-floorplan-key', ...(extra || {}) });
    const fp = await j(await fetch(base + `/api/floorplan?location_id=${loc1}`, { headers: H(mgr.token) }));
    check('floor plan: areas + tables + status + outline', Array.isArray(fp.areas) && fp.areas.some(a => a.tables.length) && Array.isArray(fp.room_outline) && fp.summary.tables > 0 && fp.can_edit === true, JSON.stringify(fp.summary));
    const aTable = fp.areas.flatMap(a => a.tables).find(t => t.status === 'available');
    r = await fetch(base + `/api/floorplan/tables/${aTable.id}/seat`, { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ guest_name: 'Kim', party_size: 3 }) });
    check('seat a guest → table occupied', r.status === 200, await r.text());
    const fp2 = await j(await fetch(base + `/api/floorplan?location_id=${loc1}`, { headers: H(mgr.token) }));
    const seated = fp2.areas.flatMap(a => a.tables).find(t => t.id === aTable.id);
    check('seated table shows status + ETA', seated.status === 'waiting_to_order' && seated.occupied === true && seated.minutes_to_free > 0 && fp2.summary.occupied >= 1, JSON.stringify({ s: seated.status, m: seated.minutes_to_free }));
    r = await fetch(base + `/api/floorplan/tables/${aTable.id}/seat`, { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ guest_name: 'X' }) });
    check('cannot seat an occupied table (409)', r.status === 409, 'status=' + r.status);
    r = await fetch(base + `/api/floorplan/tables/${aTable.id}/status`, { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ status: 'waiting_to_pay' }) });
    check('advance table status', r.status === 200, await r.text());
    r = await fetch(base + `/api/floorplan/tables/${aTable.id}/status`, { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ status: 'available' }) });
    check('free the table (back to available)', r.status === 200, await r.text());
    // Layout editing — manager own location; RBAC.
    const fArea = await j(await fetch(base + '/api/floorplan/areas', { method: 'POST', headers: H(mgr.token), body: JSON.stringify({ name: 'Mezzanine' }) }));
    check('manager adds a floor area', fArea.success === true && !!fArea.id, JSON.stringify(fArea));
    r = await fetch(base + '/api/floorplan/room', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, outline: [{ x: 5, y: 5 }, { x: 95, y: 5 }, { x: 95, y: 95 }, { x: 5, y: 95 }] }) });
    check('manager reshapes the room', r.status === 200, await r.text());
    r = await fetch(base + `/api/floorplan?location_id=${loc1}`, { headers: H(emp.token) });
    check('employee blocked from floor plan (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + `/api/floorplan?location_id=${loc2}`, { headers: H(mgr.token) });
    check('manager blocked from another location floor plan (403)', r.status === 403, 'status=' + r.status);
    // Waitlist service key: can view + seat, cannot edit layout.
    r = await fetch(base + `/api/floorplan?location_id=${loc1}`, { headers: svc() });
    const svcFp = await j(r);
    check('service key can view the floor plan', r.status === 200 && svcFp.can_edit === false, 'status=' + r.status);
    const aTable2 = svcFp.areas.flatMap(a => a.tables).find(t => t.status === 'available');
    r = await fetch(base + `/api/floorplan/tables/${aTable2.id}/seat`, { method: 'PUT', headers: svc(), body: JSON.stringify({ guest_name: 'FrontDesk', party_size: 2 }) });
    check('service key can seat a guest', r.status === 200, await r.text());
    r = await fetch(base + '/api/floorplan/areas', { method: 'POST', headers: svc(), body: JSON.stringify({ location_id: loc1, name: 'Nope' }) });
    check('service key cannot edit layout (403)', r.status === 403, 'status=' + r.status);

    // ── Guest-visit lifecycle (the six Service lists) ──────────────────────
    const V = '/api/visits';
    const vl = await j(await fetch(base + `${V}?location_id=${loc1}`, { headers: H(token) }));
    check('visit lists: seeded stages present', vl.summary.waiting >= 3 && vl.summary.seated >= 2 && vl.summary.in_service >= 3 && vl.summary.paying >= 1, JSON.stringify(vl.summary));
    check('visit lists: checks due surfaced', vl.summary.checks_due >= 1 && vl.lists.in_service.some(v => v.check_due), 'due=' + vl.summary.checks_due);
    check('visit lists: servers offered for assignment', Array.isArray(vl.servers) && vl.servers.length >= 1, 'servers=' + vl.servers.length);
    check('summary includes walk-ins today', typeof vl.summary.walkins_today === 'number' && vl.summary.walkins_today >= 0, 'w=' + vl.summary.walkins_today);
    const vAll = await j(await fetch(base + V, { headers: H(token) }));
    check('owner sees all-location visits', vAll.all_locations === true && (vAll.lists.waiting.length + vAll.lists.in_service.length) >= 3, JSON.stringify(vAll.summary));

    const fpNow = await j(await fetch(base + `/api/floorplan?location_id=${loc1}`, { headers: H(token) }));
    const freeT = fpNow.areas.flatMap(a => a.tables).filter(t => t.status === 'available');
    const [T1, T2, T3] = freeT;
    const srv = vl.servers[0];

    let cr = await j(await fetch(base + V, { method: 'POST', headers: H(token), body: JSON.stringify({ location_id: loc1, guest_name: 'Smoke Party', party_size: 2, source: 'walkin' }) }));
    check('create a waiting visit', cr.success === true && cr.visit.stage === 'waiting', JSON.stringify(cr.visit && cr.visit.stage));
    const vid = cr.id;
    let sd = await j(await fetch(base + `${V}/${vid}/seat`, { method: 'PUT', headers: H(token), body: JSON.stringify({ table_id: T1.id, check_interval_min: 10 }) }));
    check('seat a visit → seated + table', sd.visit && sd.visit.stage === 'seated' && sd.visit.table_label === T1.label, JSON.stringify(sd.visit && { s: sd.visit.stage, t: sd.visit.table_label }));
    const fpOcc = await j(await fetch(base + `/api/floorplan?location_id=${loc1}`, { headers: H(token) }));
    const occT = fpOcc.areas.flatMap(a => a.tables).find(t => t.id === T1.id);
    check('seating reflects on the floor plan', occT.occupied === true && occT.status === 'waiting_to_order', occT.status);
    const dup = await j(await fetch(base + V, { method: 'POST', headers: H(token), body: JSON.stringify({ location_id: loc1, guest_name: 'Dupe', party_size: 2 }) }));
    r = await fetch(base + `${V}/${dup.id}/seat`, { method: 'PUT', headers: H(token), body: JSON.stringify({ table_id: T1.id }) });
    check('cannot seat two parties at one table (409)', r.status === 409, 'status=' + r.status);

    let cl = await j(await fetch(base + `${V}/${vid}/claim`, { method: 'PUT', headers: H(token), body: JSON.stringify({ server_id: srv.id, server_name: srv.name }) }));
    check('claim → in_service + server + check timer', cl.visit && cl.visit.stage === 'in_service' && cl.visit.server_name === srv.name && cl.visit.minutes_to_check > 0, JSON.stringify(cl.visit && { s: cl.visit.stage, m: cl.visit.minutes_to_check }));
    const fpSrv = await j(await fetch(base + `/api/floorplan?location_id=${loc1}`, { headers: H(token) }));
    check('in-service reflects on the floor plan (served)', fpSrv.areas.flatMap(a => a.tables).find(t => t.id === T1.id).status === 'served');
    let ck = await j(await fetch(base + `${V}/${vid}/check`, { method: 'PUT', headers: H(token), body: JSON.stringify({ note: 'all good' }) }));
    check('log a check → count up + timer reset', ck.visit.check_count >= 1 && ck.visit.minutes_to_check > 0, JSON.stringify({ c: ck.visit.check_count }));
    r = await fetch(base + `${V}/${vid}/interval`, { method: 'PUT', headers: H(token), body: JSON.stringify({ check_interval_min: 7 }) });
    check('invalid check interval rejected (400)', r.status === 400, 'status=' + r.status);
    r = await fetch(base + `${V}/${vid}/interval`, { method: 'PUT', headers: H(token), body: JSON.stringify({ check_interval_min: 5 }) });
    check('set check interval (5 min)', r.status === 200, await r.text());
    let py = await j(await fetch(base + `${V}/${vid}/pay`, { method: 'PUT', headers: H(token), body: JSON.stringify({}) }));
    check('move to paying', py.visit.stage === 'paying', py.visit.stage);
    let dn = await j(await fetch(base + `${V}/${vid}/done`, { method: 'PUT', headers: H(token), body: JSON.stringify({}) }));
    check('done → visit done', dn.visit.stage === 'done', dn.visit.stage);
    const fpFree = await j(await fetch(base + `/api/floorplan?location_id=${loc1}`, { headers: H(token) }));
    check('done frees the table (available again)', fpFree.areas.flatMap(a => a.tables).find(t => t.id === T1.id).status === 'available');

    r = await fetch(base + `${V}/${dup.id}/cancel`, { method: 'PUT', headers: H(token), body: JSON.stringify({ reason: 'left' }) });
    check('cancel a waiting visit', r.status === 200, await r.text());

    const wi = await j(await fetch(base + V, { method: 'POST', headers: H(token), body: JSON.stringify({ location_id: loc1, guest_name: 'Mover', party_size: 2, table_id: T2.id }) }));
    check('walk-in seated directly (no wait)', wi.visit.stage === 'seated' && wi.visit.table_label === T2.label, JSON.stringify(wi.visit && wi.visit.stage));
    let tr = await j(await fetch(base + `${V}/${wi.id}/transfer`, { method: 'PUT', headers: H(token), body: JSON.stringify({ table_id: T3.id }) }));
    check('transfer to another table', tr.visit.table_label === T3.label, JSON.stringify(tr.visit && tr.visit.table_label));
    const fpTr = await j(await fetch(base + `/api/floorplan?location_id=${loc1}`, { headers: H(token) }));
    check('transfer frees the old table', fpTr.areas.flatMap(a => a.tables).find(t => t.id === T2.id).status === 'available');

    const det = await j(await fetch(base + `${V}/${vid}`, { headers: H(token) }));
    check('visit history logs every movement', Array.isArray(det.events) && det.events.length >= 5 && det.events.some(e => e.event === 'seated') && det.events.some(e => e.event === 'done'), 'n=' + (det.events || []).length);
    const rep = await j(await fetch(base + `${V}/reports/servers?location_id=${loc1}`, { headers: H(token) }));
    check('server performance report', Array.isArray(rep.servers) && rep.servers.length >= 1 && rep.servers[0].tables_served >= 1, 'n=' + (rep.servers || []).length);
    check('report includes tips_total', rep.servers.every(x => 'tips_total' in x));

    // Server flags (call for help / ready to bus), a tip at close, and the tally
    const fx = await j(await fetch(base + V, { method: 'POST', headers: H(token), body: JSON.stringify({ location_id: loc1, guest_name: 'Flags Test', party_size: 2, notes: 'Nut allergy' }) }));
    let hf = await j(await fetch(base + `${V}/${fx.id}/help`, { method: 'PUT', headers: H(token), body: JSON.stringify({ on: true }) }));
    check('raise a call-for-help flag', hf.visit.help_flag === true, JSON.stringify(hf.visit && hf.visit.help_flag));
    let bf = await j(await fetch(base + `${V}/${fx.id}/bus`, { method: 'PUT', headers: H(token), body: JSON.stringify({ on: true }) }));
    check('raise a ready-to-bus flag', bf.visit.bus_flag === true, JSON.stringify(bf.visit && bf.visit.bus_flag));
    const fl = await j(await fetch(base + `${V}?location_id=${loc1}`, { headers: H(token) }));
    check('flags surface in needs_help + to_bus', fl.summary.help >= 1 && fl.summary.to_bus >= 1 && fl.needs_help.some(v => v.id === fx.id) && fl.to_bus.some(v => v.id === fx.id), JSON.stringify({ h: fl.summary.help, b: fl.summary.to_bus }));
    check('note carried on the visit', fl.needs_help.find(v => v.id === fx.id).notes === 'Nut allergy');
    let cf = await j(await fetch(base + `${V}/${fx.id}/help`, { method: 'PUT', headers: H(token), body: JSON.stringify({ on: false }) }));
    check('clear the help flag', cf.visit.help_flag === false);
    let df = await j(await fetch(base + `${V}/${fx.id}/done`, { method: 'PUT', headers: H(token), body: JSON.stringify({ tip_amount: 12.5 }) }));
    check('done records an optional tip', df.visit.stage === 'done' && df.visit.tip_amount === 12.5, JSON.stringify(df.visit && df.visit.tip_amount));
    const tally = await j(await fetch(base + `${V}/me/tally?location_id=${loc1}&server_id=${srv.id}`, { headers: H(token) }));
    check('server tally: covers + tips + open tables', typeof tally.covers === 'number' && typeof tally.tips === 'number' && typeof tally.open_tables === 'number', JSON.stringify(tally));

    // ── My Tasks (staff day-task assignments) ──────────────────────────────
    const sara = vl.servers.find(s => s.name === 'Sara Tran') || vl.servers[0];
    const st = await j(await fetch(base + `/api/stafftasks?user_id=${sara.id}`, { headers: svc() }));
    check('staff day tasks: assigned list', Array.isArray(st.tasks) && st.tasks.length >= 1 && 'done' in st.tasks[0], JSON.stringify(st.summary));
    const myTask = st.tasks.find(t => !t.done) || st.tasks[0];
    r = await fetch(base + `/api/stafftasks/${myTask.id}/done`, { method: 'PUT', headers: svc(), body: JSON.stringify({ done: true, user_id: sara.id }) });
    const doneRes = await j(r);
    check('mark my task done', r.status === 200 && doneRes.done === true, JSON.stringify(doneRes));
    r = await fetch(base + '/api/stafftasks');
    check('staff tasks require auth (401)', r.status === 401, 'status=' + r.status);
    const otherStaff = vl.servers.find(s => s.id !== sara.id);
    if (otherStaff) {
      r = await fetch(base + `/api/stafftasks/${myTask.id}/done`, { method: 'PUT', headers: svc(), body: JSON.stringify({ done: false, user_id: otherStaff.id }) });
      check('cannot complete a task that is not yours (403)', r.status === 403, 'status=' + r.status);
    }

    // ── Location activity trail (merged Management + Staff-app, filterable) ──
    const act1 = await j(await fetch(base + `/api/locations/${loc1}/activity?range=all&limit=200`, { headers: H(token) }));
    check('owner sees location activity', Array.isArray(act1) && act1.length >= 1, 'n=' + (act1 || []).length);
    check('activity is scoped to the location', act1.every(a => a.location_id === loc1), 'leak');
    check('activity rows carry a source', act1.every(a => a.source === 'management' || a.source === 'frontdesk'), 'no source');
    check('activity accepts a range filter', Array.isArray(await j(await fetch(base + `/api/locations/${loc1}/activity?range=week`, { headers: H(token) }))));
    r = await fetch(base + `/api/locations/${loc1}/activity`, { headers: H(mgr.token) });
    check('manager sees own location activity', r.status === 200, 'status=' + r.status);
    r = await fetch(base + `/api/locations/${loc2}/activity`, { headers: H(mgr.token) });
    check('manager blocked from another location activity (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + `/api/locations/${loc1}/activity`, { headers: H(emp.token) });
    check('employee blocked from location activity (403)', r.status === 403, 'status=' + r.status);

    // RBAC
    r = await fetch(base + `${V}?location_id=${loc1}`, { headers: H(emp.token) });
    check('employee blocked from service lists (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + `${V}?location_id=${loc2}`, { headers: H(mgr.token) });
    check('manager blocked from another location visits (403)', r.status === 403, 'status=' + r.status);
    const mgrV = await j(await fetch(base + V, { headers: H(mgr.token) }));
    check('manager sees only own location visits', mgrV.all_locations === false && mgrV.location && mgrV.location.id === loc1, JSON.stringify(mgrV.location));

    // Staff app (service key): Front Desk creates+seats, server claims
    const fpS = await j(await fetch(base + `/api/floorplan?location_id=${loc1}`, { headers: svc() }));
    const freeS = fpS.areas.flatMap(a => a.tables).filter(t => t.status === 'available');
    const cs = await j(await fetch(base + V, { method: 'POST', headers: svc(), body: JSON.stringify({ location_id: loc1, guest_name: 'SvcWalk', party_size: 2, source: 'walkin', actor_name: 'Host', actor_role: 'host' }) }));
    check('service key creates a visit', cs.success === true && cs.visit.stage === 'waiting', JSON.stringify(cs.visit && cs.visit.stage));
    r = await fetch(base + `${V}/${cs.id}/seat`, { method: 'PUT', headers: svc(), body: JSON.stringify({ location_id: loc1, table_id: freeS[0].id }) });
    check('service key seats a visit', r.status === 200, await r.text());
    r = await fetch(base + `${V}/${cs.id}/claim`, { method: 'PUT', headers: svc(), body: JSON.stringify({ location_id: loc1, server_id: srv.id, server_name: srv.name, actor_name: srv.name, actor_role: 'server' }) });
    check('service key (server) claims a table', r.status === 200, await r.text());
    r = await fetch(base + V, { headers: svc() });
    check('service key requires a location (400)', r.status === 400, 'status=' + r.status);

    // ── Additional access levels ───────────────────────────────
    const login = async (email, pw) => (await j(await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) }))).token;
    const roleReg = await j(await fetch(base + '/api/auth/roles', { headers: H(token) }));
    check('role registry exposed', Array.isArray(roleReg) && roleReg.length >= 15, 'count=' + (roleReg || []).length);
    const gmTok = await login('gm@phohanoi.com', 'Gm123456!');
    const gmStaff = await j(await fetch(base + '/api/staff', { headers: H(gmTok) }));
    check('GM sees all-location staff', Array.isArray(gmStaff) && gmStaff.length > 20, 'count=' + (gmStaff || []).length);
    r = await fetch(base + '/api/central/summary', { headers: H(gmTok) });
    check('GM can access central kitchen', r.status === 200, 'status=' + r.status);
    const anTok = await login('analyst@phohanoi.com', 'Analyst123!');
    r = await fetch(base + '/api/reports/sales', { headers: H(anTok) });
    check('analyst can view reports', r.status === 200, 'status=' + r.status);
    r = await fetch(base + '/api/staff', { headers: H(anTok) });
    check('analyst blocked from staff (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + `/api/inventory/?location_id=${loc1}`, { headers: H(anTok) });
    check('analyst blocked from inventory (403)', r.status === 403, 'status=' + r.status);
    const drTok = await login('driver@phohanoi.com', 'Driver123!');
    r = await fetch(base + '/api/central/fulfillment', { headers: H(drTok) });
    check('driver can view fulfillment/deliveries', r.status === 200, 'status=' + r.status);
    r = await fetch(base + `/api/inventory/?location_id=${loc1}`, { headers: H(drTok) });
    check('driver blocked from inventory (403)', r.status === 403, 'status=' + r.status);
    const svTok = await login('server@phohanoi.com', 'Server123!');
    r = await fetch(base + `/api/inventory/?location_id=${loc1}`, { headers: H(svTok) });
    check('server (position) blocked from inventory (403)', r.status === 403, 'status=' + r.status);
    const svWk = await j(await fetch(base + '/api/schedule/my-week', { headers: H(svTok) }));
    check('server sees own schedule', Array.isArray(svWk.shifts) && svWk.days.length === 7, JSON.stringify(svWk).slice(0, 40));
    r = await fetch(base + '/api/menu/items', { headers: H(svTok) });
    check('server blocked from menu (403)', r.status === 403, 'status=' + r.status);

    // ── Activity log (access trail) ────────────────────────────
    await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'harry@phohanoi.com', password: 'wrong' }) });
    const acts = await j(await fetch(base + '/api/activity', { headers: H(token) }));
    check('activity log records events', Array.isArray(acts) && acts.length > 0, 'len=' + (acts || []).length);
    check('successful login is logged', acts.some(a => a.path === '/api/auth/login' && a.status === 200), 'no login event');
    check('writes are logged', acts.some(a => ['POST', 'PUT', 'DELETE'].includes(a.method) && a.status < 400), 'no write event');
    const logins = await j(await fetch(base + '/api/activity?event=logins', { headers: H(token) }));
    check('failed login is logged', logins.some(a => a.status === 401), 'no failed login');
    r = await fetch(base + '/api/activity', { headers: H(mgr.token) });
    check('manager blocked from activity log (403)', r.status === 403, 'status=' + r.status);

    // ── Reports module ─────────────────────────────────────────
    const repInv = await j(await fetch(base + '/api/reports/inventory', { headers: H(token) }));
    // Org-wide report includes the Central Kitchen warehouse: 10 stores + 1 CK = 11 locations.
    check('inventory report', repInv.total_value > 0 && repInv.by_category.length >= 4 && repInv.by_location.length === 11 && repInv.by_location.some(l => /Central Kitchen/.test(l.location)) && repInv.top_items.length > 0, JSON.stringify({ v: repInv.total_value, locs: repInv.by_location.length }));
    const repSales = await j(await fetch(base + '/api/reports/sales', { headers: H(token) }));
    check('sales report', repSales.total_revenue > 0 && repSales.by_day.length >= 25 && repSales.by_location.length === 10 && repSales.avg_check > 0, JSON.stringify(repSales.total_revenue));
    const repPay = await j(await fetch(base + '/api/reports/payments', { headers: H(token) }));
    check('payments report totals add up', repPay.totals.total > 0 && Math.abs((repPay.totals.cash + repPay.totals.card + repPay.totals.online) - repPay.totals.total) < 5, JSON.stringify(repPay.totals));
    const repTs = await j(await fetch(base + '/api/reports/timesheets', { headers: H(token) }));
    check('timesheets report', repTs.total_hours > 0 && repTs.total_labor_cost > 0 && repTs.by_staff.length >= 5, JSON.stringify(repTs.total_hours));
    const repAn = await j(await fetch(base + '/api/reports/analytics', { headers: H(token) }));
    check('analytics report', repAn.revenue > 0 && repAn.food_cost_pct > 0 && repAn.labor_cost_pct != null && repAn.revenue_trend.length >= 25, JSON.stringify({ f: repAn.food_cost_pct, l: repAn.labor_cost_pct }));

    // manager scoped to their location; employee blocked
    const mgrSales = await j(await fetch(base + '/api/reports/sales', { headers: H(mgr.token) }));
    check('manager report scoped to one location', mgrSales.by_location.length === 1, 'locs=' + mgrSales.by_location.length);
    r = await fetch(base + '/api/reports/sales', { headers: H(emp.token) });
    check('employee blocked from reports (403)', r.status === 403, 'status=' + r.status);

    // ── Messages ───────────────────────────────────────────────
    const unread0 = await j(await fetch(base + '/api/messages/unread-count', { headers: H(token) }));
    check('owner has unread messages', unread0.count >= 2, 'count=' + unread0.count);
    const inbox = await j(await fetch(base + '/api/messages/inbox', { headers: H(token) }));
    check('owner inbox populated', inbox.length >= 2 && inbox.some(m => !m.is_read));

    const empMe = await j(await fetch(base + '/api/auth/me', { headers: H(emp.token) }));
    r = await fetch(base + '/api/messages', { method: 'POST', headers: H(token), body: JSON.stringify({ audience: 'direct', recipient_id: empMe.id, subject: 'Hi', body: 'Welcome aboard!' }) });
    const sentMsg = await j(r);
    check('send direct message', r.status === 200 && sentMsg.recipients === 1, JSON.stringify(sentMsg));
    const empInbox = await j(await fetch(base + '/api/messages/inbox', { headers: H(emp.token) }));
    check('recipient received message', empInbox.some(m => m.body === 'Welcome aboard!' && !m.is_read));
    const empUnread = await j(await fetch(base + '/api/messages/unread-count', { headers: H(emp.token) }));
    check('recipient unread count', empUnread.count >= 1);
    const theRow = empInbox.find(m => m.body === 'Welcome aboard!');
    r = await fetch(base + `/api/messages/thread/${theRow.thread_id}`, { headers: H(emp.token) });
    check('opening a thread marks it read', r.status === 200);
    const empUnread2 = await j(await fetch(base + '/api/messages/unread-count', { headers: H(emp.token) }));
    check('unread decremented after read', empUnread2.count === empUnread.count - 1, `${empUnread.count} -> ${empUnread2.count}`);

    r = await fetch(base + '/api/messages', { method: 'POST', headers: H(token), body: JSON.stringify({ audience: 'all', subject: 'Notice', body: 'All-staff notice' }) });
    const bc = await j(r);
    check('owner broadcast to all', r.status === 200 && bc.recipients >= 13, 'recipients=' + bc.recipients);
    r = await fetch(base + '/api/messages', { method: 'POST', headers: H(emp.token), body: JSON.stringify({ audience: 'all', body: 'spam' }) });
    check('employee cannot broadcast (403)', r.status === 403, 'status=' + r.status);
    const ownerSent = await j(await fetch(base + '/api/messages/sent', { headers: H(token) }));
    check('sent list includes broadcast', ownerSent.some(m => m.audience === 'all'));

    // ── Locations module ───────────────────────────────────────
    const locsList = await j(await fetch(base + '/api/locations', { headers: H(token) }));
    check('locations list (10 stores + central kitchen)', locsList.length === 11 && locsList.some(l => l.type === 'central_kitchen') && locsList.every(l => 'manager_name' in l && 'staff_count' in l), 'len=' + locsList.length);
    check('store switchers exclude central kitchen', locs.length === 10 && !locs.some(l => l.type === 'central_kitchen'));
    const locDet = await j(await fetch(base + `/api/locations/${loc1}`, { headers: H(token) }));
    check('location detail (info + 7 days hours)', !!locDet.city && locDet.hours.length === 7 && !!locDet.phone, JSON.stringify(locDet.city));
    const locStaff = await j(await fetch(base + `/api/locations/${loc1}/staff`, { headers: H(token) }));
    check('location staff roster', Array.isArray(locStaff) && locStaff.length >= 1);
    const locEq = await j(await fetch(base + `/api/locations/${loc1}/equipment`, { headers: H(token) }));
    check('location equipment (vendor + maintenance)', locEq.length === 12 && !!locEq[0].vendor && !!locEq[0].maintenance_freq && !!locEq[0].status, 'len=' + locEq.length);

    const newLoc = await j(await fetch(base + '/api/locations', { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'Pho Ha Noi — Test', city: 'Testville', state: 'CA', phone: '(408) 555-9999', seats: 40 }) }));
    check('create location', newLoc.success === true && !!newLoc.id);
    const nd = await j(await fetch(base + `/api/locations/${newLoc.id}`, { headers: H(token) }));
    check('new location gets default hours', nd.hours.length === 7);
    r = await fetch(base + `/api/locations/${newLoc.id}`, { method: 'PUT', headers: H(token), body: JSON.stringify({ seats: 55, status: 'draft' }) });
    check('update location', r.status === 200);

    const ne = await j(await fetch(base + `/api/locations/${newLoc.id}/equipment`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'Test Fryer', category: 'Cooking', vendor: 'Vulcan', maintenance_freq: 'monthly' }) }));
    check('add equipment', ne.success === true && !!ne.id);
    r = await fetch(base + `/api/locations/equipment/${ne.id}`, { method: 'PUT', headers: H(token), body: JSON.stringify({ status: 'needs_service' }) });
    check('edit equipment status', r.status === 200);
    r = await fetch(base + `/api/locations/equipment/${ne.id}`, { method: 'DELETE', headers: H(token) });
    check('delete equipment', r.status === 200);
    r = await fetch(base + `/api/locations/${loc1}/hours`, { method: 'PUT', headers: H(token), body: JSON.stringify({ hours: [{ day_of_week: 0, open_time: '11:00', close_time: '21:00', is_closed: 0 }] }) });
    check('set operating hours', r.status === 200);

    // RBAC
    r = await fetch(base + '/api/locations', { headers: H(emp.token) });
    check('employee blocked from locations (403)', r.status === 403, 'status=' + r.status);
    const mgrLocs = await j(await fetch(base + '/api/locations', { headers: H(mgr.token) }));
    check('manager sees only their location', mgrLocs.length === 1 && mgrLocs[0].id === loc1, 'len=' + mgrLocs.length);
    r = await fetch(base + '/api/locations', { method: 'POST', headers: H(mgr.token), body: JSON.stringify({ name: 'X' }) });
    check('manager cannot create location (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + `/api/locations/${loc1}/equipment`, { method: 'POST', headers: H(mgr.token), body: JSON.stringify({ name: 'Mgr Equip' }) });
    check('manager can add equipment to own location', r.status === 200, 'status=' + r.status);
    const otherLoc = locsList.find(l => l.id !== loc1 && l.type !== 'central_kitchen').id;
    r = await fetch(base + `/api/locations/${otherLoc}/equipment`, { method: 'POST', headers: H(mgr.token), body: JSON.stringify({ name: 'Nope' }) });
    check('manager blocked from other location (403)', r.status === 403, 'status=' + r.status);

    // ── Central Kitchen module ─────────────────────────────────
    const ckSum = await j(await fetch(base + '/api/central/summary', { headers: H(token) }));
    check('CK summary', !!ckSum.location && ckSum.products === 7 && ckSum.low_stock >= 1 && ckSum.pending_stores === 10 && ckSum.staff === 3, JSON.stringify({ p: ckSum.products, s: ckSum.staff }));
    const ckDem = await j(await fetch(base + '/api/central/demand', { headers: H(token) }));
    check('CK demand aggregation', ckDem.products.length === 7 && ckDem.products[0].total_requested > 0 && Array.isArray(ckDem.products[0].by_store), JSON.stringify(ckDem.products[0].total_requested));
    const ckProds = await j(await fetch(base + '/api/central/products', { headers: H(token) }));
    check('CK products with recipes + cost', ckProds.length === 7 && ckProds.every(p => Array.isArray(p.ingredients)) && ckProds.some(p => p.batch_cost > 0));
    const ckPlan = await j(await fetch(base + '/api/central/batch-plan', { headers: H(token) }));
    const sheet = ckPlan.sheets.find(s => s.batches > 0);
    check('CK batch plan (scaling + yield + alerts)', ckPlan.alerts.length >= 1 && !!sheet && sheet.usable_output < sheet.gross_output && sheet.ingredients.length >= 1, JSON.stringify({ a: ckPlan.alerts.length }));

    r = await fetch(base + '/api/central/production', { method: 'POST', headers: H(token), body: JSON.stringify({ product_id: sheet.product_id, batches: 3 }) });
    const prod = await j(r);
    check('CK record production (updates on-hand)', r.status === 200 && prod.produced > 0, JSON.stringify(prod));
    const onHandBefore = ckProds.find(p => p.id === sheet.product_id).on_hand;
    const ckProds2 = await j(await fetch(base + '/api/central/products', { headers: H(token) }));
    check('CK on-hand increased after production', ckProds2.find(p => p.id === sheet.product_id).on_hand > onHandBefore);

    // Master-recipe editor: create product, update its attributes, set its recipe.
    r = await fetch(base + '/api/central/products', { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'Test Chili Oil', unit: 'bottle', batch_yield: 50, shrinkage_pct: 0.05, safety_stock: 30, on_hand: 10 }) });
    const newProd = await j(r);
    check('CK create product', r.status === 200 && newProd.id > 0);
    r = await fetch(base + `/api/central/products/${newProd.id}`, { method: 'PUT', headers: H(token), body: JSON.stringify({ safety_stock: 80, shrinkage_pct: 0.12 }) });
    check('CK update product attributes', r.status === 200);
    const ingList = await j(await fetch(base + '/api/central/ingredients', { headers: H(token) }));
    check('CK ingredient picker (from inventory costs)', ingList.length > 0 && ingList.every(i => 'avg_cost' in i));
    r = await fetch(base + `/api/central/products/${newProd.id}/recipe`, { method: 'PUT', headers: H(token), body: JSON.stringify({ ingredients: [{ item_name: ingList[0].item_name, quantity: 4 }] }) });
    check('CK set recipe', r.status === 200);
    const edited = (await j(await fetch(base + '/api/central/products', { headers: H(token) }))).find(p => p.id === newProd.id);
    check('CK product reflects edits (attrs + recipe + cost)', edited.safety_stock === 80 && Math.abs(edited.shrinkage_pct - 0.12) < 1e-9 && edited.ingredients.length === 1 && edited.batch_cost > 0, JSON.stringify({ s: edited.safety_stock, i: edited.ingredients.length, c: edited.batch_cost }));

    const ckFul = await j(await fetch(base + '/api/central/fulfillment', { headers: H(token) }));
    check('CK fulfillment (stores, pick list, manifests)', ckFul.stores.length === 10 && ckFul.pick_list.length === 7 && ckFul.manifests.length >= 3 && ckFul.stores.every(s => s.location_id), 'manifests=' + ckFul.manifests.length);
    const fulStore = ckFul.stores.find(s => s.status === 'requested');
    const stockBefore = await j(await fetch(base + `/api/inventory/?location_id=${fulStore.location_id}`, { headers: H(token) }));
    const ful = await j(await fetch(base + `/api/central/fulfill/${fulStore.location_id}`, { method: 'POST', headers: H(token), body: '{}' }));
    check('CK fulfill a store', ful.fulfilled >= 1);
    // Fulfillment delivers the produced stock into the store's own inventory.
    const stockAfter = await j(await fetch(base + `/api/inventory/?location_id=${fulStore.location_id}`, { headers: H(token) }));
    const delivered = stockAfter.filter(i => i.category === 'Prepared (Central Kitchen)');
    check('CK delivery lands in store inventory', delivered.length >= 1 && stockAfter.length >= stockBefore.length, JSON.stringify({ before: stockBefore.length, after: stockAfter.length, delivered: delivered.length }));
    const deliveryTxn = (await j(await fetch(base + `/api/inventory/transactions?location_id=${fulStore.location_id}`, { headers: H(token) }))).some(t => t.notes === 'Central Kitchen delivery');
    check('CK delivery logged in store ledger', deliveryTxn);

    const ckStaff = await j(await fetch(base + '/api/central/staff', { headers: H(token) }));
    check('CK staff with PINs', ckStaff.length === 3 && ckStaff.every(s => s.has_pin));
    const ckTasks = await j(await fetch(base + '/api/central/tasks', { headers: H(token) }));
    check('CK tasks (some photo-verified)', ckTasks.length >= 4 && ckTasks.some(t => t.requires_photo));
    const photoTask = ckTasks.find(t => t.requires_photo && t.status !== 'done');
    r = await fetch(base + `/api/central/tasks/${photoTask.id}/complete`, { method: 'PUT', headers: H(token), body: '{}' });
    check('photo task needs a photo (400)', r.status === 400, 'status=' + r.status);
    r = await fetch(base + `/api/central/tasks/${photoTask.id}/complete`, { method: 'PUT', headers: H(token), body: JSON.stringify({ photo_url: 'https://example.com/p.jpg' }) });
    check('complete photo task with photo', r.status === 200);

    const cin = await j(await fetch(base + '/api/central/clock', { method: 'POST', headers: H(token), body: JSON.stringify({ pin: '2222' }) }));
    check('PIN clock-in', cin.success && cin.action === 'clock_in', JSON.stringify(cin.action));
    const cout = await j(await fetch(base + '/api/central/clock', { method: 'POST', headers: H(token), body: JSON.stringify({ pin: '2222' }) }));
    check('PIN clock-out', cout.success && cout.action === 'clock_out', JSON.stringify(cout.action));
    r = await fetch(base + '/api/central/clock', { method: 'POST', headers: H(token), body: JSON.stringify({ pin: '0000' }) });
    check('bad PIN rejected (404)', r.status === 404, 'status=' + r.status);

    // Auto-generate store requests from each store's recent sales (7-day covers).
    const gen = await j(await fetch(base + '/api/central/generate-requests', { method: 'POST', headers: H(token), body: '{}' }));
    check('CK generate requests from sales', gen.success && gen.generated > 0 && gen.stores > 0, JSON.stringify({ g: gen.generated, s: gen.stores }));
    const demGen = await j(await fetch(base + '/api/central/demand', { headers: H(token) }));
    check('generated demand reflects sales volume', demGen.products.some(p => p.total_requested > 0 && p.by_store.length > 0));

    // RBAC: central kitchen is owner/admin only
    r = await fetch(base + '/api/central/summary', { headers: H(mgr.token) });
    check('manager blocked from central kitchen (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + '/api/central/summary', { headers: H(emp.token) });
    check('employee blocked from central kitchen (403)', r.status === 403, 'status=' + r.status);

    // ── Central-Kitchen distribution (raw-food warehouse → stores) ──────────
    const ckStock = await j(await fetch(base + '/api/distribution/ck-stock', { headers: H(token) }));
    check('CK distribution stock lists warehouse items', !!ckStock.location && ckStock.items.length >= 40 && ckStock.items.some(i => i.low) && ckStock.items.every(i => 'free' in i && 'reserved' in i), 'n=' + ckStock.items.length);
    const ckStar0 = ckStock.items.find(i => i.item_name === 'Star Anise').quantity; // seeded low

    const avail = await j(await fetch(base + `/api/distribution/availability?location_id=${loc2}`, { headers: H(token) }));
    const availStar = avail.items.find(i => i.item_name === 'Star Anise');
    check('availability splits CK-first vs vendor', !!availStar && availStar.from_ck > 0 && availStar.from_vendor > 0 && availStar.need === availStar.from_ck + availStar.from_vendor, JSON.stringify(availStar && { need: availStar.need, ck: availStar.from_ck, v: availStar.from_vendor }));
    check('availability covers some items fully from CK', avail.items.some(i => i.from_vendor === 0 && i.from_ck > 0), 'none fully from CK');

    r = await fetch(base + '/api/distribution/order', { method: 'POST', headers: H(token), body: JSON.stringify({ location_id: loc2, items: [{ item_id: availStar.id, item_name: 'Star Anise', quantity: availStar.need }] }) });
    const placed = await j(r);
    check('place a CK-first distribution order', r.status === 200 && placed.created === 1, JSON.stringify(placed));

    const ckQueue = await j(await fetch(base + '/api/distribution/orders?scope=ck', { headers: H(token) }));
    const dord = ckQueue.orders.find(o => o.item_name === 'Star Anise' && o.status === 'requested' && o.to_location_id === loc2);
    check('order splits with an auto vendor PO', !!dord && dord.ck_qty === availStar.from_ck && dord.vendor_qty === availStar.from_vendor && dord.vendor_order_id > 0 && dord.vendor_status === 'pending', JSON.stringify(dord && { ck: dord.ck_qty, v: dord.vendor_qty, po: dord.vendor_order_id }));

    r = await fetch(base + `/api/distribution/orders/${dord.id}`, { method: 'PUT', headers: H(token), body: JSON.stringify({ status: 'shipped' }) });
    check('ship the CK order', r.status === 200, await r.text());
    const ckStar1 = (await j(await fetch(base + '/api/distribution/ck-stock', { headers: H(token) }))).items.find(i => i.item_name === 'Star Anise').quantity;
    check('shipping deducts CK stock', Math.abs(ckStar1 - (ckStar0 - dord.ck_qty)) < 1e-9, JSON.stringify({ before: ckStar0, after: ckStar1, ck: dord.ck_qty }));

    const storeStar0 = (await j(await fetch(base + `/api/inventory/?location_id=${loc2}`, { headers: H(token) }))).find(i => i.item_name === 'Star Anise').quantity;
    r = await fetch(base + `/api/distribution/orders/${dord.id}`, { method: 'PUT', headers: H(token), body: JSON.stringify({ status: 'received' }) });
    check('receive the CK order', r.status === 200, await r.text());
    const storeStar1 = (await j(await fetch(base + `/api/inventory/?location_id=${loc2}`, { headers: H(token) }))).find(i => i.item_name === 'Star Anise').quantity;
    check('receiving lands CK stock in the store', Math.abs(storeStar1 - (storeStar0 + dord.ck_qty)) < 1e-9, JSON.stringify({ before: storeStar0, after: storeStar1, ck: dord.ck_qty }));
    r = await fetch(base + `/api/distribution/orders/${dord.id}`, { method: 'PUT', headers: H(token), body: JSON.stringify({ status: 'shipped' }) });
    check('a received order cannot be re-shipped (400)', r.status === 400, 'status=' + r.status);

    r = await fetch(base + '/api/distribution/order', { method: 'POST', headers: H(token), body: JSON.stringify({ location_id: loc2, source: 'vendor', items: [{ item_id: availStar.id, item_name: 'Star Anise', quantity: 6 }] }) });
    check('vendor-only override order', (await j(r)).created === 1);
    const vOrder = (await j(await fetch(base + `/api/distribution/orders?scope=store&location_id=${loc2}`, { headers: H(token) }))).orders.find(o => o.item_name === 'Star Anise' && o.ck_qty === 0);
    check('vendor-only order skips CK (all vendor, settled)', !!vOrder && vOrder.vendor_qty === 6 && vOrder.status === 'received' && vOrder.vendor_order_id > 0, JSON.stringify(vOrder && { ck: vOrder.ck_qty, v: vOrder.vendor_qty, s: vOrder.status }));

    // RBAC: store staff can't touch the CK warehouse or its incoming queue.
    r = await fetch(base + '/api/distribution/ck-stock', { headers: H(mgr.token) });
    check('store manager blocked from CK warehouse (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + '/api/distribution/orders?scope=ck', { headers: H(mgr.token) });
    check('store manager blocked from CK queue (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + '/api/distribution/ck-stock', { headers: H(emp.token) });
    check('employee blocked from CK warehouse (403)', r.status === 403, 'status=' + r.status);

    // ── Timesheet: late/OT flags, rounding, approve-total, OT escalation ──
    const tdb = require('../db/database');
    const tsLoc = mgr.user.location_id;
    const tsUser = (await j(await fetch(base + '/api/staff', { headers: H(mgr.token) })))[0];
    const TD = '2026-08-10';
    tdb.prepare(`DELETE FROM time_entries WHERE user_id=? AND work_date=?`).run(tsUser.id, TD);
    tdb.prepare(`DELETE FROM ot_approvals WHERE user_id=? AND work_date=?`).run(tsUser.id, TD);
    tdb.prepare(`DELETE FROM time_adjustments WHERE user_id=? AND work_date=?`).run(tsUser.id, TD);
    tdb.prepare(`DELETE FROM timesheet_approvals WHERE user_id=? AND period_start=?`).run(tsUser.id, TD);
    const ci = new Date(TD + 'T15:00:00Z'), co = new Date(ci.getTime() + 600 * 60000);
    tdb.prepare(`INSERT INTO time_entries (user_id,location_id,work_date,clock_in,clock_out,scheduled_minutes,worked_minutes,late_minutes,short_confirmed,opened_by) VALUES (?,?,?,?,?,?,?,?,0,?)`)
      .run(tsUser.id, tsLoc, TD, ci.toISOString(), co.toISOString(), 480, 600, 20, tsUser.id);
    const tsGet = async (tok) => j(await fetch(base + `/api/timeclock/payroll?location_id=${tsLoc}&kind=daily&start=${TD}&end=${TD}`, { headers: H(tok) }));
    let ts = await tsGet(mgr.token), row = ts.staff.find(s => s.user_id === tsUser.id);
    check('timesheet flags OT + late', row && row.ot_pending_hours === 2 && row.late_minutes === 20, JSON.stringify(row && { ot: row.ot_pending_hours, late: row.late_minutes }));
    r = await fetch(base + '/api/timeclock/ot-escalate', { method: 'POST', headers: H(mgr.token), body: JSON.stringify({ location_id: tsLoc, user_id: tsUser.id, work_date: TD, note: 'coverage' }) });
    check('manager escalates OT', r.status === 200, 'status=' + r.status);
    const reqs = await j(await fetch(base + '/api/timeclock/ot-requests', { headers: H(token) }));
    check('leadership sees escalated OT request', reqs.requests.some(x => x.user_id === tsUser.id && x.work_date === TD));
    r = await fetch(base + '/api/timeclock/ot-requests', { headers: H(mgr.token) });
    check('manager cannot see leadership OT queue (403)', r.status === 403, 'status=' + r.status);
    r = await fetch(base + '/api/timeclock/ot-approval', { method: 'PUT', headers: H(token), body: JSON.stringify({ location_id: tsLoc, user_id: tsUser.id, work_date: TD, approved: true, note: 'ok' }) });
    check('leadership approves escalated OT', r.status === 200, 'status=' + r.status);
    check('escalated queue clears after approval', !(await j(await fetch(base + '/api/timeclock/ot-requests', { headers: H(token) }))).requests.some(x => x.user_id === tsUser.id && x.work_date === TD));
    r = await fetch(base + '/api/timeclock/adjust', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: tsLoc, user_id: tsUser.id, work_date: TD, adjusted_minutes: 480, note: 'rounded' }) });
    check('manager rounds a day', r.status === 200, 'status=' + r.status);
    ts = await tsGet(mgr.token); row = ts.staff.find(s => s.user_id === tsUser.id);
    check('rounding sets the effective total', row && row.total_hours === 8, 'total=' + (row && row.total_hours));
    r = await fetch(base + '/api/timeclock/approve-total', { method: 'POST', headers: H(mgr.token), body: JSON.stringify({ location_id: tsLoc, user_id: tsUser.id, period_kind: 'daily', period_start: TD, period_end: TD, note: 'signed off' }) });
    check('approve the daily total', r.status === 200, 'status=' + r.status);
    check('period shows approved', (await tsGet(mgr.token)).staff.find(s => s.user_id === tsUser.id).approved === 1);
    // Staff self-view (my-hours) + manager performance history.
    const tsEmail = tdb.prepare(`SELECT email FROM users WHERE id=?`).get(tsUser.id).email;
    const mh = await j(await fetch(base + `/api/timeclock/my-hours?as=${encodeURIComponent(tsEmail)}&kind=daily&anchor=${TD}`, { headers: { 'X-Service-Key': 'dev-floorplan-key' } }));
    check('my-hours self-view returns the day (rounded 8h)', mh.days && mh.days.length === 1 && mh.days[0].effective_min === 480, JSON.stringify(mh.days && mh.days[0]));
    r = await fetch(base + '/api/timeclock/my-hours');
    check('my-hours needs auth (401)', r.status === 401, 'status=' + r.status);
    const perf = await j(await fetch(base + `/api/timeclock/performance?location_id=${tsLoc}&start=${TD}&end=${TD}`, { headers: H(mgr.token) }));
    check('performance history tallies the day', perf.staff.some(s => s.user_id === tsUser.id && s.days === 1));
    r = await fetch(base + '/api/timeclock/performance?location_id=' + tsLoc, { headers: H(emp.token) });
    check('performance history blocked from staff (403)', r.status === 403, 'status=' + r.status);

    // ── Messaging: directory unification, group send, service-key as-user ──
    const mrecips = await j(await fetch(base + '/api/messages/recipients', { headers: H(token) }));
    check('directory unified: 10 front-desk hosts', mrecips.filter(u => u.role === 'frontdesk').length === 10, 'fd=' + mrecips.filter(u => u.role === 'frontdesk').length);
    const twoIds = mrecips.slice(0, 2).map(u => u.id);
    r = await fetch(base + '/api/messages', { method: 'POST', headers: H(token), body: JSON.stringify({ recipient_ids: twoIds, subject: 'Smoke group', body: 'hi team' }) });
    const gsend = await j(r);
    check('group send delivers to N recipients', r.status === 200 && gsend.recipients === 2, JSON.stringify(gsend));
    // Threading: reply to a message, then read the full conversation back.
    r = await fetch(base + '/api/messages/' + gsend.id + '/reply', { method: 'POST', headers: H(token), body: JSON.stringify({ body: 'follow-up' }) });
    check('reply to a message (threaded)', r.status === 200 && (await j(r)).success === true, 'status=' + r.status);
    const thread = await j(await fetch(base + '/api/messages/thread/' + gsend.id, { headers: H(token) }));
    check('thread returns the full conversation', Array.isArray(thread.messages) && thread.messages.length === 2, 'n=' + (thread.messages || []).length);
    // Archive + mark-unread (recipient state — test as the actual recipient host1).
    const SK = { 'X-Service-Key': 'dev-floorplan-key', 'Content-Type': 'application/json' };
    const host1 = mrecips.find(u => u.name === 'Front Desk 1');
    const arootId = (await j(await fetch(base + '/api/messages', { method: 'POST', headers: H(token), body: JSON.stringify({ recipient_ids: [host1.id], subject: 'Arch smoke', body: 'x' }) }))).id;
    // Collapsed inbox: a second message in the thread must not add a second row.
    await fetch(base + '/api/messages/' + arootId + '/reply', { method: 'POST', headers: H(token), body: JSON.stringify({ body: 'second' }) });
    const arow = (await j(await fetch(base + '/api/messages/inbox?as=host1@phohanoi.com', { headers: SK }))).filter(m => m.thread_id === arootId);
    check('inbox collapses a thread to one row', arow.length === 1 && arow[0].thread_count >= 2, 'rows=' + arow.length + ' count=' + (arow[0] && arow[0].thread_count));
    r = await fetch(base + '/api/messages/thread/' + arootId + '/archive?as=host1@phohanoi.com', { method: 'POST', headers: SK });
    check('archive a conversation', r.status === 200, 'status=' + r.status);
    let hInbox = await j(await fetch(base + '/api/messages/inbox?as=host1@phohanoi.com', { headers: SK }));
    check('archived thread leaves the active inbox', !hInbox.some(m => m.thread_id === arootId));
    hInbox = await j(await fetch(base + '/api/messages/inbox?archived=1&as=host1@phohanoi.com', { headers: SK }));
    check('archived thread shows in the archive', hInbox.some(m => m.thread_id === arootId));
    r = await fetch(base + '/api/messages/thread/' + arootId + '/unarchive?as=host1@phohanoi.com', { method: 'POST', headers: SK });
    check('unarchive a conversation', r.status === 200, 'status=' + r.status);
    r = await fetch(base + '/api/messages/thread/' + arootId + '/unread?as=host1@phohanoi.com', { method: 'POST', headers: SK });
    check('mark a conversation unread', r.status === 200, 'status=' + r.status);
    r = await fetch(base + '/api/messages/inbox?as=host1@phohanoi.com', { headers: { 'X-Service-Key': 'dev-floorplan-key' } });
    check('service-key as-user inbox (200)', r.status === 200 && Array.isArray(await r.json()), 'status=' + r.status);
    r = await fetch(base + '/api/messages/inbox?as=nobody@nowhere.test', { headers: { 'X-Service-Key': 'dev-floorplan-key' } });
    check('service-key unknown user rejected (401)', r.status === 401, 'status=' + r.status);
    r = await fetch(base + '/api/messages/inbox');
    check('messages needs auth (401)', r.status === 401, 'status=' + r.status);
    // Live message push (SSE): unauthenticated 401, authenticated event-stream.
    r = await fetch(base + '/api/messages/stream');
    check('message stream needs auth (401)', r.status === 401, 'status=' + r.status);
    {
      const ac = new AbortController();
      const sr = await fetch(base + '/api/messages/stream?token=' + token, { signal: ac.signal });
      check('message stream opens (200 + event-stream)',
        sr.status === 200 && /text\/event-stream/.test(sr.headers.get('content-type') || ''), 'ct=' + sr.headers.get('content-type'));
      ac.abort();
    }

    // Live push (SSE): the visit stream authenticates by query token and streams events.
    r = await fetch(base + '/api/visits/stream');
    check('visit stream needs auth (401)', r.status === 401, 'status=' + r.status);
    {
      const ac = new AbortController();
      const sr = await fetch(base + `/api/visits/stream?token=${token}`, { signal: ac.signal });
      check('visit stream opens (200 + event-stream)',
        sr.status === 200 && /text\/event-stream/.test(sr.headers.get('content-type') || ''),
        'ct=' + sr.headers.get('content-type'));
      ac.abort();
    }
  } catch (e) {
    fail++; console.log('  FAIL  exception: ' + e.message);
  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
