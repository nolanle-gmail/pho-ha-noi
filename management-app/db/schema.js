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
      phone TEXT,                          -- 10-digit login credential (stored digits only)
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL, -- validated in code against the access-level registry (lib/auth.js)
      location_id INTEGER REFERENCES locations(id),
      hourly_rate REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Access-level registry (the "Roles" managed on the Access Levels page).
    -- Seeded from lib/auth.js defaults; Owner/Admin can add/edit/remove rows.
    -- 'scope' is the role's access level (all / location / self); 'caps' is a
    -- JSON array of capabilities (org, manage, ops, reports, central, delivery).
    CREATE TABLE IF NOT EXISTS roles (
      key         TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      scope       TEXT NOT NULL DEFAULT 'self',
      rank        INTEGER NOT NULL DEFAULT 10,
      caps        TEXT NOT NULL DEFAULT '[]',
      is_builtin  INTEGER NOT NULL DEFAULT 0,
      is_active   INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
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
      type TEXT NOT NULL DEFAULT 'restaurant',
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

    -- ── Central Kitchen (production & supply hub) ─────────────────────────
    -- Items the central kitchen produces (broths, prepped proteins, sauces).
    CREATE TABLE IF NOT EXISTS ck_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      unit TEXT DEFAULT 'each',
      batch_yield REAL NOT NULL DEFAULT 0,      -- gross output per batch
      shrinkage_pct REAL NOT NULL DEFAULT 0,    -- yield loss (0–1)
      safety_stock REAL NOT NULL DEFAULT 0,
      on_hand REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    -- Master recipe: raw inventory ingredients + quantity per batch.
    CREATE TABLE IF NOT EXISTS ck_recipe_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES ck_products(id),
      item_name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0
    );
    -- Daily item requests submitted by each store location.
    CREATE TABLE IF NOT EXISTS store_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      product_id INTEGER NOT NULL REFERENCES ck_products(id),
      quantity REAL NOT NULL DEFAULT 0,
      request_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','fulfilled')),
      created_at TEXT DEFAULT (datetime('now'))
    );
    -- Production batch runs, with yield/shrinkage tracking.
    CREATE TABLE IF NOT EXISTS ck_production_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES ck_products(id),
      batches REAL NOT NULL,
      planned_output REAL NOT NULL,
      actual_output REAL NOT NULL,
      shrinkage_loss REAL NOT NULL DEFAULT 0,
      produced_at TEXT DEFAULT (datetime('now')),
      produced_by INTEGER REFERENCES users(id)
    );
    -- CK HR: task assignments (optionally photo-verified) and shift schedule.
    CREATE TABLE IF NOT EXISTS ck_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      assigned_to INTEGER REFERENCES users(id),
      requires_photo INTEGER NOT NULL DEFAULT 0,
      photo_url TEXT,
      status TEXT NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned','done')),
      due TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ck_shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      shift_date TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sr_date ON store_requests(request_date, product_id);
    CREATE INDEX IF NOT EXISTS idx_ckrec_prod ON ck_recipe_ingredients(product_id);

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

    -- Access / activity trail — every login, write, and denied attempt, with who,
    -- what, the response status, and the client IP. (Complements audit_log's
    -- richer business events.)
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
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);

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

    -- Picture / video attachments on a message. Stored as bytes in the DB (like
    -- day-task proof photos) so they persist on the mounted volume; images and
    -- videos have their own size caps enforced in the route.
    CREATE TABLE IF NOT EXISTS message_attachments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL CHECK(kind IN ('image','video')),
      mime       TEXT NOT NULL,
      bytes      BLOB NOT NULL,
      byte_size  INTEGER NOT NULL DEFAULT 0,
      filename   TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_msg_attach ON message_attachments(message_id);

    -- Persistent staff chat groups (like channels). A group has a stable membership;
    -- only members see and post; leadership can audit any group; owner/admin can
    -- deactivate a group (is_active=0) — messages are retained for audit.
    CREATE TABLE IF NOT EXISTS chat_groups (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      is_active  INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chat_group_members (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id   INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_member ON chat_group_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_member_group ON chat_group_members(group_id);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id   INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      sender_id  INTEGER NOT NULL REFERENCES users(id),
      body       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_msg_group ON chat_messages(group_id, id);
    -- Picture / video attachments on a chat message (same as message_attachments).
    CREATE TABLE IF NOT EXISTS chat_message_attachments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL CHECK(kind IN ('image','video')),
      mime            TEXT NOT NULL,
      bytes           BLOB NOT NULL,
      byte_size       INTEGER NOT NULL DEFAULT 0,
      filename        TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_attach ON chat_message_attachments(chat_message_id);
    -- Per-member read cursor, so the group list can show unread counts.
    CREATE TABLE IF NOT EXISTS chat_reads (
      group_id     INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      last_read_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (group_id, user_id)
    );
  `);

  // Staff profiles: full HR record per person (1:1 with users). Sensitive
  // identifiers (SSN, bank/account numbers) are intentionally NOT stored here —
  // keep those in a dedicated payroll provider.
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_profiles (
      user_id           INTEGER PRIMARY KEY REFERENCES users(id),
      preferred_name    TEXT,
      legal_first_name  TEXT,
      legal_last_name   TEXT,
      dob               TEXT,
      gender            TEXT,
      personal_email    TEXT,
      phone             TEXT,
      alt_phone         TEXT,
      address_line1     TEXT,
      address_line2     TEXT,
      city              TEXT,
      state             TEXT,
      postal_code       TEXT,
      country           TEXT DEFAULT 'USA',
      emergency_name    TEXT,
      emergency_relation TEXT,
      emergency_phone   TEXT,
      employee_code     TEXT,
      job_title         TEXT,
      department        TEXT,
      employment_type   TEXT,
      status            TEXT DEFAULT 'active',
      hire_date         TEXT,
      termination_date  TEXT,
      supervisor_id     INTEGER REFERENCES users(id),
      pay_type          TEXT,
      payroll_ref       TEXT,
      preferred_contact TEXT,
      skills            TEXT,
      notes             TEXT,
      updated_at        TEXT DEFAULT (datetime('now'))
    );
    -- Additional locations a person can work at (home location is users.location_id).
    CREATE TABLE IF NOT EXISTS staff_locations (
      user_id     INTEGER NOT NULL REFERENCES users(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      PRIMARY KEY (user_id, location_id)
    );

    -- Job/task catalog — the menu of jobs a manager can assign to staff on a shift.
    CREATE TABLE IF NOT EXISTS jobs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT UNIQUE,                 -- Job ID, e.g. "FOH-02"
      name        TEXT NOT NULL,
      description TEXT,                         -- description / instructions
      department  TEXT,                         -- Front of House / Back of House / Bar / Facilities / Management
      complexity  TEXT DEFAULT 'medium',        -- low / medium / high
      est_minutes INTEGER,                      -- typical duration
      notes       TEXT,
      kind        TEXT NOT NULL DEFAULT 'standard', -- 'standard' (role duty) or 'specific' (day task)
      is_active   INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- Day-of assignment of a specific task to a working staff member.
    CREATE TABLE IF NOT EXISTS task_assignments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      task_date   TEXT NOT NULL,               -- ISO date
      job_id      INTEGER NOT NULL REFERENCES jobs(id),
      user_id     INTEGER REFERENCES users(id),  -- NULL = unassigned
      task_time   TEXT,                          -- HH:MM, within the assignee's working hours
      done        INTEGER NOT NULL DEFAULT 0,
      created_by  INTEGER REFERENCES users(id),
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE (location_id, task_date, job_id)
    );

    -- Proof photos for a day task (optional). Stored as bytes in the DB so they
    -- persist on the mounted volume with no extra file storage. Many per task —
    -- staff can attach several images; managers view them all in the Day Tasks tab.
    CREATE TABLE IF NOT EXISTS task_photos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
      mime        TEXT NOT NULL,
      bytes       BLOB NOT NULL,
      byte_size   INTEGER NOT NULL DEFAULT 0,
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_photos_task ON task_photos(task_id);

    -- Comments / feedback on a day task (optional). Many per task — staff leave a
    -- note alongside their proof photos; managers can reply with feedback. Shown in
    -- My Tasks and in the Day Tasks board next to the photos.
    CREATE TABLE IF NOT EXISTS task_comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      author_id  INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);

    -- Which specific tasks apply to which location. A row = the task is on that
    -- location's day-task list. Most restaurants share a set; each can add/remove,
    -- and the Central Kitchen has its own.
    CREATE TABLE IF NOT EXISTS location_tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      job_id      INTEGER NOT NULL REFERENCES jobs(id),
      created_by  INTEGER REFERENCES users(id),
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE (location_id, job_id)
    );

    -- Time clock: staff check-in / check-out punches from the Front-Desk kiosk.
    -- One row per work day per staff member; clock_out is null until they leave.
    CREATE TABLE IF NOT EXISTS time_entries (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER NOT NULL REFERENCES users(id),
      location_id       INTEGER NOT NULL REFERENCES locations(id),
      work_date         TEXT NOT NULL,               -- ISO date (local)
      clock_in          TEXT NOT NULL,               -- ISO datetime
      clock_out         TEXT,                        -- ISO datetime, null while on the clock
      scheduled_minutes INTEGER NOT NULL DEFAULT 0,  -- snapshot of the day's scheduled span at check-in
      worked_minutes    INTEGER,                     -- filled at check-out
      short_confirmed   INTEGER NOT NULL DEFAULT 0,  -- staff confirmed leaving early
      opened_by         INTEGER REFERENCES users(id),-- manager/opener who opened the station
      created_at        TEXT DEFAULT (datetime('now'))
    );

    -- Overtime approvals: a manager (or authorized person) must approve a staff
    -- member's overtime for a day, with a note, before it counts on payroll.
    -- Owner / General Manager can later adjust the approved minutes.
    CREATE TABLE IF NOT EXISTS ot_approvals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id   INTEGER NOT NULL REFERENCES locations(id),
      user_id       INTEGER NOT NULL REFERENCES users(id),
      work_date     TEXT NOT NULL,               -- ISO date the OT was worked
      approved      INTEGER NOT NULL DEFAULT 0,
      ot_minutes    INTEGER NOT NULL DEFAULT 0,  -- approved overtime (1.5×) minutes
      dt_minutes    INTEGER NOT NULL DEFAULT 0,  -- approved double-time (2×) minutes
      note          TEXT,
      approved_by   INTEGER REFERENCES users(id),
      approved_at   TEXT,
      updated_at    TEXT DEFAULT (datetime('now')),
      UNIQUE (location_id, user_id, work_date)
    );

    -- Alerts raised to a location's manager (e.g. a staff member left early).
    CREATE TABLE IF NOT EXISTS staff_alerts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id   INTEGER NOT NULL REFERENCES locations(id),
      user_id       INTEGER REFERENCES users(id),
      kind          TEXT NOT NULL,                   -- 'short_shift'
      message       TEXT NOT NULL,
      time_entry_id INTEGER REFERENCES time_entries(id),
      resolved      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    -- Manager rounding of a day's worked minutes (e.g. 7.5h → 8h, or +30m → 1h OT).
    -- The adjusted total replaces clocked minutes when computing regular/OT/pay.
    CREATE TABLE IF NOT EXISTS time_adjustments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id      INTEGER NOT NULL REFERENCES locations(id),
      user_id          INTEGER NOT NULL REFERENCES users(id),
      work_date        TEXT NOT NULL,
      adjusted_minutes INTEGER NOT NULL,
      note             TEXT,
      adjusted_by      INTEGER REFERENCES users(id),
      adjusted_at      TEXT DEFAULT (datetime('now')),
      UNIQUE (location_id, user_id, work_date)
    );

    -- A manager's sign-off on a person's total hours for a period (day/week/month).
    CREATE TABLE IF NOT EXISTS timesheet_approvals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id   INTEGER NOT NULL REFERENCES locations(id),
      user_id       INTEGER NOT NULL REFERENCES users(id),
      period_kind   TEXT NOT NULL,                   -- 'daily' | 'weekly' | 'monthly'
      period_start  TEXT NOT NULL,
      period_end    TEXT NOT NULL,
      total_minutes INTEGER NOT NULL DEFAULT 0,      -- approved total (with adjustments)
      note          TEXT,
      approved_by   INTEGER REFERENCES users(id),
      approved_at   TEXT DEFAULT (datetime('now')),
      UNIQUE (location_id, user_id, period_kind, period_start)
    );

    -- Floor plan: areas + numbered tables per location, with a live seating status.
    -- The Management "Floor Plan" tab is the editor + status; the Waitlist Front Desk
    -- reads/seats through this (via a service key) so both apps share one source.
    CREATE TABLE IF NOT EXISTS floor_areas (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      name        TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS restaurant_tables (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id   INTEGER NOT NULL REFERENCES locations(id),
      area_id       INTEGER REFERENCES floor_areas(id),
      label         TEXT NOT NULL,
      seats         INTEGER NOT NULL DEFAULT 2,
      is_active     INTEGER NOT NULL DEFAULT 1,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      pos_x         INTEGER NOT NULL DEFAULT 50,
      pos_y         INTEGER NOT NULL DEFAULT 50,
      shape         TEXT NOT NULL DEFAULT 'round',
      status        TEXT NOT NULL DEFAULT 'available', -- available|waiting_to_order|served|waiting_to_pay|cleaning
      guest_name    TEXT,
      party_size    INTEGER,
      seated_at     TEXT,
      est_free_at   TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tables_loc ON restaurant_tables(location_id);

    -- Guest-visit lifecycle: the spine that tracks a party from the waitlist through
    -- seating, service, timed checks, paying and done. Single source of truth — the
    -- Staff app (Front Desk + Servers) reads/writes this via a service key, and the
    -- floor plan reflects each visit's stage. A walk-in starts at 'seated' (no wait).
    CREATE TABLE IF NOT EXISTS service_visits (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id        INTEGER NOT NULL REFERENCES locations(id),
      source             TEXT NOT NULL DEFAULT 'walkin',   -- waitlist|walkin
      guest_name         TEXT,
      party_size         INTEGER NOT NULL DEFAULT 1,
      phone              TEXT,
      notes              TEXT,
      stage              TEXT NOT NULL DEFAULT 'waiting',  -- waiting|seated|in_service|paying|done|canceled
      table_id           INTEGER REFERENCES restaurant_tables(id),
      server_id          INTEGER REFERENCES users(id),
      server_name        TEXT,                             -- denormalized for display + history
      check_interval_min INTEGER,                          -- 5|10|20 (null = no timed checks)
      next_check_at      TEXT,
      last_checked_at    TEXT,
      check_count        INTEGER NOT NULL DEFAULT 0,
      waitlist_ref       TEXT,                             -- links to the Staff app's waitlist party
      quoted_minutes     INTEGER,
      help_flag          INTEGER NOT NULL DEFAULT 0,       -- server raised a hand (needs a manager)
      help_at            TEXT,
      bus_flag           INTEGER NOT NULL DEFAULT 0,       -- table flagged for a busser to clear
      bus_at             TEXT,
      tip_amount         REAL,                             -- optional tip recorded at close (server's own tally)
      created_at         TEXT DEFAULT (datetime('now')),
      seated_at          TEXT,
      service_started_at TEXT,
      paying_at          TEXT,
      done_at            TEXT,
      canceled_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_visits_loc_stage ON service_visits(location_id, stage);
    CREATE INDEX IF NOT EXISTS idx_visits_server ON service_visits(server_id);
    CREATE INDEX IF NOT EXISTS idx_visits_table ON service_visits(table_id);

    -- Every stage transition + check, for movement history and performance reporting.
    CREATE TABLE IF NOT EXISTS visit_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      visit_id     INTEGER NOT NULL REFERENCES service_visits(id) ON DELETE CASCADE,
      location_id  INTEGER NOT NULL REFERENCES locations(id),
      event        TEXT NOT NULL,   -- created|seated|claimed|assigned|checked|paying|done|canceled|transferred|reopened
      from_stage   TEXT,
      to_stage     TEXT,
      actor_id     INTEGER REFERENCES users(id),
      actor_name   TEXT,
      actor_role   TEXT,
      detail       TEXT,            -- JSON
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_visit_events_visit ON visit_events(visit_id);
    CREATE INDEX IF NOT EXISTS idx_visit_events_loc ON visit_events(location_id);

    -- Weekly staff schedule — one row per staff member per working day per location.
    -- A person can have shifts at different locations on different days.
    CREATE TABLE IF NOT EXISTS shifts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      shift_date  TEXT NOT NULL,                -- ISO date (YYYY-MM-DD)
      start_time  TEXT,                         -- "09:00"
      end_time    TEXT,                         -- "17:00"
      notes       TEXT,
      created_by  INTEGER REFERENCES users(id),
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- Jobs/tasks assigned to a shift (a shift can carry several jobs).
    CREATE TABLE IF NOT EXISTS shift_jobs (
      shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      job_id   INTEGER NOT NULL REFERENCES jobs(id),
      PRIMARY KEY (shift_id, job_id)
    );

    -- Breaks within a shift (e.g. a 15-min break 10:45–11:00). Non-working time,
    -- netted out of the shift's worked hours.
    CREATE TABLE IF NOT EXISTS shift_breaks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id   INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      start_time TEXT,
      end_time   TEXT,
      label      TEXT
    );

    -- Central-Kitchen distribution: a store's raw-food order to the Central Kitchen,
    -- tracked as one unit with its CK-first / vendor-fallback split. The CK portion
    -- (ck_qty) moves through this row's own ship→receive lifecycle; the shortfall
    -- (vendor_qty) is an ordinary vendor supply_order linked via vendor_order_id.
    CREATE TABLE IF NOT EXISTS distribution_orders (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      to_location_id  INTEGER NOT NULL REFERENCES locations(id),  -- the ordering store
      item_id         INTEGER REFERENCES inventory(id),           -- the store's inventory row (nullable)
      item_name       TEXT NOT NULL,
      unit            TEXT DEFAULT 'units',
      requested_qty   REAL NOT NULL,
      ck_qty          REAL NOT NULL DEFAULT 0,                     -- filled from Central Kitchen
      vendor_qty      REAL NOT NULL DEFAULT 0,                     -- shortfall routed to a vendor
      status          TEXT NOT NULL DEFAULT 'requested'
                        CHECK(status IN ('requested','approved','shipped','received','cancelled')),
      vendor_order_id INTEGER REFERENCES supply_orders(id),       -- auto-created PO for the shortfall
      requested_by    INTEGER REFERENCES users(id),
      approved_by     INTEGER REFERENCES users(id),
      notes           TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    -- Floor alerts: an urgent, on-screen ping a manager/owner pushes to working
    -- staff (e.g. "help table 5 now"). Targets one person, a whole role at the
    -- store, or everyone on the floor. Delivered live over SSE and popped up in
    -- the Staff app; recipients acknowledge ("On it") in floor_alert_acks.
    CREATE TABLE IF NOT EXISTS floor_alerts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id    INTEGER NOT NULL REFERENCES locations(id),
      sender_id      INTEGER NOT NULL REFERENCES users(id),
      target_type    TEXT NOT NULL CHECK(target_type IN ('user','role','all')),
      target_user_id INTEGER REFERENCES users(id),   -- when target_type='user'
      target_role    TEXT,                            -- when target_type='role'
      body           TEXT NOT NULL,
      priority       TEXT NOT NULL DEFAULT 'urgent' CHECK(priority IN ('normal','urgent')),
      active         INTEGER NOT NULL DEFAULT 1,      -- sender can close it
      created_at     TEXT DEFAULT (datetime('now'))
    );
    -- One row per staff member who acknowledged an alert.
    CREATE TABLE IF NOT EXISTS floor_alert_acks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id  INTEGER NOT NULL REFERENCES floor_alerts(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      ack_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(alert_id, user_id)
    );
  `);

  // Migrations for databases created before these columns existed.
  for (const stmt of [
    `ALTER TABLE inventory ADD COLUMN description TEXT`,
    `ALTER TABLE inventory ADD COLUMN notes TEXT`,
    `ALTER TABLE inventory ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`,
    // Central-Kitchen stock only: whether this raw item is offered to stores for distribution.
    `ALTER TABLE inventory ADD COLUMN distributable INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN hourly_rate REAL NOT NULL DEFAULT 0`,
    // Phone is the login credential (10 digits, stored digits-only).
    `ALTER TABLE users ADD COLUMN phone TEXT`,
    `ALTER TABLE locations ADD COLUMN city TEXT`,
    `ALTER TABLE locations ADD COLUMN state TEXT`,
    `ALTER TABLE locations ADD COLUMN zip TEXT`,
    `ALTER TABLE locations ADD COLUMN phone TEXT`,
    `ALTER TABLE locations ADD COLUMN email TEXT`,
    `ALTER TABLE locations ADD COLUMN timezone TEXT DEFAULT 'America/Los_Angeles'`,
    `ALTER TABLE locations ADD COLUMN opening_date TEXT`,
    `ALTER TABLE locations ADD COLUMN seats INTEGER DEFAULT 0`,
    `ALTER TABLE locations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
    `ALTER TABLE locations ADD COLUMN type TEXT NOT NULL DEFAULT 'restaurant'`,
    `ALTER TABLE users ADD COLUMN pin TEXT`,
    `ALTER TABLE staff_profiles ADD COLUMN status TEXT DEFAULT 'active'`,
    `ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard'`,
    `ALTER TABLE task_assignments ADD COLUMN task_time TEXT`,
    // Day-task progress: staff taps Start (started_at) then Done (done_at); a proof
    // photo can be attached before Done (stored in task_photos).
    `ALTER TABLE task_assignments ADD COLUMN started_at TEXT`,
    `ALTER TABLE task_assignments ADD COLUMN done_at TEXT`,
    // A schedule entry is a work shift by default, or a leave entry (sick /
    // vacation / on-leave). Leave carries its own hours — a full day, a number of
    // hours, or a from–to span — so the timesheet can total leave vs worked hours.
    `ALTER TABLE shifts ADD COLUMN kind TEXT NOT NULL DEFAULT 'work'`,
    `ALTER TABLE shifts ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE shifts ADD COLUMN leave_hours REAL`,
    `ALTER TABLE locations ADD COLUMN room_outline TEXT`,
    `ALTER TABLE users ADD COLUMN employee_code TEXT`,
    `ALTER TABLE service_visits ADD COLUMN help_flag INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE service_visits ADD COLUMN help_at TEXT`,
    `ALTER TABLE service_visits ADD COLUMN bus_flag INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE service_visits ADD COLUMN bus_at TEXT`,
    `ALTER TABLE service_visits ADD COLUMN tip_amount REAL`,
    `ALTER TABLE activity_log ADD COLUMN location_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_activity_loc ON activity_log(location_id, created_at)`,
    // Message threading: a reply carries its thread's root id + the message it answers.
    `ALTER TABLE messages ADD COLUMN thread_id INTEGER`,
    `ALTER TABLE messages ADD COLUMN parent_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id)`,
    // Per-recipient archive: a reader can file a conversation away from their inbox.
    `ALTER TABLE message_recipients ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    // Timesheet: late arrival (minutes past scheduled start) + OT escalation to leadership.
    `ALTER TABLE time_entries ADD COLUMN late_minutes INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE ot_approvals ADD COLUMN escalated INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE ot_approvals ADD COLUMN escalated_by INTEGER`,
    `ALTER TABLE ot_approvals ADD COLUMN escalated_at TEXT`,
    `ALTER TABLE ot_approvals ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0`,
  ]) { try { db.exec(stmt); } catch { /* column already exists */ } }

  // Phone is now the login credential. Backfill a unique 10-digit login phone for
  // every account created before this existed, so no one is locked out. The named
  // demo accounts keep the fixed numbers documented in the handbook (so already-seeded
  // production matches the docs); everyone else gets a deterministic 408-<id> number
  // they can change later in the staff editor. A unique index then enforces one
  // account per phone. All updates are guarded on an empty phone, so a real edit is
  // never overwritten.
  try {
    const setPhone = db.prepare(`UPDATE users SET phone=? WHERE email=? AND (phone IS NULL OR phone='')`);
    const named = {
      'harry@phohanoi.com': '4084830030', 'admin@phohanoi.com': '4085550001',
      'support@phohanoi.com': '4085550002', 'employee@phohanoi.com': '4085550003',
      'gm@phohanoi.com': '4085550004', 'analyst@phohanoi.com': '4085550005',
      'driver@phohanoi.com': '4085550006', 'server@phohanoi.com': '4085550007',
      'server2@phohanoi.com': '4085550008', 'server3@phohanoi.com': '4085550009',
      'host@phohanoi.com': '4085550010', 'chef@phohanoi.com': '4085550011',
    };
    for (let i = 1; i <= 10; i++) named[`manager${i}@phohanoi.com`] = `40855501${String(i).padStart(2, '0')}`;
    for (let i = 1; i <= 10; i++) named[`host${i}@phohanoi.com`] = `40855502${String(i).padStart(2, '0')}`;
    for (const [email, phone] of Object.entries(named)) { try { setPhone.run(phone, email); } catch { /* number already taken by a real edit */ } }
    // Everyone else: a deterministic unique number from their id.
    db.exec(`UPDATE users SET phone = '408' || substr('0000000' || id, -7) WHERE phone IS NULL OR phone=''`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone)`);
  } catch { /* users table not present yet */ }

  // Day-task proof photos: rebuild the old one-per-task table (task_id was the
  // PRIMARY KEY) into a many-per-task table with its own autoincrement id, so
  // staff can attach several images. Runs once — detected by the absence of an
  // `id` column — and copies every existing photo across before dropping the old
  // table. Wrapped in a transaction so a failure leaves the original intact.
  try {
    const cols = db.prepare(`PRAGMA table_info('task_photos')`).all();
    if (cols.length && !cols.some(c => c.name === 'id')) {
      db.exec('BEGIN');
      try {
        db.exec(`
          CREATE TABLE task_photos_new (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id     INTEGER NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
            mime        TEXT NOT NULL,
            bytes       BLOB NOT NULL,
            byte_size   INTEGER NOT NULL DEFAULT 0,
            uploaded_by INTEGER REFERENCES users(id),
            uploaded_at TEXT DEFAULT (datetime('now'))
          );
          INSERT INTO task_photos_new (task_id, mime, bytes, byte_size, uploaded_by, uploaded_at)
            SELECT task_id, mime, bytes, byte_size, uploaded_by, uploaded_at FROM task_photos;
          DROP TABLE task_photos;
          ALTER TABLE task_photos_new RENAME TO task_photos;
          CREATE INDEX IF NOT EXISTS idx_task_photos_task ON task_photos(task_id);`);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  } catch { /* task_photos not present yet, or already rebuilt */ }

  // Existing messages become the root of their own thread.
  try { db.exec(`UPDATE messages SET thread_id = id WHERE thread_id IS NULL`); } catch { /* messages table not present yet */ }

  // Give every user a login employee code: reuse their HR profile code if present,
  // otherwise generate a stable one from their id (E0001, E0002, …).
  try {
    db.exec(`UPDATE users SET employee_code = (SELECT sp.employee_code FROM staff_profiles sp WHERE sp.user_id = users.id)
             WHERE (employee_code IS NULL OR employee_code = '')
               AND EXISTS (SELECT 1 FROM staff_profiles sp WHERE sp.user_id = users.id AND sp.employee_code IS NOT NULL AND sp.employee_code <> '')`);
    db.exec(`UPDATE users SET employee_code = 'E' || substr('0000' || id, -4) WHERE employee_code IS NULL OR employee_code = ''`);
  } catch { /* staff_profiles not present yet */ }

  // Backfill per-location task lists for databases created before location_tasks
  // existed: if there are specific tasks but no memberships yet, enable every active
  // specific task at every active location (preserves the prior "all tasks show
  // everywhere" behavior). Fresh seeds set memberships explicitly, so this is a no-op there.
  try {
    const hasMembership = db.prepare(`SELECT 1 FROM location_tasks LIMIT 1`).get();
    const hasSpecific = db.prepare(`SELECT 1 FROM jobs WHERE kind='specific' AND is_active=1 LIMIT 1`).get();
    if (!hasMembership && hasSpecific) {
      db.exec(`INSERT OR IGNORE INTO location_tasks (location_id, job_id)
               SELECT l.id, j.id FROM locations l CROSS JOIN jobs j
               WHERE j.kind='specific' AND j.is_active=1 AND l.is_active=1`);
    }
  } catch { /* location_tasks not present yet */ }
}

module.exports = { migrate };

if (require.main === module) {
  migrate();
  console.log('Schema ready.');
}
