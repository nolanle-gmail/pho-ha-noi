// One-off, idempotent seeder for demo day-task assignments on an existing/prod
// database, so the Staff app's "My Tasks" has data today. Skips if the first
// restaurant location already has assignments for today. Safe to re-run.
// Run: node db/seed-stafftasks.js
const db = require('./database');
const { seedStaffTasks } = require('./seed');

const loc = db.prepare(`SELECT id, name FROM locations WHERE COALESCE(type,'') != 'central_kitchen' AND is_active=1 ORDER BY id LIMIT 1`).get();
if (!loc) { console.log('No restaurant location found — nothing to seed.'); process.exit(0); }

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
const existing = db.prepare(`SELECT COUNT(*) c FROM task_assignments WHERE location_id=? AND task_date=?`).get(loc.id, today).c;
if (existing > 0) { console.log(`${loc.name} already has ${existing} task assignments for ${today} — skipped.`); process.exit(0); }

seedStaffTasks(db, [loc.id]);
