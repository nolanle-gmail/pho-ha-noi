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
  for (const t of ['message_recipients', 'messages', 'recipe_ingredients', 'menu_items', 'menu_categories',
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
  locIds.forEach((lid, i) => mkUser(`Manager ${i + 1}`, `manager${i + 1}@phohanoi.com`, 'Manager123!', 'manager', lid));
  mkUser('Support Staff', 'support@phohanoi.com', 'Support123!', 'support', locIds[0]);
  mkUser('Employee One', 'employee@phohanoi.com', 'Employee123!', 'employee', locIds[0]);
  // Hourly rates drive labor-cost figures in the Timesheets report.
  db.exec(`UPDATE users SET hourly_rate = CASE role WHEN 'manager' THEN 30 WHEN 'support' THEN 22 WHEN 'employee' THEN 18 ELSE 0 END`);
  const owner = db.prepare(`SELECT id FROM users WHERE role='owner'`).get();

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

  console.log(`Seeded ${LOCATIONS.length} locations (+ hours, ${equipCount} equipment), ${ITEMS.length} items each, ${VENDORS.length} vendors, ${menuCount} menu items, ${salesRows} sales days, ${tsRows} timesheets, 3 messages.`);
  console.log('Owner login: harry@phohanoi.com / Harry123!');
}

if (require.main === module) { run(); console.log('Seed complete.'); }
module.exports = { run };
