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
    r = await fetch(base + '/api/schedule/jobs', { headers: H(emp.token) });
    check('employee blocked from job catalog (403)', r.status === 403, 'status=' + r.status);

    // ── Scheduling: weekly shifts ──────────────────────────────
    const wk = await j(await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(mgr.token) }));
    check('manager gets weekly schedule', Array.isArray(wk.staff) && !!wk.week_start && wk.days.length === 7, JSON.stringify(wk).slice(0, 80));
    const schedStaff = wk.staff.find(s => s.role !== 'manager') || wk.staff[0];
    const shiftRes = await j(await fetch(base + '/api/schedule/shifts', { method: 'POST', headers: H(mgr.token),
      body: JSON.stringify({ user_id: schedStaff.id, location_id: loc1, shift_date: wk.days[1], start_time: '09:00', end_time: '17:00', job_ids: jobIds, breaks: [{ start_time: '12:00', label: 'Lunch' }] }) }));
    check('manager creates shift with jobs', shiftRes.success === true && !!shiftRes.id, JSON.stringify(shiftRes));
    const wk2 = await j(await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(mgr.token) }));
    const savedShift = (wk2.staff.find(s => s.id === schedStaff.id) || {}).shifts.find(s => s.id === shiftRes.id);
    check('shift appears with assigned jobs', !!savedShift && savedShift.jobs.length === jobIds.length, JSON.stringify(savedShift || {}).slice(0, 80));
    check('break is 10 min with auto end time', !!savedShift && savedShift.breaks.length === 1 && savedShift.breaks[0].start_time === '12:00' && savedShift.breaks[0].end_time === '12:10', JSON.stringify(savedShift && savedShift.breaks));
    const shortRes = await j(await fetch(base + '/api/schedule/shifts', { method: 'POST', headers: H(mgr.token),
      body: JSON.stringify({ user_id: schedStaff.id, location_id: loc1, shift_date: wk.days[2], start_time: '09:00', end_time: '11:00', breaks: [{ start_time: '10:00' }] }) }));
    const wk3 = await j(await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(mgr.token) }));
    const shortShift = (wk3.staff.find(s => s.id === schedStaff.id) || {}).shifts.find(s => s.id === shortRes.id);
    check('no break allowed on a short (<3.5h) shift', !!shortShift && shortShift.breaks.length === 0, JSON.stringify(shortShift && shortShift.breaks));
    // Clear any seeded shifts on the cap-test day so the day total is a controlled 8h (≤10h).
    for (const os of ((wk3.staff.find(s => s.id === schedStaff.id) || {}).shifts || []).filter(s => s.shift_date === wk.days[5])) {
      await fetch(base + `/api/schedule/shifts/${os.id}`, { method: 'DELETE', headers: H(mgr.token) });
    }
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
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[0].job_id, user_id: schedStaff.id }) });
    check('assign a specific day task', r.status === 200, await r.text());
    const dt2 = await j(await fetch(base + `/api/schedule/day-tasks?location_id=${loc1}&date=${dtDay}`, { headers: H(mgr.token) }));
    check('day task shows the assignee', (dt2.tasks.find(t => t.job_id === dt.tasks[0].job_id) || {}).user_id === schedStaff.id, JSON.stringify(dt2.summary));
    const wk6 = await j(await fetch(base + `/api/schedule/week?location_id=${loc1}`, { headers: H(mgr.token) }));
    const st6 = (wk6.staff.find(s => s.id === schedStaff.id) || {}).shifts.find(s => s.shift_date === dtDay);
    check('assigned task appears on staff schedule summary', !!st6 && (st6.tasks || []).some(t => t.id === dt.tasks[0].job_id), JSON.stringify(st6 && st6.tasks));
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
    // Two tasks for the same person must not overlap. tasks[0] now sits at 08:10 (a 15-min slot → 08:10–08:25).
    await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[1].job_id, user_id: schedStaff.id }) });
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[1].job_id, time: '08:15' }) });
    check('overlapping task time rejected (400)', r.status === 400, 'status=' + r.status);
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: dt.tasks[1].job_id, time: '08:25' }) });
    check('adjacent non-overlapping time allowed', r.status === 200, await r.text());
    const stdJob = allJobs.find(x => x.kind === 'standard');
    r = await fetch(base + '/api/schedule/day-tasks', { method: 'PUT', headers: H(mgr.token), body: JSON.stringify({ location_id: loc1, date: dtDay, job_id: stdJob.id, user_id: schedStaff.id }) });
    check('standard job rejected as a day task (400)', r.status === 400, 'status=' + r.status);
    r = await fetch(base + `/api/schedule/day-tasks?location_id=${loc1}`, { headers: H(emp.token) });
    check('employee blocked from day-tasks (403)', r.status === 403, 'status=' + r.status);

    r = await fetch(base + `/api/schedule/shifts/${shiftRes.id}`, { method: 'DELETE', headers: H(mgr.token) });
    check('manager deletes shift', r.status === 200, await r.text());

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
    check('inventory report', repInv.total_value > 0 && repInv.by_category.length >= 4 && repInv.by_location.length === 10 && repInv.top_items.length > 0, JSON.stringify(repInv.total_value));
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
    const theMsg = empInbox.find(m => m.body === 'Welcome aboard!');
    r = await fetch(base + `/api/messages/${theMsg.id}/read`, { method: 'POST', headers: H(emp.token) });
    check('mark message read', r.status === 200);
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
  } catch (e) {
    fail++; console.log('  FAIL  exception: ' + e.message);
  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
