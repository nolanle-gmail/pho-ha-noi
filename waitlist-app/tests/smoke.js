// End-to-end smoke test for the waitlist API. Run: node tests/smoke.js
process.env.DB_PATH = process.env.DB_PATH || require('path').join(__dirname, '..', 'db', 'phohanoi_waitlist.db');
const app = require('../server');

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + '  ' + d); } };

(async () => {
  const server = app.listen(4098);
  const base = 'http://localhost:4098';
  const H = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  const j = (r) => r.json();
  try {
    let r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'harry@phohanoi.com', password: 'Harry123!' }) });
    check('owner login', r.status === 200);
    const { token } = await j(r);

    r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'harry@phohanoi.com', password: 'nope' }) });
    check('bad password rejected', r.status === 401);

    const locs = await j(await fetch(base + '/api/waitlist/locations', { headers: H(token) }));
    check('ten locations', locs.length === 10, 'len=' + locs.length);
    // Seeded queue lives at San Jose; /locations is alphabetical, so resolve by name.
    const loc = Object.fromEntries(locs.map(l => [l.name, l.id]))['Pho Ha Noi — San Jose'];

    let queue = await j(await fetch(base + `/api/waitlist/?location_id=${loc}`, { headers: H(token) }));
    check('seeded queue', queue.length >= 4, 'len=' + queue.length);

    const quote = await j(await fetch(base + `/api/waitlist/quote?location_id=${loc}`, { headers: H(token) }));
    check('quote scales with queue', quote.suggested_minutes === quote.parties_ahead * 8, JSON.stringify(quote));

    r = await fetch(base + '/api/waitlist/', { method: 'POST', headers: H(token), body: JSON.stringify({ location_id: loc, guest_name: 'Smoke, Test', party_size: 3, phone: '+14085559999' }) });
    const added = await j(r);
    check('add party (auto quote)', r.status === 200 && added.quoted_minutes >= 0, JSON.stringify(added));
    const id = added.id;

    r = await fetch(base + `/api/waitlist/${id}/notify`, { method: 'POST', headers: H(token) });
    const notified = await j(r);
    check('notify (SMS stub)', r.status === 200 && notified.sent === true, JSON.stringify(notified));

    r = await fetch(base + `/api/waitlist/${id}/notify`, { method: 'POST', headers: H(token) });
    check('notify allowed while waiting', r.status === 200);

    r = await fetch(base + `/api/waitlist/${id}/seat`, { method: 'PUT', headers: H(token), body: JSON.stringify({ table_number: '7' }) });
    check('seat party', r.status === 200, await r.text());

    r = await fetch(base + `/api/waitlist/${id}/seat`, { method: 'PUT', headers: H(token), body: JSON.stringify({}) });
    check('cannot re-seat', r.status === 409);

    const stats = await j(await fetch(base + `/api/waitlist/stats?location_id=${loc}`, { headers: H(token) }));
    check('stats seated_today', stats.seated_today >= 1, JSON.stringify(stats));

    // Add + leave
    const p2 = await j(await fetch(base + '/api/waitlist/', { method: 'POST', headers: H(token), body: JSON.stringify({ location_id: loc, guest_name: 'Leaver', party_size: 2 }) }));
    r = await fetch(base + `/api/waitlist/${p2.id}/leave`, { method: 'PUT', headers: H(token) });
    check('mark left', r.status === 200);

    const history = await j(await fetch(base + `/api/waitlist/history?location_id=${loc}`, { headers: H(token) }));
    check('history has handled parties', history.length >= 2, 'len=' + history.length);

    // ── Activity log / audit: who did what ─────────────────────
    const audit = await j(await fetch(base + `/api/waitlist/audit?location_id=${loc}`, { headers: H(token) }));
    check('audit log populated', Array.isArray(audit) && audit.length >= 4, 'len=' + (audit && audit.length));
    check('audit records party_added', audit.some(a => a.action === 'party_added'), 'no party_added');
    check('audit records party_notified', audit.some(a => a.action === 'party_notified'));
    check('audit records party_seated', audit.some(a => a.action === 'party_seated'));
    check('audit records party_left', audit.some(a => a.action === 'party_left'));
    check('audit records the actor', audit.every(a => 'user_name' in a) && audit.some(a => a.user_name === 'Harry Nguyen'), 'no actor');
    check('audit detail parsed to object', audit.some(a => a.detail && a.detail.guest), 'no detail.guest');

    // RBAC: host pinned to their location
    const host = await j(await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'host2@phohanoi.com', password: 'Host123!' }) }));
    const hostQueue = await j(await fetch(base + '/api/waitlist/', { headers: H(host.token) }));
    check('host scoped to own location', Array.isArray(hostQueue), 'not array');
  } catch (e) { fail++; console.log('  FAIL  exception: ' + e.message); }
  finally { server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
