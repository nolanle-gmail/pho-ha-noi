// One-off production reset: remove all staff except owner/admin accounts, and
// wipe all demo/test ACTIVITY, while keeping the business setup (locations, floor
// plans, menu & recipes, inventory items & vendors, and the job/task catalog).
//
// Run against a database with:  DB_PATH=/data/phohanoi_management.db node db/cleanup.js
// It opens its own connection with foreign keys OFF so rows can be cleared in any
// order; kept tables tolerate the now-unused user references (shown as blank in the
// UI via LEFT JOINs). This is destructive and intended to be run once, after a backup.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'phohanoi_management.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = OFF');

const count = (t) => { try { return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { return '-'; } };
const clear = (t) => { try { const n = count(t); db.exec(`DELETE FROM ${t}`); console.log(`  cleared ${t}: ${n} -> 0`); } catch (e) { console.log(`  skip ${t}: ${e.message}`); } };

// Every table that only holds demo ACTIVITY is emptied entirely.
const ACTIVITY = [
  'shift_breaks', 'shift_jobs', 'shifts',
  'task_comments', 'task_photos', 'task_assignments',
  'time_adjustments', 'timesheet_approvals', 'ot_approvals', 'time_entries', 'timesheets', 'staff_alerts',
  'visit_events', 'service_visits',
  'floor_alert_acks', 'floor_alerts',
  'message_attachments', 'message_recipients', 'messages',
  'chat_reads', 'chat_messages', 'chat_group_members', 'chat_groups',
  'daily_sales',
  'supply_orders', 'distribution_orders',
  'store_requests', 'transfer_requests', 'waste_log', 'cycle_counts',
  'ck_production_runs', 'ck_tasks', 'ck_shifts',
  'activity_log', 'audit_log',
];

const kept = db.prepare(`SELECT id, name, role FROM users WHERE role IN ('owner','admin','hr') ORDER BY id`).all();
const keptIds = kept.map(u => u.id);
console.log('=== Management DB cleanup:', dbPath, '===');
console.log('Users before:', count('users'));
console.log('KEEPING these accounts:');
kept.forEach(u => console.log(`  - ${u.name} (${u.role}, id ${u.id})`));

db.exec('BEGIN');
try {
  for (const t of ACTIVITY) clear(t);
  // HR records for removed people (owner/admin keep theirs).
  const placeholders = keptIds.map(() => '?').join(',');
  for (const t of ['staff_profiles', 'staff_locations']) {
    try { const info = db.prepare(`DELETE FROM ${t} WHERE user_id NOT IN (${placeholders})`).run(...keptIds); console.log(`  ${t}: removed ${info.changes} for non-owner/admin`); } catch (e) { console.log(`  skip ${t}: ${e.message}`); }
  }
  const del = db.prepare(`DELETE FROM users WHERE role NOT IN ('owner','admin','hr')`).run();
  console.log(`  users: removed ${del.changes}`);
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); console.error('ROLLED BACK:', e.message); process.exit(1); }

console.log('Users after:', count('users'));
console.log('Kept (should be untouched): locations', count('locations'), '| menu_items', count('menu_items'), '| inventory', count('inventory'), '| vendors', count('vendors'), '| jobs', count('jobs'), '| restaurant_tables', count('restaurant_tables'));
console.log('=== done ===');
