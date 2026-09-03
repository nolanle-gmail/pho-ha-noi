// One-off production reset for the Waitlist DB: clear the demo guest queue and
// logs, and remove the offline break-glass accounts except the owner, while keeping
// locations and floor plans. Management is the source of truth for staff; this only
// tidies the small local mirror. Destructive; run once after a backup:
//   DB_PATH=/data/phohanoi_waitlist.db node db/cleanup.js
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'phohanoi_waitlist.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = OFF');

const count = (t) => { try { return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { return '-'; } };
const clear = (t) => { try { const n = count(t); db.exec(`DELETE FROM ${t}`); console.log(`  cleared ${t}: ${n} -> 0`); } catch (e) { console.log(`  skip ${t}: ${e.message}`); } };

console.log('=== Waitlist DB cleanup:', dbPath, '===');
console.log('Users before:', count('users'), '| waitlist rows:', count('waitlist'));
db.exec('BEGIN');
try {
  for (const t of ['waitlist', 'notify_log', 'audit_log', 'activity_log']) clear(t);
  const del = db.prepare(`DELETE FROM users WHERE role NOT IN ('owner')`).run(); // break-glass has no admin role; keep the owner
  console.log(`  break-glass users: removed ${del.changes}`);
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); console.error('ROLLED BACK:', e.message); process.exit(1); }
console.log('Users after:', count('users'), '| kept locations:', count('locations'), '| restaurant_tables:', count('restaurant_tables'));
console.log('=== done ===');
