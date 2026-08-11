// Seed Pho Ha Noi with realistic Vietnamese-restaurant inventory across two
// locations, staff, vendors, lots (some expiring), and a couple of open orders.
// Idempotent-ish: wipes and repopulates domain tables each run.
const bcrypt = require('bcryptjs');
const db = require('./database');
const { migrate } = require('./schema');

migrate();

// A pho restaurant's stock, grouped by category.
// [name, category, unit, base_qty, min, par, unit_cost, perishable]
const ITEMS = [
  // Proteins
  ['Beef Bones (marrow)', 'Protein', 'lbs', 180, 60, 240, 1.80, true],
  ['Beef Brisket', 'Protein', 'lbs', 90, 40, 140, 5.20, true],
  ['Beef Flank', 'Protein', 'lbs', 60, 30, 100, 6.10, true],
  ['Eye of Round (sliced)', 'Protein', 'lbs', 70, 30, 110, 7.40, true],
  ['Beef Meatballs (bò viên)', 'Protein', 'lbs', 55, 25, 90, 4.30, true],
  ['Beef Tripe', 'Protein', 'lbs', 25, 15, 50, 3.10, true],
  ['Beef Tendon', 'Protein', 'lbs', 22, 12, 45, 3.60, true],
  ['Whole Chicken', 'Protein', 'lbs', 80, 40, 130, 2.20, true],
  // Noodles & dry
  ['Rice Noodles (bánh phở)', 'Noodles', 'lbs', 140, 60, 220, 1.10, false],
  ['Vermicelli (bún)', 'Noodles', 'lbs', 60, 25, 100, 1.20, false],
  ['Rice Paper', 'Noodles', 'pack', 40, 20, 80, 2.40, false],
  // Produce
  ['Yellow Onion', 'Produce', 'lbs', 90, 40, 140, 0.55, true],
  ['Ginger', 'Produce', 'lbs', 30, 15, 55, 1.30, true],
  ['Bean Sprouts', 'Produce', 'lbs', 45, 30, 90, 0.90, true],
  ['Thai Basil', 'Produce', 'bunch', 60, 40, 120, 0.45, true],
  ['Cilantro', 'Produce', 'bunch', 55, 35, 110, 0.40, true],
  ['Green Onion', 'Produce', 'bunch', 70, 45, 130, 0.35, true],
  ['Culantro (ngò gai)', 'Produce', 'bunch', 30, 20, 70, 0.60, true],
  ['Lime', 'Produce', 'each', 200, 100, 400, 0.15, true],
  ['Jalapeño', 'Produce', 'lbs', 20, 10, 40, 1.10, true],
  ['Napa Cabbage', 'Produce', 'lbs', 25, 12, 50, 0.70, true],
  // Pantry & spices
  ['Fish Sauce', 'Pantry', 'gal', 12, 6, 24, 9.50, false],
  ['Hoisin Sauce', 'Pantry', 'bottle', 30, 15, 60, 3.20, false],
  ['Sriracha', 'Pantry', 'bottle', 28, 15, 60, 2.80, false],
  ['Rock Sugar', 'Pantry', 'lbs', 40, 20, 80, 1.40, false],
  ['Salt', 'Pantry', 'lbs', 50, 20, 90, 0.35, false],
  ['Star Anise', 'Spices', 'lbs', 8, 4, 16, 12.00, false],
  ['Cinnamon Stick', 'Spices', 'lbs', 7, 4, 15, 10.50, false],
  ['Cardamom (black)', 'Spices', 'lbs', 3, 2, 8, 24.00, false],
  ['Cloves', 'Spices', 'lbs', 3, 2, 8, 18.00, false],
  ['Coriander Seed', 'Spices', 'lbs', 6, 3, 12, 6.50, false],
  ['Fennel Seed', 'Spices', 'lbs', 5, 3, 12, 5.80, false],
  ['MSG', 'Pantry', 'lbs', 15, 6, 30, 2.10, false],
  ['Black Pepper', 'Spices', 'lbs', 10, 4, 20, 8.00, false],
  // Beverage
  ['Vietnamese Coffee (ground)', 'Beverage', 'lbs', 24, 12, 48, 7.20, false],
  ['Condensed Milk', 'Beverage', 'can', 60, 30, 120, 1.60, false],
  ['Jasmine Tea', 'Beverage', 'lbs', 10, 5, 20, 6.00, false],
  ['Soda (assorted)', 'Beverage', 'case', 20, 10, 40, 9.00, false],
  ['Coconut Water', 'Beverage', 'case', 15, 8, 30, 14.00, false],
  // Packaging
  ['To-Go Soup Bowls (32oz)', 'Packaging', 'case', 18, 10, 40, 32.00, false],
  ['To-Go Lids', 'Packaging', 'case', 18, 10, 40, 18.00, false],
  ['Chopsticks', 'Packaging', 'case', 12, 6, 24, 22.00, false],
  ['Napkins', 'Packaging', 'case', 20, 10, 40, 16.00, false],
  ['Plastic Spoons', 'Packaging', 'case', 14, 8, 30, 12.00, false],
  ['To-Go Bags', 'Packaging', 'case', 16, 8, 32, 20.00, false],
  // Cleaning
  ['Dish Soap', 'Cleaning', 'gal', 8, 4, 16, 11.00, false],
  ['Sanitizer', 'Cleaning', 'gal', 6, 3, 12, 13.00, false],
  ['Paper Towels', 'Cleaning', 'case', 10, 5, 20, 24.00, false],
  ['Trash Bags', 'Cleaning', 'case', 9, 4, 18, 19.00, false],
];

// [name, address, city, state, zip, phone, seats, opening_date]
const LOCATIONS = [
  ['Pho Ha Noi — San Jose', '123 Santana Row', 'San Jose', 'CA', '95128', '(408) 555-0181', 78, '2021-06-01'],
  ['Pho Ha Noi — Milpitas', '456 Great Mall Dr', 'Milpitas', 'CA', '95035', '(408) 555-0142', 54, '2022-01-15'],
  ['Pho Ha Noi — Cupertino', '789 Stevens Creek Blvd', 'Cupertino', 'CA', '95014', '(408) 555-0193', 66, '2022-05-01'],
  ['Pho Ha Noi — Fremont', '321 Fremont Blvd', 'Fremont', 'CA', '94538', '(510) 555-0124', 60, '2022-09-01'],
  ['Pho Ha Noi — Palo Alto', '654 University Ave', 'Palo Alto', 'CA', '94301', '(650) 555-0165', 84, '2023-01-10'],
  ['Pho Ha Noi — Berkeley', '987 Shattuck Ave', 'Berkeley', 'CA', '94704', '(510) 555-0136', 48, '2023-04-01'],
  ['Pho Ha Noi — Fountain Valley', '159 Brookhurst St', 'Fountain Valley', 'CA', '92708', '(714) 555-0117', 70, '2023-07-01'],
  ['Pho Ha Noi — Santa Clara', '753 El Camino Real', 'Santa Clara', 'CA', '95050', '(408) 555-0158', 62, '2023-10-01'],
  ['Pho Ha Noi — Sunnyvale', '852 Murphy Ave', 'Sunnyvale', 'CA', '94086', '(408) 555-0149', 58, '2024-02-01'],
  ['Pho Ha Noi — Oakland', '426 Broadway', 'Oakland', 'CA', '94607', '(510) 555-0170', 72, '2024-06-01'],
];

// Weekly hours (index 0=Mon … 6=Sun): [open, close]
const HOURS = [['10:00', '22:00'], ['10:00', '22:00'], ['10:00', '22:00'], ['10:00', '22:00'], ['10:00', '23:00'], ['09:00', '23:00'], ['09:00', '21:00']];

// Standard restaurant equipment template: [name, category, vendor, vendor_phone, model, maintenance_freq]
const EQUIPMENT = [
  ['Walk-in Cooler', 'Refrigeration', 'CoolTech Refrigeration', '(800) 555-2100', 'CT-WC8x10', 'quarterly'],
  ['Walk-in Freezer', 'Refrigeration', 'CoolTech Refrigeration', '(800) 555-2100', 'CT-WF6x8', 'quarterly'],
  ['Pho Broth Kettle (100 qt)', 'Cooking', 'Vulcan Equipment', '(800) 555-3300', 'VK-100ST', 'monthly'],
  ['6-Burner Range', 'Cooking', 'Vulcan Equipment', '(800) 555-3300', 'V6B-36', 'quarterly'],
  ['Deep Fryer (dual)', 'Cooking', 'Vulcan Equipment', '(800) 555-3300', 'VF-2X', 'monthly'],
  ['Commercial Rice Cooker', 'Cooking', 'Town Foodservice', '(800) 555-4400', 'TRC-55', 'biannual'],
  ['Ice Machine', 'Refrigeration', 'Hoshizaki Service', '(800) 555-5500', 'HZ-500', 'quarterly'],
  ['Conveyor Dishwasher', 'Cleaning', 'Ecolab', '(800) 555-6600', 'EC-DW44', 'monthly'],
  ['Exhaust Hood & Fire Suppression', 'Safety', 'BaySafe Fire', '(800) 555-7700', 'BS-Hood12', 'biannual'],
  ['POS Terminal', 'Technology', 'Toast POS', '(800) 555-8800', 'Toast Flex', 'as_needed'],
  ['Prep Table Refrigerator', 'Refrigeration', 'CoolTech Refrigeration', '(800) 555-2100', 'CT-PT48', 'quarterly'],
  ['Steam Table / Soup Warmer', 'Cooking', 'Town Foodservice', '(800) 555-4400', 'TS-6W', 'quarterly'],
];

const VENDORS = [
  ['Golden Ox Meats', 'Danny Vo', '(408) 555-0140', 'orders@goldenox.example', 1, 'Beef bones, brisket, flank'],
  ['Saigon Produce Co.', 'Linh Tran', '(408) 555-0177', 'sales@saigonproduce.example', 1, 'Herbs, sprouts, onion, lime'],
  ['Mekong Dry Goods', 'Peter Ng', '(408) 555-0192', 'peter@mekongdry.example', 2, 'Noodles, spices, sauces'],
  ['Bay Restaurant Supply', 'Karen Ho', '(408) 555-0110', 'karen@bayrsupply.example', 3, 'Packaging, cleaning'],
];

const rng = (() => { let s = 20260804; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function run() {
  // Clear domain tables (children before parents for FK safety).
  for (const t of ['ck_recipe_ingredients', 'store_requests', 'ck_production_runs', 'ck_tasks', 'ck_shifts', 'ck_products',
                   'message_recipients', 'messages', 'recipe_ingredients', 'menu_items', 'menu_categories',
                   'daily_sales', 'timesheets', 'equipment', 'location_hours',
                   'inventory_transactions', 'inventory_lots', 'waste_log', 'cycle_counts',
                   'supply_orders', 'transfer_requests', 'inventory', 'vendors', 'audit_log', 'users', 'locations']) {
    db.exec(`DELETE FROM ${t}`);
  }

  const insLoc = db.prepare(`INSERT INTO locations (name,address,city,state,zip,phone,email,timezone,opening_date,seats,status,is_active) VALUES (?,?,?,?,?,?,?,?,?,?, 'active',1)`);
  const insHours = db.prepare(`INSERT INTO location_hours (location_id,day_of_week,open_time,close_time,is_closed) VALUES (?,?,?,?,0)`);
  const locIds = LOCATIONS.map(([name, addr, city, state, zip, phone, seats, opening]) => {
    const email = city.toLowerCase().replace(/[^a-z]/g, '') + '@phohanoi.com';
    const id = insLoc.run(name, addr, city, state, zip, phone, email, 'America/Los_Angeles', opening, seats).lastInsertRowid;
    HOURS.forEach((h, d) => insHours.run(id, d, h[0], h[1]));
    return id;
  });

  // Equipment per location (standard set with vendor + maintenance schedule).
  const insEq = db.prepare(`INSERT INTO equipment (location_id,name,category,model,serial,vendor,vendor_phone,purchase_date,warranty_expiry,maintenance_freq,last_service,next_service,status,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const freqDays = { monthly: 30, quarterly: 91, biannual: 182, annual: 365, as_needed: null };
  let equipCount = 0;
  locIds.forEach((lid, li) => {
    const opening = new Date(LOCATIONS[li][7]);
    EQUIPMENT.forEach(([name, cat, vendor, vphone, model, freq], ei) => {
      const purchase = addDays(opening, -14 + ei);
      const warranty = new Date(purchase); warranty.setFullYear(warranty.getFullYear() + 3);
      const last = addDays(new Date(), -(15 + Math.floor(rng() * 45)));
      const fd = freqDays[freq];
      const next = fd ? iso(addDays(last, fd)) : null;
      let status = 'operational';
      const roll = rng();
      if (roll > 0.94) status = 'out_of_order'; else if (roll > 0.82) status = 'needs_service';
      if (next && new Date(next) < new Date() && status === 'operational') status = 'needs_service';
      const serial = 'SN-' + String(lid).padStart(2, '0') + String(ei + 1).padStart(2, '0') + '-' + Math.floor(rng() * 9000 + 1000);
      insEq.run(lid, name, cat, model, serial, vendor, vphone, iso(purchase), iso(warranty), freq, iso(last), next, status, null);
      equipCount++;
    });
  });

  // Users — one account per access level (owner, admin, manager, support, employee).
  const hash = (p) => bcrypt.hashSync(p, 10);
  const mkUser = (name, email, pw, role, lid) =>
    db.prepare(`INSERT INTO users (name,email,password_hash,role,location_id) VALUES (?,?,?,?,?)`).run(name, email, hash(pw), role, lid);
  mkUser('Harry Nguyen', 'harry@phohanoi.com', 'Harry123!', 'owner', null);           // sees everything
  mkUser('Admin User', 'admin@phohanoi.com', 'Admin123!', 'admin', null);             // sees everything (for now)
  // Ten managers, one per store — real names (login emails stay manager1..10@phohanoi.com).
  const MANAGER_NAMES = [
    'Danh Pham', 'Kim Tran', 'Long Nguyen', 'Mai Vo', 'Quang Bui',
    'Linh Dao', 'Tuan Ho', 'Hoa Ly', 'Bao Phan', 'Anh Truong',
  ];
  const managerIds = locIds.map((lid, i) =>
    Number(mkUser(MANAGER_NAMES[i], `manager${i + 1}@phohanoi.com`, 'Manager123!', 'manager', lid).lastInsertRowid));
  mkUser('Support Staff', 'support@phohanoi.com', 'Support123!', 'support', locIds[0]);
  mkUser('Employee One', 'employee@phohanoi.com', 'Employee123!', 'employee', locIds[0]);
  // Demo accounts for the additional access levels.
  mkUser('Grace Kim', 'gm@phohanoi.com', 'Gm123456!', 'general_manager', null);
  mkUser('Aaron Bell', 'analyst@phohanoi.com', 'Analyst123!', 'analyst', null);
  mkUser('Dean Vo', 'driver@phohanoi.com', 'Driver123!', 'driver', locIds[0]);
  mkUser('Sara Tran', 'server@phohanoi.com', 'Server123!', 'server', locIds[0]);
  mkUser('Marco Ly', 'chef@phohanoi.com', 'Chef123456!', 'chef', locIds[0]);
  // Hourly rates drive labor-cost figures in the Timesheets report.
  db.exec(`UPDATE users SET hourly_rate = CASE role WHEN 'manager' THEN 30 WHEN 'support' THEN 22 WHEN 'employee' THEN 18 ELSE 0 END`);
  const owner = db.prepare(`SELECT id FROM users WHERE role='owner'`).get();

  // ── Staff HR profiles + 150 generated staff ────────────────────────────────
  seedStaffProfiles(db, locIds, managerIds);

  // ── Job/task catalog + a demo week of shifts ───────────────────────────────
  seedJobsAndShifts(db, locIds);

  // Vendors
  VENDORS.forEach(([name, contact, phone, email, lead, notes]) =>
    db.prepare(`INSERT INTO vendors (name,contact_name,phone,email,lead_time_days,notes) VALUES (?,?,?,?,?,?)`)
      .run(name, contact, phone, email, lead, notes));

  // Items per location (second location slightly lower stock so some go "low").
  const insItem = db.prepare(`INSERT INTO inventory (location_id,item_name,category,unit,quantity,min_quantity,par_level,unit_cost,sku,description,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insLot = db.prepare(`INSERT INTO inventory_lots (item_id,location_id,lot_code,received_qty,quantity,unit_cost,expiry_date,received_by,received_at) VALUES (?,?,?,?,?,?,date('now',?),?,datetime('now'))`);
  const insTxn = db.prepare(`INSERT INTO inventory_transactions (item_id,to_location_id,quantity,type,user_id,notes) VALUES (?,?,?,'in',?,?)`);

  // Short glossary descriptions for notable items; the rest get a sensible default.
  const DESC = {
    'Beef Bones (marrow)': 'Marrow & knuckle bones — the base of the pho broth, simmered 8–12 hrs.',
    'Beef Brisket': 'Chín (well-done) brisket, sliced for topping bowls.',
    'Beef Flank': 'Nạm — flank, simmered then sliced thin.',
    'Eye of Round (sliced)': 'Tái — raw eye of round, sliced paper-thin, cooked by hot broth.',
    'Beef Meatballs (bò viên)': 'Springy Vietnamese beef meatballs.',
    'Rice Noodles (bánh phở)': 'Flat rice noodles — the heart of every bowl.',
    'Fish Sauce': 'Nước mắm — primary seasoning; premium first-press.',
    'Hoisin Sauce': 'Tương đen — sweet bean sauce served on the side.',
    'Sriracha': 'Tương ớt — chili sauce served on the side.',
    'Rock Sugar': 'Đường phèn — sweetens and rounds out the broth.',
    'Star Anise': 'Hồi — signature warm spice in the broth sachet.',
    'Cinnamon Stick': 'Quế — cassia bark, core broth spice.',
    'Thai Basil': 'Húng quế — served on the garnish plate.',
    'Culantro (ngò gai)': 'Ngò gai — sawtooth herb for the garnish plate.',
    'Vietnamese Coffee (ground)': 'Dark roast with chicory for cà phê sữa đá.',
    'Condensed Milk': 'Sweetened condensed milk for coffee & drinks.',
  };
  const NOTE = {
    'Beef Bones (marrow)': 'Store frozen; blanch before the long simmer.',
    'Eye of Round (sliced)': 'Keep at 34°F; slice to order.',
    'Bean Sprouts': 'Highly perishable — rotate daily, check the FIFO lots.',
    'Thai Basil': 'Refrigerate; discard wilted bunches.',
    'Fish Sauce': 'Bulk from Mekong Dry Goods; shelf-stable.',
  };
  const descFor = (name, cat, unit) => DESC[name] || `${cat} item, tracked by the ${unit}.`;

  let sku = 1000;
  locIds.forEach((lid, li) => {
    ITEMS.forEach(([name, cat, unit, baseQty, min, par, cost, perishable]) => {
      // Each location carries a different stock level so dashboards vary.
      const FACTORS = [1, 0.55, 0.8, 0.65, 0.95, 0.5, 0.75, 0.85, 0.6, 0.7];
      const factor = FACTORS[li] != null ? FACTORS[li] : 0.7;
      let qty = Math.round(baseQty * factor);
      // Force a few below-min items at a couple of branches to exercise reorder.
      if ((li === 1 && ['Beef Flank', 'Thai Basil', 'Lime', 'Star Anise', 'Sriracha'].includes(name)) ||
          (li === 5 && ['Beef Brisket', 'Cilantro', 'Fish Sauce'].includes(name))) {
        qty = Math.max(0, Math.round(min * 0.5)); // force some low-stock
      }
      sku++;
      const itemId = insItem.run(lid, name, cat, unit, qty, min, par, cost, 'PHN-' + sku, descFor(name, cat, unit), NOTE[name] || null).lastInsertRowid;
      if (qty > 0) {
        insTxn.run(itemId, lid, qty, owner.id, 'Opening stock');
        if (perishable) {
          // Perishables get dated lots: split into a fresh lot and a soon-to-expire one.
          const soon = li === 0 ? '+4 days' : '+2 days';
          const fresh = '+12 days';
          const half = Math.max(1, Math.round(qty / 2));
          insLot.run(itemId, lid, 'LOT-' + itemId + 'A', half, half, cost, soon, owner.id);
          insLot.run(itemId, lid, 'LOT-' + itemId + 'B', qty - half, qty - half, cost, fresh, owner.id);
        } else {
          insLot.run(itemId, lid, 'LOT-' + itemId, qty, qty, cost, '+180 days', owner.id);
        }
      }
    });
  });

  // A couple of already-expired lots at Downtown to exercise the expiring view.
  const expItem = db.prepare(`SELECT id FROM inventory WHERE item_name='Bean Sprouts' AND location_id=?`).get(locIds[0]);
  if (expItem) db.prepare(`INSERT INTO inventory_lots (item_id,location_id,lot_code,received_qty,quantity,unit_cost,expiry_date,received_by,received_at) VALUES (?,?,?,?,?,?,date('now','-1 days'),?,datetime('now','-6 days'))`)
    .run(expItem.id, locIds[0], 'LOT-OLD-SPROUTS', 10, 6, 0.9, owner.id);

  // Sample open supply orders.
  const flank = db.prepare(`SELECT id FROM inventory WHERE item_name='Beef Flank' AND location_id=?`).get(locIds[1]);
  const meatVendor = db.prepare(`SELECT id,name FROM vendors WHERE name='Golden Ox Meats'`).get();
  if (flank) db.prepare(`INSERT INTO supply_orders (item_id,item_name,location_id,quantity,vendor,vendor_id,status,ordered_by,notes) VALUES (?,?,?,?,?,?, 'pending',?,?)`)
    .run(flank.id, 'Beef Flank', locIds[1], 80, meatVendor.name, meatVendor.id, owner.id, 'Weekly beef order');
  const basil = db.prepare(`SELECT id FROM inventory WHERE item_name='Thai Basil' AND location_id=?`).get(locIds[1]);
  const prodVendor = db.prepare(`SELECT id,name FROM vendors WHERE name='Saigon Produce Co.'`).get();
  if (basil) db.prepare(`INSERT INTO supply_orders (item_id,item_name,location_id,quantity,vendor,vendor_id,status,ordered_by,notes) VALUES (?,?,?,?,?,?, 'approved',?,?)`)
    .run(basil.id, 'Thai Basil', locIds[1], 120, prodVendor.name, prodVendor.id, owner.id, 'Herbs restock');

  // ── Menu & recipes ───────────────────────────────────────────────────────
  // [category, [ [name, description, price, [[ingredient, qtyPerServing], ...]] ]]
  const MENU = [
    ['Phở', [
      ['Phở Tái', 'Rare beef, sliced thin, cooked in hot broth', 13.95,
        [['Beef Bones (marrow)', 0.6], ['Rice Noodles (bánh phở)', 0.4], ['Eye of Round (sliced)', 0.25],
         ['Yellow Onion', 0.08], ['Green Onion', 0.05], ['Thai Basil', 0.1], ['Bean Sprouts', 0.15],
         ['Lime', 0.5], ['Fish Sauce', 0.02], ['Star Anise', 0.01], ['Cinnamon Stick', 0.01]]],
      ['Phở Chín', 'Well-done brisket', 13.95,
        [['Beef Bones (marrow)', 0.6], ['Rice Noodles (bánh phở)', 0.4], ['Beef Brisket', 0.3],
         ['Yellow Onion', 0.08], ['Green Onion', 0.05], ['Thai Basil', 0.1], ['Bean Sprouts', 0.15], ['Lime', 0.5], ['Fish Sauce', 0.02]]],
      ['Phở Đặc Biệt', 'House special — rare beef, brisket, meatball, tripe & tendon', 15.95,
        [['Beef Bones (marrow)', 0.6], ['Rice Noodles (bánh phở)', 0.4], ['Eye of Round (sliced)', 0.15],
         ['Beef Brisket', 0.15], ['Beef Meatballs (bò viên)', 0.15], ['Beef Tripe', 0.1], ['Beef Tendon', 0.1],
         ['Yellow Onion', 0.08], ['Green Onion', 0.05], ['Thai Basil', 0.1], ['Bean Sprouts', 0.15], ['Lime', 0.5]]],
      ['Phở Gà', 'Chicken pho', 12.95,
        [['Whole Chicken', 0.4], ['Rice Noodles (bánh phở)', 0.4], ['Yellow Onion', 0.08], ['Ginger', 0.03],
         ['Green Onion', 0.05], ['Cilantro', 0.05], ['Lime', 0.5]]],
      ['Phở Chay', 'Vegetarian pho', 12.5,
        [['Rice Noodles (bánh phở)', 0.4], ['Napa Cabbage', 0.2], ['Bean Sprouts', 0.15], ['Thai Basil', 0.1],
         ['Yellow Onion', 0.08], ['Ginger', 0.03], ['Green Onion', 0.05]]],
    ]],
    ['Appetizers', [
      ['Gỏi Cuốn', 'Fresh spring rolls (2)', 6.5,
        [['Rice Paper', 0.1], ['Vermicelli (bún)', 0.1], ['Bean Sprouts', 0.05], ['Thai Basil', 0.03], ['Hoisin Sauce', 0.05]]],
      ['Chả Giò', 'Crispy fried egg rolls (3)', 6.95,
        [['Rice Paper', 0.08], ['Vermicelli (bún)', 0.05], ['Green Onion', 0.03]]],
    ]],
    ['Beverages', [
      ['Cà Phê Sữa Đá', 'Vietnamese iced coffee', 4.95,
        [['Vietnamese Coffee (ground)', 0.05], ['Condensed Milk', 0.1]]],
      ['Trà Đá', 'Jasmine iced tea', 2.5, [['Jasmine Tea', 0.02]]],
      ['Nước Dừa', 'Coconut water', 3.95, [['Coconut Water', 0.03]]],
    ]],
    ['Desserts', [
      ['Chè', 'Sweet dessert soup', 4.5, [['Rock Sugar', 0.1], ['Condensed Milk', 0.05]]],
    ]],
  ];

  const insCat = db.prepare(`INSERT INTO menu_categories (name, sort_order) VALUES (?,?)`);
  const insMenu = db.prepare(`INSERT INTO menu_items (category_id, name, description, price) VALUES (?,?,?,?)`);
  const insRec = db.prepare(`INSERT INTO recipe_ingredients (menu_item_id, item_name, quantity) VALUES (?,?,?)`);
  let menuCount = 0;
  MENU.forEach(([cat, items], ci) => {
    const catId = insCat.run(cat, ci).lastInsertRowid;
    items.forEach(([name, desc, price, recipe]) => {
      const mid = insMenu.run(catId, name, desc, price).lastInsertRowid;
      recipe.forEach(([ing, qty]) => insRec.run(mid, ing, qty));
      menuCount++;
    });
  });

  // ── Sales (30 days × all locations) — powers Sales, Analytics & Payments ──
  const BASE = [4200, 2600, 3800, 3000, 4600, 2400, 3500, 4000, 2800, 3300]; // per-location daily baseline
  const insSale = db.prepare(`INSERT INTO daily_sales (location_id, sale_date, total_revenue, cash_revenue, card_revenue, online_revenue, cover_count, food_sales, beverage_sales) VALUES (?, date('now', ?), ?,?,?,?,?,?,?)`);
  let salesRows = 0;
  for (let d = 0; d < 30; d++) {
    locIds.forEach((lid, li) => {
      const base = BASE[li] || 3000;
      const rev = Math.round(base * (0.8 + rng() * 0.5));
      const covers = Math.round(rev / (35 + rng() * 20));
      const food = Math.round(rev * 0.78), bev = rev - food;
      const cash = Math.round(rev * (0.2 + rng() * 0.1));
      const online = Math.round(rev * (0.1 + rng() * 0.1));
      const card = rev - cash - online;
      insSale.run(lid, `-${d} days`, rev, cash, card, online, covers, food, bev);
      salesRows++;
    });
  }

  // ── Timesheets (14 days) for hourly staff — powers Timesheets report ──────
  const staff = db.prepare(`SELECT id, location_id FROM users WHERE role IN ('manager','support','employee') AND location_id IS NOT NULL`).all();
  const insTs = db.prepare(`INSERT INTO timesheets (user_id, location_id, clock_in, clock_out, hours) VALUES (?,?, datetime('now', ?), datetime('now', ?), ?)`);
  let tsRows = 0;
  for (let d = 1; d <= 14; d++) {
    staff.forEach(s => {
      if (rng() < 0.25) return; // day off
      const hrs = [6, 7, 8, 8, 9][Math.floor(rng() * 5)];
      const startAgo = d * 24 - 9; // mid-service start
      insTs.run(s.id, s.location_id, `-${startAgo} hours`, `-${startAgo - hrs} hours`, hrs);
      tsRows++;
    });
  }

  // ── Team messages ─────────────────────────────────────────────────────────
  const m1 = db.prepare(`SELECT id FROM users WHERE email='manager1@phohanoi.com'`).get();
  const sup = db.prepare(`SELECT id FROM users WHERE email='support@phohanoi.com'`).get();
  const insMsg = db.prepare(`INSERT INTO messages (sender_id, audience, location_id, subject, body, created_at) VALUES (?,?,?,?,?, datetime('now', ?))`);
  const insMr = db.prepare(`INSERT INTO message_recipients (message_id, user_id, is_read) VALUES (?,?,?)`);
  let mid = insMsg.run(m1.id, 'direct', null, 'Beef Flank running low', 'We are low on Beef Flank at Milpitas — can we expedite this week’s order?', '-3 hours').lastInsertRowid;
  insMr.run(mid, owner.id, 0);
  mid = insMsg.run(sup.id, 'direct', null, 'Produce delivery received', 'Saigon Produce delivery received and logged into inventory.', '-75 minutes').lastInsertRowid;
  insMr.run(mid, owner.id, 0);
  mid = insMsg.run(owner.id, 'all', null, 'Welcome to the Management System', 'Team — our new Pho Ha Noi Management System is live. Please sign in and set your password under Account Settings.', '-1 days').lastInsertRowid;
  db.prepare(`SELECT id FROM users WHERE is_active=1 AND id<>?`).all(owner.id).forEach(u => insMr.run(mid, u.id, 0));

  // ── Central Kitchen (production & supply hub) ───────────────────────────────
  const ckId = db.prepare(`INSERT INTO locations (name,address,city,state,zip,phone,email,timezone,opening_date,seats,type,status,is_active)
    VALUES (?,?,?,?,?,?,?,?,?,0,'central_kitchen','active',1)`)
    .run('Pho Ha Noi — Central Kitchen', '2000 Industrial Pkwy', 'Hayward', 'CA', '94545', '(510) 555-0100', 'kitchen@phohanoi.com', 'America/Los_Angeles', '2021-03-01').lastInsertRowid;
  // CK operating (production) hours: Mon–Sat 04:00–16:00, closed Sunday.
  for (let d = 0; d < 7; d++) db.prepare(`INSERT INTO location_hours (location_id,day_of_week,open_time,close_time,is_closed) VALUES (?,?,?,?,?)`).run(ckId, d, '04:00', '16:00', d === 6 ? 1 : 0);
  // CK equipment.
  [['Industrial Broth Kettle #1', 'Cooking', 'Vulcan Equipment', '(800) 555-3300', 'VK-300ST'],
   ['Industrial Broth Kettle #2', 'Cooking', 'Vulcan Equipment', '(800) 555-3300', 'VK-300ST'],
   ['Blast Chiller', 'Refrigeration', 'CoolTech Refrigeration', '(800) 555-2100', 'CT-BC40'],
   ['Vacuum Sealer / Packaging Line', 'Packaging', 'PackRight Systems', '(800) 555-9100', 'PR-VS8'],
   ['Refrigerated Delivery Van', 'Logistics', 'FleetCo', '(800) 555-9200', 'Isuzu NPR-XD']].forEach(([n, c, v, vp, m], i) =>
    db.prepare(`INSERT INTO equipment (location_id,name,category,model,vendor,vendor_phone,maintenance_freq,status) VALUES (?,?,?,?,?,?,?, 'operational')`).run(ckId, n, c, m, v, vp, i === 4 ? 'quarterly' : 'monthly'));

  // CK staff (with PIN time-clock codes) + a manager.
  const ckStaff = [
    ['Trang Le', 'ck.manager@phohanoi.com', 'CKManager123!', 'manager', 34, '1111'],
    ['Bao Nguyen', 'ck.cook@phohanoi.com', 'CKCook123!', 'support', 24, '2222'],
    ['Mai Pham', 'ck.prep@phohanoi.com', 'CKPrep123!', 'employee', 19, '3333'],
  ].map(([name, email, pw, role, rate, pin]) => {
    const id = db.prepare(`INSERT INTO users (name,email,password_hash,role,location_id,hourly_rate,pin) VALUES (?,?,?,?,?,?,?)`).run(name, email, hash(pw), role, ckId, rate, pin).lastInsertRowid;
    return { id, name, role };
  });

  // CK products with master recipes. [name, unit, batch_yield, shrinkage, safety, on_hand, [[ingredient, qtyPerBatch]]]
  const CK_PRODUCTS = [
    ['Beef Pho Broth', 'gal', 40, 0.06, 300, 220, [['Beef Bones (marrow)', 120], ['Yellow Onion', 20], ['Ginger', 8], ['Star Anise', 2], ['Cinnamon Stick', 2], ['Fish Sauce', 3], ['Rock Sugar', 5], ['Salt', 4]]],
    ['Chicken Pho Broth', 'gal', 30, 0.05, 180, 150, [['Whole Chicken', 60], ['Yellow Onion', 12], ['Ginger', 6], ['Salt', 3], ['Fish Sauce', 2]]],
    ['Sliced Rare Beef', 'lb', 50, 0.04, 400, 260, [['Eye of Round (sliced)', 52]]],
    ['Braised Brisket', 'lb', 40, 0.10, 300, 150, [['Beef Brisket', 48], ['Fish Sauce', 1], ['Rock Sugar', 1]]],
    ['Beef Meatballs (bò viên)', 'lb', 60, 0.03, 260, 280, [['Beef Meatballs (bò viên)', 62]]],
    ['Spice Sachet', 'each', 200, 0.02, 1200, 700, [['Star Anise', 1.5], ['Cinnamon Stick', 1.5], ['Cardamom (black)', 0.5], ['Cloves', 0.5], ['Coriander Seed', 1], ['Fennel Seed', 1]]],
    ['Hoisin-Sriracha Blend', 'bottle', 100, 0.01, 400, 460, [['Hoisin Sauce', 30], ['Sriracha', 20]]],
  ];
  const insCkP = db.prepare(`INSERT INTO ck_products (name,unit,batch_yield,shrinkage_pct,safety_stock,on_hand) VALUES (?,?,?,?,?,?)`);
  const insCkR = db.prepare(`INSERT INTO ck_recipe_ingredients (product_id,item_name,quantity) VALUES (?,?,?)`);
  const ckProdIds = CK_PRODUCTS.map(([name, unit, yld, shr, safety, oh, recipe]) => {
    const pid = insCkP.run(name, unit, yld, shr, safety, oh).lastInsertRowid;
    recipe.forEach(([ing, q]) => insCkR.run(pid, ing, q));
    return pid;
  });

  // Today's store requests to the central kitchen (demand aggregation).
  const insReq = db.prepare(`INSERT INTO store_requests (location_id, product_id, quantity, request_date, status) VALUES (?,?,?, date('now'), 'requested')`);
  const REQ_BASE = [30, 18, 24, 16, 20, 40, 30]; // per-product typical store request
  let reqCount = 0;
  locIds.forEach((lid) => {
    ckProdIds.forEach((pid, pi) => {
      if (rng() < 0.2) return; // not every store orders every product
      const qty = Math.round(REQ_BASE[pi] * (0.6 + rng() * 0.8));
      insReq.run(lid, pid, qty);
      reqCount++;
    });
  });

  // A couple of production runs earlier today/yesterday.
  const insRun = db.prepare(`INSERT INTO ck_production_runs (product_id,batches,planned_output,actual_output,shrinkage_loss,produced_by,produced_at) VALUES (?,?,?,?,?,?, datetime('now', ?))`);
  insRun.run(ckProdIds[0], 5, 188, 185, 15, ckStaff[1].id, '-6 hours');
  insRun.run(ckProdIds[2], 4, 192, 190, 8, ckStaff[1].id, '-5 hours');
  insRun.run(ckProdIds[5], 3, 588, 585, 12, ckStaff[2].id, '-4 hours');

  // CK tasks (some photo-verified) and today's shifts.
  const insTask = db.prepare(`INSERT INTO ck_tasks (title, assigned_to, requires_photo, due) VALUES (?,?,?, date('now'))`);
  insTask.run('QA check morning broth batch', ckStaff[0].id, 1);
  insTask.run('Deep-clean broth kettle #2', ckStaff[1].id, 1);
  insTask.run('Restock spice sachet station', ckStaff[2].id, 0);
  insTask.run('Load North Bay delivery truck', ckStaff[2].id, 1);
  const insShift = db.prepare(`INSERT INTO ck_shifts (user_id, shift_date, start_time, end_time) VALUES (?, date('now'), ?, ?)`);
  ckStaff.forEach((s, i) => insShift.run(s.id, ['04:00', '05:00', '06:00'][i], ['12:00', '13:00', '14:00'][i]));

  console.log(`Seeded ${LOCATIONS.length} locations (+ hours, ${equipCount} equipment), ${ITEMS.length} items each, ${VENDORS.length} vendors, ${menuCount} menu items, ${salesRows} sales days, ${tsRows} timesheets, 3 messages.`);
  console.log('Owner login: harry@phohanoi.com / Harry123!');
}

// ── Staff HR profiles + 150 generated staff ──────────────────────────────────
// Gives the 10 managers (+ support/employee) real HR records, then generates
// 150 staff spread across the stores, each with a full profile for the Directory.
function seedStaffProfiles(db, locIds, managerIds) {
  const rand = (n) => Math.floor(Math.random() * n);
  const pick = (arr) => arr[rand(arr.length)];
  const pad = (n, w) => String(n).padStart(w, '0');

  const FIRST = [
    'An', 'Bao', 'Binh', 'Chau', 'Cuong', 'Dao', 'Diep', 'Duc', 'Dung', 'Giang',
    'Ha', 'Hai', 'Hanh', 'Hieu', 'Hoa', 'Hoang', 'Hong', 'Hue', 'Huy', 'Khanh',
    'Lam', 'Lan', 'Linh', 'Loan', 'Long', 'Mai', 'Minh', 'Nam', 'Nga', 'Ngoc',
    'Nhung', 'Oanh', 'Phong', 'Phuc', 'Phuong', 'Quan', 'Quyen', 'Son', 'Tam', 'Thanh',
    'Thao', 'Thu', 'Thuy', 'Tien', 'Toan', 'Trang', 'Trinh', 'Tuan', 'Tuyet', 'Vy',
    'Alex', 'Amy', 'Brian', 'Cindy', 'David', 'Ella', 'Frank', 'Grace', 'Henry', 'Ivy',
    'Jason', 'Kevin', 'Lisa', 'Nathan', 'Olivia', 'Peter', 'Rachel', 'Steven', 'Tina', 'William',
  ];
  const LAST = [
    'Nguyen', 'Tran', 'Le', 'Pham', 'Hoang', 'Phan', 'Vu', 'Vo', 'Dang', 'Bui',
    'Do', 'Ho', 'Ngo', 'Duong', 'Ly', 'Dinh', 'Dao', 'Truong', 'Cao', 'Mai',
    'Chen', 'Wang', 'Kim', 'Park', 'Garcia', 'Martinez', 'Nguyen-Tran', 'Lam', 'Ta', 'Luu',
  ];
  const CITIES = [
    ['San Jose', '95112'], ['Milpitas', '95035'], ['Cupertino', '95014'], ['Fremont', '94536'],
    ['Palo Alto', '94301'], ['Berkeley', '94704'], ['Santa Clara', '95050'], ['Sunnyvale', '94086'],
    ['Oakland', '94607'], ['Fountain Valley', '92708'],
  ];
  const STREETS = ['Oak', 'Maple', 'Cedar', 'Pine', 'Elm', 'Willow', 'Lincoln', 'Mission', 'Bascom', 'King', 'Alum Rock', 'Story', 'Tully', 'Berryessa'];
  const FOH_TITLES = ['Server', 'Host', 'Cashier', 'Busser', 'Barista', 'Shift Lead', 'Food Runner'];
  const BOH_TITLES = ['Line Cook', 'Prep Cook', 'Dishwasher', 'Kitchen Assistant', 'Broth Cook', 'Grill Cook'];
  const EMP_TYPES = ['full_time', 'full_time', 'full_time', 'part_time', 'part_time', 'seasonal'];
  const STATUSES = ['active', 'active', 'active', 'active', 'active', 'active', 'active', 'active', 'vacation', 'sick', 'inactive'];
  const RELATIONS = ['Spouse', 'Parent', 'Sibling', 'Partner', 'Friend'];
  const CONTACTS = ['phone', 'email', 'text'];
  const SKILLS_FOH = ['customer service', 'POS / register', 'opening', 'closing', 'catering', 'training new hires', 'bilingual (VN/EN)'];
  const SKILLS_BOH = ['broth prep', 'knife skills', 'grill', 'wok', 'food safety', 'inventory', 'noodle station'];

  const phone = () => `(${pick(['408', '510', '650', '669', '714', '925'])}) ${pad(rand(900) + 100, 3)}-${pad(rand(10000), 4)}`;
  const dob = () => `19${pad(rand(38) + 62, 2)}-${pad(rand(12) + 1, 2)}-${pad(rand(28) + 1, 2)}`; // 1962–1999
  const hireDate = () => `20${pad(rand(9) + 16, 2)}-${pad(rand(12) + 1, 2)}-${pad(rand(28) + 1, 2)}`; // 2016–2024

  const insProfile = db.prepare(`INSERT INTO staff_profiles
    (user_id, preferred_name, legal_first_name, legal_last_name, dob, gender, personal_email,
     phone, address_line1, city, state, postal_code, country, emergency_name, emergency_relation,
     emergency_phone, employee_code, job_title, department, employment_type, status, hire_date,
     pay_type, preferred_contact, skills, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(user_id) DO NOTHING`);

  // Build a profile record for an existing user id.
  const mkProfile = (userId, first, last, opts = {}) => {
    const [city, zip] = pick(CITIES);
    const boh = opts.boh !== undefined ? opts.boh : Math.random() < 0.5;
    const title = opts.title || (boh ? pick(BOH_TITLES) : pick(FOH_TITLES));
    const dept = opts.department || (boh ? 'Back of House' : 'Front of House');
    const skills = (boh ? SKILLS_BOH : SKILLS_FOH).filter(() => Math.random() < 0.4);
    insProfile.run(
      userId, first, first, last, dob(), pick(['female', 'male', 'other', '']),
      `${first}.${last}${rand(90) + 10}@gmail.com`.toLowerCase(),
      phone(), `${rand(4000) + 100} ${pick(STREETS)} St`, city, 'CA', zip, 'USA',
      `${pick(FIRST)} ${last}`, pick(RELATIONS), phone(),
      opts.code || `PHN-${pad(userId, 4)}`, title, dept,
      opts.employment_type || pick(EMP_TYPES), opts.status || pick(STATUSES), hireDate(),
      'hourly', pick(CONTACTS), skills.join(', '),
    );
  };

  // Managers, support, employee get real HR records too.
  managerIds.forEach((id, i) => {
    const u = db.prepare(`SELECT name FROM users WHERE id=?`).get(id);
    const [first, ...rest] = (u.name || 'Store Manager').split(' ');
    mkProfile(id, first, rest.join(' ') || 'Manager', {
      title: 'General Manager', department: 'Management', boh: false,
      employment_type: 'full_time', status: 'active', code: `MGR-${pad(i + 1, 3)}`,
    });
  });
  const support = db.prepare(`SELECT id FROM users WHERE role='support' LIMIT 1`).get();
  if (support) mkProfile(support.id, 'Support', 'Staff', { title: 'Inventory Support', department: 'Operations', boh: false, employment_type: 'full_time', status: 'active' });
  const emp = db.prepare(`SELECT id FROM users WHERE email='employee@phohanoi.com'`).get();
  if (emp) mkProfile(emp.id, 'Employee', 'One', { title: 'Server', department: 'Front of House', boh: false, employment_type: 'part_time', status: 'active' });

  // 150 generated staff spread across the stores.
  const insUser = db.prepare(`INSERT INTO users (name,email,password_hash,role,location_id,hourly_rate,is_active) VALUES (?,?,?,?,?,?,?)`);
  const pwHash = bcrypt.hashSync('Staff123!', 10);
  const insAlsoWorks = db.prepare(`INSERT OR IGNORE INTO staff_locations (user_id, location_id) VALUES (?,?)`);
  const usedEmail = new Set();
  let made = 0;
  for (let i = 0; i < 150; i++) {
    const first = pick(FIRST), last = pick(LAST);
    let email = `${first}.${last}${i + 1}@phohanoi.com`.toLowerCase();
    while (usedEmail.has(email)) email = `${first}.${last}${i + 1}.${rand(999)}@phohanoi.com`.toLowerCase();
    usedEmail.add(email);
    const role = Math.random() < 0.18 ? 'support' : 'employee';
    const lid = pick(locIds);
    const boh = Math.random() < 0.5;
    const status = pick(STATUSES);
    const rate = role === 'support' ? 20 + rand(6) : 16 + rand(8);
    const r = insUser.run(`${first} ${last}`, email, pwHash, role, lid, rate, status === 'inactive' ? 0 : 1);
    const uid = Number(r.lastInsertRowid);
    mkProfile(uid, first, last, { boh, status });
    // ~30% also work a second store (transfers / cross-location coverage).
    if (Math.random() < 0.3) { const alt = pick(locIds); if (alt !== lid) insAlsoWorks.run(uid, alt); }
    made++;
  }
  console.log(`Seeded ${managerIds.length} manager profiles + ${made} generated staff with HR profiles.`);
}

// ── Job/task catalog + demo shifts ───────────────────────────────────────────
// The catalog of restaurant jobs a manager can assign to a staff member's shift,
// plus a demo week of scheduled shifts so the location Schedule tab isn't empty.
const JOBS = [
  // [code, name, description, department, complexity, est_minutes, notes]
  ['FOH-01', 'Greet & Seat Guests', 'Welcome guests, manage the waitlist, seat parties, and present menus.', 'Front of House', 'low', 5, 'Set the tone for the visit — warm and prompt.'],
  ['FOH-02', 'Take Orders', 'Take food and drink orders accurately, enter them into the POS, and note allergies/modifications.', 'Front of House', 'medium', 10, 'Always confirm spice level and protein choice for pho.'],
  ['FOH-03', 'Serve Food & Drinks', 'Run and deliver orders to the correct table and verify accuracy before dropping.', 'Front of House', 'low', 5, ''],
  ['FOH-04', 'Bus & Reset Tables', 'Clear dishes, wipe and sanitize surfaces, and reset the table for the next party.', 'Front of House', 'low', 8, ''],
  ['FOH-05', 'Handle Payments', 'Process cash and card payments, close checks in the POS, and keep the drawer balanced.', 'Front of House', 'medium', 5, 'Follow cash-handling policy; no shared drawers.'],
  ['FOH-06', 'Phone & To-Go Orders', 'Take phone and online pickup orders, package to-go correctly, and stage for pickup.', 'Front of House', 'medium', 10, 'Double-check bag contents against the ticket.'],
  ['FOH-07', 'Stock Herb & Condiment Station', 'Refill hoisin/sriracha, herb plates, bean sprouts, limes, and jalapeños.', 'Front of House', 'low', 20, ''],
  ['BOH-01', 'Broth Station (Pho)', 'Monitor and season the simmering broth, hold correct temperature, and maintain levels all shift.', 'Back of House', 'high', 30, 'Signature product — taste and adjust regularly.'],
  ['BOH-02', 'Noodle Station', 'Blanch rice noodles to order, portion bowls, and assemble pho on the line.', 'Back of House', 'medium', 8, ''],
  ['BOH-03', 'Protein Prep', 'Slice rare beef, portion brisket/meatballs/tendon, and prep chicken for service.', 'Back of House', 'high', 30, 'Follow FIFO and label with prep date.'],
  ['BOH-04', 'Line Cook (Wok/Grill)', 'Cook stir-fry, grilled, and fried items to the ticket and to standard.', 'Back of House', 'high', 15, ''],
  ['BOH-05', 'Cold Prep / Garnish', 'Prep vegetables, herbs, garnishes, and roll spring/summer rolls.', 'Back of House', 'medium', 25, ''],
  ['BOH-06', 'Expo / Plating', 'Assemble and quality-check plates at the pass before they leave the kitchen.', 'Back of House', 'high', 10, 'Own the ticket times and call the line.'],
  ['BOH-07', 'Dishwashing', 'Run the dish pit, keep clean dishes stocked, and manage kitchen trash.', 'Back of House', 'low', 45, ''],
  ['BAR-01', 'Prepare Beverages', 'Make Vietnamese coffee, tea, smoothies, and soft drinks to order.', 'Bar', 'medium', 8, ''],
  ['BAR-02', 'Stock Drink Station', 'Restock ice, cups, lids, syrups, and canned drinks.', 'Bar', 'low', 20, ''],
  ['FAC-01', 'Opening Checklist', 'Unlock, power on equipment, run temperature checks, and set up all stations for service.', 'Facilities', 'medium', 30, 'Record walk-in temps on the log.'],
  ['FAC-02', 'Closing Checklist', 'Shut down equipment, secure cash, complete the cleaning list, and lock up.', 'Facilities', 'medium', 30, 'Manager verifies before departure.'],
  ['FAC-03', 'Deep Clean / Sanitation', 'Deep-clean floors, hood, restrooms, and equipment per the sanitation schedule.', 'Facilities', 'medium', 60, ''],
  ['FAC-04', 'Receiving & Restock', 'Receive deliveries, verify invoices against the order, and stock dry/cold storage.', 'Facilities', 'medium', 30, 'Reject anything out of temp or damaged.'],
  ['FAC-05', 'Trash & Recycling', 'Take out trash, break down boxes, and manage recycling/compost.', 'Facilities', 'low', 15, ''],
  ['MGT-01', 'Shift Lead / Floor Manager', 'Oversee service flow, handle guest issues, and coordinate the team on the floor.', 'Management', 'high', 0, 'Point person for the shift.'],
  ['MGT-02', 'Cash Reconciliation', 'Count drawers, prepare the deposit, and record daily sales.', 'Management', 'medium', 20, ''],
  ['MGT-03', 'Inventory Count', 'Perform cycle counts, flag low stock, and place reorders.', 'Management', 'medium', 45, ''],
  ['MGT-04', 'Staff Scheduling', 'Build and adjust the weekly staff schedule and assign jobs.', 'Management', 'medium', 30, ''],
];

// Specific day-of tasks a manager assigns to whoever's working that day.
const SPECIFIC_TASKS = [
  ['CLN-01', 'Clean Restrooms', 'Clean and restock the restrooms; check and initial every 2 hours.', 'Facilities', 'low', 15, 'Log the check on the restroom sheet.'],
  ['CLN-02', 'Help Bus & Clean Tables', 'Jump in during the rush to clear, wipe, sanitize, and reset tables.', 'Front of House', 'low', 0, ''],
  ['CLN-03', 'Help Chef Clean Up (BOH)', 'Assist the kitchen with end-of-shift cleaning and the dish backlog.', 'Back of House', 'low', 0, ''],
  ['CLN-04', 'Sweep & Mop Floors', 'Sweep and mop the dining room, entry, and restroom floors.', 'Facilities', 'low', 15, ''],
  ['CLN-05', 'Sanitize High-Touch Surfaces', 'Wipe door handles, POS screens, menus, and condiment caddies.', 'Facilities', 'low', 10, ''],
  ['CLN-06', 'Restock To-Go Station', 'Refill to-go containers, bags, lids, utensils, and napkins.', 'Front of House', 'low', 10, ''],
];
function seedJobsAndShifts(db, locIds) {
  const insJob = db.prepare(`INSERT INTO jobs (code,name,description,department,complexity,est_minutes,notes,kind) VALUES (?,?,?,?,?,?,?,?)`);
  // Facilities duties are day-of "specific" tasks; the rest are standard role duties.
  const jobIds = JOBS.map(j => Number(insJob.run(...j, j[3] === 'Facilities' ? 'specific' : 'standard').lastInsertRowid));
  SPECIFIC_TASKS.forEach(j => insJob.run(...j, 'specific'));
  const jobByCode = {}; JOBS.forEach((j, i) => { jobByCode[j[0]] = jobIds[i]; });

  // Monday of the current week.
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  // Local-date ISO — toISOString() would shift the date in negative-offset zones.
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dayISO = (offset) => { const d = new Date(monday); d.setDate(monday.getDate() + offset); return iso(d); };

  const insShift = db.prepare(`INSERT INTO shifts (user_id,location_id,shift_date,start_time,end_time,notes,created_by) VALUES (?,?,?,?,?,?,?)`);
  const insSJ = db.prepare(`INSERT OR IGNORE INTO shift_jobs (shift_id, job_id) VALUES (?,?)`);
  const rand = (n) => Math.floor(Math.random() * n);
  const pick = (a) => a[rand(a.length)];
  const AM = ['08:00', '10:00', '17:00']; const shiftLen = { '08:00': '16:00', '10:00': '18:00', '17:00': '23:00' };
  const FOH = ['FOH-01', 'FOH-02', 'FOH-03', 'FOH-04', 'FOH-05', 'FOH-06', 'FOH-07', 'BAR-01'];
  const BOH = ['BOH-01', 'BOH-02', 'BOH-03', 'BOH-04', 'BOH-05', 'BOH-06', 'BOH-07', 'FAC-04'];

  // For the first 4 stores, schedule ~6 staff across Mon–Sat with 1–2 jobs each.
  let shiftCount = 0;
  const mgr = db.prepare(`SELECT id FROM users WHERE role='manager' AND location_id=? LIMIT 1`);
  locIds.slice(0, 4).forEach((lid) => {
    const boss = mgr.get(lid);
    const staff = db.prepare(`SELECT id FROM users WHERE location_id=? AND role IN ('employee','support') AND is_active=1 LIMIT 6`).all(lid);
    staff.forEach((s, si) => {
      // Five working days offset per person so it looks like a real rota.
      for (let d = 0; d < 6; d++) {
        if ((d + si) % 6 === 5) continue; // one day off
        const start = pick(AM);
        const r = insShift.run(s.id, lid, dayISO(d), start, shiftLen[start], null, boss ? boss.id : null);
        const pool = si % 2 === 0 ? FOH : BOH;
        const nJobs = 1 + rand(2);
        const chosen = new Set();
        while (chosen.size < nJobs) chosen.add(pick(pool));
        chosen.forEach(code => insSJ.run(Number(r.lastInsertRowid), jobByCode[code]));
        shiftCount++;
      }
    });
  });
  console.log(`Seeded ${JOBS.length + SPECIFIC_TASKS.length} jobs (${SPECIFIC_TASKS.length} specific tasks) and ${shiftCount} demo shifts for the current week.`);
}

if (require.main === module) { run(); console.log('Seed complete.'); }
module.exports = { run };
