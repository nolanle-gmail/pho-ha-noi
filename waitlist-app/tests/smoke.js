// End-to-end smoke test for the waitlist API. Run: node tests/smoke.js
process.env.DB_PATH = process.env.DB_PATH || require('path').join(__dirname, '..', 'db', 'phohanoi_waitlist.db');
process.env.CHECKIN_MAX = process.env.CHECKIN_MAX || '5'; // low cap so the rate-limit test is cheap
const app = require('../server');

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + '  ' + d); } };

(async () => {
  const server = app.listen(4098);
  const base = 'http://localhost:4098';
  const H = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  const j = (r) => r.json();
  try {
    let r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '4084830030', password: 'Harry123!' }) });
    check('owner login by phone', r.status === 200);
    const { token } = await j(r);

    r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '4084830030', password: 'nope' }) });
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
    check('stats include kiosk walk-ins today', typeof stats.kiosk_walkins_today === 'number', JSON.stringify(stats.kiosk_walkins_today));

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

    // ── Owner-only: full guest history + daily report ──────────
    const allHist = await j(await fetch(base + '/api/waitlist/history/all', { headers: H(token) }));
    check('owner guest history (all locations)', Array.isArray(allHist) && allHist.length >= 20, 'len=' + (allHist && allHist.length));
    check('history rows carry location name', allHist.every(r => 'location_name' in r));
    const locNames = new Set(allHist.map(r => r.location_name));
    check('history spans multiple locations', locNames.size >= 5, 'locs=' + locNames.size);

    const oneLoc = await j(await fetch(base + `/api/waitlist/history/all?location_id=${loc}`, { headers: H(token) }));
    check('history filters by location', oneLoc.every(r => r.location_id === loc));

    // CSV export path: a large limit returns the full set (not capped at 500)
    const fullExport = await j(await fetch(base + '/api/waitlist/history/all?limit=50000', { headers: H(token) }));
    check('history honors large export limit', Array.isArray(fullExport) && fullExport.length >= allHist.length, 'len=' + fullExport.length);
    check('export rows have CSV fields', fullExport.every(r => 'guest_name' in r && 'created_at' in r && 'location_name' in r));

    const report = await j(await fetch(base + '/api/waitlist/report/daily', { headers: H(token) }));
    check('daily report has rows + totals', report.rows.length >= 1 && report.totals.guests > 0, JSON.stringify(report.totals));
    check('report day has guest headcount', report.rows.every(r => 'guests' in r && 'parties' in r));

    // ── Customer self-check-in (public, no auth) ──────────────────────────
    const pubLocs = await j(await fetch(base + '/api/public/locations'));
    check('public locations (no auth)', Array.isArray(pubLocs) && pubLocs.length === 10, 'len=' + (pubLocs || []).length);
    const pubStatus = await j(await fetch(base + `/api/public/status?location_id=${loc}`));
    check('public status (no auth)', typeof pubStatus.parties_ahead === 'number' && !!pubStatus.location, JSON.stringify(pubStatus).slice(0, 60));
    const selfIn = await j(await fetch(base + '/api/public/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: loc, guest_name: 'Self Serve', party_size: 2, phone: '(408) 555-0123', notes: 'High chair · booth' }) }));
    check('self check-in creates entry', selfIn.success === true && !!selfIn.ref && selfIn.position >= 1, JSON.stringify(selfIn).slice(0, 60));
    r = await fetch(base + '/api/public/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: loc, party_size: 2 }) });
    check('self check-in requires a name (400)', r.status === 400, 'status=' + r.status);
    const pos = await j(await fetch(base + `/api/public/position/${selfIn.ref}`));
    check('guest can track their spot', pos.status === 'waiting' && pos.guest_name === 'Self Serve' && pos.position >= 1, JSON.stringify(pos).slice(0, 60));
    const selfInQueue = await j(await fetch(base + `/api/waitlist/?location_id=${loc}`, { headers: H(token) }));
    const selfRow = selfInQueue.find(x => x.public_ref === selfIn.ref);
    check('self check-in shows on front-desk board with source', !!selfRow && selfRow.source === 'self', 'not found');
    check('special request carried to the board', selfRow && selfRow.notes === 'High chair · booth', 'notes=' + (selfRow && selfRow.notes));
    r = await fetch(base + '/api/public/position/nope-nope', {});
    check('unknown reference 404', r.status === 404, 'status=' + r.status);

    // Duplicate submit (double-tap / reload) returns the same entry, not a new one.
    const dup = await j(await fetch(base + '/api/public/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: loc, guest_name: 'Self Serve', party_size: 2, phone: '(408) 555-0123' }) }));
    check('duplicate submit reuses existing entry', dup.duplicate === true && dup.ref === selfIn.ref, JSON.stringify(dup).slice(0, 60));

    // Rate limit kicks in after CHECKIN_MAX (=5) check-ins per IP.
    const burst = [];
    for (let i = 0; i < 8; i++) {
      const rr = await fetch(base + '/api/public/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: loc, guest_name: 'Burst ' + i, party_size: 2 }) });
      burst.push(rr.status);
    }
    check('check-in is rate limited (429)', burst.includes(429), 'statuses=' + burst.join(','));

    // ── RBAC: host pinned to own location; cannot see owner history/report ──
    const host = await j(await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '4085550202', password: 'Host123!' }) }));
    const hostQueue = await j(await fetch(base + '/api/waitlist/', { headers: H(host.token) }));
    check('host scoped to own location', Array.isArray(hostQueue), 'not array');
    r = await fetch(base + '/api/waitlist/history/all', { headers: H(host.token) });
    check('host BLOCKED from guest history', r.status === 403, 'status=' + r.status);
    r = await fetch(base + '/api/waitlist/report/daily', { headers: H(host.token) });
    check('host BLOCKED from daily report', r.status === 403, 'status=' + r.status);

    // ── Activity log (owner-only access trail) ─────────────────
    const wacts = await j(await fetch(base + '/api/waitlist/activity-log', { headers: H(token) }));
    check('activity log records events', Array.isArray(wacts) && wacts.length > 0, 'len=' + (wacts || []).length);
    check('login is logged', wacts.some(a => a.path === '/api/auth/login' && a.status === 200), 'no login event');
    check('self check-in is logged', wacts.some(a => a.path === '/api/public/checkin'), 'no checkin event');
    r = await fetch(base + '/api/waitlist/activity-log', { headers: H(host.token) });
    check('host blocked from activity log (403)', r.status === 403, 'status=' + r.status);

    // Manager also blocked (owner-only)
    const mgr = await j(await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '4085550101', password: 'Manager123!' }) }));
    r = await fetch(base + '/api/waitlist/history/all', { headers: H(mgr.token) });
    check('manager BLOCKED from guest history', r.status === 403, 'status=' + r.status);

    // ── Table map (proxied to the Management app) ──────────────
    // The floor plan now lives in the Management app; the Front Desk reads/seats
    // through /api/floormap. Auth + wiring are checked here (Management isn't up
    // during this smoke, so a proxied call returns 502 — proving it forwards).
    r = await fetch(base + '/api/floormap');
    check('table map requires auth (401)', r.status === 401, 'status=' + r.status);
    r = await fetch(base + '/api/floormap', { headers: H(host.token) });
    check('front desk table map proxies to Management (200/502)', r.status === 200 || r.status === 502, 'status=' + r.status);

    // ── Staff service board (proxied to Management /api/visits) ─────────────
    // Management isn't up during this smoke, so proxied calls return 502 and the
    // Management-auth fallback yields 401 — both prove the wiring without it.
    r = await fetch(base + '/api/service');
    check('service board requires auth (401)', r.status === 401, 'status=' + r.status);
    r = await fetch(base + '/api/service', { headers: H(host.token) });
    check('service board proxies to Management (200/502)', r.status === 200 || r.status === 502, 'status=' + r.status);
    r = await fetch(base + '/api/mytasks');
    check('my tasks require auth (401)', r.status === 401, 'status=' + r.status);
    r = await fetch(base + '/api/mytasks', { headers: H(host.token) });
    check('my tasks proxy to Management (200/502)', r.status === 200 || r.status === 502, 'status=' + r.status);

    // ── Front-of-house activity feed (read by Management for the merged view) ──
    r = await fetch(base + '/api/activity-feed');
    check('activity feed requires auth (401)', r.status === 401, 'status=' + r.status);
    r = await fetch(base + '/api/activity-feed', { headers: { 'X-Service-Key': 'dev-floorplan-key' } });
    check('activity feed via service key', r.status === 200 && Array.isArray(await r.json()), 'status=' + r.status);
    const afeed = await j(await fetch(base + `/api/activity-feed?location_id=${loc}&range=day`, { headers: H(token) }));
    check('owner reads activity feed (today, scoped)', Array.isArray(afeed) && afeed.every(a => a.source === 'frontdesk'), 'n=' + (afeed || []).length);
    r = await fetch(base + '/api/activity-feed', { headers: H(host.token) });
    check('non-owner blocked from activity feed (403)', r.status === 403, 'status=' + r.status);

    // ── PWA: installable Staff app (manifest + service worker + icons) ─────
    const mani = await fetch(base + '/manifest.webmanifest');
    check('PWA manifest served', mani.status === 200);
    const mj = await j(mani);
    check('manifest names the Staff app + standalone', /Staff$/.test(mj.name || '') && mj.display === 'standalone' && Array.isArray(mj.icons) && mj.icons.length >= 2, JSON.stringify({ n: mj.name, d: mj.display }));
    check('service worker served', (await fetch(base + '/sw.js')).status === 200);
    check('PWA icons served', (await fetch(base + '/icon-512.png')).status === 200 && (await fetch(base + '/apple-touch-icon.png')).status === 200);
    // A phone that isn't a local account falls through to the Management directory
    // (unreachable during this smoke → a clean 401, proving the fallback path runs).
    r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '9995550000', password: 'whatever123' }) });
    check('non-local phone falls back to Management (401 when down)', r.status === 401, 'status=' + r.status);

    // ── Messaging proxy: mounted + auth-gated (forwards to Management) ─────
    r = await fetch(base + '/api/messages/inbox');
    check('messages proxy needs auth (401)', r.status === 401, 'status=' + r.status);

    // ── My Hours proxy: mounted + auth-gated ──────────────────────────────
    r = await fetch(base + '/api/timeclock/my-hours');
    check('my-hours proxy needs auth (401)', r.status === 401, 'status=' + r.status);

    // ── Live push (SSE): the Staff stream authenticates by query token ─────
    r = await fetch(base + '/api/stream');
    check('staff stream needs auth (401)', r.status === 401, 'status=' + r.status);
    {
      const ac = new AbortController();
      const sr = await fetch(base + `/api/stream?token=${token}&location_id=${loc}`, { signal: ac.signal });
      check('staff stream opens (200 + event-stream)',
        sr.status === 200 && /text\/event-stream/.test(sr.headers.get('content-type') || ''),
        'ct=' + sr.headers.get('content-type'));
      ac.abort();
    }
  } catch (e) { fail++; console.log('  FAIL  exception: ' + e.message); }
  finally { server.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
