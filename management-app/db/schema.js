// Schema for the Pho Ha Noi inventory system. Ported from the source design
// (C:\Restaurant_Design) and consolidated so every column exists up front.
const db = require('./database');

function migrate() {
  db.exec(`
    -- Staff/user accounts with roles.
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','admin','manager','support','employee')),
      location_id INTEGER REFERENCES locations(id),
      hourly_rate REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Physical locations (restaurants / central commissary).
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      phone TEXT,
      email TEXT,
      timezone TEXT DEFAULT 'America/Los_Angeles',
      opening_date TEXT,
      seats INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','draft','closed')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Operating hours per location (day_of_week 0=Mon … 6=Sun).
    CREATE TABLE IF NOT EXISTS location_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      day_of_week INTEGER NOT NULL,
      open_time TEXT,
      close_time TEXT,
      is_closed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(location_id, day_of_week)
    );

    -- Equipment / assets at a location, with vendor + maintenance tracking.
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      name TEXT NOT NULL,
      category TEXT,
      model TEXT,
      serial TEXT,
      vendor TEXT,
      vendor_phone TEXT,
      purchase_date TEXT,
      warranty_expiry TEXT,
      maintenance_freq TEXT DEFAULT 'quarterly',
      last_service TEXT,
      next_service TEXT,
      status TEXT NOT NULL DEFAULT 'operational' CHECK(status IN ('operational','needs_service','out_of_order')),
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_equip_loc ON equipment(location_id);

    -- Inventory items — stock is per (item_name, location). Attributes: SKU,
    -- category, unit, reorder trigger (min_quantity), target level (par_level),
    -- and rolling unit cost for valuation/COGS.
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      item_name TEXT NOT NULL,
      category TEXT,
      unit TEXT DEFAULT 'units',
      quantity REAL DEFAULT 0,
      min_quantity REAL DEFAULT 10,
      par_level REAL,
      unit_cost REAL NOT NULL DEFAULT 0,
      sku TEXT,
      description TEXT,
      notes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_updated TEXT DEFAULT (datetime('now'))
    );

    -- Immutable movement ledger: every in/out/transfer.
    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventory(id),
      from_location_id INTEGER REFERENCES locations(id),
      to_location_id INTEGER REFERENCES locations(id),
      quantity REAL NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('in','out','transfer_sent')),
      user_id INTEGER REFERENCES users(id),
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Received batches with expiry, drawn down FIFO. Parallel ledger to
    -- inventory.quantity for traceability and spoilage control.
    CREATE TABLE IF NOT EXISTS inventory_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventory(id),
      location_id INTEGER REFERENCES locations(id),
      lot_code TEXT,
      received_qty REAL NOT NULL,
      quantity REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      expiry_date TEXT,
      received_by INTEGER REFERENCES users(id),
      received_at TEXT DEFAULT (datetime('now')),
      depleted_at TEXT
    );

    -- Vendor master records (soft-deleted to preserve order history).
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_name TEXT,
      phone TEXT,
      email TEXT,
      lead_time_days INTEGER DEFAULT 0,
      notes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Purchase / supply orders with a lifecycle. Receiving one adds stock.
    CREATE TABLE IF NOT EXISTS supply_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER REFERENCES inventory(id),
      item_name TEXT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      quantity REAL NOT NULL,
      vendor TEXT,
      vendor_id INTEGER REFERENCES vendors(id),
      shipping_address TEXT,
      tracking_number TEXT,
      expected_date TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','shipped','received','cancelled')),
      ordered_by INTEGER REFERENCES users(id),
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Inter-location transfer requests with an approval workflow.
    CREATE TABLE IF NOT EXISTS transfer_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_name TEXT NOT NULL,
      quantity REAL NOT NULL,
      from_location_id INTEGER NOT NULL REFERENCES locations(id),
      to_location_id INTEGER NOT NULL REFERENCES locations(id),
      requested_by INTEGER NOT NULL REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','in_transit','received','cancelled')),
      tracking_number TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Waste / spoilage write-offs with a reason.
    CREATE TABLE IF NOT EXISTS waste_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventory(id),
      location_id INTEGER REFERENCES locations(id),
      quantity REAL NOT NULL,
      reason TEXT,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Physical cycle counts with the system-vs-counted variance recorded.
    CREATE TABLE IF NOT EXISTS cycle_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventory(id),
      location_id INTEGER REFERENCES locations(id),
      system_qty REAL NOT NULL,
      counted_qty REAL NOT NULL,
      variance REAL NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Simple audit trail of write actions.
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      entity TEXT,
      entity_id INTEGER,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ── Menu & Recipes ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS menu_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER REFERENCES menu_categories(id),
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    -- A recipe line ties a menu item to an inventory ingredient (by name) and a
    -- per-serving quantity. Costing multiplies quantity by the ingredient's
    -- average inventory unit cost across locations.
    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
      item_name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_inv_loc ON inventory(location_id);
    CREATE INDEX IF NOT EXISTS idx_txn_item ON inventory_transactions(item_id);
    CREATE INDEX IF NOT EXISTS idx_lot_item ON inventory_lots(item_id);
    CREATE INDEX IF NOT EXISTS idx_so_loc ON supply_orders(location_id);
    CREATE INDEX IF NOT EXISTS idx_recipe_item ON recipe_ingredients(menu_item_id);

    -- ── Sales & Timesheets (for reporting) ────────────────────────────────
    CREATE TABLE IF NOT EXISTS daily_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      sale_date TEXT NOT NULL,
      total_revenue REAL NOT NULL DEFAULT 0,
      cash_revenue REAL NOT NULL DEFAULT 0,
      card_revenue REAL NOT NULL DEFAULT 0,
      online_revenue REAL NOT NULL DEFAULT 0,
      cover_count INTEGER NOT NULL DEFAULT 0,
      food_sales REAL NOT NULL DEFAULT 0,
      beverage_sales REAL NOT NULL DEFAULT 0,
      UNIQUE(location_id, sale_date)
    );
    CREATE TABLE IF NOT EXISTS timesheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      location_id INTEGER REFERENCES locations(id),
      clock_in TEXT NOT NULL,
      clock_out TEXT,
      hours REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sales_loc_date ON daily_sales(location_id, sale_date);
    CREATE INDEX IF NOT EXISTS idx_ts_user ON timesheets(user_id);

    -- ── Team messaging ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      audience TEXT NOT NULL DEFAULT 'direct' CHECK(audience IN ('direct','all','location')),
      location_id INTEGER REFERENCES locations(id),
      subject TEXT,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    -- One row per recipient (a broadcast fans out to many), tracking read state.
    CREATE TABLE IF NOT EXISTS message_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      is_read INTEGER NOT NULL DEFAULT 0,
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_msg_recip ON message_recipients(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_id);
  `);

  // Migrations for databases created before these columns existed.
  for (const stmt of [
    `ALTER TABLE inventory ADD COLUMN description TEXT`,
    `ALTER TABLE inventory ADD COLUMN notes TEXT`,
    `ALTER TABLE inventory ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN hourly_rate REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE locations ADD COLUMN city TEXT`,
    `ALTER TABLE locations ADD COLUMN state TEXT`,
    `ALTER TABLE locations ADD COLUMN zip TEXT`,
    `ALTER TABLE locations ADD COLUMN phone TEXT`,
    `ALTER TABLE locations ADD COLUMN email TEXT`,
    `ALTER TABLE locations ADD COLUMN timezone TEXT DEFAULT 'America/Los_Angeles'`,
    `ALTER TABLE locations ADD COLUMN opening_date TEXT`,
    `ALTER TABLE locations ADD COLUMN seats INTEGER DEFAULT 0`,
    `ALTER TABLE locations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
  ]) { try { db.exec(stmt); } catch { /* column already exists */ } }
}

module.exports = { migrate };

if (require.main === module) {
  migrate();
  console.log('Schema ready.');
}
