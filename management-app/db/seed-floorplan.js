// One-off, idempotent floor-plan seeder for existing databases that predate the
// Floor Plan feature (e.g. production). Adds 4 areas + 30 tables + a room outline
// to every restaurant location that has none. Safe to run repeatedly: locations
// that already have tables are skipped. Run: node db/seed-floorplan.js
const db = require('./database');

const ROOM = JSON.stringify([{ x: 3, y: 4 }, { x: 97, y: 4 }, { x: 97, y: 96 }, { x: 58, y: 96 }, { x: 58, y: 90 }, { x: 42, y: 90 }, { x: 42, y: 96 }, { x: 3, y: 96 }]);
const PLAN = [
  ['Dining Room', '', 12, 4, 'round', 4, [8, 12, 46, 52]],
  ['Bar', 'B', 6, 2, 'square', 6, [56, 10, 94, 20]],
  ['Lounge', 'L', 4, 4, 'round', 2, [58, 34, 82, 54]],
  ['Patio', 'P', 8, 4, 'square', 4, [10, 64, 92, 90]],
];

const insArea = db.prepare(`INSERT INTO floor_areas (location_id, name, sort_order) VALUES (?,?,?)`);
const insTable = db.prepare(`INSERT INTO restaurant_tables (location_id, area_id, label, seats, sort_order, pos_x, pos_y, shape) VALUES (?,?,?,?,?,?,?,?)`);
const hasTables = db.prepare(`SELECT 1 FROM restaurant_tables WHERE location_id=? LIMIT 1`);

// Restaurants only — the central commissary has no dining floor.
const locs = db.prepare(`SELECT id, name FROM locations WHERE COALESCE(type,'') != 'central_kitchen' AND is_active=1 ORDER BY id`).all();

let seeded = 0, skipped = 0, tables = 0;
for (const loc of locs) {
  if (hasTables.get(loc.id)) { skipped++; continue; }
  db.prepare(`UPDATE locations SET room_outline=? WHERE id=?`).run(ROOM, loc.id);
  PLAN.forEach(([area, prefix, count, seats, shape, cols, box], si) => {
    const aid = insArea.run(loc.id, area, si).lastInsertRowid;
    const rows = Math.ceil(count / cols); const [x0, y0, x1, y1] = box;
    for (let i = 0; i < count; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      const px = cols === 1 ? Math.round((x0 + x1) / 2) : Math.round(x0 + c * (x1 - x0) / (cols - 1));
      const py = rows === 1 ? Math.round((y0 + y1) / 2) : Math.round(y0 + r * (y1 - y0) / (rows - 1));
      insTable.run(loc.id, aid, `${prefix}${i + 1}`, seats, i, px, py, shape); tables++;
    }
  });
  seeded++;
}
console.log(`Floor plan: seeded ${seeded} location(s) (${tables} tables), skipped ${skipped} already-seeded.`);
