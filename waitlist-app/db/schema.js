// Schema for the Pho Ha Noi host check-in / waiting list.
const db = require('./database');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      avg_turn_minutes INTEGER NOT NULL DEFAULT 8,  -- per party ahead, used to quote waits
      is_active INTEGER NOT NULL DEFAULT 1,
      room_outline TEXT,                            -- JSON polygon [{x,y}…] in % of the floor board
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','manager','frontdesk')),
      location_id INTEGER REFERENCES locations(id),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Walk-in waiting list. A party is 'waiting', then 'seated' or 'left'.
    -- notified_at records when the host paged them that a table is ready.
    CREATE TABLE IF NOT EXISTS waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      guest_name TEXT NOT NULL,
      party_size INTEGER NOT NULL DEFAULT 2,
      phone TEXT,
      quoted_minutes INTEGER,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','seated','left')),
      table_number TEXT,
      notified_at TEXT,
      seated_at TEXT,
      source TEXT NOT NULL DEFAULT 'staff', -- 'staff' (front desk) or 'self' (customer kiosk)
      public_ref TEXT,                       -- short code so a self-check-in guest can track their spot
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Record of pages sent (SMS is stubbed; every page is logged here).
    CREATE TABLE IF NOT EXISTS notify_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      waitlist_id INTEGER REFERENCES waitlist(id),
      channel TEXT,
      recipient TEXT,
      body TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Audit trail of who did what (add / notify / seat / remove).
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      location_id INTEGER REFERENCES locations(id),
      action TEXT NOT NULL,
      entity TEXT,
      entity_id INTEGER,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Access / activity trail — every login, write (incl. customer self check-ins),
    -- and denied attempt, with who, what, response status, and client IP.
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT,
      user_role TEXT,
      method TEXT,
      path TEXT,
      status INTEGER,
      ip TEXT,
      detail TEXT,
      location_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Floor plan: areas (Dining, Bar, Lounge, Patio…) and the numbered tables in
    -- them, per location. The Front Desk picks a table from here when seating.
    CREATE TABLE IF NOT EXISTS floor_areas (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      name        TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS restaurant_tables (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      area_id     INTEGER REFERENCES floor_areas(id),
      label       TEXT NOT NULL,               -- table number/code, e.g. "12" or "P3"
      seats       INTEGER NOT NULL DEFAULT 2,
      is_active   INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      pos_x       INTEGER NOT NULL DEFAULT 50,  -- % of board width  (0–100)
      pos_y       INTEGER NOT NULL DEFAULT 50,  -- % of board height (0–100)
      shape       TEXT NOT NULL DEFAULT 'round',-- 'round' | 'square'
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tables_loc ON restaurant_tables(location_id);
    CREATE INDEX IF NOT EXISTS idx_wl_loc_status ON waitlist(location_id, status);
    CREATE INDEX IF NOT EXISTS idx_audit_loc ON audit_log(location_id);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
  `);

  // Migrations for databases created before these columns existed.
  for (const stmt of [
    `ALTER TABLE waitlist ADD COLUMN source TEXT NOT NULL DEFAULT 'staff'`,
    `ALTER TABLE waitlist ADD COLUMN public_ref TEXT`,
    `ALTER TABLE restaurant_tables ADD COLUMN pos_x INTEGER NOT NULL DEFAULT 50`,
    `ALTER TABLE restaurant_tables ADD COLUMN pos_y INTEGER NOT NULL DEFAULT 50`,
    `ALTER TABLE restaurant_tables ADD COLUMN shape TEXT NOT NULL DEFAULT 'round'`,
    `ALTER TABLE locations ADD COLUMN room_outline TEXT`,
    `ALTER TABLE activity_log ADD COLUMN location_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_wactivity_loc ON activity_log(location_id, created_at)`,
    // Staff auth is unified to the Management directory, so an actor's id may be a
    // Management id (not in this app's users table). Denormalize the actor's name
    // and role onto audit_log so the "who did what" log still shows who acted.
    `ALTER TABLE audit_log ADD COLUMN user_name TEXT`,
    `ALTER TABLE audit_log ADD COLUMN user_role TEXT`,
  ]) { try { db.exec(stmt); } catch { /* column already exists */ } }
}

module.exports = { migrate };
if (require.main === module) { migrate(); console.log('Schema ready.'); }
