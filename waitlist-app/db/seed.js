// Seed Pho Ha Noi waitlist: owner, two locations, host accounts, and a few
// walk-in parties currently waiting.
const bcrypt = require('bcryptjs');
const db = require('./database');
const { migrate } = require('./schema');

migrate();

const LOCATIONS = [
  ['Pho Ha Noi — San Jose', '123 Santana Row, San Jose, CA 95128', 8],
  ['Pho Ha Noi — Milpitas', '456 Great Mall Dr, Milpitas, CA 95035', 7],
  ['Pho Ha Noi — Cupertino', '789 Stevens Creek Blvd, Cupertino, CA 95014', 9],
  ['Pho Ha Noi — Fremont', '321 Fremont Blvd, Fremont, CA 94538', 8],
  ['Pho Ha Noi — Palo Alto', '654 University Ave, Palo Alto, CA 94301', 10],
  ['Pho Ha Noi — Berkeley', '987 Shattuck Ave, Berkeley, CA 94704', 9],
  ['Pho Ha Noi — Fountain Valley', '159 Brookhurst St, Fountain Valley, CA 92708', 8],
  ['Pho Ha Noi — Santa Clara', '753 El Camino Real, Santa Clara, CA 95050', 7],
  ['Pho Ha Noi — Sunnyvale', '852 Murphy Ave, Sunnyvale, CA 94086', 8],
  ['Pho Ha Noi — Oakland', '426 Broadway, Oakland, CA 94607', 9],
];

const PARTIES = [
  ['Nguyen, Kim', 4, '+14085550101', 'Booth if possible', -18],
  ['Tran, David', 2, '+14085550102', null, -12],
  ['Pham, Lily', 6, '+14085550103', 'High chair needed', -7],
  ['Le, Anh', 3, '+14085550104', null, -3],
];

function run() {
  for (const t of ['audit_log', 'notify_log', 'waitlist', 'restaurant_tables', 'floor_areas', 'users', 'locations']) db.exec(`DELETE FROM ${t}`);

  const locIds = LOCATIONS.map(([name, addr, turn]) =>
    db.prepare(`INSERT INTO locations (name, address, avg_turn_minutes) VALUES (?,?,?)`).run(name, addr, turn).lastInsertRowid);

  // Default room outline (a rectangle with an entrance notch) for the floor map.
  const DEFAULT_ROOM = JSON.stringify([
    { x: 3, y: 4 }, { x: 97, y: 4 }, { x: 97, y: 96 }, { x: 58, y: 96 },
    { x: 58, y: 90 }, { x: 42, y: 90 }, { x: 42, y: 96 }, { x: 3, y: 96 },
  ]);
  locIds.forEach((lid) => db.prepare(`UPDATE locations SET room_outline=? WHERE id=?`).run(DEFAULT_ROOM, lid));

  // Default floor plan for every location: areas with numbered tables, laid out on
  // the visual floor map. Each area occupies a region [x0,y0 .. x1,y1] (% of board)
  // and its tables are placed on a grid within it.
  const insArea = db.prepare(`INSERT INTO floor_areas (location_id, name, sort_order) VALUES (?,?,?)`);
  const insTable = db.prepare(`INSERT INTO restaurant_tables (location_id, area_id, label, seats, sort_order, pos_x, pos_y, shape) VALUES (?,?,?,?,?,?,?,?)`);
  // [area, prefix, count, seats, shape, cols, [x0,y0,x1,y1]]
  const PLAN = [
    ['Dining Room', '', 12, 4, 'round', 4, [8, 12, 46, 52]],
    ['Bar', 'B', 6, 2, 'square', 6, [56, 10, 94, 20]],
    ['Lounge', 'L', 4, 4, 'round', 2, [58, 34, 82, 54]],
    ['Patio', 'P', 8, 4, 'square', 4, [10, 64, 92, 90]],
  ];
  let tableCount = 0;
  locIds.forEach((lid) => PLAN.forEach(([area, prefix, count, seats, shape, cols, box], si) => {
    const aid = insArea.run(lid, area, si).lastInsertRowid;
    const rows = Math.ceil(count / cols);
    const [x0, y0, x1, y1] = box;
    for (let i = 0; i < count; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      const px = cols === 1 ? Math.round((x0 + x1) / 2) : Math.round(x0 + (c * (x1 - x0)) / (cols - 1));
      const py = rows === 1 ? Math.round((y0 + y1) / 2) : Math.round(y0 + (r * (y1 - y0)) / (rows - 1));
      insTable.run(lid, aid, `${prefix}${i + 1}`, seats, i, px, py, shape);
      tableCount++;
    }
  }));

  const hash = (p) => bcrypt.hashSync(p, 10);
  db.prepare(`INSERT INTO users (name,email,password_hash,role,location_id) VALUES (?,?,?,?,?)`).run('Harry Nguyen', 'harry@phohanoi.com', hash('Harry123!'), 'owner', null);
  locIds.forEach((lid, i) => {
    db.prepare(`INSERT INTO users (name,email,password_hash,role,location_id) VALUES (?,?,?,?,?)`).run(`Manager ${i + 1}`, `manager${i + 1}@phohanoi.com`, hash('Manager123!'), 'manager', lid);
    db.prepare(`INSERT INTO users (name,email,password_hash,role,location_id) VALUES (?,?,?,?,?)`).run(`Host ${i + 1}`, `host${i + 1}@phohanoi.com`, hash('Host123!'), 'frontdesk', lid);
  });

  // A live queue at Downtown, staggered arrival times.
  const ins = db.prepare(`INSERT INTO waitlist (location_id, guest_name, party_size, phone, quoted_minutes, notes, created_at) VALUES (?,?,?,?,?,?, datetime('now', ?))`);
  PARTIES.forEach(([name, size, phone, notes, minsAgo], idx) =>
    ins.run(locIds[0], name, size, phone, (idx) * LOCATIONS[0][2], notes, `${minsAgo} minutes`));

  // A couple already handled today (for history), attributed to Host 1 in the log.
  const host1 = db.prepare(`SELECT id FROM users WHERE email='host1@phohanoi.com'`).get();
  const vo = db.prepare(`INSERT INTO waitlist (location_id, guest_name, party_size, phone, status, seated_at, table_number, created_at) VALUES (?,?,?,?, 'seated', datetime('now','-25 minutes'), '12', datetime('now','-40 minutes'))`).run(locIds[0], 'Vo, Thanh', 2, '+14085550110').lastInsertRowid;
  const walk = db.prepare(`INSERT INTO waitlist (location_id, guest_name, party_size, status, created_at) VALUES (?,?,?, 'left', datetime('now','-50 minutes'))`).run(locIds[0], 'Walk-off party', 5).lastInsertRowid;

  const audit = db.prepare(`INSERT INTO audit_log (user_id, location_id, action, entity, entity_id, detail, created_at) VALUES (?,?,?, 'waitlist', ?, ?, datetime('now', ?))`);
  audit.run(host1.id, locIds[0], 'party_added', vo, JSON.stringify({ guest: 'Vo, Thanh', party_size: 2 }), '-42 minutes');
  audit.run(host1.id, locIds[0], 'party_notified', vo, JSON.stringify({ guest: 'Vo, Thanh', channel: 'sms' }), '-30 minutes');
  audit.run(host1.id, locIds[0], 'party_seated', vo, JSON.stringify({ guest: 'Vo, Thanh', party_size: 2, table_number: '12' }), '-25 minutes');
  audit.run(host1.id, locIds[0], 'party_added', walk, JSON.stringify({ guest: 'Walk-off party', party_size: 5 }), '-55 minutes');
  audit.run(host1.id, locIds[0], 'party_left', walk, JSON.stringify({ guest: 'Walk-off party', party_size: 5 }), '-50 minutes');

  // ── Historical guests across all 10 locations (last 21 days) ─────────────
  // Populates the owner-only guest history and daily report.
  const rng = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const FIRST = ['Nguyen', 'Tran', 'Le', 'Pham', 'Hoang', 'Vo', 'Dang', 'Bui', 'Do', 'Ngo', 'Duong', 'Ly', 'Chen', 'Kim', 'Smith', 'Garcia', 'Patel'];
  const GIVEN = ['Kim', 'David', 'Lily', 'Anh', 'Minh', 'Linh', 'Tuan', 'Mai', 'Alex', 'Sarah', 'Danny', 'Grace', 'Henry', 'Ivy'];
  const histIns = db.prepare(`INSERT INTO waitlist (location_id, guest_name, party_size, phone, quoted_minutes, status, seated_at, created_at) VALUES (?,?,?,?,?,?,?, datetime('now', ?))`);
  let histCount = 0;
  for (let d = 1; d <= 21; d++) {
    locIds.forEach((lid, li) => {
      // Busier locations (lower index) and weekends see more guests.
      const base = li < 4 ? 4 : 2;
      const count = Math.floor(rng() * base) + Math.floor(rng() * 3);
      for (let i = 0; i < count; i++) {
        const name = `${FIRST[Math.floor(rng() * FIRST.length)]}, ${GIVEN[Math.floor(rng() * GIVEN.length)]}`;
        const size = 1 + Math.floor(rng() * 6);
        const hoursAgo = d * 24 - Math.floor(rng() * 10) - 11; // spread through service hours
        const seated = rng() > 0.18; // most parties get seated; some leave
        histIns.run(lid, name, size, null, Math.floor(rng() * 40),
          seated ? 'seated' : 'left', null, `-${hoursAgo} hours`);
        histCount++;
      }
    });
  }
  // Set a realistic seated_at for the historical seated rows (a few minutes
  // after arrival). Done in a follow-up pass so the insert stays simple.
  db.prepare(`UPDATE waitlist SET seated_at=datetime(created_at, '+' || (10 + (id % 30)) || ' minutes') WHERE status='seated' AND seated_at IS NULL`).run();

  console.log(`Seeded ${LOCATIONS.length} locations, ${tableCount} tables (floor plan), ${PARTIES.length} waiting parties, ${histCount} historical guests.`);
  console.log('Owner: harry@phohanoi.com / Harry123!  ·  Host: host1@phohanoi.com / Host123!');
}

if (require.main === module) { run(); console.log('Seed complete.'); }
module.exports = { run };
