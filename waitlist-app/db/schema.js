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
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_wl_loc_status ON waitlist(location_id, status);
    CREATE INDEX IF NOT EXISTS idx_audit_loc ON audit_log(location_id);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
  `);

  // Migrations for databases created before these columns existed.
  for (const stmt of [
    `ALTER TABLE waitlist ADD COLUMN source TEXT NOT NULL DEFAULT 'staff'`,
    `ALTER TABLE waitlist ADD COLUMN public_ref TEXT`,
  ]) { try { db.exec(stmt); } catch { /* column already exists */ } }
}

module.exports = { migrate };
if (require.main === module) { migrate(); console.log('Schema ready.'); }
