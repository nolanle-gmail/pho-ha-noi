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

const LOCATIONS = [
  ['Pho Ha Noi — San Jose', '123 Santana Row, San Jose, CA 95128'],
  ['Pho Ha Noi — Milpitas', '456 Great Mall Dr, Milpitas, CA 95035'],
  ['Pho Ha Noi — Cupertino', '789 Stevens Creek Blvd, Cupertino, CA 95014'],
  ['Pho Ha Noi — Fremont', '321 Fremont Blvd, Fremont, CA 94538'],
  ['Pho Ha Noi — Palo Alto', '654 University Ave, Palo Alto, CA 94301'],
  ['Pho Ha Noi — Berkeley', '987 Shattuck Ave, Berkeley, CA 94704'],
  ['Pho Ha Noi — Fountain Valley', '159 Brookhurst St, Fountain Valley, CA 92708'],
  ['Pho Ha Noi — Santa Clara', '753 El Camino Real, Santa Clara, CA 95050'],
  ['Pho Ha Noi — Sunnyvale', '852 Murphy Ave, Sunnyvale, CA 94086'],
  ['Pho Ha Noi — Oakland', '426 Broadway, Oakland, CA 94607'],
];

const VENDORS = [
  ['Golden Ox Meats', 'Danny Vo', '(408) 555-0140', 'orders@goldenox.example', 1, 'Beef bones, brisket, flank'],
  ['Saigon Produce Co.', 'Linh Tran', '(408) 555-0177', 'sales@saigonproduce.example', 1, 'Herbs, sprouts, onion, lime'],
  ['Mekong Dry Goods', 'Peter Ng', '(408) 555-0192', 'peter@mekongdry.example', 2, 'Noodles, spices, sauces'],
  ['Bay Restaurant Supply', 'Karen Ho', '(408) 555-0110', 'karen@bayrsupply.example', 3, 'Packaging, cleaning'],
];

function run() {
  // Clear domain tables (respect FK order).
  for (const t of ['inventory_transactions', 'inventory_lots', 'waste_log', 'cycle_counts',
                   'supply_orders', 'transfer_requests', 'inventory', 'vendors', 'audit_log', 'users', 'locations']) {
    db.exec(`DELETE FROM ${t}`);
  }

  const locIds = LOCATIONS.map(([name, addr]) =>
    db.prepare(`INSERT INTO locations (name, address) VALUES (?,?)`).run(name, addr).lastInsertRowid);

  // Users — one account per access level (owner, admin, manager, support, employee).
  const hash = (p) => bcrypt.hashSync(p, 10);
  const mkUser = (name, email, pw, role, lid) =>
    db.prepare(`INSERT INTO users (name,email,password_hash,role,location_id) VALUES (?,?,?,?,?)`).run(name, email, hash(pw), role, lid);
  mkUser('Harry Nguyen', 'harry@phohanoi.com', 'Harry123!', 'owner', null);           // sees everything
  mkUser('Admin User', 'admin@phohanoi.com', 'Admin123!', 'admin', null);             // sees everything (for now)
  locIds.forEach((lid, i) => mkUser(`Manager ${i + 1}`, `manager${i + 1}@phohanoi.com`, 'Manager123!', 'manager', lid));
  mkUser('Support Staff', 'support@phohanoi.com', 'Support123!', 'support', locIds[0]);
  mkUser('Employee One', 'employee@phohanoi.com', 'Employee123!', 'employee', locIds[0]);
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

  console.log(`Seeded ${LOCATIONS.length} locations, ${ITEMS.length} items each, ${VENDORS.length} vendors.`);
  console.log('Owner login: harry@phohanoi.com / Harry123!');
}

if (require.main === module) { run(); console.log('Seed complete.'); }
module.exports = { run };
