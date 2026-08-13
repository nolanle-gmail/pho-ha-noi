// One-off, idempotent demo seeder for the guest-visit lists on an existing
// database (e.g. production). Seeds a spread across every Service list at the
// first restaurant location, but only if it has no visits yet. Safe to re-run.
// Run: node db/seed-visits.js
const db = require('./database');
const { seedVisits } = require('./seed');

const loc = db.prepare(`SELECT id, name FROM locations WHERE COALESCE(type,'') != 'central_kitchen' AND is_active=1 ORDER BY id LIMIT 1`).get();
if (!loc) { console.log('No restaurant location found — nothing to seed.'); process.exit(0); }

const existing = db.prepare(`SELECT COUNT(*) c FROM service_visits WHERE location_id=?`).get(loc.id).c;
if (existing > 0) { console.log(`${loc.name} already has ${existing} visits — skipped.`); process.exit(0); }

seedVisits(db, [loc.id]);
