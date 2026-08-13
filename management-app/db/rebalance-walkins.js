// One-off: rebalance the demo visits on an existing/prod database to match the
// realistic seed mix — most seated guests came from the waitlist, only a few are
// walk-ins (Vo Minh, Ho Grace, Dang May). Run: node db/rebalance-walkins.js
const db = require('./database');

const loc = db.prepare(`SELECT id, name FROM locations WHERE COALESCE(type,'') != 'central_kitchen' AND is_active=1 ORDER BY id LIMIT 1`).get();
if (!loc) { console.log('No restaurant location found — nothing to do.'); process.exit(0); }

const reset = db.prepare(`UPDATE service_visits SET source='waitlist' WHERE location_id=? AND source='walkin'`).run(loc.id);
const marked = db.prepare(`UPDATE service_visits SET source='walkin' WHERE location_id=? AND guest_name IN ('Vo, Minh','Ho, Grace','Dang, May')`).run(loc.id);
console.log(`${loc.name}: reset ${reset.changes} demo visits to waitlist, set ${marked.changes} as walk-ins.`);
