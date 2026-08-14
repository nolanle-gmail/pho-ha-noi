// Pho Ha Noi — Host Check-in / Waitlist
const S = { token: null, user: null, locations: [], loc: null, view: 'board' };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Stored timestamps are UTC (SQLite datetime('now')); show them in the viewer's local time.
function fmtLocalTs(ts) {
  if (!ts) return '';
  let s = String(ts).includes('T') ? String(ts) : String(ts).replace(' ', 'T');
  if (!/[Z+]/.test(s.slice(10))) s += 'Z';
  const d = new Date(s);
  if (isNaN(d)) return ts;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const fmtLocalHm = (ts) => { const f = fmtLocalTs(ts); return f ? f.slice(11, 16) : ''; };

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  const res = await fetch('/api' + path, Object.assign({}, opts, { headers }));
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const q = (p) => `${p}${p.includes('?') ? '&' : '?'}${S.loc ? 'location_id=' + S.loc : ''}`;
// Everyone gets My Tasks; roles then add their own tools. Servers/bussers land on
// My Tables, front-desk roles on the Front Desk, everyone else on My Tasks.
const SERVER_ROLES = ['server', 'busser'];
const FD_ROLES = ['owner', 'manager', 'assistant_manager', 'general_manager', 'regional_manager', 'frontdesk', 'host'];
const isServerRole = (r) => SERVER_ROLES.includes(r);
const isFrontDeskRole = (r) => FD_ROLES.includes(r);
const landingView = (r) => isServerRole(r) ? 'server' : (isFrontDeskRole(r) ? 'board' : 'mytasks');

let toastTimer;
function toast(msg, bad) {
  clearTimeout(toastTimer);
  let t = $('toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg;
  toastTimer = setTimeout(() => t.remove(), 3200);
}
function waited(createdAt) {
  const ms = Date.now() - new Date((createdAt || '').replace(' ', 'T') + 'Z').getTime();
  return Math.max(0, Math.round(ms / 60000));
}

$('loginForm').onsubmit = async (e) => {
  e.preventDefault(); $('loginErr').textContent = '';
  try {
    const d = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
    S.token = d.token; S.user = d.user;
    localStorage.setItem('phnw_token', d.token); localStorage.setItem('phnw_user', JSON.stringify(d.user));
    await boot();
  } catch (err) { $('loginErr').textContent = err.message; }
};
$('logout').onclick = () => { localStorage.clear(); location.reload(); };

function tick() { $('clock').textContent = new Date().toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }); }

async function boot() {
  $('login').classList.add('hidden'); $('app').classList.remove('hidden');
  tick(); setInterval(tick, 20000);
  S.view = landingView(S.user.role);   // role-appropriate landing screen
  // The Staff Clock kiosk shortcut is for host / front-desk staff, plus owner + manager.
  $('staffClock').classList.toggle('hidden', !['host', 'frontdesk', 'owner', 'manager'].includes(S.user.role));
  S.locations = await api('/waitlist/locations').catch(() => []);   // non-HOST staff can't list; non-fatal
  const picker = $('locPicker');
  const short = (id) => ((S.locations.find(l => String(l.id) === String(id)) || {}).name || '').replace('Pho Ha Noi — ', '');
  if (S.user.role === 'owner') {
    // Owner can view any store; remember the last one they were looking at.
    picker.classList.remove('hidden');
    picker.innerHTML = S.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    const saved = localStorage.getItem('phnw_fd_loc');
    S.loc = (saved && S.locations.some(l => String(l.id) === saved)) ? saved : String(S.locations[0].id);
    picker.value = S.loc;
    picker.onchange = () => { S.loc = picker.value; try { localStorage.setItem('phnw_fd_loc', S.loc); } catch { /* private mode */ } render(); setupStaffStream(); };
  } else {
    // Host / front-desk staff are pinned to their own store's waitlist.
    S.loc = String(S.user.location_id);
    picker.classList.add('hidden');
    const badge = $('locName');
    badge.textContent = '📍 ' + short(S.loc);
    badge.classList.remove('hidden');
  }
  renderNav();
  render();
  setupStaffStream();   // sub-second push (SSE) for live views
  // Slow backstop only — the SSE stream (setupStaffStream) carries live changes
  // from the other app (e.g. a guest seated at the Front Desk) within a moment.
  setInterval(() => {
    if (!LIVE_VIEWS.includes(S.view) || $('modalHost').innerHTML) return;
    const y = window.scrollY; Promise.resolve(render()).then(() => window.scrollTo(0, y));
  }, 15000);
}

// Live views that refresh on push. Board (Front Desk), Server view, Table Map.
const LIVE_VIEWS = ['board', 'server', 'tables'];
let STAFF_ES = null, STAFF_ES_LOC = null, STAFF_PUSH_T = null, STAFF_LIVE = '';

// Live-push status pill shown on the board so staff can trust it's real-time.
const LIVE_LABEL = { live: '● Live', connecting: '● Connecting…', off: '● Reconnecting…' };
function setStaffLive(state) {
  STAFF_LIVE = state;
  const el = $('staffLive');
  if (!el) return;
  el.dataset.state = state;
  el.textContent = LIVE_LABEL[state] || '';
  // Only surface it on the live boards; other views (tasks, activity) don't push.
  el.classList.toggle('hidden', !state || !LIVE_VIEWS.includes(S.view));
}

// One SSE connection carries both this app's waitlist events and the Management
// app's visit events (forwarded server-side), so any change lands sub-second.
function setupStaffStream() {
  const loc = S.loc || '';
  if (STAFF_ES && STAFF_ES_LOC === loc) return;   // already streaming this scope
  if (STAFF_ES) { STAFF_ES.close(); STAFF_ES = null; }
  const token = localStorage.getItem('phnw_token');
  if (!token || typeof EventSource === 'undefined') return;
  STAFF_ES_LOC = loc;
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(token)}${loc ? `&location_id=${encodeURIComponent(loc)}` : ''}`);
  STAFF_ES = es;
  setStaffLive('connecting');
  es.onopen = () => setStaffLive('live');
  es.onmessage = () => {
    setStaffLive('live');   // a message means the pipe is healthy
    clearTimeout(STAFF_PUSH_T);
    STAFF_PUSH_T = setTimeout(() => {
      if (!LIVE_VIEWS.includes(S.view) || $('modalHost').innerHTML) return;
      const y = window.scrollY; Promise.resolve(render()).then(() => window.scrollTo(0, y));
    }, 150);   // coalesce bursts of events into one render
  };
  es.onerror = () => setStaffLive('off');   // EventSource auto-reconnects; poll is the backstop
}

// Sub-navigation: owner sees everything; managers get the Front Desk + Floor Plan.
function renderNav() {
  const nav = $('subnav');
  const role = S.user.role;
  const items = [['mytasks', '📋 My Tasks']];   // every staff member has tasks
  if (isServerRole(role)) items.push(['server', '🛎️ My Tables']);
  if (isFrontDeskRole(role)) items.push(['board', '🍜 Front Desk']);
  if (isServerRole(role) || isFrontDeskRole(role)) items.push(['tables', '🍽️ Floor']);
  if (role === 'owner') items.push(['history', '📜 Guest History'], ['report', '📊 Daily Report'], ['activity', '🧾 Activity Log']);
  nav.classList.remove('hidden');
  nav.innerHTML = items.map(([k, l]) => `<button class="navbtn ${S.view === k ? 'active' : ''}" data-view="${k}">${l}</button>`).join('');
  nav.querySelectorAll('button').forEach(b => b.onclick = () => { S.view = b.dataset.view; renderNav(); render(); });
}

// Dispatch to the active view.
function render() {
  setStaffLive(STAFF_LIVE);   // keep the live pill in sync with the current view
  if (S.view === 'mytasks') return renderMyTasks();
  if (S.view === 'server') return renderServer();
  if (S.view === 'history') return renderHistory();
  if (S.view === 'report') return renderReport();
  if (S.view === 'activity') return renderActivity();
  if (S.view === 'tables') return renderTables();
  return renderBoard();
}

// ── My Tasks: the staff member's day-task assignments (any role) ──────────────
async function renderMyTasks() {
  const v = $('view');
  let d;
  try { d = await api('/mytasks'); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (d.tasks && d.tasks[0] && d.tasks[0].location_name) { const b = $('locName'); b.textContent = '📍 ' + d.tasks[0].location_name.replace('Pho Ha Noi — ', ''); b.classList.remove('hidden'); }
  const { done, total } = d.summary;
  const pct = total ? Math.round(done / total * 100) : 0;
  const day = (() => { const dt = new Date(d.date + 'T00:00:00'); return isNaN(dt) ? d.date : dt.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }); })();
  const cards = d.tasks.length ? d.tasks.map(mtCard).join('') : '<div class="sv-empty">No tasks assigned for today — enjoy your shift.</div>';
  v.innerHTML = `
    <div class="sv-head">
      <div><div class="sv-hi">My Tasks</div><div class="muted">${esc(day)} · ${done}/${total} done</div></div>
      ${total ? `<div class="mt-ring${done === total ? ' full' : ''}">${pct}%</div>` : ''}
    </div>
    ${cards}`;
  v.querySelectorAll('[data-mt]').forEach(b => b.onclick = () => mtToggle(b.dataset.mt, b.dataset.done === '1'));
}
function mtCard(t) {
  const time = t.task_time ? `<span class="mt-time">${esc(t.task_time)}</span>` : '';
  const meta = [t.department, t.est_minutes ? `~${t.est_minutes}m` : '', t.complexity].filter(Boolean).join(' · ');
  return `<div class="mt-card${t.done ? ' done' : ''}">
    <button class="mt-check" data-mt="${t.id}" data-done="${t.done ? 1 : 0}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}">${t.done ? '✓' : ''}</button>
    <div class="mt-body"><div class="mt-name">${time}${esc(t.name)}</div>
      ${meta ? `<div class="muted mt-meta">${esc(meta)}</div>` : ''}
      ${t.description ? `<div class="mt-desc">${esc(t.description)}</div>` : ''}</div></div>`;
}
async function mtToggle(id, currentlyDone) {
  try { await api(`/mytasks/${id}/done`, { method: 'PUT', body: JSON.stringify({ done: !currentlyDone }) }); renderMyTasks(); }
  catch (e) { toast(e.message, true); }
}

// ── Server view: my tables, checks, claim queue, covers + tips ────────────────
async function renderServer() {
  const v = $('view');
  let data, tally;
  try { [data, tally] = await Promise.all([api('/service'), api('/service/me/tally')]); }
  catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (data.location) { const b = $('locName'); b.textContent = '📍 ' + data.location.name.replace('Pho Ha Noi — ', ''); b.classList.remove('hidden'); }
  const me = String(S.user.id);
  const mine = [...(data.lists.in_service || []), ...(data.lists.paying || [])].filter(t => String(t.server_id) === me);
  const rank = (t) => t.stage === 'paying' ? 1e9 : (t.minutes_to_check == null ? 1e8 : t.minutes_to_check);
  mine.sort((a, b) => rank(a) - rank(b));
  const dueMine = mine.filter(t => t.stage === 'in_service' && t.check_due);
  const claim = data.lists.seated || [];
  const toBus = data.to_bus || [];
  S.svById = {}; [...mine, ...claim, ...toBus].forEach(t => S.svById[t.id] = t);

  const hero = dueMine.length ? `<div class="sv-hero"><div class="sv-hero-h">⏰ Needs a check now</div>${dueMine.map(t => `
    <div class="sv-hero-row"><span class="sv-tnum">T${esc(t.table_label || '?')}</span>
      <span class="sv-hero-info">${esc(t.guest_name || 'Guest')} · ${t.party_size}👤 · <b>overdue ${Math.abs(t.minutes_to_check)}m</b></span>
      <button class="sv-btn go" data-act="check" data-vid="${t.id}">✓ Checked</button></div>`).join('')}</div>` : '';

  const myCards = mine.length ? mine.map(svServerCard).join('') : '<div class="sv-empty">No tables yet — claim one below.</div>';
  const claimCards = claim.length ? claim.map((t, i) => `<div class="sv-row${i === 0 ? ' first' : ''}">
      <span class="sv-tnum sm">T${esc(t.table_label || '?')}</span>
      <span class="sv-row-info">${esc(t.guest_name || 'Guest')} · ${t.party_size}👤${t.notes ? ` <span class="sv-note-i">${esc(t.notes)}</span>` : ''}<br><span class="muted">seated ${t.seated_min_ago ?? 0}m ago</span></span>
      <button class="sv-btn claim" data-act="claim" data-vid="${t.id}">Claim</button></div>`).join('') : '<div class="sv-empty">No open tables to claim.</div>';
  const busSection = toBus.length ? `<div class="sv-sec-h">To bus <span class="sv-n">${toBus.length}</span></div>${toBus.map(t => `<div class="sv-row">
      <span class="sv-tnum sm">T${esc(t.table_label || '?')}</span>
      <span class="sv-row-info">${esc(t.guest_name || '')} <span class="muted">· ready to clear</span></span>
      <button class="sv-btn" data-act="bussed" data-vid="${t.id}">✓ Bussed</button></div>`).join('')}` : '';

  v.innerHTML = `
    <div class="sv-head">
      <div><div class="sv-hi">Hi, ${esc((S.user.name || '').split(' ')[0])}</div><div class="muted">${mine.length} table${mine.length !== 1 ? 's' : ''} · ${tally.open_tables} open</div></div>
      <div class="sv-stats"><div><b>${tally.covers}</b><span>covers</span></div><div><b>$${(tally.tips || 0).toFixed(2)}</b><span>tips</span></div></div>
    </div>
    ${hero}
    <div class="sv-sec-h">My tables</div>${myCards}
    <div class="sv-sec-h">Open to claim <span class="muted" style="font-weight:400">· whole floor, oldest first</span></div>${claimCards}
    ${busSection}`;
  v.querySelectorAll('[data-act]').forEach(b => b.onclick = () => svAction(b.dataset.act, +b.dataset.vid));
}

function svServerCard(t) {
  const paying = t.stage === 'paying';
  const chk = paying ? '<span class="sv-pay">paying</span>'
    : (t.minutes_to_check == null ? '' : (t.check_due ? `<b class="sv-due">check overdue ${Math.abs(t.minutes_to_check)}m</b>` : `check in ${t.minutes_to_check}m`));
  const note = t.notes ? `<div class="sv-note">⚠ ${esc(t.notes)}</div>` : '';
  const actions = paying
    ? `<button class="sv-btn go wide" data-act="done" data-vid="${t.id}">✓ Done</button>`
    : `<button class="sv-btn go" data-act="check" data-vid="${t.id}">✓ Check</button><button class="sv-btn" data-act="pay" data-vid="${t.id}">To pay</button><button class="sv-btn" data-act="done" data-vid="${t.id}">Done</button>`;
  return `<div class="sv-card${t.check_due ? ' due' : ''}">
    <div class="sv-card-top"><span class="sv-tnum">T${esc(t.table_label || '?')}</span>
      <div class="sv-card-info"><div class="sv-g">${esc(t.guest_name || 'Guest')} · ${t.party_size}👤</div><div class="muted">${chk}</div></div></div>
    ${note}
    <div class="sv-actions">${actions}</div>
    <div class="sv-flags">
      <button class="sv-flag${t.help_flag ? ' on' : ''}" data-act="help" data-vid="${t.id}">${t.help_flag ? '✋ Help raised' : '✋ Call for help'}</button>
      <button class="sv-flag${t.bus_flag ? ' on' : ''}" data-act="bus" data-vid="${t.id}">${t.bus_flag ? '🧹 Bus pinged' : '🧹 Ready to bus'}</button>
    </div></div>`;
}

async function svAction(act, vid) {
  const t = (S.svById || {})[vid] || {};
  const put = (path, body) => api(`/service/${vid}/${path}`, { method: 'PUT', body: JSON.stringify(body || {}) });
  try {
    if (act === 'done') return svDoneModal(vid);
    if (act === 'check') { await put('check'); toast('Checked'); }
    else if (act === 'pay') { await put('pay'); toast('Moved to paying'); }
    else if (act === 'claim') { await put('claim'); toast('Table claimed'); }
    else if (act === 'help') { await put('help', { on: !t.help_flag }); toast(t.help_flag ? 'Help cleared' : 'Manager notified'); }
    else if (act === 'bus') { await put('bus', { on: !t.bus_flag }); toast(t.bus_flag ? 'Bus canceled' : 'Busser pinged'); }
    else if (act === 'bussed') { await put('bus', { on: false }); toast('Table cleared'); }
    renderServer();
  } catch (e) { toast(e.message, true); }
}

function svDoneModal(vid) {
  modal('Close table', `<label>Tip (optional)</label><input id="svTip" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" style="width:100%" />`,
    async () => { const tip = ($('svTip').value || '').trim(); await api(`/service/${vid}/done`, { method: 'PUT', body: JSON.stringify(tip ? { tip_amount: tip } : {}) }); toast('Table done'); renderServer(); }, 'Done');
}

// ── Live table map (status is the source of truth in the Management app) ──────
const TABLE_STATUS = {
  available: ['Available', '#16a34a', '#dcfce7'],
  waiting_to_order: ['Waiting to order', '#2b5bd7', '#e7eefc'],
  served: ['Served', '#0e7490', '#e0f2fe'],
  waiting_to_pay: ['Waiting to pay', '#b4630b', '#fdecd8'],
  cleaning: ['Cleaning up', '#6b7280', '#ededed'],
};
// Guest count is optional to display — governs the party-size chip on the Table
// Map. Stored per-device; tooltips always keep the detail on hover.
function showGuests() { return localStorage.getItem('phn_show_guests') !== '0'; }
function toggleGuests() { localStorage.setItem('phn_show_guests', showGuests() ? '0' : '1'); }
function statusTableEl(t) {
  const [lbl, c, bg] = TABLE_STATUS[t.status] || TABLE_STATUS.available;
  const occ = t.status !== 'available';
  const sub = occ ? `${showGuests() && t.party_size ? t.party_size + '\u{1F464}' : ''}${t.minutes_to_free != null ? ' ~' + t.minutes_to_free + 'm' : ''}`.trim() : `${t.seats}p`;
  const chk = t.stage === 'in_service' && t.minutes_to_check != null ? (t.check_due ? ' \u00b7 check overdue ' + Math.abs(t.minutes_to_check) + 'm' : ' \u00b7 check in ' + t.minutes_to_check + 'm') : '';
  const tip = occ ? lbl + (t.guest_name ? ' \u00b7 ' + esc(t.guest_name) : '') + (t.party_size ? ' \u00b7 ' + t.party_size + ' guests' : '') + (t.server_name ? ' \u00b7 ' + esc(t.server_name) : '') + chk : 'available, ' + t.seats + ' seats';
  const srv = t.server_name ? `<span class="ftable-srv">${esc(t.server_name.split(' ')[0])}</span>` : '';
  const badge = t.check_due ? '<span class="ftable-due">\u23f0</span>' : '';
  return `<div class="ftable ${t.shape === 'square' ? 'sq' : ''}${t.check_due ? ' due' : ''}" data-tbl="${t.id}" style="left:${t.pos_x}%;top:${t.pos_y}%;--ac:${c};--abg:${bg}" title="${esc(t.label)} \u00b7 ${tip}"><span class="ftable-l">${esc(t.label)}</span><span class="ftable-s">${esc(sub)}</span>${badge}${srv}</div>`;
}
function fpBoardHtml(fp) {
  const all = fp.areas.flatMap(a => a.tables);
  return `${roomSvg(fp.room_outline)}${all.map(statusTableEl).join('') || '<div class="fp-empty">No tables set up \u2014 add them in the Management app.</div>'}`;
}
function statusLegend(fp) {
  const all = fp.areas.flatMap(a => a.tables);
  return `<div class="fp-legend">${Object.entries(TABLE_STATUS).map(([k, [l, c]]) => `<span class="fp-leg"><span class="fp-dot" style="background:${c}"></span>${l} <span class="fp-leg-n">${all.filter(t => (t.status || 'available') === k).length}</span></span>`).join('')}</div>`;
}

// The Table Map view (Front Desk): live status, tap to seat / change status.
async function renderTables() {
  let fp;
  try { fp = await api(q('/floormap')); } catch (e) { $('view').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const sm = fp.summary || { available: 0, occupied: 0, tables: 0 };
  $('view').innerHTML = `
    <div class="section-head"><h2>Table Map</h2>
      <div style="display:flex;gap:.4rem;align-items:center"><span class="badge seated">${sm.available} available</span> <span class="badge ${sm.occupied ? 'waiting' : 'left'}">${sm.occupied} occupied</span><button class="btn sm ghost" id="tmGuests">${showGuests() ? '👤 Guests shown' : '👤 Guests hidden'}</button></div></div>
    ${statusLegend(fp)}
    <p class="sub" style="margin:.1rem 0 .6rem">Tap an available table to seat a guest; tap an occupied table to change its status.</p>
    <div class="floor-board" id="fpBoard">${fpBoardHtml(fp)}</div>`;
  $('tmGuests').onclick = () => { toggleGuests(); renderTables(); };
  $('view').querySelectorAll('[data-tbl]').forEach(el => el.onclick = () => {
    const t = fp.areas.flatMap(a => a.tables).find(x => String(x.id) === String(el.dataset.tbl));
    if (t.status === 'available') seatAtTable(t.id, t.label, t.seats, () => renderTables());
    else tableStatusModal(t, () => renderTables());
  });
}
// Seat directly at a chosen table (no waiting-list party).
function seatAtTable(tid, label, seats, after) {
  modal(`Seat at table ${label}`, `<label>Guest name (optional)</label><input id="fGuest" placeholder="Name" /><label>Party size</label><input id="fSize" type="number" min="1" max="${seats}" value="${Math.min(seats, 2)}" />`,
    async () => { await api(`/floormap/tables/${tid}/seat`, { method: 'PUT', body: JSON.stringify({ guest_name: $('fGuest').value.trim(), party_size: $('fSize').value }) }); toast(`Seated at ${label}`); after(); }, 'Seat');
}
function tableStatusModal(t, after) {
  const host = $('modalHost');
  const [lbl] = TABLE_STATUS[t.status] || TABLE_STATUS.available;
  const btns = [['waiting_to_order', 'Waiting to order'], ['served', 'Served'], ['waiting_to_pay', 'Waiting to pay'], ['cleaning', 'Cleaning up']]
    .map(([k, l]) => `<button class="btn ${t.status === k ? '' : 'ghost'}" data-st="${k}" style="justify-content:flex-start">${t.status === k ? '\u25cf ' : ''}${l}</button>`).join('');
  host.innerHTML = `<div class="modal-bg"><div class="modal"><h3>Table ${esc(t.label)} \u2014 ${lbl}</h3>
    <p class="sub" style="margin:.1rem 0 .6rem">${t.guest_name ? esc(t.guest_name) + ' \u00b7 ' : ''}${t.party_size ? t.party_size + ' guests \u00b7 ' : ''}${t.minutes_to_free != null ? 'free in ~' + t.minutes_to_free + ' min' : ''}</p>
    <div style="display:grid;gap:.4rem">${btns}</div>
    <div class="actions"><button class="btn ghost" id="mCancel">Close</button><button class="btn green" id="fpFree">\u2713 Free the table</button></div></div></div>`;
  const close = () => host.innerHTML = '';
  $('mCancel').onclick = close;
  host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
  const set = async (s) => { try { await api(`/floormap/tables/${t.id}/status`, { method: 'PUT', body: JSON.stringify({ status: s }) }); toast('Updated'); close(); after(); } catch (e) { toast(e.message, true); } };
  host.querySelectorAll('[data-st]').forEach(b => b.onclick = () => set(b.dataset.st));
  $('fpFree').onclick = () => set('available');
}

let activityFilter = 'all';
async function renderActivity() {
  let all;
  try { all = await api(q('/activity-feed?range=day')); }   // today only; q() adds location_id
  catch (e) { $('view').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const match = (r) => activityFilter === 'all' ? true
    : activityFilter === 'logins' ? r.path === '/api/auth/login'
      : activityFilter === 'checkins' ? r.path === '/api/public/checkin'
        : (r.status === 401 || r.status === 403);
  const rows = all.filter(match);
  const sBadge = (s) => s >= 500 ? 'left' : s >= 400 ? 'waiting' : 'seated';
  const label = (r) => {
    if (r.path === '/api/auth/login') return r.status === 200 ? 'signed in' : 'sign-in failed';
    if (r.path === '/api/public/checkin') return 'customer self check-in';
    return `${r.method} ${r.path.replace('/api/waitlist', '').replace('/api', '')}`;
  };
  const tab = (k, l) => `<button class="navbtn ${activityFilter === k ? 'active' : ''}" data-af="${k}">${l}</button>`;
  $('view').innerHTML = `
    <div class="section-head"><h2>Activity Log <span style="font-weight:400;color:var(--muted);font-size:.9rem">— today · ${rows.length}</span></h2>
      <div style="display:flex;gap:.25rem;align-items:center">${tab('all', 'All')}${tab('logins', 'Logins')}${tab('checkins', 'Check-ins')}${tab('denied', 'Denied')}<button class="btn" id="expCsv" style="padding:.4rem .7rem;margin-left:.4rem">⬇ Export CSV</button></div></div>
    <p style="color:var(--muted);font-size:.85rem;margin:0 0 1rem">Every sign-in, change, and blocked attempt — who, what, status and IP. Read-only page views aren't logged.</p>
    <div class="hist"><table><thead><tr><th>When (local)</th><th>Who</th><th>Action</th><th>Status</th><th>IP</th></tr></thead><tbody>
      ${rows.length ? rows.map(r => `<tr>
        <td style="white-space:nowrap">${esc(fmtLocalTs(r.created_at))}</td>
        <td>${r.user_name ? esc(r.user_name) : '<span style="color:var(--muted)">customer / anon</span>'}${r.user_role ? ` · <span style="color:var(--muted)">${esc(r.user_role)}</span>` : ''}${r.detail && r.detail.email && !r.user_role ? ` <span style="color:var(--muted)">${esc(r.detail.email)}</span>` : ''}</td>
        <td>${esc(label(r))}</td>
        <td><span class="badge ${sBadge(r.status)}">${r.status}</span></td>
        <td style="color:var(--muted)">${esc(r.ip || '—')}</td>
      </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:1.5rem">No activity recorded yet.</td></tr>'}
    </tbody></table></div>`;
  $('view').querySelectorAll('[data-af]').forEach(b => b.onclick = () => { activityFilter = b.dataset.af; render(); });
  $('expCsv').onclick = exportActivityCSV;
}

async function exportActivityCSV() {
  const btn = $('expCsv'); const orig = btn.textContent; btn.textContent = 'Preparing…'; btn.disabled = true;
  try {
    const all = await api(q('/activity-feed?range=day&limit=1000'));
    const match = (r) => activityFilter === 'all' ? true : activityFilter === 'logins' ? r.path === '/api/auth/login' : activityFilter === 'checkins' ? r.path === '/api/public/checkin' : (r.status === 401 || r.status === 403);
    const rows = all.filter(match);
    const act = (r) => r.path === '/api/auth/login' ? (r.status === 200 ? 'signed in' : 'sign-in failed')
      : r.path === '/api/public/checkin' ? 'customer self check-in'
        : `${r.method} ${r.path.replace('/api/waitlist', '').replace('/api', '')}`;
    const headers = ['When (local)', 'Who', 'Role', 'Email', 'Action', 'Status', 'IP'];
    const lines = [headers.join(',')];
    for (const r of rows) lines.push([
      fmtLocalTs(r.created_at), r.user_name || '', r.user_role || '',
      (r.detail && r.detail.email) || '', act(r), r.status, r.ip || '',
    ].map(csvCell).join(','));
    const csv = '﻿' + lines.join('\r\n'); // BOM so Excel reads UTF-8
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `pho-ha-noi_activity-log_${activityFilter}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} rows to CSV`);
  } catch (e) { toast(e.message, true); }
  finally { btn.textContent = orig; btn.disabled = false; }
}

function modal(title, bodyHtml, onOk, okLabel = 'Add party') {
  const host = $('modalHost');
  host.innerHTML = `<div class="modal-bg"><div class="modal"><h3>${esc(title)}</h3><div class="err" id="mErr"></div>${bodyHtml}<div class="actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">${esc(okLabel)}</button></div></div></div>`;
  const close = () => host.innerHTML = '';
  $('mCancel').onclick = close;
  host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
  $('mOk').onclick = async () => { try { await onOk(); close(); } catch (e) { $('mErr').textContent = e.message; } };
}

// ── Visual floor map (shared by the seat picker and the Floor Plan editor) ────
const AREA_COLORS = ['#2b5bd7', '#b4630b', '#1e7e34', '#7a1420', '#6d28d9', '#0e7490', '#be185d'];
const areaColorHex = (i) => AREA_COLORS[i % AREA_COLORS.length];
function fpLegend(areas, editable) {
  const tag = editable ? 'button' : 'span';
  return areas.map((a, i) => `<${tag} class="fp-leg${editable ? ' ed' : ''}"${editable ? ` data-area="${a.id}"` : ''}><span class="fp-dot" style="background:${areaColorHex(i)}"></span>${esc(a.name)}${a.tables ? ` <span class="fp-leg-n">${a.tables.length}</span>` : ''}</${tag}>`).join('');
}
function roomSvg(outline) {
  if (!Array.isArray(outline) || outline.length < 3) return '';
  return `<svg class="room-svg" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="${outline.map(p => `${p.x},${p.y}`).join(' ')}"/></svg>`;
}
function ftableEl(t, ci, mode) {
  const cls = ['ftable', t.shape === 'square' ? 'sq' : '', t.occupied ? 'occ' : '', t.is_active === 0 ? 'off' : ''].filter(Boolean).join(' ');
  const attr = mode === 'pick' ? (t.occupied ? '' : ` data-pick="${esc(t.label)}"`) : (mode === 'edit' ? ` data-tid="${t.id}"` : '');
  const title = t.occupied ? 'Occupied · ' + esc(t.guest || '') : `${esc(t.label)} · ${t.seats} seats`;
  return `<div class="${cls}"${attr} style="left:${t.pos_x}%;top:${t.pos_y}%;--ac:${areaColorHex(ci)}" title="${title}"><span class="ftable-l">${esc(t.label)}</span><span class="ftable-s">${t.seats}p</span></div>`;
}

// Seat a party by tapping a table on the floor map (occupied tables are greyed).
// Seat a waiting party: pick a free table on the live map → mark it occupied
// (in the Management floor plan) and mark the party seated at that table.
async function seatModal(id, name) {
  let fp;
  try { fp = await api(q('/floormap')); } catch { fp = { areas: [] }; }
  const tablesHtml = fp.areas.flatMap(a => a.tables).map(t => {
    if (t.status !== 'available') return statusTableEl(t); // occupied → shown greyed, not pickable
    return `<div class="ftable ${t.shape === 'square' ? 'sq' : ''}" data-pick="${t.id}" data-label="${esc(t.label)}" style="left:${t.pos_x}%;top:${t.pos_y}%;--ac:#16a34a;--abg:#dcfce7" title="${esc(t.label)} · ${t.seats} seats"><span class="ftable-l">${esc(t.label)}</span><span class="ftable-s">${t.seats}p</span></div>`;
  }).join('');
  const body = `<p class="sub" style="margin:.1rem 0 .5rem">Tap a free (green) table for <strong>${esc(name)}</strong>.</p>
    ${statusLegend(fp)}
    <div class="floor-board picker" id="floorBoard">${roomSvg(fp.room_outline)}${tablesHtml || '<div class="fp-empty">No tables — set them up in the Management app.</div>'}</div>
    <label style="margin-top:.5rem;display:block;font-size:.83rem;color:var(--muted)">Selected: <strong id="selName">none</strong></label>
    <input type="hidden" id="fSel" /><input type="hidden" id="fSelLabel" />`;
  modal(`Seat ${name}`, body, async () => {
    const tid = $('fSel').value, label = $('fSelLabel').value;
    if (tid) await api(`/floormap/tables/${tid}/seat`, { method: 'PUT', body: JSON.stringify({ guest_name: name, party_size: 2, source: 'waitlist', waitlist_ref: String(id) }) });
    await api(`/waitlist/${id}/seat`, { method: 'PUT', body: JSON.stringify({ table_number: label || null }) });
    toast(`${name} seated${label ? ' at ' + label : ''}`); render();
  }, 'Seat party');
  const host = $('modalHost');
  host.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => {
    host.querySelectorAll('.ftable').forEach(x => x.classList.remove('sel'));
    el.classList.add('sel'); $('fSel').value = el.dataset.pick; $('fSelLabel').value = el.dataset.label; $('selName').textContent = el.dataset.label;
  });
}

const ACTION_LABEL = {
  party_added: ['Added', 'gold'], party_notified: ['Notified', 'gold'],
  party_seated: ['Seated', 'seated'], party_left: ['Removed', 'left'],
  area_add: ['Area added', 'gold'], area_remove: ['Area removed', 'left'],
  table_add: ['Table added', 'gold'], table_remove: ['Table removed', 'left'],
};
function auditSummary(a) {
  const d = a.detail || {};
  const bits = [];
  if (d.guest) bits.push(esc(d.guest));
  if (d.party_size != null) bits.push('party of ' + d.party_size);
  if (d.table_number) bits.push('table ' + esc(d.table_number));
  if (d.channel === 'sms') bits.push('by SMS');
  return bits.join(' · ');
}

async function renderBoard() {
  const [queue, stats, history, audit, svc] = await Promise.all([api(q('/waitlist/')), api(q('/waitlist/stats')), api(q('/waitlist/history')), api(q('/waitlist/audit')), api(q('/service')).catch(() => ({ summary: {} }))]);
  // Walk-ins today = kiosk walk-ins + walk-ins seated directly (Front Desk / Table Map).
  const walkins = (stats.kiosk_walkins_today || 0) + ((svc.summary && svc.summary.walkins_today) || 0);
  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="label">Waiting now</div><div class="value">${stats.waiting}</div></div>
      <div class="stat"><div class="label">Longest wait</div><div class="value ${stats.longest_wait_min >= 30 ? 'warn' : ''}">${stats.longest_wait_min}m</div></div>
      <div class="stat"><div class="label">Quote next party</div><div class="value">${stats.next_quote_min}m</div></div>
      <div class="stat"><div class="label">Seated today</div><div class="value">${stats.seated_today}</div></div>
      <div class="stat"><div class="label">Walk-ins today</div><div class="value">🚶 ${walkins}</div></div>
    </div>
    <div class="section-head"><h2>Waiting (${queue.length})</h2><div style="display:flex;gap:.5rem"><button class="btn ghost big" id="walkinBtn">🚶 Walk-in</button><button class="btn big" id="addBtn">+ Add party</button></div></div>
    <div id="queue">
      ${queue.length ? queue.map((p, i) => partyCard(p, i)).join('') : '<div class="empty">No one waiting. Tap “Add party” to check in a walk-in.</div>'}
    </div>
    <div class="section-head" style="margin-top:2rem"><h2>Handled today</h2></div>
    <div class="hist"><table><thead><tr><th>Guest</th><th>Party</th><th>Status</th><th>Table</th><th>Time</th></tr></thead><tbody>
      ${history.length ? history.map(h => `<tr><td>${esc(h.guest_name)}</td><td>${h.party_size}</td><td><span class="badge ${h.status}">${h.status}</span></td><td>${esc(h.table_number || '—')}</td><td>${esc((h.seated_at || h.created_at || '').slice(11, 16))}</td></tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:1.5rem">No parties handled yet today.</td></tr>'}
    </tbody></table></div>

    <div class="section-head" style="margin-top:2rem"><h2>Activity log <span style="font-weight:400;color:var(--muted);font-size:.9rem">— who did what</span></h2></div>
    <div class="hist"><table><thead><tr><th>When</th><th>Action</th><th>Details</th><th>Who</th></tr></thead><tbody>
      ${audit.length ? audit.map(a => { const [lbl, tone] = ACTION_LABEL[a.action] || [a.action, 'left']; return `<tr><td>${esc(fmtLocalHm(a.created_at))}</td><td><span class="badge ${tone === 'gold' ? 'seated' : tone}" style="${tone === 'gold' ? 'background:var(--gold-soft);color:#92400e' : ''}">${lbl}</span></td><td>${auditSummary(a)}</td><td><strong>${esc(a.user_name || '—')}</strong>${a.user_role ? ` <span style="color:var(--muted)">· ${esc(a.user_role)}</span>` : ''}</td></tr>`; }).join('') : '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:1.5rem">No activity logged yet today.</td></tr>'}
    </tbody></table></div>`;

  $('addBtn').onclick = openAdd;
  $('walkinBtn').onclick = walkInModal;
  $('view').querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act, b.dataset.id, b.dataset.name));
}

// Walk-in: a guest seated right away (no waiting list) — pick a free table and go.
// Seats directly onto the visit lifecycle, so it flows into the Service lists.
async function walkInModal() {
  let fp;
  try { fp = await api(q('/floormap')); } catch { fp = { areas: [] }; }
  const tablesHtml = fp.areas.flatMap(a => a.tables).map(t => {
    if (t.status !== 'available') return statusTableEl(t); // occupied → greyed, not pickable
    return `<div class="ftable ${t.shape === 'square' ? 'sq' : ''}" data-pick="${t.id}" data-label="${esc(t.label)}" style="left:${t.pos_x}%;top:${t.pos_y}%;--ac:#16a34a;--abg:#dcfce7" title="${esc(t.label)} · ${t.seats} seats"><span class="ftable-l">${esc(t.label)}</span><span class="ftable-s">${t.seats}p</span></div>`;
  }).join('');
  const body = `
    <label>Guest name (optional)</label><input id="wName" placeholder="e.g. Walk-in" />
    <label>Party size</label>
    <div class="stepper"><button type="button" id="wMinus">−</button><span class="n" id="wSizeN">2</span><button type="button" id="wPlus">+</button></div>
    <p class="sub" style="margin:.6rem 0 .3rem">Tap a free (green) table to seat now.</p>
    ${statusLegend(fp)}
    <div class="floor-board picker" id="floorBoard">${roomSvg(fp.room_outline)}${tablesHtml || '<div class="fp-empty">No tables — set them up in the Management app.</div>'}</div>
    <label style="margin-top:.5rem;display:block;font-size:.83rem;color:var(--muted)">Selected: <strong id="wSelName">none</strong></label>
    <input type="hidden" id="wSel" />`;
  let size = 2;
  modal('Seat a walk-in', body, async () => {
    const tid = $('wSel').value;
    if (!tid) throw new Error('Tap a free table first.');
    const name = $('wName').value.trim() || 'Walk-in';
    await api('/service', { method: 'POST', body: JSON.stringify({ guest_name: name, party_size: size, table_id: tid, source: 'walkin' }) });
    toast(`${name} seated`); render();
  }, 'Seat walk-in');
  const host = $('modalHost');
  const setSize = (n) => { size = Math.max(1, n); $('wSizeN').textContent = size; };
  $('wMinus').onclick = () => setSize(size - 1);
  $('wPlus').onclick = () => setSize(size + 1);
  host.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => {
    host.querySelectorAll('.ftable').forEach(x => x.classList.remove('sel'));
    el.classList.add('sel'); $('wSel').value = el.dataset.pick; $('wSelName').textContent = el.dataset.label;
  });
}

function partyCard(p, i) {
  const notified = !!p.notified_at;
  return `<div class="party ${notified ? 'notified' : ''}">
    <div class="pos">${i + 1}</div>
    <div class="info">
      <div class="name">${esc(p.guest_name)}${p.source === 'self' ? '<span class="tag self">SELF CHECK-IN</span>' : ''}${notified ? '<span class="tag">NOTIFIED</span>' : ''}</div>
      <div class="meta">👥 ${p.party_size}${p.phone ? ' · 📱 ' + esc(p.phone) : ''}${p.notes ? ' · ' + esc(p.notes) : ''}</div>
    </div>
    <div class="waited"><b>${waited(p.created_at)}m</b>waited${p.quoted_minutes != null ? ` · quoted ${p.quoted_minutes}m` : ''}</div>
    <div class="acts">
      ${notified ? '' : `<button class="btn ghost" data-act="notify" data-id="${p.id}" data-name="${esc(p.guest_name)}">🔔 Notify</button>`}
      <button class="btn green" data-act="seat" data-id="${p.id}" data-name="${esc(p.guest_name)}">Seat</button>
      <button class="btn ghost" data-act="leave" data-id="${p.id}">Left</button>
    </div>
  </div>`;
}

async function openAdd() {
  let size = 2;
  modal('Add party', `
    <label>Guest name</label><input id="fName" placeholder="e.g. Nguyen, Kim" />
    <label>Phone (for SMS page)</label><input id="fPhone" inputmode="tel" placeholder="+1 408 555 0100" />
    <label>Party size</label>
    <div class="stepper"><button type="button" id="minus">−</button><span class="n" id="sizeN">2</span><button type="button" id="plus">+</button></div>
    <label>Notes</label><input id="fNotes" placeholder="Booth, high chair, birthday…" />
  `, async () => {
    const name = $('fName').value.trim();
    if (!name) throw new Error('Guest name is required.');
    await api('/waitlist/', { method: 'POST', body: JSON.stringify({
      location_id: S.loc, guest_name: name, party_size: size, phone: $('fPhone').value.trim() || null,
      notes: $('fNotes').value.trim() || null }) });
    toast('Party added to waitlist'); render();
  });
  const setN = () => $('sizeN').textContent = size;
  $('plus').onclick = () => { size = Math.min(50, size + 1); setN(); };
  $('minus').onclick = () => { size = Math.max(1, size - 1); setN(); };
}

async function act(action, id, name) {
  try {
    if (action === 'notify') {
      const r = await api(`/waitlist/${id}/notify`, { method: 'POST' });
      toast(r.sent ? `Paged ${name} by SMS 🔔` : `Marked notified (no phone on file)`);
    } else if (action === 'seat') {
      return seatModal(id, name);
    } else if (action === 'leave') {
      await api(`/waitlist/${id}/leave`, { method: 'PUT' }); toast(`${name || 'Party'} removed`);
    }
    render();
  } catch (e) { toast(e.message, true); }
}

// ── Owner: Guest History (all time, any location) ──────────────────────────
const histFilter = { loc: '', start: '', end: '', status: '' };
function daysAgoISO(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }
if (!histFilter.start) { histFilter.start = daysAgoISO(21); histFilter.end = daysAgoISO(0); }

function locOptions(selected) {
  return `<option value="">All 10 locations</option>` +
    S.locations.map(l => `<option value="${l.id}" ${String(selected) === String(l.id) ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
}

async function renderHistory() {
  $('view').innerHTML = `
    <div class="section-head"><h2>Guest History <span style="font-weight:400;color:var(--muted);font-size:.9rem">— all guests, any point in time</span></h2>
      <button class="btn" id="exportCsv">⬇ Export CSV</button></div>
    <div class="filters">
      <div class="field"><label>Location</label><select id="hLoc">${locOptions(histFilter.loc)}</select></div>
      <div class="field"><label>From</label><input id="hStart" type="date" value="${histFilter.start}"></div>
      <div class="field"><label>To</label><input id="hEnd" type="date" value="${histFilter.end}"></div>
      <div class="field"><label>Status</label><select id="hStatus">
        <option value="">All</option><option value="seated">Seated</option><option value="left">Left</option><option value="waiting">Waiting</option>
      </select></div>
    </div>
    <div id="histResults"><p style="color:var(--muted)">Loading…</p></div>`;
  const bind = () => {
    histFilter.loc = $('hLoc').value; histFilter.start = $('hStart').value; histFilter.end = $('hEnd').value; histFilter.status = $('hStatus').value;
    loadHistory();
  };
  ['hLoc', 'hStart', 'hEnd', 'hStatus'].forEach(id => $(id).onchange = bind);
  $('hStatus').value = histFilter.status;
  $('exportCsv').onclick = exportHistoryCSV;
  loadHistory();
}

// Build a CSV cell: quote when it contains a comma, quote or newline.
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportHistoryCSV() {
  const btn = $('exportCsv');
  const orig = btn.textContent;
  btn.textContent = 'Preparing…'; btn.disabled = true;
  try {
    const p = new URLSearchParams();
    if (histFilter.loc) p.set('location_id', histFilter.loc);
    if (histFilter.start) p.set('start', histFilter.start);
    if (histFilter.end) p.set('end', histFilter.end);
    if (histFilter.status) p.set('status', histFilter.status);
    p.set('limit', '50000'); // full export, not the display cap
    const rows = await api('/waitlist/history/all?' + p.toString());

    const headers = ['Date', 'Guest', 'Party Size', 'Location', 'Status', 'Phone',
      'Quoted (min)', 'Added At', 'Notified At', 'Seated At', 'Table', 'Notes'];
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push([
        (r.created_at || '').slice(0, 10), r.guest_name, r.party_size, r.location_name,
        r.status, r.phone || '', r.quoted_minutes == null ? '' : r.quoted_minutes,
        r.created_at || '', r.notified_at || '', r.seated_at || '', r.table_number || '', r.notes || '',
      ].map(csvCell).join(','));
    }
    const csv = '﻿' + lines.join('\r\n'); // BOM so Excel reads UTF-8

    const locPart = histFilter.loc
      ? (S.locations.find(l => String(l.id) === String(histFilter.loc)) || {}).name?.replace('Pho Ha Noi — ', '').replace(/\s+/g, '-')
      : 'all-locations';
    const fname = `pho-ha-noi_guest-history_${locPart}_${histFilter.start || 'start'}_to_${histFilter.end || 'end'}.csv`;

    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = fname; document.body.appendChild(a); a.click();
    a.remove(); URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} guests to CSV`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.textContent = orig; btn.disabled = false;
  }
}

async function loadHistory() {
  const p = new URLSearchParams();
  if (histFilter.loc) p.set('location_id', histFilter.loc);
  if (histFilter.start) p.set('start', histFilter.start);
  if (histFilter.end) p.set('end', histFilter.end);
  if (histFilter.status) p.set('status', histFilter.status);
  let rows;
  try { rows = await api('/waitlist/history/all?' + p.toString()); }
  catch (e) { $('histResults').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const guests = rows.reduce((s, r) => s + (r.party_size || 0), 0);
  $('histResults').innerHTML = `
    <p style="color:var(--muted);margin:.2rem 0 1rem">${rows.length} parties · ${guests} guests in range</p>
    <div class="hist"><table><thead><tr><th>Date</th><th>Guest</th><th>Party</th><th>Location</th><th>Status</th><th>Phone</th><th>Seated</th></tr></thead><tbody>
      ${rows.length ? rows.map(r => `<tr>
        <td>${esc((r.created_at || '').slice(0, 10))}</td>
        <td>${esc(r.guest_name)}</td>
        <td>${r.party_size}</td>
        <td>${esc((r.location_name || '').replace('Pho Ha Noi — ', ''))}</td>
        <td><span class="badge ${r.status}">${r.status}</span></td>
        <td>${esc(r.phone || '—')}</td>
        <td>${esc((r.seated_at || '').slice(0, 16).replace('T', ' '))}</td>
      </tr>`).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:1.5rem">No guests match these filters.</td></tr>'}
    </tbody></table></div>`;
}

// ── Owner: Daily Report ────────────────────────────────────────────────────
const repFilter = { loc: '', start: daysAgoISO(21), end: daysAgoISO(0) };

async function renderReport() {
  $('view').innerHTML = `
    <div class="section-head"><h2>Daily Report <span style="font-weight:400;color:var(--muted);font-size:.9rem">— guests on the waitlist per day</span></h2></div>
    <div class="filters">
      <div class="field"><label>Location</label><select id="rLoc">${locOptions(repFilter.loc)}</select></div>
      <div class="field"><label>From</label><input id="rStart" type="date" value="${repFilter.start}"></div>
      <div class="field"><label>To</label><input id="rEnd" type="date" value="${repFilter.end}"></div>
    </div>
    <div id="repResults"><p style="color:var(--muted)">Loading…</p></div>`;
  const bind = () => { repFilter.loc = $('rLoc').value; repFilter.start = $('rStart').value; repFilter.end = $('rEnd').value; loadReport(); };
  ['rLoc', 'rStart', 'rEnd'].forEach(id => $(id).onchange = bind);
  loadReport();
}

async function loadReport() {
  const p = new URLSearchParams();
  if (repFilter.loc) p.set('location_id', repFilter.loc);
  if (repFilter.start) p.set('start', repFilter.start);
  if (repFilter.end) p.set('end', repFilter.end);
  let data;
  try { data = await api('/waitlist/report/daily?' + p.toString()); }
  catch (e) { $('repResults').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const t = data.totals, maxG = Math.max(1, ...data.rows.map(r => r.guests));
  const avg = data.days ? Math.round(t.guests / data.days) : 0;
  $('repResults').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="label">Total guests</div><div class="value">${t.guests}</div></div>
      <div class="stat"><div class="label">Total parties</div><div class="value">${t.parties}</div></div>
      <div class="stat"><div class="label">Avg guests / day</div><div class="value">${avg}</div></div>
      <div class="stat"><div class="label">Seated / Left</div><div class="value" style="font-size:1.4rem">${t.seated} / ${t.left}</div></div>
    </div>
    <div class="hist"><table><thead><tr><th>Day</th><th>Guests</th><th>Parties</th><th>Seated</th><th>Left</th><th style="width:38%">Guests</th></tr></thead><tbody>
      ${data.rows.length ? data.rows.map(r => `<tr>
        <td>${esc(r.day)}</td>
        <td><strong>${r.guests}</strong></td>
        <td>${r.parties}</td>
        <td>${r.seated}</td>
        <td>${r.left_count}</td>
        <td><div style="background:var(--gold-soft);border-radius:6px;height:14px"><div style="background:var(--gold);height:14px;border-radius:6px;width:${(r.guests / maxG * 100).toFixed(0)}%"></div></div></td>
      </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:1.5rem">No data in range.</td></tr>'}
    </tbody></table></div>`;
}

(function init() {
  const t = localStorage.getItem('phnw_token'), u = localStorage.getItem('phnw_user');
  if (t && u) { S.token = t; S.user = JSON.parse(u); boot().catch(() => { localStorage.clear(); location.reload(); }); }
})();
