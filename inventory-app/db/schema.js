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
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Physical locations (restaurants / central commissary).
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

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

    CREATE INDEX IF NOT EXISTS idx_inv_loc ON inventory(location_id);
    CREATE INDEX IF NOT EXISTS idx_txn_item ON inventory_transactions(item_id);
    CREATE INDEX IF NOT EXISTS idx_lot_item ON inventory_lots(item_id);
    CREATE INDEX IF NOT EXISTS idx_so_loc ON supply_orders(location_id);
  `);

  // Migrations for databases created before these columns existed.
  for (const stmt of [
    `ALTER TABLE inventory ADD COLUMN description TEXT`,
    `ALTER TABLE inventory ADD COLUMN notes TEXT`,
    `ALTER TABLE inventory ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`,
  ]) { try { db.exec(stmt); } catch { /* column already exists */ } }
}

module.exports = { migrate };

if (require.main === module) {
  migrate();
  console.log('Schema ready.');
}
