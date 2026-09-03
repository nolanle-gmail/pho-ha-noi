// Front-desk hosts primarily live in the Staff (waitlist) app, but messaging is
// a single directory owned by Management. So every front-desk host must also
// exist here, matched by email, or they couldn't be messaged / send messages.
// Idempotent: safe to run on every boot (fresh seed and existing prod alike).
const db = require('./database');
const bcrypt = require('bcryptjs');

function ensureDirectory() {
  const locs = db.prepare(`SELECT id FROM locations ORDER BY id`).all();
  if (!locs.length) return; // nothing seeded yet
  const has = db.prepare(`SELECT id FROM users WHERE email=?`);
  const ins = db.prepare(`INSERT INTO users (name, email, phone, password_hash, role, location_id) VALUES (?,?,?,?,?,?)`);
  const pw = bcrypt.hashSync('Host123!', 10);
  let added = 0;
  for (let i = 0; i < 10; i++) {
    const email = `host${i + 1}@phohanoi.com`;
    if (has.get(email)) continue;
    const lid = (locs[i] || locs[locs.length - 1]).id;
    // Front-desk login phone (10 digits): (408) 555-02NN.
    ins.run(`Front Desk ${i + 1}`, email, `40855502${String(i + 1).padStart(2, '0')}`, pw, 'frontdesk', lid);
    added++;
  }
  if (added) console.log(`Directory: added ${added} front-desk host account(s) for messaging.`);
}

module.exports = { ensureDirectory };
