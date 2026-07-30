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
  for (const t of ['audit_log', 'notify_log', 'waitlist', 'users', 'locations']) db.exec(`DELETE FROM ${t}`);

  const locIds = LOCATIONS.map(([name, addr, turn]) =>
    db.prepare(`INSERT INTO locations (name, address, avg_turn_minutes) VALUES (?,?,?)`).run(name, addr, turn).lastInsertRowid);

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

  console.log(`Seeded ${LOCATIONS.length} locations, ${PARTIES.length} waiting parties.`);
  console.log('Owner: harry@phohanoi.com / Harry123!  ·  Host: host1@phohanoi.com / Host123!');
}

if (require.main === module) { run(); console.log('Seed complete.'); }
module.exports = { run };
