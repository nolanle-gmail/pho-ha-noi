// Pho Ha Noi Management System — SPA
const S = { token: null, user: null, locations: [], loc: null, section: 'overview', tab: 'dashboard', menuTab: 'menu', staffTab: 'directory', reportTab: 'inventory', msgTab: 'inbox', unread: 0, msgThread: null, msgArchived: false, hoursKind: 'weekly', hoursAnchor: null, perfDays: 90, locView: 'list', locDetailId: null, locTab: 'details', ckTab: 'overview', schedWeek: null, mySchedWeek: null, dayTaskDate: null };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Display a stored 10-digit login phone as (xxx) xxx-xxxx; pass anything else through.
const fmtPhone = (v) => { const d = String(v == null ? '' : v).replace(/\D+/g, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (v || '—'); };
// Stored timestamps are UTC ('YYYY-MM-DD HH:MM:SS', via SQLite datetime('now')).
// Show them in the viewer's local time instead of raw UTC.
function fmtLocalTs(ts) {
  if (!ts) return '';
  let s = String(ts).includes('T') ? String(ts) : String(ts).replace(' ', 'T');
  if (!/[Z+]/.test(s.slice(10))) s += 'Z'; // mark as UTC if no zone
  const d = new Date(s);
  if (isNaN(d)) return ts;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numf = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });

// ── API ────────────────────────────────────────────────────────────────────
async function api(pathOrPath, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  const res = await fetch('/api' + pathOrPath, Object.assign({}, opts, { headers }));
  if (res.status === 401 && S.token) { forceRelogin(); throw new Error('Session expired'); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// A 401 while we hold a token means the JWT expired or was revoked. Tear the
// session down cleanly — a reload kills every timer and the Service SSE stream —
// and return to the login screen with a note, rather than showing stale data
// and silently retrying a dead token.
function forceRelogin() {
  if (S._expiring) return;   // one 401 wins even if several fire at once
  S._expiring = true;
  try { sessionStorage.setItem('phn_expired', '1'); } catch { /* private mode */ }
  localStorage.clear();
  location.reload();
}

// The "session expired" notice, shown as a dismissible top banner on the login
// screen after a forced re-login (the inline .err stays for wrong-password).
function showSessionBanner() {
  const b = $('sessionBanner'); if (!b) return;
  b.hidden = false;
  const hide = () => { b.hidden = true; clearTimeout(t); };
  const x = $('sessionBannerX'); if (x) x.onclick = hide;
  const t = setTimeout(hide, 6000);   // auto-dismiss after a few seconds
}
const invQ = (p) => `/inventory${p}${p.includes('?') ? '&' : '?'}${S.loc ? 'location_id=' + S.loc : ''}`;

// ── Toast ────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, bad) {
  clearTimeout(toastTimer);
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg;
  toastTimer = setTimeout(() => t.remove(), 3200);
}

// ── Modal ────────────────────────────────────────────────────────────────
function modal(title, fields, onSubmit, submitLabel = 'Save') {
  const host = $('modalHost');
  const inputs = fields.map(f => {
    if (f.type === 'select') {
      return `<label>${esc(f.label)}</label><select data-k="${f.key}">${f.options.map(o => `<option value="${esc(o.value)}" ${o.value == f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    }
    return `<label>${esc(f.label)}</label><input data-k="${f.key}" type="${f.type || 'text'}" value="${esc(f.value == null ? '' : f.value)}" placeholder="${esc(f.placeholder || '')}" ${f.step ? `step="${f.step}"` : ''} />`;
  }).join('');
  host.innerHTML = `<div class="modal-bg"><div class="modal"><h3>${esc(title)}</h3><div class="err" id="mErr"></div>${inputs}<div class="actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">${esc(submitLabel)}</button></div></div></div>`;
  const close = () => host.innerHTML = '';
  $('mCancel').onclick = close;
  host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
  $('mOk').onclick = async () => {
    const vals = {};
    host.querySelectorAll('[data-k]').forEach(el => vals[el.dataset.k] = el.value);
    try { await onSubmit(vals); close(); } catch (e) { $('mErr').textContent = e.message; }
  };
}

// Short description shown as a hover popup on a job/task chip.
function chipTip(o, extra) {
  const lines = [o.code ? `${o.code} · ${o.name}` : o.name];
  if (extra) lines.push(extra);
  if (o.description) lines.push(o.description);
  const meta = [];
  if (o.complexity) meta.push(o.complexity);
  if (o.est_minutes) meta.push('~' + o.est_minutes + ' min');
  if (meta.length) lines.push(meta.join(' · '));
  return lines.join('\n');
}
// A single floating popup driven by [data-tip]. Positioned in JS so it never clips
// inside scrolling/overflow containers the way a pure-CSS tooltip would.
let _tipEl = null;
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest ? e.target.closest('[data-tip]') : null;
  if (!t) return;
  if (!_tipEl) { _tipEl = document.createElement('div'); _tipEl.className = 'tip-pop'; document.body.appendChild(_tipEl); }
  _tipEl.textContent = t.getAttribute('data-tip') || '';
  _tipEl.style.display = 'block';
  const r = t.getBoundingClientRect();
  let left = r.left;
  if (left + _tipEl.offsetWidth > window.innerWidth - 8) left = window.innerWidth - _tipEl.offsetWidth - 8;
  let top = r.bottom + 6;
  if (top + _tipEl.offsetHeight > window.innerHeight - 8) top = r.top - _tipEl.offsetHeight - 6;
  _tipEl.style.left = Math.max(8, left) + 'px';
  _tipEl.style.top = Math.max(8, top) + 'px';
});
document.addEventListener('mouseout', (e) => {
  const t = e.target.closest ? e.target.closest('[data-tip]') : null;
  if (t && _tipEl) _tipEl.style.display = 'none';
});
document.addEventListener('scroll', () => { if (_tipEl) _tipEl.style.display = 'none'; }, true);

// ── Auth ────────────────────────────────────────────────────────────────
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  try {
    const phone = ($('phone').value || '').replace(/\D+/g, '');
    const d = await api('/auth/login', { method: 'POST', body: JSON.stringify({ phone, password: $('password').value }) });
    S.token = d.token; S.user = d.user;
    localStorage.setItem('phn_token', d.token);
    localStorage.setItem('phn_user', JSON.stringify(d.user));
    await boot();
  } catch (err) { $('loginErr').textContent = err.message; }
};
$('logout').onclick = () => { localStorage.clear(); location.reload(); };

async function boot() {
  const sb = $('sessionBanner'); if (sb) sb.hidden = true;   // clear the expiry notice once signed in
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  // Load the access-level registry so labels, nav and scope are role-aware.
  try { (await api('/auth/roles')).forEach(r => { ROLE_DEFS[r.key] = r; ROLE_CHIP[r.key] = roleChip(r.key); }); } catch { /* fall back to raw keys */ }
  $('who').textContent = `${S.user.name} · ${roleLabel(S.user.role)}`;
  $('sbUser').innerHTML = `<div class="user-name">${esc(S.user.name)}</div><div class="user-role">${esc(roleLabel(S.user.role))}</div>`;
  S.locations = await api('/inventory/locations').catch(() => []);
  const picker = $('locPicker');
  const seesAll = roleScopeOf(S.user.role) === 'all';
  if (seesAll && S.locations.length) {
    picker.innerHTML = S.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    S.loc = String(S.locations[0].id);
    picker.value = S.loc;
    picker.onchange = () => { S.loc = picker.value; render(); };
  } else {
    S.loc = String(S.user.location_id);
  }
  renderSidebar();
  $('hamburger').onclick = () => $('app').classList.toggle('sidebar-open');
  $('sidebarOverlay').onclick = () => $('app').classList.remove('sidebar-open');
  $('logout').onclick = () => { localStorage.clear(); location.reload(); };
  $('navAccount').onclick = () => { setActiveNav(null); $('app').classList.remove('sidebar-open'); openAccount(); };

  const allowed = allowedSections();
  const start = allowed.some(s => s[0] === S.section) ? S.section : allowed[0][0];
  showSection(start);
  refreshUnread();
  setupMessageStream();   // live badge/inbox the moment a message arrives
}

// ── Access-level registry (loaded from the API at boot; mirrors lib/auth.js) ──
let ROLE_DEFS = {};
const roleDef = (r) => ROLE_DEFS[r] || { label: r, scope: 'self', caps: [] };
const roleLabel = (r) => roleDef(r).label;
const roleScopeOf = (r) => roleDef(r).scope;
// Does role `r` have capability `cap`? 'any' = everyone; 'scheduled' = gets a shift roster.
const roleHasCap = (r, cap) => cap === 'any' ? true
  : cap === 'scheduled' ? roleScopeOf(r) !== 'all'
  : roleDef(r).caps.includes(cap);
const myCap = (cap) => roleHasCap(S.user.role, cap);
const SCOPE_LABEL = { all: 'All locations', location: 'Their location', self: 'Self only' };
const CAP_LABEL = {
  org: 'Account & access-level admin', manage: 'Staff, schedules, menu & locations',
  ops: 'Inventory operations', reports: 'Reports & analytics',
  central: 'Central Kitchen hub', delivery: 'Delivery manifests / fulfillment',
};
const roleChip = (r) => { const c = roleDef(r).caps; return c.includes('org') ? 'gold' : c.includes('manage') ? 'blue' : c.includes('reports') ? 'low' : (c.includes('ops') || c.includes('central') || c.includes('delivery')) ? 'ok' : 'gray'; };

// ── Left-menu sections (gated by capability, not a fixed role list) ──────────
const SECTIONS = [
  ['overview', '📊', 'Overview', 'any'],
  ['service', '🛎️', 'Service', 'manage'],
  ['locations', '📍', 'Locations', 'manage'],
  ['staff', '👥', 'Staff', 'manage'],
  ['myschedule', '🗓️', 'My Schedule', 'scheduled'],
  ['inventory', '📦', 'Inventory', 'ops'],
  ['central', '🏭', 'Central Kitchen', 'central'],
  ['deliveries', '🚚', 'Deliveries', 'delivery'],
  ['menu', '🍽️', 'Menu/Recipes', 'manage'],
  ['reports', '📈', 'Reports', 'reports'],
  ['messages', '💬', 'Messages', 'any'],
];
const allowedSections = () => SECTIONS.filter(s => myCap(s[3]));

function renderSidebar() {
  $('sidebarNav').innerHTML = allowedSections().map(([k, icon, label]) =>
    `<button class="nav-item ${S.section === k ? 'active' : ''}" data-section="${k}"><span class="nav-icon">${icon}</span>${esc(label)}${k === 'messages' && S.unread ? `<span class="nav-badge">${S.unread}</span>` : ''}</button>`
  ).join('');
  $('sidebarNav').querySelectorAll('button').forEach(b => b.onclick = () => showSection(b.dataset.section));
}
async function refreshUnread() {
  try { S.unread = (await api('/messages/unread-count')).count; } catch { S.unread = 0; }
  renderSidebar();
}

// App-wide live push for messages: the badge (and an open inbox) update the
// moment someone sends to me, instead of waiting for the next poll.
let MSG_ES = null;
function setupMessageStream() {
  if (MSG_ES || typeof EventSource === 'undefined') return;
  const token = localStorage.getItem('phn_token');
  if (!token) return;
  MSG_ES = new EventSource(`/api/messages/stream?token=${encodeURIComponent(token)}`);
  MSG_ES.onmessage = (e) => {
    let d = null; try { d = JSON.parse(e.data); } catch { /* heartbeat */ }
    if (d && d.type === 'alert') { showAlertPopup(d.alert); return; }               // urgent floor ping → pop up
    if (d && d.type === 'alert_ack') { toast(`✓ ${d.user_name || 'Someone'} is on it`); if (S.section === 'messages' && S.msgTab === 'alerts') renderMessages(); return; }
    refreshUnread();
    if (S.section === 'messages' && !S.msgThread && S.msgTab === 'inbox') renderMessages();
  };
  MSG_ES.onerror = () => { /* EventSource auto-reconnects */ };
}
function setActiveNav(section) {
  $('sidebarNav').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.section === section));
}

function showSection(section) {
  S.section = section;
  S.msgThread = null; S.msgArchived = false;   // leave any open conversation when switching sections
  setActiveNav(section);
  $('app').classList.remove('sidebar-open');
  const meta = SECTIONS.find(s => s[0] === section);
  $('pageTitle').textContent = meta ? meta[2] : 'Account Settings';
  const isInv = section === 'inventory';
  const isMenu = section === 'menu';
  const isStaff = section === 'staff';
  const isReports = section === 'reports';
  const isMessages = section === 'messages';
  const isCentral = section === 'central';
  $('tabs').classList.toggle('hidden', !(isInv || isMenu || isStaff || isReports || isMessages || isCentral));
  $('locPicker').classList.toggle('hidden', !(isInv && roleScopeOf(S.user.role) === 'all'));
  $('view').innerHTML = '<div class="empty">Loading…</div>';
  if (SVC.timer && section !== 'service') { clearInterval(SVC.timer); SVC.timer = null; }
  if (SVC.es && section !== 'service') { SVC.es.close(); SVC.es = null; SVC.esLoc = undefined; SVC.live = ''; }
  if (section === 'service') { renderService(); return; }
  if (isInv) { renderTabs(); render(); return; }
  if (isMenu) { renderMenuTabs(); renderMenu(); return; }
  if (isStaff) { renderStaffTabs(); renderStaffModule(); return; }
  if (isReports) { renderReportTabs(); renderReportModule(); return; }
  if (isMessages) { renderMsgTabs(); renderMessages(); return; }
  if (isCentral) { renderCkTabs(); renderCentral(); return; }
  if (section === 'locations') { S.locView = 'list'; S.locDetailId = null; renderLocationsSection(); return; }
  const fn = { overview: renderOverview, myschedule: renderMySchedule, myhours: renderMyHoursMgmt, deliveries: renderDeliveries }[section];
  (fn || (() => renderPlaceholder(meta ? meta[2] : 'Section', '📄', '')))();
}

// ── Service: the live guest-visit board (six lists) ──────────────────────────
// Owner/GM see every location (with an "All locations" option); a manager is
// pinned to their own store. Auto-refreshes so the floor stays current.
const SVC = { loc: null, timer: null, byId: {}, scroll: 0, es: null, esLoc: undefined, pushT: null, live: '' };

// Live-push status pill shown on the board. Reflects the EventSource state so
// the floor staff can trust that seatings/claims are arriving in real time.
const LIVE_LABEL = { live: '● Live', connecting: '● Connecting…', off: '● Reconnecting…' };
function setSvcLive(state) {
  SVC.live = state;
  const el = $('svcLive');
  if (el) { el.dataset.state = state; el.textContent = LIVE_LABEL[state] || ''; }
}

// Sub-second push: subscribe to the visit stream (SSE) for the current scope.
// Any seating/claim/advance in Management OR a walk-in from the Staff app lands
// here within a moment. The interval poll below stays only as a slow backstop.
function setupServiceStream() {
  const loc = (SVC.loc && SVC.loc !== 'all') ? SVC.loc : '';
  if (SVC.es && SVC.esLoc === loc) return;   // already streaming this scope
  if (SVC.es) { SVC.es.close(); SVC.es = null; }
  const token = localStorage.getItem('phn_token');
  if (!token || typeof EventSource === 'undefined') return;
  SVC.esLoc = loc;
  const es = new EventSource(`/api/visits/stream?token=${encodeURIComponent(token)}${loc ? `&location_id=${encodeURIComponent(loc)}` : ''}`);
  SVC.es = es;
  setSvcLive('connecting');
  es.onopen = () => setSvcLive('live');
  es.onmessage = () => {
    setSvcLive('live');   // a message means the pipe is healthy
    clearTimeout(SVC.pushT);
    SVC.pushT = setTimeout(async () => {
      if (S.section !== 'service') return;
      if ($('modalHost').innerHTML) return;   // don't refresh out from under an open modal
      const y = window.scrollY; await renderService(); window.scrollTo(0, y);
    }, 150);   // coalesce bursts of events into one render
  };
  es.onerror = () => setSvcLive('off');   // EventSource auto-reconnects; poll is the backstop
}
const SVC_STAGES = [
  ['waiting', 'Waitlist', '#6d28d9'],
  ['seated', 'Seated', '#2b5bd7'],
  ['in_service', 'In service', '#0e7490'],
  ['paying', 'Paying', '#b4630b'],
  ['done', 'Done', '#6b7280'],
];
const svcLocName = (id) => { const l = (S.locations || []).find(x => String(x.id) === String(id)); return l ? l.name.replace(/^Pho Ha Noi\s*[—-]\s*/, '') : ''; };

async function renderService() {
  const seesAll = roleScopeOf(S.user.role) === 'all';
  if (!seesAll) SVC.loc = String(S.user.location_id);
  else if (SVC.loc === null) SVC.loc = 'all';
  const board = $('svcBoard'); if (board) SVC.scroll = board.scrollLeft;   // keep scroll across refresh

  const single = SVC.loc && SVC.loc !== 'all';
  const q = '/visits?' + (single ? `location_id=${SVC.loc}&` : '') + 'include=done';
  let data, report;
  try { [data, report] = await Promise.all([api(q), api('/visits/reports/servers' + (single ? `?location_id=${SVC.loc}` : ''))]); }
  catch (e) { $('view').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  SVC.byId = {}; SVC_STAGES.forEach(([k]) => (data.lists[k] || []).forEach(v => SVC.byId[v.id] = v));

  const sm = data.summary;
  const due = (data.lists.in_service || []).filter(v => v.check_due);
  const locSelect = seesAll
    ? `<select id="svcLocSel">${['all', ...(S.locations || []).map(l => String(l.id))].map(v => `<option value="${v}" ${v === SVC.loc ? 'selected' : ''}>${v === 'all' ? 'All locations' : esc(svcLocName(v))}</option>`).join('')}</select>`
    : `<span class="badge blue">${esc(svcLocName(SVC.loc))}</span>`;

  const cols = SVC_STAGES.map(([k, label, color]) => {
    const items = data.lists[k] || [];
    return `<div class="svc-col" style="--sc:${color}">
      <div class="svc-col-head"><span class="svc-dot" style="background:${color}"></span>${label}<span class="svc-n">${items.length}</span></div>
      <div class="svc-col-body">${items.map(v => svcCard(v, k)).join('') || '<div class="svc-empty">—</div>'}</div>
    </div>`;
  }).join('');

  $('view').innerHTML = `
    <div class="svc-top">
      <div class="svc-loc">${locSelect}</div>
      <span id="svcLive" class="live-badge" data-state="${SVC.live}" title="Real-time push connection">${LIVE_LABEL[SVC.live] || ''}</span>
      <button class="btn sm ghost" id="svcRefresh">↻ Refresh</button>
    </div>
    <div class="svc-kpis">
      <div class="card"><div class="label">Waiting</div><div class="value">${sm.waiting}</div></div>
      <div class="card"><div class="label">Seated</div><div class="value">${sm.seated}</div></div>
      <div class="card"><div class="label">In service</div><div class="value">${sm.in_service}</div></div>
      <div class="card"><div class="label">Paying</div><div class="value">${sm.paying}</div></div>
      <div class="card"><div class="label">Checks due</div><div class="value${sm.checks_due ? ' bad' : ''}">${sm.checks_due || 0}</div></div>
      ${sm.help ? `<div class="card"><div class="label">Needs help</div><div class="value bad">🚩 ${sm.help}</div></div>` : ''}
      ${sm.to_bus ? `<div class="card"><div class="label">To bus</div><div class="value warn">🧹 ${sm.to_bus}</div></div>` : ''}
      <div class="card"><div class="label">Staff walk-ins today</div><div class="value">🚶 ${sm.walkins_today || 0}</div></div>
    </div>
    ${due.length ? `<div class="svc-due"><strong>⏰ Check now:</strong> ${due.map(v => `<button class="chip-due" data-act="check" data-vid="${v.id}" title="Log a check">${esc(v.table_label || '?')}${v.server_name ? ' · ' + esc(v.server_name) : ''} <span class="chip-due-x">✓</span></button>`).join('')}</div>` : ''}
    ${(data.needs_help || []).length ? `<div class="svc-due help"><strong>🚩 Needs help:</strong> ${data.needs_help.map(v => `<button class="chip-due" data-act="unhelp" data-vid="${v.id}" title="Resolve">${esc(v.table_label ? 'T' + v.table_label : v.guest_name || '?')}${v.server_name ? ' · ' + esc(v.server_name) : ''} <span class="chip-due-x">✓</span></button>`).join('')}</div>` : ''}
    ${(data.to_bus || []).length ? `<div class="svc-due bus"><strong>🧹 To bus:</strong> ${data.to_bus.map(v => `<button class="chip-due" data-act="unbus" data-vid="${v.id}" title="Mark bussed">T${esc(v.table_label || '?')} <span class="chip-due-x">✓</span></button>`).join('')}</div>` : ''}
    <div class="svc-board" id="svcBoard">${cols}</div>
    <div class="svc-report">
      <h3>Servers today${single ? '' : ' — all locations'}</h3>
      ${report.servers.length ? `<div class="table-wrap"><table><thead><tr><th>Server</th><th class="num">Tables</th><th class="num">Guests</th><th class="num">Checks</th><th class="num">Avg service</th><th class="num">Tips</th></tr></thead><tbody>
        ${report.servers.map(s => `<tr><td><strong>${esc(s.server_name || '—')}</strong></td><td class="num">${s.tables_served}</td><td class="num">${s.guests_served || 0}</td><td class="num">${s.checks_done || 0}</td><td class="num">${s.avg_service_min != null ? s.avg_service_min + 'm' : '—'}</td><td class="num">$${(s.tips_total || 0).toFixed(2)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No servers have picked up tables yet.</div>'}
    </div>`;

  const bd = $('svcBoard'); if (bd) bd.scrollLeft = SVC.scroll;
  if (seesAll) $('svcLocSel').onchange = (e) => { SVC.loc = e.target.value; SVC.scroll = 0; renderService(); };
  $('svcRefresh').onclick = () => renderService();
  $('view').querySelectorAll('[data-act]').forEach(b => b.onclick = () => svcAction(b.dataset.act, parseInt(b.dataset.vid, 10)));

  setupServiceStream();   // sub-second push for this scope

  if (SVC.timer) clearInterval(SVC.timer);
  SVC.timer = setInterval(async () => {
    if (S.section !== 'service') { clearInterval(SVC.timer); SVC.timer = null; return; }
    if ($('modalHost').innerHTML) return;   // don't refresh out from under an open modal
    const y = window.scrollY; await renderService(); window.scrollTo(0, y);   // keep the view steady
  }, 15000);   // slow backstop; the SSE stream carries live updates
}

function svcCard(v, stage) {
  const loc = SVC.loc === 'all' ? `<span class="svc-loc-tag">${esc(svcLocName(v.location_id))}</span>` : '';
  const flags = `${v.help_flag ? '<span class="svc-cflag" title="Called for help">🚩</span>' : ''}${v.bus_flag ? '<span class="svc-cflag" title="Ready to bus">🧹</span>' : ''}`;
  // Flag walk-ins on every stage (a Front-Desk walk-in is seated straight away,
  // so it would otherwise be indistinguishable from a seated waitlist guest).
  const walkTag = v.source === 'walkin' ? '<span class="svc-src walk">🚶 walk-in</span>' : '';
  const who = `<div class="svc-guest">${esc(v.guest_name || 'Guest')} <span class="svc-party">·&nbsp;${v.party_size}👤</span>${walkTag}${flags}${loc}</div>`;
  const note = v.notes ? `<div class="svc-note">${esc(v.notes)}</div>` : '';
  const tbl = v.table_label ? `<span class="svc-tbl">T${esc(v.table_label)}</span>` : '';
  const A = (act, label, cls) => `<button class="btn xs ${cls || 'ghost'}" data-act="${act}" data-vid="${v.id}">${label}</button>`;
  let meta = '', actions = '';
  if (stage === 'waiting') {
    meta = `<div class="svc-meta">waited ${v.waited_min ?? 0}m${v.quoted_minutes ? ` · quoted ${v.quoted_minutes}m` : ''}</div>`;
    actions = A('seat', 'Seat', '') + A('cancel', 'Left');
  } else if (stage === 'seated') {
    meta = `<div class="svc-meta">${tbl} · seated ${v.seated_min_ago ?? 0}m ago${v.server_name ? ' · ' + esc(v.server_name) : ' · <em>no server</em>'}</div>`;
    actions = A('assign', v.server_name ? 'Reassign' : 'Assign server', '') + A('transfer', 'Move') + A('cancel', 'Left');
  } else if (stage === 'in_service') {
    const dueCls = v.check_due ? ' due' : '';
    const chk = v.minutes_to_check != null ? (v.check_due ? `check overdue ${Math.abs(v.minutes_to_check)}m` : `check in ${v.minutes_to_check}m`) : '';
    meta = `<div class="svc-meta${dueCls}">${tbl} · ${esc(v.server_name || '—')} · ${chk} <span class="svc-int">(${v.check_interval_min || 10}m)</span></div>`;
    actions = A('check', '✓ Check', v.check_due ? 'warn' : '') + A('pay', 'To pay') + A('interval', '⏱') + A('transfer', 'Move');
  } else if (stage === 'paying') {
    meta = `<div class="svc-meta">${tbl} · ${esc(v.server_name || '—')}</div>`;
    actions = A('done', '✓ Done', 'ok') + A('assign', 'Server');
  } else {
    meta = `<div class="svc-meta">${tbl || ''} ${v.server_name ? '· ' + esc(v.server_name) : ''} · done</div>`;
  }
  return `<div class="svc-card${stage === 'in_service' && v.check_due ? ' card-due' : ''}">${who}${meta}${note}${actions ? `<div class="svc-actions">${actions}</div>` : ''}</div>`;
}

async function svcAction(act, vid) {
  const v = SVC.byId[vid]; if (!v && !['check', 'unhelp', 'unbus'].includes(act)) return;
  const put = async (path, body) => { await api(`/visits/${vid}/${path}`, { method: 'PUT', body: JSON.stringify(body || {}) }); renderService(); };
  if (act === 'unhelp') { await api(`/visits/${vid}/help`, { method: 'PUT', body: JSON.stringify({ on: false }) }); toast('Help resolved'); return renderService(); }
  if (act === 'unbus') { await api(`/visits/${vid}/bus`, { method: 'PUT', body: JSON.stringify({ on: false }) }); toast('Marked bussed'); return renderService(); }
  if (act === 'check') { await api(`/visits/${vid}/check`, { method: 'PUT', body: '{}' }); toast('Checked'); return renderService(); }
  if (act === 'pay') return put('pay');
  if (act === 'done') { await api(`/visits/${vid}/done`, { method: 'PUT', body: '{}' }); toast('Table freed'); return renderService(); }
  if (act === 'cancel') return modal(`Remove ${v.guest_name || 'this party'}?`, [], async () => { await put('cancel', { reason: 'left' }); }, 'Remove');
  if (act === 'seat') return svcSeatModal(v);
  if (act === 'assign') return svcAssignModal(v);
  if (act === 'transfer') return svcTransferModal(v);
  if (act === 'interval') return svcIntervalModal(v);
}

// Available tables at a location (from the floor plan).
async function svcFreeTables(locId) {
  const fp = await api('/floorplan?location_id=' + locId);
  return fp.areas.flatMap(a => a.tables).filter(t => t.status === 'available').map(t => ({ value: t.id, label: `T${t.label} (${t.seats} seats)` }));
}
const INTERVAL_OPTS = [{ value: 5, label: 'Check every 5 min' }, { value: 10, label: 'Check every 10 min' }, { value: 20, label: 'Check every 20 min' }];

async function svcSeatModal(v) {
  let tables; try { tables = await svcFreeTables(v.location_id); } catch (e) { return toast(e.message, true); }
  if (!tables.length) return toast('No open tables right now.', true);
  modal(`Seat ${v.guest_name || 'guest'} (${v.party_size})`, [
    { key: 'table_id', label: 'Table', type: 'select', options: tables, value: tables[0].value },
    { key: 'check_interval_min', label: 'Check window', type: 'select', options: INTERVAL_OPTS, value: 10 },
  ], async (vals) => { await api(`/visits/${v.id}/seat`, { method: 'PUT', body: JSON.stringify(vals) }); toast('Seated'); renderService(); }, 'Seat');
}
async function svcAssignModal(v) {
  let d; try { d = await api('/visits?location_id=' + v.location_id); } catch (e) { return toast(e.message, true); }
  if (!d.servers.length) return toast('No servers on staff at this location.', true);
  modal(`Assign server — ${v.guest_name || 'table ' + (v.table_label || '')}`, [
    { key: 'server_id', label: 'Server', type: 'select', options: d.servers.map(s => ({ value: s.id, label: s.name })), value: v.server_id || d.servers[0].id },
  ], async (vals) => {
    const s = d.servers.find(x => String(x.id) === String(vals.server_id));
    await api(`/visits/${v.id}/assign`, { method: 'PUT', body: JSON.stringify({ server_id: s.id, server_name: s.name }) });
    toast('Server assigned'); renderService();
  }, 'Assign');
}
async function svcTransferModal(v) {
  let tables; try { tables = await svcFreeTables(v.location_id); } catch (e) { return toast(e.message, true); }
  if (!tables.length) return toast('No open tables to move to.', true);
  modal(`Move ${v.guest_name || 'party'} to another table`, [
    { key: 'table_id', label: 'New table', type: 'select', options: tables, value: tables[0].value },
  ], async (vals) => { await api(`/visits/${v.id}/transfer`, { method: 'PUT', body: JSON.stringify(vals) }); toast('Moved'); renderService(); }, 'Move');
}
async function svcIntervalModal(v) {
  modal(`Check window — table ${v.table_label || ''}`, [
    { key: 'check_interval_min', label: 'How often to check', type: 'select', options: INTERVAL_OPTS, value: v.check_interval_min || 10 },
  ], async (vals) => { await api(`/visits/${v.id}/interval`, { method: 'PUT', body: JSON.stringify(vals) }); toast('Check window updated'); renderService(); }, 'Save');
}

const TABS = [
  ['dashboard', 'Dashboard'], ['stock', 'Stock'], ['orders', 'Orders & Reorder'],
  ['transfers', 'Transfers'], ['lots', 'Lots & Expiry'], ['vendors', 'Vendors'],
  ['reports', 'Reports'], ['activity', 'Activity'], ['glossary', 'Glossary'],
];
function renderTabs() {
  $('tabs').innerHTML = TABS.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'active' : ''}">${l}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; renderTabs(); render(); });
}

// ── Render dispatch ────────────────────────────────────────────────────────
function render() {
  const v = $('view');
  v.innerHTML = '<div class="empty">Loading…</div>';
  ({ dashboard: renderDashboard, stock: renderStock, glossary: renderGlossary, orders: renderOrders, transfers: renderTransfers,
     lots: renderLots, vendors: renderVendors, reports: renderReports, activity: renderActivity }[S.tab])();
}

function statusBadge(qty, min) {
  if (qty <= 0) return '<span class="badge out">OUT</span>';
  if (min && qty <= min) return '<span class="badge low">LOW</span>';
  return '<span class="badge ok">OK</span>';
}

// ── Dashboard ────────────────────────────────────────────────────────────
async function renderDashboard() {
  const [d, low, exp] = await Promise.all([
    api(invQ('/dashboard')), api(invQ('/') ), api(invQ('/expiring?days=7')),
  ]);
  const lowItems = low.filter(i => i.quantity < i.min_quantity).slice(0, 12);
  $('view').innerHTML = `
    <h2 class="page">Dashboard</h2>
    <div class="kpis">
      <div class="card"><div class="label">Inventory value</div><div class="value">${money(d.total_value)}</div></div>
      <div class="card"><div class="label">Items tracked</div><div class="value">${d.item_count}</div></div>
      <div class="card"><div class="label">Below minimum</div><div class="value ${d.low_stock ? 'warn' : ''}">${d.low_stock}</div></div>
      <div class="card"><div class="label">Expiring ≤ 7 days</div><div class="value ${d.expiring_7d ? 'bad' : ''}">${d.expiring_7d}</div></div>
      <div class="card"><div class="label">Open orders</div><div class="value">${d.open_orders}</div></div>
    </div>
    <div class="section">
      <h3>Low stock — needs reorder</h3>
      ${lowItems.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th>Category</th><th class="num">On hand</th><th class="num">Min</th><th class="num">Par</th><th>Status</th></tr></thead><tbody>
        ${lowItems.map(i => `<tr><td>${esc(i.item_name)}</td><td>${esc(i.category)}</td><td class="num">${numf(i.quantity)} ${esc(i.unit)}</td><td class="num">${numf(i.min_quantity)}</td><td class="num">${i.par_level == null ? '—' : numf(i.par_level)}</td><td>${statusBadge(i.quantity, i.min_quantity)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Everything is above minimum. 🎉</div>'}
    </div>
    <div class="section">
      <h3>Expiring soon (${exp.expired} expired · ${exp.soon} within 7 days)</h3>
      ${exp.lots.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th>Lot</th><th class="num">Qty</th><th>Expiry</th><th>Days left</th></tr></thead><tbody>
        ${exp.lots.slice(0, 12).map(l => `<tr><td>${esc(l.item_name)}</td><td class="mono">${esc(l.lot_code || '—')}</td><td class="num">${numf(l.quantity)} ${esc(l.unit)}</td><td>${esc(l.expiry_date)}</td><td>${l.days_left < 0 ? `<span class="badge out">${l.days_left}d</span>` : `<span class="badge low">${l.days_left}d</span>`}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Nothing expiring in the next 7 days.</div>'}
    </div>`;
}

// ── Stock ────────────────────────────────────────────────────────────────
async function renderStock() {
  const items = await api(invQ('/'));
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Stock</h2>
      <div style="display:flex;gap:.5rem">
        <button class="btn" id="addItem">+ Add item</button>
        <button class="btn ghost" id="receiveSku">Receive by SKU</button>
      </div></div>
    <div class="table-wrap"><table><thead><tr>
      <th>Item</th><th>SKU</th><th>Category</th><th class="num">On hand</th><th class="num">Min</th><th class="num">Par</th><th class="num">Unit cost</th><th>Status</th><th>Actions</th>
    </tr></thead><tbody>
      ${items.map(i => `<tr>
        <td><strong>${esc(i.item_name)}</strong></td>
        <td class="mono">${esc(i.sku || '—')}</td>
        <td>${esc(i.category)}</td>
        <td class="num">${numf(i.quantity)} ${esc(i.unit)}</td>
        <td class="num">${numf(i.min_quantity)}</td>
        <td class="num">${i.par_level == null ? '—' : numf(i.par_level)}</td>
        <td class="num">${money(i.unit_cost)}</td>
        <td>${statusBadge(i.quantity, i.min_quantity)}</td>
        <td><div class="actions-cell">
          <button class="btn sm order-hover" data-act="order" data-id="${i.id}" title="Create a purchase order for this item">🛒 Order</button>
          <button class="btn sm" data-act="receive" data-id="${i.id}" data-name="${esc(i.item_name)}">Receive</button>
          <button class="btn sm ghost" data-act="waste" data-id="${i.id}" data-name="${esc(i.item_name)}">Waste</button>
          <button class="btn sm ghost" data-act="count" data-id="${i.id}" data-name="${esc(i.item_name)}">Count</button>
          <button class="btn sm ghost" data-act="edit" data-id="${i.id}">Edit</button>
        </div></td>
      </tr>`).join('')}
    </tbody></table></div>`;

  $('addItem').onclick = () => openAddItemModal(items);

  $('receiveSku').onclick = () => modal('Receive by SKU', [
    { key: 'sku', label: 'SKU' }, { key: 'quantity', label: 'Quantity', type: 'number' },
    { key: 'expiry_date', label: 'Expiry (YYYY-MM-DD, optional)' }, { key: 'lot_code', label: 'Lot code (optional)' },
  ], async (v) => { const r = await api('/inventory/receive', { method: 'POST', body: JSON.stringify(Object.assign({ location_id: S.loc }, v)) }); toast(`Received into ${r.item_name}`); render(); });

  $('view').querySelectorAll('[data-act]').forEach(b => b.onclick = () => itemAction(b.dataset.act, b.dataset.id, b.dataset.name, items));
}

function itemAction(act, id, name, items) {
  if (act === 'order') { const it = items.find(x => x.id == id); return openOrderModal({ item_id: it.id, suggested_qty: suggestQty(it) }); }
  if (act === 'receive') return modal(`Receive — ${name}`, [
    { key: 'quantity', label: 'Quantity', type: 'number' },
    { key: 'expiry_date', label: 'Expiry (YYYY-MM-DD, optional)' }, { key: 'lot_code', label: 'Lot code (optional)' },
  ], async (v) => { await api('/inventory/receive', { method: 'POST', body: JSON.stringify(Object.assign({ item_id: id }, v)) }); toast('Stock received'); render(); });
  if (act === 'waste') return modal(`Log waste — ${name}`, [
    { key: 'quantity', label: 'Quantity', type: 'number' }, { key: 'reason', label: 'Reason' },
  ], async (v) => { await api('/inventory/waste', { method: 'POST', body: JSON.stringify(Object.assign({ item_id: id }, v)) }); toast('Waste logged'); render(); });
  if (act === 'count') return modal(`Cycle count — ${name}`, [
    { key: 'counted_quantity', label: 'Counted quantity', type: 'number' },
  ], async (v) => { const r = await api('/inventory/count', { method: 'POST', body: JSON.stringify(Object.assign({ item_id: id }, v)) }); toast(`Variance ${r.variance > 0 ? '+' : ''}${r.variance}`); render(); });
  if (act === 'edit') {
    const it = items.find(x => x.id == id);
    return modal(`Edit — ${it.item_name}`, [
      { key: 'category', label: 'Category', value: it.category }, { key: 'unit', label: 'Unit', value: it.unit },
      { key: 'min_quantity', label: 'Min', type: 'number', value: it.min_quantity },
      { key: 'par_level', label: 'Par', type: 'number', value: it.par_level }, { key: 'unit_cost', label: 'Unit cost ($)', type: 'number', step: '0.01', value: it.unit_cost },
      { key: 'sku', label: 'SKU', value: it.sku },
      { key: 'reason', label: 'Reason / note (for audit)' },
    ], async (v) => { await api('/inventory/' + id, { method: 'PUT', body: JSON.stringify(v) }); toast('Item updated'); render(); });
  }
}

// Add a stock item by picking from the Glossary catalog (the master item list),
// so item names stay consistent. New names are created on the Glossary tab.
async function openAddItemModal(existing) {
  const have = new Set((existing || []).map(i => i.item_name));
  let gloss;
  try { gloss = await api('/inventory/warehouse'); } catch (e) { return toast(e.message, true); }
  const catalog = (gloss.items || []).filter(g => !have.has(g.item_name));
  const host = $('modalHost');
  const close = () => host.innerHTML = '';
  if (!catalog.length) {
    host.innerHTML = `<div class="modal-bg"><div class="modal"><h3>Add item to stock</h3>
      <p>Every item in the Glossary is already stocked at this location. To add a brand-new item name, use the <strong>Glossary</strong> tab.</p>
      <div class="actions"><button class="btn" id="mCancel">Close</button></div></div></div>`;
    $('mCancel').onclick = close;
    host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
    return;
  }
  const opts = catalog.map(g => `<option value="${esc(g.item_name)}" data-cat="${esc(g.category || '')}" data-unit="${esc(g.unit || '')}">${esc(g.item_name)} — ${esc(g.category || 'Other')}</option>`).join('');
  host.innerHTML = `<div class="modal-bg"><div class="modal">
    <h3>Add item to stock</h3><div class="err" id="mErr"></div>
    <label>Item (from Glossary)</label><select id="aiItem">${opts}</select>
    <div style="display:flex;gap:.6rem"><div style="flex:1"><label>Category</label><input id="aiCat" /></div><div style="flex:1"><label>Unit</label><input id="aiUnit" /></div></div>
    <label>Opening qty</label><input id="aiQty" type="number" value="0" />
    <div style="display:flex;gap:.6rem"><div style="flex:1"><label>Min (reorder trigger)</label><input id="aiMin" type="number" value="0" /></div><div style="flex:1"><label>Par (target level)</label><input id="aiPar" type="number" /></div></div>
    <label>Unit cost ($)</label><input id="aiCost" type="number" step="0.01" value="0" />
    <label>SKU (optional)</label><input id="aiSku" />
    <label>Reason / note (for audit)</label><input id="aiReason" placeholder="why this item is being added" />
    <p class="sub" style="color:var(--muted);margin:.5rem 0 0">To add a brand-new item name, use the <strong>Glossary</strong> tab.</p>
    <div class="actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">Add item</button></div>
  </div></div>`;
  $('mCancel').onclick = close;
  host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
  const fill = () => { const o = $('aiItem').selectedOptions[0]; if (o) { $('aiCat').value = o.dataset.cat || ''; $('aiUnit').value = o.dataset.unit || ''; } };
  fill(); $('aiItem').onchange = fill;
  $('mOk').onclick = async () => {
    try {
      await api('/inventory/', { method: 'POST', body: JSON.stringify({
        location_id: S.loc, item_name: $('aiItem').value,
        category: $('aiCat').value.trim() || 'Other', unit: $('aiUnit').value.trim() || 'units',
        quantity: $('aiQty').value, min_quantity: $('aiMin').value, par_level: $('aiPar').value,
        unit_cost: $('aiCost').value, sku: $('aiSku').value.trim() || null, reason: $('aiReason').value.trim(),
      }) });
      toast('Item added'); close(); render();
    } catch (e) { $('mErr').textContent = e.message; }
  };
}

// ── Glossary (item catalog) ─────────────────────────────────────────────
function suggestQty(it) {
  const buildTo = (it.par_level && it.par_level > it.min_quantity) ? it.par_level : (it.min_quantity || 0);
  const s = Math.max(0, Math.ceil(buildTo - it.quantity));
  return s > 0 ? s : Math.max(1, Math.ceil(it.min_quantity || 1));
}

async function renderGlossary() {
  const items = await api(invQ('/'));
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Glossary — item catalog</h2>
      <button class="btn" id="gAdd">+ Add item</button></div>
    <p class="sub" style="margin:-.5rem 0 1rem;color:var(--muted)">${items.length} items · descriptions, SKU, category & notes. Order directly from any row.</p>
    <div class="table-wrap"><table><thead><tr>
      <th>Item</th><th>SKU</th><th>Category</th><th>Unit</th><th>Description</th><th>Notes</th><th class="num">On hand</th><th class="num">Cost</th><th>Actions</th>
    </tr></thead><tbody>
      ${items.map(i => `<tr>
        <td><strong>${esc(i.item_name)}</strong></td>
        <td class="mono">${esc(i.sku || '—')}</td>
        <td>${esc(i.category)}</td>
        <td>${esc(i.unit)}</td>
        <td style="max-width:280px;color:#374151">${i.description ? esc(i.description) : '<span style="color:var(--muted)">—</span>'}</td>
        <td style="max-width:180px;color:#374151">${i.notes ? esc(i.notes) : '<span style="color:var(--muted)">—</span>'}</td>
        <td class="num">${numf(i.quantity)}</td>
        <td class="num">${money(i.unit_cost)}</td>
        <td><div class="actions-cell">
          <button class="btn sm" data-g="order" data-id="${i.id}">Order</button>
          <button class="btn sm ghost" data-g="edit" data-id="${i.id}">Edit</button>
          <button class="btn sm ghost" data-g="del" data-id="${i.id}">Remove</button>
        </div></td>
      </tr>`).join('')}
    </tbody></table></div>`;
  $('gAdd').onclick = () => glossaryEdit(null);
  $('view').querySelectorAll('[data-g]').forEach(b => b.onclick = () => {
    const it = items.find(x => x.id == b.dataset.id);
    if (b.dataset.g === 'order') return openOrderModal({ item_id: it.id, suggested_qty: suggestQty(it) });
    if (b.dataset.g === 'edit') return glossaryEdit(it);
    if (b.dataset.g === 'del') return confirmDelete(it);
  });
}

function glossaryEdit(it) {
  const isNew = !it;
  const fields = [
    { key: 'item_name', label: 'Item name', value: it ? it.item_name : '' },
    { key: 'category', label: 'Category', value: it ? it.category : 'Produce' },
    { key: 'unit', label: 'Unit', value: it ? it.unit : 'lbs' },
    { key: 'sku', label: 'SKU', value: it ? it.sku : '' },
    { key: 'description', label: 'Description', value: it ? it.description : '' },
    { key: 'notes', label: 'Notes', value: it ? it.notes : '' },
    { key: 'min_quantity', label: 'Min (reorder trigger)', type: 'number', value: it ? it.min_quantity : 0 },
    { key: 'par_level', label: 'Par (target level)', type: 'number', value: it ? it.par_level : '' },
    { key: 'unit_cost', label: 'Unit cost ($)', type: 'number', step: '0.01', value: it ? it.unit_cost : 0 },
  ];
  if (isNew) fields.push({ key: 'quantity', label: 'Opening qty', type: 'number', value: 0 });
  fields.push({ key: 'reason', label: 'Reason / note (for audit)' });
  modal(isNew ? 'Add item' : `Edit — ${it.item_name}`, fields, async (v) => {
    if (isNew) { await api('/inventory/', { method: 'POST', body: JSON.stringify(Object.assign({ location_id: S.loc }, v)) }); toast('Item added'); }
    else { await api('/inventory/' + it.id, { method: 'PUT', body: JSON.stringify(v) }); toast('Item updated'); }
    render();
  }, isNew ? 'Add item' : 'Save');
}

function confirmDelete(it) {
  modal(`Remove “${it.item_name}”?`, [
    { key: '_', label: 'This hides the item from stock & glossary. History is preserved. Type REMOVE to confirm.', placeholder: 'REMOVE' },
    { key: 'reason', label: 'Reason / note (for audit)' },
  ], async (v) => {
    if ((v._ || '').trim().toUpperCase() !== 'REMOVE') throw new Error('Type REMOVE to confirm.');
    await api('/inventory/' + it.id, { method: 'DELETE', body: JSON.stringify({ reason: v.reason || '' }) }); toast('Item removed'); render();
  }, 'Remove');
}

// ── Create order (PO) — pick existing item or add a new one ────────────────
async function openOrderModal(prefill) {
  prefill = prefill || {};
  const [items, vendors, ckCat] = await Promise.all([api(invQ('/')), api('/inventory/vendors'), api('/distribution/ck-catalog').catch(() => ({ items: {} }))]);
  const ckItems = (ckCat && ckCat.items) || {};
  const iOpts = items.map(i => `<option value="${i.id}" ${prefill.item_id == i.id ? 'selected' : ''}>${esc(i.item_name)} — ${numf(i.quantity)} ${esc(i.unit)} on hand</option>`).join('');
  const vendorTail = '<option value="">— No vendor —</option>' + vendors.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  // The source dropdown puts the Central Kitchen first and pre-selected when the item is
  // stocked there; otherwise it's the plain vendor list.
  const sourceOptionsFor = (itemName) => {
    const avail = ckItems[itemName];
    return (avail > 0 ? `<option value="ck" selected>🏭 Central Kitchen — ${numf(avail)} on hand</option>` : '') + vendorTail;
  };
  const nameOf = (id) => { const it = items.find(x => x.id == id); return it ? it.item_name : ''; };
  const host = $('modalHost');
  host.innerHTML = `<div class="modal-bg"><div class="modal">
    <h3>Create order</h3><div class="err" id="mErr"></div>
    <div class="seg"><button type="button" class="seg-btn active" data-mode="existing">Existing item</button><button type="button" class="seg-btn" data-mode="new">+ New item</button></div>
    <div id="existBlock"><label>Item</label><select id="oItem">${iOpts}</select></div>
    <div id="newBlock" class="hidden">
      <label>New item name</label><input id="nName" placeholder="e.g. Chili Oil" />
      <div style="display:flex;gap:.6rem"><div style="flex:1"><label>Category</label><input id="nCat" value="Pantry" /></div><div style="flex:1"><label>Unit</label><input id="nUnit" value="bottle" /></div></div>
      <label>Unit cost ($)</label><input id="nCost" type="number" step="0.01" value="0" />
    </div>
    <label>Quantity to order</label><input id="oQty" type="number" value="${prefill.suggested_qty || ''}" />
    <label>Order from</label><select id="oVendor">${sourceOptionsFor(nameOf(prefill.item_id))}</select>
    <label>Expected date (optional)</label><input id="oDate" type="date" />
    <label>Reason / note (for audit)</label><input id="oNotes" placeholder="why you're ordering — kept on the order & the audit log" />
    <div class="actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">Create order</button></div>
  </div></div>`;
  let mode = 'existing';
  const close = () => host.innerHTML = '';
  $('mCancel').onclick = close;
  host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
  // Re-pick the source list whenever the chosen existing item changes.
  $('oItem').onchange = () => { $('oVendor').innerHTML = sourceOptionsFor(nameOf($('oItem').value)); };
  host.querySelectorAll('.seg-btn').forEach(b => b.onclick = () => {
    mode = b.dataset.mode;
    host.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
    $('existBlock').classList.toggle('hidden', mode !== 'existing');
    $('newBlock').classList.toggle('hidden', mode !== 'new');
    // A brand-new item can't already be at the Central Kitchen — vendors only.
    $('oVendor').innerHTML = mode === 'new' ? vendorTail : sourceOptionsFor(nameOf($('oItem').value));
  });
  $('mOk').onclick = async () => {
    try {
      const qty = parseFloat($('oQty').value);
      if (!(qty > 0)) throw new Error('Enter a quantity greater than 0.');
      const source = $('oVendor').value, expected_date = $('oDate').value || null, notes = $('oNotes').value.trim() || null;
      // Central Kitchen source → the CK-first distribution flow (splits any shortfall to a vendor).
      if (mode === 'existing' && source === 'ck') {
        await api('/distribution/order', { method: 'POST', body: JSON.stringify({ location_id: S.loc, reason: notes || '', items: [{ item_id: $('oItem').value, item_name: nameOf($('oItem').value), quantity: qty, notes }] }) });
        toast('Ordered — Central Kitchen first'); close();
        if (['orders', 'glossary', 'stock'].includes(S.tab)) render();
        return;
      }
      let item_id;
      if (mode === 'new') {
        const name = $('nName').value.trim();
        if (!name) throw new Error('Enter the new item name.');
        const created = await api('/inventory/', { method: 'POST', body: JSON.stringify({ location_id: S.loc, item_name: name, category: $('nCat').value.trim() || 'Other', unit: $('nUnit').value.trim() || 'units', unit_cost: $('nCost').value, quantity: 0, min_quantity: 0, reason: notes || '' }) });
        item_id = created.id;
      } else { item_id = $('oItem').value; }
      await api('/inventory/order', { method: 'POST', body: JSON.stringify({ location_id: S.loc, item_id, quantity: qty, vendor_id: source || null, expected_date, notes, reason: notes || '' }) });
      toast('Order created'); close();
      if (['orders', 'glossary', 'stock'].includes(S.tab)) render();
    } catch (e) { $('mErr').textContent = e.message; }
  };
}

// ── Orders & Reorder ─────────────────────────────────────────────────────
async function renderOrders() {
  const distQ = (p) => `/distribution${p}${p.includes('?') ? '&' : '?'}${S.loc ? 'location_id=' + S.loc : ''}`;
  const [avail, orders, vendors, ckOrders] = await Promise.all([
    api(distQ('/availability')), api(invQ('/supply-orders')), api('/inventory/vendors'), api(distQ('/orders?scope=store')),
  ]);
  const sugg = avail.items;
  const ckTotal = sugg.reduce((a, s) => a + s.from_ck, 0);
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Orders & Reorder</h2>
      <button class="btn" id="newOrder">+ New order</button></div>
    <div class="section">
      <div class="row-between"><h3>Low stock — reorder <span style="font-weight:400;color:var(--muted);font-size:.85rem">Central Kitchen first, vendors for the shortfall</span></h3>
        ${sugg.length ? `<div style="display:flex;gap:.5rem"><button class="btn" id="orderCK">Order all — CK first (${sugg.length})</button><button class="btn ghost" id="createPO">Vendor PO instead</button></div>` : ''}</div>
      ${sugg.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Need</th><th class="num">🏭 From CK</th><th class="num">🚚 From vendor</th><th class="num">Est. cost</th></tr></thead><tbody>
        ${sugg.map(s => `<tr><td>${esc(s.item_name)}</td><td class="num">${numf(s.quantity)}</td><td class="num"><strong>${numf(s.need)} ${esc(s.unit)}</strong></td><td class="num">${s.from_ck > 0 ? `<span class="badge ok">${numf(s.from_ck)}</span>` : '<span style="color:var(--muted)">0</span>'}</td><td class="num">${s.from_vendor > 0 ? `<span class="badge gold">${numf(s.from_vendor)}</span>` : '<span style="color:var(--muted)">0</span>'}</td><td class="num">${money(Math.round(s.need * (s.unit_cost || 0) * 100) / 100)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="sub" style="color:var(--muted);margin:.4rem 0 0">The Central Kitchen can cover <strong>${numf(ckTotal)}</strong> unit${ckTotal === 1 ? '' : 's'} right now; the rest is auto-drafted as vendor POs.</p>` : '<div class="empty">No items below par. Nothing to reorder.</div>'}
    </div>
    <div class="section">
      <h3>Central Kitchen orders <span style="font-weight:400;color:var(--muted);font-size:.85rem">raw food from the warehouse</span></h3>
      ${ckOrders.orders.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Ordered</th><th class="num">CK</th><th class="num">Vendor</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        ${ckOrders.orders.map(o => `<tr><td>${esc(o.item_name)}</td><td class="num">${numf(o.requested_qty)} ${esc(o.unit)}</td><td class="num">${numf(o.ck_qty)}</td><td class="num">${o.vendor_qty > 0 ? numf(o.vendor_qty) : '—'}</td><td>${distBadge(o.status)}</td>
          <td><div class="actions-cell">${o.status === 'shipped' ? `<button class="btn sm" data-drecv="${o.id}">Mark received</button>` : ''}</div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No Central Kitchen orders yet.</div>'}
    </div>
    <div class="section">
      <h3>Purchase / supply orders</h3>
      ${orders.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Qty</th><th>Vendor</th><th>Status</th><th>Ordered by</th><th>Actions</th></tr></thead><tbody>
        ${orders.map(o => `<tr><td>${esc(o.item_name)}</td><td class="num">${numf(o.quantity)} ${esc(o.unit)}</td><td>${esc(o.vendor_name || '—')}</td><td>${orderBadge(o.status)}</td><td>${esc(o.ordered_by_name)}</td>
          <td><div class="actions-cell">${nextOrderActions(o)}</div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No orders yet.</div>'}
    </div>`;

  $('newOrder').onclick = () => openOrderModal();
  const orderCK = $('orderCK');
  if (orderCK) orderCK.onclick = () => modal('Order all — Central Kitchen first', [
    { key: 'reason', label: 'Reason / note (for audit)' },
  ], async (v) => { const r = await api('/distribution/order', { method: 'POST', body: JSON.stringify({ location_id: S.loc, reason: v.reason || '', items: sugg.map(s => ({ item_id: s.id, item_name: s.item_name, quantity: s.need })) }) }); toast(`Placed ${r.created} order${r.created === 1 ? '' : 's'} — Central Kitchen first`); render(); }, 'Place order');
  const createPO = $('createPO');
  if (createPO) createPO.onclick = () => {
    const vOpts = [{ value: '', label: '— No vendor —' }].concat(vendors.map(v => ({ value: v.id, label: v.name })));
    modal('Vendor purchase order (skip Central Kitchen)', [
      { key: 'vendor_id', label: 'Vendor', type: 'select', options: vOpts, value: '' },
      { key: 'reason', label: 'Reason / note (for audit)' },
    ], async (v) => { const r = await api('/inventory/reorder/create', { method: 'POST', body: JSON.stringify({ location_id: S.loc, vendor_id: v.vendor_id || null, reason: v.reason || '', items: sugg.map(s => ({ item_id: s.id, quantity: s.need })) }) }); toast(`Created ${r.created} vendor order lines`); render(); }, 'Create PO');
  };
  $('view').querySelectorAll('[data-drecv]').forEach(b => b.onclick = async () => {
    try { await api('/distribution/orders/' + b.dataset.drecv, { method: 'PUT', body: JSON.stringify({ status: 'received' }) }); toast('Received into inventory'); render(); }
    catch (e) { toast(e.message, true); }
  });
  $('view').querySelectorAll('[data-order]').forEach(b => b.onclick = async () => {
    try { await api('/inventory/order/' + b.dataset.order, { method: 'PUT', body: JSON.stringify({ status: b.dataset.status }) }); toast('Order ' + b.dataset.status); render(); }
    catch (e) { toast(e.message, true); }
  });
}
function distBadge(s) { const m = { requested: 'gold', approved: 'gold', shipped: 'blue', received: 'ok', cancelled: 'out' }; return `<span class="badge ${m[s] || 'gray'}">${s}</span>`; }
function orderBadge(s) { const m = { pending: 'gray', approved: 'gold', shipped: 'gold', received: 'ok', cancelled: 'out' }; return `<span class="badge ${m[s] || 'gray'}">${s}</span>`; }
function nextOrderActions(o) {
  const steps = { pending: 'approved', approved: 'shipped', shipped: 'received' };
  let html = '';
  if (steps[o.status]) html += `<button class="btn sm" data-order="${o.id}" data-status="${steps[o.status]}">Mark ${steps[o.status]}</button>`;
  if (o.status !== 'received' && o.status !== 'cancelled') html += `<button class="btn sm ghost" data-order="${o.id}" data-status="cancelled">Cancel</button>`;
  return html || '—';
}

// ── Transfers ──────────────────────────────────────────────────────────────
async function renderTransfers() {
  const [items, reqs] = await Promise.all([api(invQ('/')), api(invQ('/transfer-requests'))]);
  const others = S.locations.filter(l => String(l.id) !== String(S.loc));
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Transfers</h2>
      <button class="btn" id="newTransfer" ${others.length ? '' : 'disabled'}>+ Direct transfer</button></div>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Qty</th><th>From → To</th><th>Status</th><th>Requested by</th></tr></thead><tbody>
      ${reqs.length ? reqs.map(r => `<tr><td>${esc(r.item_name)}</td><td class="num">${numf(r.quantity)}</td><td>${esc(r.from_location_name)} → ${esc(r.to_location_name)}</td><td>${orderBadge(r.status)}</td><td>${esc(r.requested_by_name)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">No transfer requests.</td></tr>'}
    </tbody></table></div>`;
  const nt = $('newTransfer');
  if (nt && others.length) nt.onclick = () => modal('Direct transfer', [
    { key: 'item_id', label: 'Item', type: 'select', options: items.map(i => ({ value: i.id, label: `${i.item_name} (${numf(i.quantity)} ${i.unit})` })) },
    { key: 'to_location_id', label: 'To location', type: 'select', options: others.map(l => ({ value: l.id, label: l.name })) },
    { key: 'quantity', label: 'Quantity', type: 'number' },
  ], async (v) => { await api('/inventory/transfer', { method: 'POST', body: JSON.stringify({ item_id: v.item_id, from_location_id: S.loc, to_location_id: v.to_location_id, quantity: v.quantity }) }); toast('Transferred'); render(); });
}

// ── Lots & Expiry ──────────────────────────────────────────────────────────
async function renderLots() {
  const [lots, exp] = await Promise.all([api(invQ('/lots')), api(invQ('/expiring?days=14'))]);
  $('view').innerHTML = `
    <h2 class="page">Lots & Expiry</h2>
    <div class="kpis">
      <div class="card"><div class="label">Active lots</div><div class="value">${lots.length}</div></div>
      <div class="card"><div class="label">Expired</div><div class="value ${exp.expired ? 'bad' : ''}">${exp.expired}</div></div>
      <div class="card"><div class="label">Expiring ≤ 14 days</div><div class="value ${exp.soon ? 'warn' : ''}">${exp.soon}</div></div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th>Lot</th><th class="num">Remaining</th><th class="num">Unit cost</th><th>Expiry</th><th>Received</th><th>Actions</th></tr></thead><tbody>
      ${lots.length ? lots.map(l => `<tr><td>${esc(l.item_name)}</td><td class="mono">${esc(l.lot_code || '—')}</td><td class="num">${numf(l.quantity)} ${esc(l.unit)}</td><td class="num">${money(l.unit_cost)}</td><td>${l.expiry_date ? esc(l.expiry_date) : '<span class="badge gray">none</span>'}</td><td class="mono">${esc((l.received_at || '').slice(0, 10))}</td><td><button class="btn sm ghost" data-discard="${l.id}">Discard</button></td></tr>`).join('') : '<tr><td colspan="7" class="empty">No active lots.</td></tr>'}
    </tbody></table></div>`;
  $('view').querySelectorAll('[data-discard]').forEach(b => b.onclick = () => modal('Discard lot', [{ key: 'reason', label: 'Reason', value: 'Expired' }],
    async (v) => { await api('/inventory/lots/' + b.dataset.discard + '/discard', { method: 'POST', body: JSON.stringify(v) }); toast('Lot discarded'); render(); }, 'Discard'));
}

// ── Vendors ────────────────────────────────────────────────────────────────
async function renderVendors() {
  const vendors = await api('/inventory/vendors');
  const canManage = ['owner', 'manager'].includes(S.user.role);
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Vendors</h2>${canManage ? '<button class="btn" id="addVendor">+ Add vendor</button>' : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Contact</th><th>Phone</th><th>Email</th><th class="num">Lead time</th><th>Notes</th></tr></thead><tbody>
      ${vendors.length ? vendors.map(v => `<tr><td><strong>${esc(v.name)}</strong></td><td>${esc(v.contact_name || '—')}</td><td>${esc(v.phone || '—')}</td><td>${esc(v.email || '—')}</td><td class="num">${v.lead_time_days}d</td><td>${esc(v.notes || '')}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No vendors.</td></tr>'}
    </tbody></table></div>`;
  const av = $('addVendor');
  if (av) av.onclick = () => modal('Add vendor', [
    { key: 'name', label: 'Name' }, { key: 'contact_name', label: 'Contact name' },
    { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
    { key: 'lead_time_days', label: 'Lead time (days)', type: 'number', value: 1 }, { key: 'notes', label: 'Notes' },
    { key: 'reason', label: 'Reason / note (for audit)' },
  ], async (v) => { await api('/inventory/vendors', { method: 'POST', body: JSON.stringify(v) }); toast('Vendor added'); render(); });
}

// ── Reports (valuation & COGS) ──────────────────────────────────────────────
async function renderReports() {
  const val = await api(invQ('/valuation'));
  const max = Math.max(1, ...val.by_category.map(c => c.value || 0));
  $('view').innerHTML = `
    <h2 class="page">Reports</h2>
    <div class="kpis">
      <div class="card"><div class="label">Inventory value (on hand)</div><div class="value">${money(val.total_value)}</div></div>
      <div class="card"><div class="label">Consumed cost (30d COGS)</div><div class="value">${money(val.consumed_cost)}</div></div>
    </div>
    <div class="section"><h3>Value by category</h3>
      <div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Value</th><th style="width:40%">Share</th></tr></thead><tbody>
        ${val.by_category.map(c => `<tr><td>${esc(c.category)}</td><td class="num">${money(c.value)}</td><td><div style="background:var(--gold-soft);border-radius:6px;height:14px"><div style="background:var(--gold);height:14px;border-radius:6px;width:${((c.value || 0) / max * 100).toFixed(0)}%"></div></div></td></tr>`).join('')}
      </tbody></table></div>
      <p class="sub" style="margin-top:.8rem">COGS window: ${val.start} → ${val.end}</p>
    </div>`;
}

// ── Activity (transactions, waste, counts) ──────────────────────────────────
const ACTION_LABEL = {
  // Inventory
  order_create: ['Order created', 'gold'], order_status: ['Order updated', 'gold'], order_received: ['Order received', 'ok'],
  reorder_create: ['Reorder → PO', 'gold'], transfer: ['Transfer', 'gold'], transfer_status: ['Transfer updated', 'gold'],
  transfer_received: ['Transfer received', 'ok'], transfer_request_create: ['Transfer requested', 'gold'],
  stock_received: ['Stock received', 'ok'], item_create: ['Item added', 'gray'],
  item_update: ['Item edited', 'gray'], item_delete: ['Item removed', 'out'], waste_logged: ['Waste', 'out'],
  cycle_count: ['Cycle count', 'gray'], lot_discarded: ['Lot discarded', 'out'],
  vendor_create: ['Vendor added', 'gray'], vendor_update: ['Vendor edited', 'gray'], vendor_delete: ['Vendor removed', 'out'],
  // Central Kitchen distribution
  distribution_order: ['CK order placed', 'blue'], distribution_ship: ['CK shipped', 'blue'],
  distribution_receive: ['CK received', 'ok'], distribution_cancel: ['CK order cancelled', 'out'],
  ck_stock_update: ['CK stock curated', 'gray'],
  // Central Kitchen production & HR
  ck_generate_requests: ['CK demand generated', 'gray'], ck_product_create: ['CK product added', 'gray'],
  ck_product_update: ['CK product edited', 'gray'], ck_recipe_set: ['CK recipe set', 'gray'],
  ck_production: ['CK production run', 'blue'], ck_fulfill: ['CK fulfilled store', 'ok'],
  ck_task_create: ['CK task added', 'gray'], ck_task_complete: ['CK task done', 'ok'],
  ck_shift_create: ['CK shift added', 'gray'], ck_clock_in: ['CK clock-in', 'gray'], ck_clock_out: ['CK clock-out', 'gray'],
};
function auditSummary(a) {
  const d = a.detail || {};
  const bits = [];
  const label = d.item || d.name || d.title || d.product;
  if (label) bits.push(esc(label));
  if (d.quantity != null) bits.push('qty ' + numf(d.quantity));
  else if (d.qty != null) bits.push('qty ' + numf(d.qty));
  if (d.source) bits.push(esc(d.source));
  if (d.status) bits.push('→ ' + esc(d.status));
  if (d.count != null) bits.push(d.count + (d.count === 1 ? ' line' : ' lines'));
  if (d.lines != null) bits.push(d.lines + (d.lines === 1 ? ' line' : ' lines'));
  if (d.ingredients != null) bits.push(d.ingredients + ' ingredients');
  if (d.hours != null) bits.push(numf(d.hours) + 'h');
  if (d.reason) bits.push(esc(d.reason));
  return bits.join(' · ');
}

async function renderActivity() {
  const [txns, waste, counts, audit] = await Promise.all([api(invQ('/transactions')), api(invQ('/waste')), api(invQ('/counts')), api('/inventory/audit')]);
  const typeBadge = (t) => ({ in: '<span class="badge ok">IN</span>', out: '<span class="badge out">OUT</span>', transfer_sent: '<span class="badge gold">TRANSFER</span>' }[t] || t);
  // Every inventory, central-kitchen and distribution action we have a label for —
  // the full audit trail for those modules (see ACTION_LABEL).
  const logged = audit.filter(a => ACTION_LABEL[a.action]);
  $('view').innerHTML = `
    <h2 class="page">Activity</h2>
    <div class="section"><h3>Activity log — who did what <span style="font-weight:400;color:var(--muted);font-size:.85rem">(inventory · central kitchen · distribution — every logged action)</span></h3>
      <div class="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>Details</th><th>Who</th></tr></thead><tbody>
        ${logged.length ? logged.map(a => { const [lbl, tone] = ACTION_LABEL[a.action] || [a.action, 'gray']; return `<tr><td class="mono">${esc((a.created_at || '').slice(0, 16))}</td><td><span class="badge ${tone}">${lbl}</span></td><td>${auditSummary(a)}</td><td><strong>${esc(a.user_name || '—')}</strong>${a.user_role ? ` <span style="color:var(--muted)">· ${esc(a.user_role)}</span>` : ''}</td></tr>`; }).join('') : '<tr><td colspan="4" class="empty">No activity logged yet.</td></tr>'}
      </tbody></table></div>
    </div>
    <div class="section"><h3>Movement ledger</h3>
      <div class="table-wrap"><table><thead><tr><th>When</th><th>Item</th><th>Type</th><th class="num">Qty</th><th>By</th><th>Notes</th></tr></thead><tbody>
        ${txns.length ? txns.map(t => `<tr><td class="mono">${esc((t.created_at || '').slice(0, 16))}</td><td>${esc(t.item_name)}</td><td>${typeBadge(t.type)}</td><td class="num">${numf(t.quantity)} ${esc(t.unit)}</td><td>${esc(t.user_name || '—')}</td><td>${esc(t.notes || '')}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No transactions.</td></tr>'}
      </tbody></table></div>
    </div>
    <div class="section"><h3>Waste log</h3>
      <div class="table-wrap"><table><thead><tr><th>When</th><th>Item</th><th class="num">Qty</th><th>Reason</th><th>By</th></tr></thead><tbody>
        ${waste.length ? waste.map(w => `<tr><td class="mono">${esc((w.created_at || '').slice(0, 16))}</td><td>${esc(w.item_name)}</td><td class="num">${numf(w.quantity)} ${esc(w.unit)}</td><td>${esc(w.reason || '—')}</td><td>${esc(w.user_name || '—')}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">No waste logged.</td></tr>'}
      </tbody></table></div>
    </div>
    <div class="section"><h3>Cycle counts</h3>
      <div class="table-wrap"><table><thead><tr><th>When</th><th>Item</th><th class="num">System</th><th class="num">Counted</th><th class="num">Variance</th><th>By</th></tr></thead><tbody>
        ${counts.length ? counts.map(c => `<tr><td class="mono">${esc((c.created_at || '').slice(0, 16))}</td><td>${esc(c.item_name)}</td><td class="num">${numf(c.system_qty)}</td><td class="num">${numf(c.counted_qty)}</td><td class="num">${c.variance > 0 ? '+' : ''}${numf(c.variance)}</td><td>${esc(c.user_name || '—')}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No counts yet.</td></tr>'}
      </tbody></table></div>
    </div>`;
}

// ── Section: Overview ──────────────────────────────────────────────────────
// Jump straight into a location's detail tab (used by the manager dashboard).
function openLocationDetail(locId, tab) {
  S.section = 'locations'; setActiveNav('locations');
  const meta = SECTIONS.find(s => s[0] === 'locations');
  $('pageTitle').textContent = meta ? meta[2] : 'Locations';
  $('locPicker').classList.add('hidden');
  S.locView = 'detail'; S.locDetailId = locId; S.locTab = tab || 'details';
  renderLocationsSection();
}

// A Messages link + unread badge for the Overview hero (every role lands here).
function msgHeroLink() {
  return `<button class="msg-hero-link" data-goto="messages">✉️ Messages${S.unread ? ` <span class="nav-badge">${S.unread}</span>` : ''}</button>`;
}

async function renderOverview() {
  const scope = roleScopeOf(S.user.role);
  if (scope === 'self') return renderSelfOverview();
  if (myCap('manage') && scope === 'location' && S.user.location_id) return renderManagerDashboard();
  let dash = null;
  if (myCap('ops')) { try { dash = await api(invQ('/dashboard')); } catch { /* no access */ } }
  let staffCount = null;
  if (myCap('manage')) {
    try { staffCount = (await api('/staff')).length; } catch { staffCount = null; }
  }
  const locName = (S.locations.find(l => String(l.id) === String(S.loc)) || {}).name || '';
  const quick = allowedSections().filter(s => s[0] !== 'overview');
  $('view').innerHTML = `
    <div class="overview-hero">
      <h2>Welcome, ${esc(S.user.name.split(' ')[0])}</h2>
      <p>Enterprise Restaurant Management System · <span class="role-chip">${esc(roleLabel(S.user.role))}</span></p>
      ${msgHeroLink()}
    </div>
    <div class="kpis">
      <div class="card"><div class="label">Locations</div><div class="value">${S.locations.length}</div></div>
      ${staffCount != null ? `<div class="card"><div class="label">Staff</div><div class="value">${staffCount}</div></div>` : ''}
      ${dash ? `<div class="card"><div class="label">Inventory value${locName ? ' · ' + esc(locName.replace('Pho Ha Noi — ', '')) : ''}</div><div class="value">${money(dash.total_value)}</div></div>
      <div class="card"><div class="label">Below minimum</div><div class="value ${dash.low_stock ? 'warn' : ''}">${dash.low_stock}</div></div>
      <div class="card"><div class="label">Expiring ≤ 7 days</div><div class="value ${dash.expiring_7d ? 'bad' : ''}">${dash.expiring_7d}</div></div>` : ''}
    </div>
    <div class="section"><h3>Jump to a section</h3>
      <div class="quick-grid">
        ${quick.map(([k, icon, label]) => `<button class="quick-card" data-goto="${k}"><span class="q-icon">${icon}</span><span>${esc(label)}</span></button>`).join('')}
      </div>
    </div>`;
  $('view').querySelectorAll('[data-goto]').forEach(b => b.onclick = () => showSection(b.dataset.goto));
}

// ── Manager dashboard (the Overview a manager lands on) ──────────────────────
async function renderManagerDashboard() {
  const loc = S.user.location_id;
  const safe = (p, fb) => p.then(x => x).catch(() => fb);
  const [week, overview, reorder, equip, dash, locDetail, dayTasks, clock, payroll] = await Promise.all([
    safe(api(`/schedule/week?location_id=${loc}`), { staff: [], days: [], location: {} }),
    safe(api('/staff/overview'), []),
    safe(api(`/inventory/reorder-suggestions?location_id=${loc}`), []),
    safe(api(`/locations/${loc}/equipment`), []),
    safe(api(`/inventory/dashboard?location_id=${loc}`), null),
    safe(api(`/locations/${loc}`), { hours: [] }),
    safe(api(`/schedule/day-tasks?location_id=${loc}`), { tasks: [], summary: { total: 0, assigned: 0, unassigned: 0 } }),
    safe(api(`/timeclock/board?location_id=${loc}`), { entries: [], not_in: [], summary: {} }),
    safe(api(`/timeclock/payroll?location_id=${loc}`), { ot_days: [], totals: {} }),
  ]);
  const locName = shortLoc(week.location && week.location.name) || 'your location';
  const rs = overview[0] || { total: week.staff.length, active: 0, vacation: 0, sick: 0, inactive: 0, manager: null };
  const today = week.today || todayIso(); // location-local today

  // Who's on today (at this location; note anyone away).
  const onToday = week.staff.map(st => {
    const todays = st.shifts.filter(s => s.shift_date === today);
    if (!todays.length) return null;
    const dayH = sumHours(todays), weekH = sumHours(st.shifts);
    const away = todays.filter(s => String(s.location_id) !== String(loc));
    return { name: st.name, role: st.role, todays, dayH, weekH, away, ot: dayH > DAILY_MAX || weekH > WEEKLY_MAX };
  }).filter(Boolean).sort((a, b) => (a.todays[0].start_time || '').localeCompare(b.todays[0].start_time || ''));

  // Schedule health for the week.
  const overWeek = week.staff.filter(st => sumHours(st.shifts) > WEEKLY_MAX);
  let overDay = 0;
  week.staff.forEach(st => {
    const byDay = {};
    st.shifts.forEach(s => { byDay[s.shift_date] = (byDay[s.shift_date] || 0) + shiftWorkedHours(s); });
    Object.values(byDay).forEach(h => { if (h > DAILY_MAX) overDay++; });
  });
  const noJobs = week.staff.reduce((n, st) => n + st.shifts.filter(s => String(s.location_id) === String(loc) && s.jobs.length === 0).length, 0);
  const unscheduled = week.staff.filter(st => st.shifts.length === 0).length;

  // Unfilled days: the store is open (per operating hours) but nobody is scheduled
  // at this location that day. Hours use day_of_week 0=Mon … 6=Sun, matching week.days.
  const openMap = {}; (locDetail.hours || []).forEach(h => { openMap[h.day_of_week] = h; });
  const unfilledDays = week.days.filter((iso, i) => {
    const h = openMap[i];
    const open = h ? !h.is_closed : true; // assume open if hours are unknown
    if (!open) return false;
    return !week.staff.some(st => st.shifts.some(s => s.shift_date === iso && String(s.location_id) === String(loc)));
  }).map((iso) => WD[(new Date(iso + 'T00:00:00').getDay() + 6) % 7]);

  const equipIssues = equip.filter(e => e.status && e.status !== 'operational');
  const serviceDue = equip.filter(e => e.next_service && e.status === 'operational' && new Date(e.next_service) < new Date());
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const stat = (label, value, cls, goto) => `<button class="card stat-btn" ${goto ? `data-goto="${goto}"` : ''}><div class="label">${label}</div><div class="value ${cls || ''}">${value}</div></button>`;
  // Overtime awaiting approval this week (won't be paid until approved).
  const otPending = (payroll.ot_days || []).filter(d => !d.approved);
  const otPendStaff = new Set(otPending.map(d => d.user_id)).size;
  const otPendHours = Math.round((((payroll.totals || {}).ot_pending_hours || 0) + ((payroll.totals || {}).dt_pending_hours || 0)) * 10) / 10;

  $('view').innerHTML = `
    <div class="overview-hero">
      <h2>${greet}, ${esc(S.user.name.split(' ')[0])}</h2>
      <p>${esc(locName)} · <span class="role-chip">${esc(roleLabel(S.user.role))}</span> · ${WD[(new Date(today + 'T00:00:00').getDay() + 6) % 7]} ${fmtDay(today)}</p>
      ${msgHeroLink()}
    </div>
    <div class="kpis">
      ${stat('Staff', rs.total, '', 'staff')}
      ${stat('On today', onToday.length, onToday.length ? 'ok' : '')}
      ${stat('On the clock', clock.summary.on_clock || 0, (clock.summary.on_clock || 0) ? 'ok' : '')}
      ${stat('Tasks to assign', dayTasks.summary.unassigned, dayTasks.summary.unassigned ? 'bad' : '')}
      ${stat('OT to approve', otPending.length, otPending.length ? 'bad' : '')}
      ${stat('Over 40h this week', overWeek.length, overWeek.length ? 'bad' : '')}
      ${stat('Low stock', reorder.length, reorder.length ? 'warn' : '', 'inventory')}
      ${stat('Equipment issues', equipIssues.length + serviceDue.length, (equipIssues.length + serviceDue.length) ? 'warn' : '')}
    </div>

    ${otPending.length ? `<div class="section" style="border-left:4px solid var(--red)">
      <div class="row-between"><h3 style="margin:0;color:var(--red)">⏱ Overtime needs approval</h3>
        <button class="btn sm" data-timeclock="1">Review & approve →</button></div>
      <p class="sub" style="margin:.35rem 0 0;font-size:.85rem"><strong>${otPending.length}</strong> overtime day${otPending.length === 1 ? '' : 's'} across <strong>${otPendStaff}</strong> staff (${otPendHours}h) this week won't be paid until approved with a note. Approve on the Time Clock tab before the pay run.</p>
    </div>` : ''}

    ${dayTasks.summary.total ? `<div class="section">
      <div class="row-between"><h3 style="margin:0">Today's tasks <span style="font-weight:400;color:var(--muted);font-size:.85rem">— ${dayTasks.summary.assigned}/${dayTasks.summary.total} assigned</span></h3>
        <button class="btn sm" data-daytasks="1">Assign tasks →</button></div>
      ${dayTasks.summary.unassigned
    ? `<p class="sub" style="margin:.4rem 0 0;color:var(--red);font-size:.85rem">⚠ ${dayTasks.summary.unassigned} still unassigned: ${dayTasks.tasks.filter(t => !t.user_id).slice(0, 6).map(t => esc(t.name)).join(', ')}${dayTasks.summary.unassigned > 6 ? '…' : ''} — assign so nothing's left behind.</p>`
    : `<p class="sub" style="margin:.4rem 0 0;color:#1e7e34;font-size:.85rem">✓ Every task today is assigned.</p>`}
    </div>` : ''}

    <div class="section">
      <div class="row-between"><h3 style="margin:0">Check-in / Check-out <span style="font-weight:400;color:var(--muted);font-size:.85rem">— ${clock.summary.on_clock || 0} on the clock · ${clock.summary.done || 0} checked out${clock.summary.not_in ? ` · ${clock.summary.not_in} not in` : ''}</span></h3>
        <button class="btn sm" data-timeclock="1">Open time clock →</button></div>
      ${clock.summary.short ? `<p class="sub" style="margin:.4rem 0 .2rem;color:var(--red);font-size:.85rem">⚠ ${clock.summary.short} checked out early today — review on the Time Clock tab.</p>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Staff</th><th>Checked in</th><th>Checked out</th><th>Worked</th><th>Status</th></tr></thead><tbody>
        ${clock.entries.length ? clock.entries.map(e => `<tr>
          <td><strong>${esc(e.name)}</strong> <span class="mono" style="color:var(--muted);font-size:.75rem">${esc(e.employee_code || '')}</span></td>
          <td class="mono">${e.clock_in || '—'}</td>
          <td class="mono">${e.clock_out || '—'}</td>
          <td>${fmtDur(e.worked_minutes)}${e.status === 'in' ? ' <span style="color:var(--muted)">so far</span>' : ''}</td>
          <td>${e.status === 'in' ? '<span class="badge ok">🟢 On clock</span>' : `<span class="badge gray">Checked out</span>${e.short ? ' <span class="badge out">⚠ short</span>' : ''}${e.overtime_minutes > 0 ? ` <span class="badge blue">+${fmtDur(e.overtime_minutes)} OT</span>` : ''}`}</td>
        </tr>`).join('') : '<tr><td colspan="5" class="empty">No check-ins yet today.</td></tr>'}
        ${clock.not_in && clock.not_in.length ? `<tr><td colspan="5" style="color:var(--muted);font-size:.83rem;background:#fafafa">Scheduled, not checked in: ${clock.not_in.slice(0, 8).map(n => esc(n.name)).join(', ')}${clock.not_in.length > 8 ? ` +${clock.not_in.length - 8} more` : ''}</td></tr>` : ''}
      </tbody></table></div>
    </div>

    <div class="dash-cols">
      <div class="section">
        <div class="row-between"><h3 style="margin:0">On today — ${WD[(new Date(today + 'T00:00:00').getDay() + 6) % 7]} ${fmtDay(today)}</h3>
          <button class="btn sm ghost" data-sched="1">Open schedule →</button></div>
        <div class="table-wrap"><table><thead><tr><th>Staff</th><th>Shift</th><th class="num">Hrs</th><th>Jobs</th></tr></thead><tbody>
          ${onToday.length ? onToday.map(p => `<tr>
            <td><strong>${esc(p.name)}</strong> <span class="badge ${ROLE_CHIP[p.role] || 'gray'}">${esc(roleLabel(p.role))}</span>${p.ot ? ' <span class="badge out" title="Over daily/weekly limit">OT ⚠</span>' : ''}${p.away.length ? ' <span class="badge blue">away</span>' : ''}</td>
            <td>${p.todays.map(s => `${s.start_time || '—'}–${s.end_time || '—'}`).join(', ')}</td>
            <td class="num">${fmtH(p.dayH)}h</td>
            <td>${p.todays.reduce((n, s) => n + s.jobs.length, 0)} assigned</td>
          </tr>`).join('') : '<tr><td colspan="4" class="empty">Nobody scheduled today.</td></tr>'}
        </tbody></table></div>
      </div>

      <div class="section">
        <h3 style="margin-top:0">This week's schedule health</h3>
        <div class="health-grid">
          <div class="health ${unfilledDays.length ? 'bad' : 'ok'}"><div class="h-num">${unfilledDays.length}</div><div>unfilled open days</div></div>
          <div class="health ${overDay ? 'warn' : 'ok'}"><div class="h-num">${overDay}</div><div>staff-days over 8h</div></div>
          <div class="health ${overWeek.length ? 'bad' : 'ok'}"><div class="h-num">${overWeek.length}</div><div>over 40h this week</div></div>
          <div class="health ${noJobs ? 'warn' : 'ok'}"><div class="h-num">${noJobs}</div><div>shifts with no jobs</div></div>
          <div class="health ${unscheduled ? 'warn' : 'ok'}"><div class="h-num">${unscheduled}</div><div>unscheduled staff</div></div>
        </div>
        ${unfilledDays.length ? `<p class="sub" style="margin:.6rem 0 0;color:var(--red);font-size:.82rem">Open but nobody scheduled: ${unfilledDays.join(', ')} — assign coverage.</p>` : ''}
        ${overWeek.length ? `<p class="sub" style="margin:.4rem 0 0;color:var(--red);font-size:.82rem">Over full-time: ${overWeek.map(s => esc(s.name)).join(', ')} — review or approve.</p>` : ''}
      </div>
    </div>

    <div class="dash-cols">
      <div class="section">
        <h3 style="margin-top:0">Roster status</h3>
        <div class="kpis" style="margin:0">
          <div class="card"><div class="label">Active</div><div class="value ok">${rs.active}</div></div>
          <div class="card"><div class="label">Vacation</div><div class="value">${rs.vacation}</div></div>
          <div class="card"><div class="label">Sick</div><div class="value">${rs.sick}</div></div>
          <div class="card"><div class="label">Inactive</div><div class="value bad">${rs.inactive}</div></div>
        </div>
        <button class="btn sm ghost" data-goto="staff" style="margin-top:.7rem">View staff directory →</button>
      </div>

      <div class="section">
        <h3 style="margin-top:0">Needs attention</h3>
        <div class="attn-block"><strong>${reorder.length}</strong> item${reorder.length === 1 ? '' : 's'} below par
          ${reorder.length ? `<ul class="attn-list">${reorder.slice(0, 4).map(i => `<li>${esc(i.item_name || i.name)} <span class="muted">${i.quantity != null ? i.quantity : ''}${i.par_level != null ? ' / ' + i.par_level : ''}</span></li>`).join('')}${reorder.length > 4 ? `<li class="muted">+${reorder.length - 4} more…</li>` : ''}</ul>` : ''}
          <button class="btn sm ghost" data-goto="inventory">Open inventory →</button></div>
        <div class="attn-block"><strong>${equipIssues.length + serviceDue.length}</strong> equipment item${(equipIssues.length + serviceDue.length) === 1 ? '' : 's'} to check
          ${(equipIssues.length + serviceDue.length) ? `<ul class="attn-list">${equipIssues.slice(0, 3).map(e => `<li>${esc(e.name)} <span class="badge low">${esc((e.status || '').replace('_', ' '))}</span></li>`).join('')}${serviceDue.slice(0, 3 - Math.min(3, equipIssues.length)).map(e => `<li>${esc(e.name)} <span class="badge out">service overdue</span></li>`).join('')}</ul>` : ''}
          <button class="btn sm ghost" data-equip="1">Open equipment →</button></div>
      </div>
    </div>`;

  $('view').querySelectorAll('[data-goto]').forEach(b => b.onclick = () => showSection(b.dataset.goto));
  $('view').querySelectorAll('[data-sched]').forEach(b => b.onclick = () => openLocationDetail(loc, 'schedule'));
  $('view').querySelectorAll('[data-equip]').forEach(b => b.onclick = () => openLocationDetail(loc, 'equipment'));
  $('view').querySelectorAll('[data-daytasks]').forEach(b => b.onclick = () => openLocationDetail(loc, 'daytasks'));
  $('view').querySelectorAll('[data-timeclock]').forEach(b => b.onclick = () => openLocationDetail(loc, 'timeclock'));
}

// ── My Schedule (a staff member's own week, read-only, with OT warnings) ─────
async function renderMySchedule() {
  let data;
  try { data = await api('/schedule/my-week' + (S.mySchedWeek ? '?week=' + S.mySchedWeek : '')); }
  catch (e) { return renderPlaceholder('My Schedule', '🗓️', e.message); }
  S.mySchedWeek = data.week_start;
  const days = data.days;
  const weekH = sumHours(data.shifts);
  const overWeek = weekH > WEEKLY_MAX;
  const jobChip = (j) => `<span class="jchip ${COMPLEXITY_CHIP[j.complexity] || 'gray'}" data-tip="${esc(chipTip(j))}">${esc(j.code || j.name)}</span>`;
  const byDay = {}; data.shifts.forEach(s => { (byDay[s.shift_date] = byDay[s.shift_date] || []).push(s); });
  const overDays = days.filter(iso => sumHours(byDay[iso] || []) > DAILY_MAX).map(iso => WD[(new Date(iso + 'T00:00:00').getDay() + 6) % 7]);

  const dayCard = (iso, i) => {
    const ss = (byDay[iso] || []).slice().sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
    const dayH = sumHours(ss);
    const dayBreak = sumBreakMinutes(ss);
    const load = taskLoad(ss);
    const over = dayH > DAILY_MAX;
    return `<div class="myday${iso === todayIso() ? ' today' : ''}">
      <div class="myday-head"><span>${WD[i]} <span class="myday-date">${fmtDay(iso)}</span></span>${ss.length ? `<span class="myday-h${over ? ' over' : ''}">${over ? '⚠ ' : ''}${fmtH(dayH)}h</span>` : ''}</div>
      ${dayBreak ? `<div class="myday-break">☕ ${dayBreak} min break${dayBreak > 10 ? 's' : ''}</div>` : ''}
      ${load.min ? `<div class="myday-tasks${load.heavy ? ' heavy' : ''}" title="${fmtDur(load.min)} of tasks on a ${fmtH(dayH)}h shift (${load.pct}%)">${load.heavy ? '⚠ ' : '📋 '}${fmtDur(load.min)} of tasks${load.heavy ? ' — heavy load' : ''}</div>` : ''}
      ${ss.length ? ss.map(s => `<div class="myshift">
        <div class="myshift-top"><strong>${s.start_time || '—'}–${s.end_time || '—'}</strong> <span class="shift-h">${fmtH(shiftWorkedHours(s))}h</span> <span class="myshift-loc">${esc(shortLoc(s.location_name))}</span></div>
        <div class="shift-jobs">${s.jobs.map(jobChip).join('') || '<span class="jchip gray">no jobs</span>'}</div>
        ${(s.tasks && s.tasks.length) ? `<div class="shift-tasks">${s.tasks.map(t => `<span class="task-chip${t.done ? ' done' : ''}" data-tip="${esc(chipTip(t, t.task_time ? 'at ' + t.task_time : ''))}">📋 ${t.task_time ? `<strong>${esc(t.task_time)}</strong> ` : ''}${esc(t.name)}${t.done ? ' ✓' : ''}</span>`).join('')}</div>` : ''}
        ${(s.breaks && s.breaks.length) ? `<div class="myshift-breaks">${s.breaks.map(b => `<span class="brk-chip">☕ ${esc(fmtBreak(b))}</span>`).join('')}</div>` : ''}
        ${s.notes ? `<div class="myshift-note">📝 ${esc(s.notes)}</div>` : ''}
      </div>`).join('') : '<div class="myday-off">Day off</div>'}
    </div>`;
  };

  const warn = (overWeek || overDays.length)
    ? `<div class="ot-banner">⚠ ${[
        overWeek ? `You're scheduled <strong>${fmtH(weekH)}h</strong> this week — over the ${WEEKLY_MAX}h full-time limit.` : '',
        overDays.length ? `Over ${DAILY_MAX}h on: <strong>${overDays.join(', ')}</strong>.` : '',
      ].filter(Boolean).join('<br>')}<br>Check with your manager if this looks wrong.</div>`
    : '';

  $('view').innerHTML = `
    <div class="row-between sched-head">
      <div class="week-nav">
        <button class="btn sm ghost" id="wkPrev">‹ Prev</button>
        <button class="btn sm ghost" id="wkToday">This week</button>
        <button class="btn sm ghost" id="wkNext">Next ›</button>
      </div>
      <div class="week-label">Week of <strong>${fmtDay(days[0])}</strong> – <strong>${fmtDay(days[6])}</strong>, ${days[6].slice(0, 4)}</div>
      <span class="badge ${overWeek ? 'out' : (weekH ? 'ok' : 'gray')}" title="Hours scheduled this week">${fmtH(weekH)}h / ${WEEKLY_MAX}h</span>
    </div>
    ${warn}
    <div class="myweek">${days.map((d, i) => dayCard(d, i)).join('')}</div>
    <p class="sub" style="color:var(--muted);margin-top:.6rem;font-size:.8rem">Limits: <strong>${DAILY_MAX}h/day</strong>, <strong>${WEEKLY_MAX}h/week</strong>. Days over the limit are flagged ⚠. Only a manager can change a shift.</p>`;

  $('wkPrev').onclick = () => { S.mySchedWeek = addDaysIso(data.week_start, -7); renderMySchedule(); };
  $('wkNext').onclick = () => { S.mySchedWeek = addDaysIso(data.week_start, 7); renderMySchedule(); };
  $('wkToday').onclick = () => { S.mySchedWeek = mondayOf(null); renderMySchedule(); };
}

// ── Self-service landing (Server, Busser, Chef, Front Desk, …) ───────────────
function renderSelfOverview() {
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const cards = [
    ['myschedule', '🗓️', 'My Schedule', 'See your shifts and assigned tasks for the week.'],
    ['myhours', '⏱️', 'My Hours', 'Your clocked hours, overtime and any late starts.'],
    ['messages', '💬', `Messages${S.unread ? ` (${S.unread})` : ''}`, 'Read announcements and message your team.'],
  ];
  $('view').innerHTML = `
    <div class="overview-hero">
      <h2>${greet}, ${esc(S.user.name.split(' ')[0])}</h2>
      <p>${esc(roleLabel(S.user.role))}${S.user.location_id ? ' · ' + esc(shortLoc((S.locations.find(l => String(l.id) === String(S.user.location_id)) || {}).name || '')) : ''}</p>
    </div>
    <div class="quick-grid">
      ${cards.map(([k, icon, label, desc]) => `<button class="quick-card lg" data-goto="${k}"><span class="q-icon">${icon}</span><span class="q-label">${label}</span><span class="q-desc">${esc(desc)}</span></button>`).join('')}
    </div>`;
  $('view').querySelectorAll('[data-goto]').forEach(b => b.onclick = () => showSection(b.dataset.goto));
}

// ── Deliveries (Driver) — read-only Central-Kitchen fulfillment / manifests ──
async function renderDeliveries() {
  let f;
  try { f = await api('/central/fulfillment'); }
  catch (e) { return renderPlaceholder('Deliveries', '🚚', e.message); }
  const shortName = (s) => (s || '').replace('Pho Ha Noi — ', '');
  $('view').innerHTML = `
    <h2 class="page">Deliveries <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${esc(f.date || '')}</span></h2>
    <p class="sub" style="color:var(--muted);margin-top:0">Today's delivery routes and per-store packing slips from the Central Kitchen.</p>
    <div class="section"><h3 style="margin-top:0">Delivery routes</h3>
      ${(f.manifests || []).length ? (f.manifests).map(m => `<div class="attn-block"><strong>${esc(m.route)}</strong> <span class="muted">— ${(m.stores || []).map(s => esc(shortName(s))).join(', ') || 'no stores today'}</span></div>`).join('') : '<div class="empty">No routes scheduled.</div>'}
    </div>
    <div class="section"><h3 style="margin-top:0">Per-store packing slips</h3>
      <div class="table-wrap"><table><thead><tr><th>Store</th><th>Items</th><th>Status</th></tr></thead><tbody>
        ${(f.stores || []).length ? f.stores.map(s => `<tr>
          <td><strong>${esc(shortName(s.location))}</strong></td>
          <td>${(s.lines || []).map(l => `${esc(l.product)} <span class="muted">×${l.quantity} ${esc(l.unit || '')}</span>`).join('<br>') || '<span class="muted">—</span>'}</td>
          <td><span class="badge ${s.status === 'fulfilled' ? 'ok' : 'low'}">${esc(s.status || 'pending')}</span></td>
        </tr>`).join('') : '<tr><td colspan="3" class="empty">Nothing to deliver right now.</td></tr>'}
      </tbody></table></div>
    </div>`;
}

// ── Section: Locations (master-detail module) ──────────────────────────────
const statusBadgeLoc = (s) => `<span class="badge ${s === 'active' ? 'ok' : (s === 'draft' ? 'gray' : 'out')}">${esc(s)}</span>`;
function renderLocationsSection() {
  if (S.locView === 'detail' && S.locDetailId) { $('tabs').classList.remove('hidden'); renderLocDetailTabs(); renderLocDetail(); }
  else { $('tabs').classList.add('hidden'); renderLocList(); }
}

async function renderLocList() {
  const locs = await api('/locations');
  const canAdd = ['owner', 'admin'].includes(S.user.role);
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Locations <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${locs.length}</span></h2>
      ${canAdd ? '<button class="btn" id="addLoc">+ Add location</button>' : ''}</div>
    <div class="loc-grid">
      ${locs.map(l => `<div class="loc-card">
        <div class="loc-card-head"><span class="loc-name">${esc(shortLoc(l.name))}</span>${statusBadgeLoc(l.status)}</div>
        <div class="loc-meta">📍 ${esc([l.city, l.state].filter(Boolean).join(', ') || '—')}</div>
        <div class="loc-meta">📞 ${esc(l.phone || '—')}</div>
        <div class="loc-stats">
          <div><span>Manager</span><strong>${esc(l.manager_name || '—')}</strong></div>
          <div><span>Staff</span><strong>${l.staff_count}</strong></div>
          <div><span>Seats</span><strong>${l.seats || '—'}</strong></div>
          <div><span>Equipment</span><strong>${l.equipment_count}${l.equipment_issues ? ` <span class="badge low">${l.equipment_issues}⚠</span>` : ''}</strong></div>
        </div>
        <button class="btn ghost sm" data-manage="${l.id}">Manage →</button>
      </div>`).join('')}
    </div>`;
  if (canAdd) $('addLoc').onclick = () => locationModal(null);
  $('view').querySelectorAll('[data-manage]').forEach(b => b.onclick = () => { S.locDetailId = b.dataset.manage; S.locView = 'detail'; S.locTab = 'details'; renderLocationsSection(); });
}

function locationModal(loc) {
  const isNew = !loc;
  const fields = [
    { key: 'name', label: 'Location name', value: loc ? loc.name : 'Pho Ha Noi — ' },
    { key: 'address', label: 'Street address', value: loc ? loc.address : '' },
    { key: 'city', label: 'City', value: loc ? loc.city : '' },
    { key: 'state', label: 'State', value: loc ? loc.state : 'CA' },
    { key: 'zip', label: 'ZIP', value: loc ? loc.zip : '' },
    { key: 'phone', label: 'Phone', value: loc ? loc.phone : '' },
    { key: 'email', label: 'Email', value: loc ? loc.email : '' },
    { key: 'seats', label: 'Seats', type: 'number', value: loc ? loc.seats : 0 },
    { key: 'opening_date', label: 'Opening date (YYYY-MM-DD)', value: loc ? loc.opening_date : '' },
    { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'draft', label: 'Draft' }, { value: 'closed', label: 'Closed' }], value: loc ? loc.status : 'active' },
  ];
  modal(isNew ? 'Add location' : `Edit — ${shortLoc(loc.name)}`, fields, async (v) => {
    if (isNew) { await api('/locations', { method: 'POST', body: JSON.stringify(v) }); toast('Location added'); }
    else { await api('/locations/' + loc.id, { method: 'PUT', body: JSON.stringify(v) }); toast('Location updated'); }
    S.locations = await api('/inventory/locations').catch(() => S.locations);
    isNew ? (S.locView = 'list', renderLocationsSection()) : renderLocDetail();
  }, isNew ? 'Add location' : 'Save');
}

const LOC_DETAIL_TABS = [['details', 'Details'], ['staff', 'Staff'], ['schedule', 'Schedule'], ['daytasks', 'Day Tasks'], ['timeclock', 'Time Clock'], ['performance', 'Performance'], ['floorplan', 'Floor Plan'], ['equipment', 'Equipment'], ['activity', 'Activity']];
// The Activity trail is limited to Owner / Admin / General Manager / Manager.
const LOC_ACTIVITY_ROLES = ['owner', 'admin', 'general_manager', 'manager'];
const locTabsForMe = () => LOC_DETAIL_TABS.filter(([k]) => k !== 'activity' || LOC_ACTIVITY_ROLES.includes(S.user.role));
function renderLocDetailTabs() {
  $('tabs').innerHTML = locTabsForMe().map(([k, l]) => `<button data-ltab="${k}" class="${S.locTab === k ? 'active' : ''}">${l}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach(b => b.onclick = () => { S.locTab = b.dataset.ltab; renderLocDetailTabs(); renderLocDetail(); });
}
async function renderLocDetail() {
  const loc = await api('/locations/' + S.locDetailId);
  $('view').innerHTML = `
    <div class="loc-detail-head">
      <button class="btn ghost sm" id="locBack">← Locations</button>
      <h2 class="page" style="margin:0">${esc(shortLoc(loc.name))} ${statusBadgeLoc(loc.status)}</h2>
    </div>
    <div id="locBody"><div class="empty">Loading…</div></div>`;
  $('locBack').onclick = () => { S.locView = 'list'; S.locDetailId = null; renderLocationsSection(); };
  if (S.locTab === 'activity' && !LOC_ACTIVITY_ROLES.includes(S.user.role)) S.locTab = 'details';
  ({ details: () => renderLocInfo(loc), staff: renderLocStaff, schedule: renderLocSchedule, daytasks: renderLocDayTasks, timeclock: renderLocTimeClock, performance: () => renderLocPerformance(loc), floorplan: renderLocFloorPlan, equipment: renderLocEquipment, activity: renderLocActivity }[S.locTab])();
}

// ── Location activity trail (Owner/Admin/GM/Manager; manager = own location) ──
const actTime = (ts) => { if (!ts) return ''; const d = new Date(String(ts).replace(' ', 'T') + (/[Z+]/.test(String(ts).slice(10)) ? '' : 'Z')); return isNaN(d) ? ts : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
function actLabel(r) {
  if (r.detail && r.detail.event === 'login') return 'Signed in';
  if (r.detail && r.detail.event === 'login_failed') return 'Failed sign-in' + (r.detail.email ? ` (${r.detail.email})` : '');
  const p = r.path || '';
  if (p.includes('/public/checkin')) return 'Customer self check-in';
  const verb = { POST: 'Created', PUT: 'Updated', PATCH: 'Updated', DELETE: 'Deleted', GET: 'Viewed' }[r.method] || r.method || '';
  return `${verb} ${p.replace(/^\/api\//, '')}`.trim();
}
function actStatusBadge(s) { if (!s) return ''; const cls = s >= 200 && s < 300 ? 'ok' : (s === 401 || s === 403 ? 'out' : 'low'); return `<span class="badge ${cls}">${s}</span>`; }
const ACT_RANGES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['all', 'All']];
async function renderLocActivity() {
  const range = S.locActRange || (S.locActRange = 'day');
  let rows;
  try { rows = await api(`/locations/${S.locDetailId}/activity?range=${range}&limit=500`); }
  catch (e) { $('locBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const rangeBtns = ACT_RANGES.map(([k, l]) => `<button class="btn sm ${range === k ? '' : 'ghost'}" data-arange="${k}">${l}</button>`).join('');
  $('locBody').innerHTML = `
    <div class="row-between" style="margin:0 0 .7rem;gap:1rem;flex-wrap:wrap">
      <p class="sub" style="color:var(--muted);margin:0">Access trail for this location — Staff app and Management: sign-ins, changes, and denied attempts.</p>
      <div style="display:flex;gap:.35rem">${rangeBtns}</div>
    </div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Where</th><th>Who</th><th>Action</th><th class="num">Status</th><th>IP</th></tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td class="mono">${esc(actTime(r.created_at))}</td>
        <td><span class="badge ${r.source === 'frontdesk' ? 'blue' : 'gray'}">${r.source === 'frontdesk' ? 'Front Desk' : 'Mgmt'}</span></td>
        <td>${r.user_name ? `<strong>${esc(r.user_name)}</strong>${r.user_role ? ` <span class="badge ${ROLE_CHIP[r.user_role] || 'gray'}">${esc(roleLabel(r.user_role))}</span>` : ''}` : '<span class="badge gray">system</span>'}</td>
        <td class="mono">${esc(actLabel(r))}</td>
        <td class="num">${actStatusBadge(r.status)}</td>
        <td class="mono" style="color:var(--muted)">${esc(r.ip || '—')}</td>
      </tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No activity in this range.</div>'}`;
  $('locBody').querySelectorAll('[data-arange]').forEach(b => b.onclick = () => { S.locActRange = b.dataset.arange; renderLocActivity(); });
}

async function renderLocInfo(loc) {
  const canEdit = ['owner', 'admin'].includes(S.user.role);
  const canEditHours = ['owner', 'admin', 'manager'].includes(S.user.role);
  const canViewFloor = ['owner', 'admin', 'manager', 'assistant_manager', 'kitchen_manager', 'general_manager', 'regional_manager'].includes(S.user.role);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hoursMap = {}; loc.hours.forEach(h => hoursMap[h.day_of_week] = h);
  $('locBody').innerHTML = `
    <div class="acct-grid">
      <div class="section"><div class="row-between"><h3>Location details</h3>${canEdit ? '<button class="btn sm ghost" id="editLoc">Edit</button>' : ''}</div>
        <div class="profile-row"><span>Address</span><strong>${esc([loc.address, loc.city, loc.state, loc.zip].filter(Boolean).join(', ') || '—')}</strong></div>
        <div class="profile-row"><span>Phone</span><strong>${esc(loc.phone || '—')}</strong></div>
        <div class="profile-row"><span>Email</span><strong>${esc(loc.email || '—')}</strong></div>
        <div class="profile-row"><span>Manager</span><strong>${esc(loc.manager ? loc.manager.name : '—')}</strong></div>
        <div class="profile-row"><span>Seats</span><strong>${loc.seats || '—'}</strong></div>
        <div class="profile-row"><span>Opened</span><strong>${esc(loc.opening_date || '—')}</strong></div>
        <div class="profile-row"><span>Timezone</span><strong>${esc(loc.timezone || '—')}</strong></div>
      </div>
      <div class="section"><div class="row-between"><h3>Operating hours</h3>${canEditHours ? '<button class="btn sm ghost" id="editHours">Edit</button>' : ''}</div>
        ${days.map((d, i) => { const h = hoursMap[i]; return `<div class="profile-row"><span>${d}</span><strong>${h && !h.is_closed ? `${h.open_time}–${h.close_time}` : 'Closed'}</strong></div>`; }).join('')}
      </div>
    </div>
    ${canViewFloor ? `<div class="section" id="locFloorSnap" style="margin-top:1rem"><div class="row-between"><h3>Floor status <span style="font-weight:400;color:var(--muted);font-size:.82rem">— live, right now</span></h3><div style="display:flex;gap:.4rem;align-items:center">${guestsToggleBtn('locFloorGuests')}<button class="btn sm ghost" id="locFloorOpen">Open Floor Plan →</button></div></div>
      <div id="locFloorSnapBody"><div class="empty">Loading floor status…</div></div></div>` : ''}`;
  if (canEdit) $('editLoc').onclick = () => locationModal(loc);
  if (canEditHours) $('editHours').onclick = () => editHoursModal(loc);
  if (canViewFloor) {
    $('locFloorGuests').onclick = () => { toggleGuests(); renderLocDetail(); };
    $('locFloorOpen').onclick = () => { S.locTab = 'floorplan'; renderLocDetailTabs(); renderLocDetail(); };
    try {
      const fp = await api('/floorplan?location_id=' + loc.id);
      // Guard against the user having navigated away while the fetch was in flight.
      if (S.locTab !== 'details' || String(S.locDetailId) !== String(loc.id)) return;
      const body = $('locFloorSnapBody'); if (body) body.innerHTML = fpSnapshotHtml(fp);
    } catch (e) { const body = $('locFloorSnapBody'); if (body) body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
}
// Read-only floor snapshot for the Location Details tab — a point-in-time picture
// of who's seated. Reuses the Floor Plan status colors; no interaction.
function fpMiniTable(t) {
  const [lbl, c, bg] = TABLE_STATUS[t.status] || TABLE_STATUS.available;
  const occ = t.status !== 'available';
  const tip = occ ? `${lbl}${t.guest_name ? ' · ' + esc(t.guest_name) : ''}${t.party_size ? ' · ' + t.party_size + ' guests' : ''}${t.server_name ? ' · ' + esc(t.server_name) : ''}${t.check_due ? ' · check overdue' : ''}` : `Available · ${t.seats} seats`;
  const sub = occ && t.party_size && showGuests() ? `<span class="ftable-s">${t.party_size}👤</span>` : '';
  const badge = t.check_due ? '<span class="ftable-due">⏰</span>' : '';
  return `<div class="ftable ${t.shape === 'square' ? 'sq' : ''}${t.check_due ? ' due' : ''}" style="left:${t.pos_x}%;top:${t.pos_y}%;--ac:${c};--abg:${bg}" title="${esc(t.label)} · ${tip}"><span class="ftable-l">${esc(t.label)}</span>${sub}${badge}</div>`;
}
function fpSnapshotHtml(fp) {
  const all = fp.areas.flatMap(a => a.tables);
  if (!all.length) return '<div class="empty">No floor plan for this location yet. Open the Floor Plan tab to set one up.</div>';
  const sm = fp.summary;
  const legend = `<div class="fp-legend">${Object.entries(TABLE_STATUS).map(([k, [l, c]]) => `<span class="fp-leg"><span class="fp-dot" style="background:${c}"></span>${l} <span class="fp-leg-n">${all.filter(t => (t.status || 'available') === k).length}</span></span>`).join('')}</div>`;
  const board = `<div class="floor-board snapshot">${roomSvgM(fp.room_outline || []) + all.map(fpMiniTable).join('')}</div>`;
  return `<div class="row-between" style="margin-bottom:.2rem"><div><span class="badge ok">${sm.available} available</span> <span class="badge ${sm.occupied ? 'blue' : 'gray'}">${sm.occupied} occupied</span> <span class="badge gray">${sm.tables} tables</span></div></div>${legend}${board}`;
}

function editHoursModal(loc) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hoursMap = {}; loc.hours.forEach(h => hoursMap[h.day_of_week] = h);
  const host = $('modalHost');
  host.innerHTML = `<div class="modal-bg"><div class="modal"><h3>Operating hours</h3><div class="err" id="mErr"></div>
    ${days.map((d, i) => { const h = hoursMap[i] || { open_time: '10:00', close_time: '22:00', is_closed: 0 }; return `<div class="hours-row"><span>${d}</span>
      <input type="time" data-open="${i}" value="${h.open_time || '10:00'}"><input type="time" data-close="${i}" value="${h.close_time || '22:00'}">
      <label><input type="checkbox" data-closed="${i}" ${h.is_closed ? 'checked' : ''}> Closed</label></div>`; }).join('')}
    <div class="actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">Save hours</button></div></div></div>`;
  const close = () => host.innerHTML = '';
  $('mCancel').onclick = close;
  host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
  $('mOk').onclick = async () => {
    const hours = days.map((d, i) => ({ day_of_week: i, open_time: host.querySelector(`[data-open="${i}"]`).value, close_time: host.querySelector(`[data-close="${i}"]`).value, is_closed: host.querySelector(`[data-closed="${i}"]`).checked ? 1 : 0 }));
    try { await api('/locations/' + loc.id + '/hours', { method: 'PUT', body: JSON.stringify({ hours }) }); toast('Hours updated'); close(); renderLocDetail(); }
    catch (e) { $('mErr').textContent = e.message; }
  };
}

async function renderLocStaff() {
  const staff = await api('/locations/' + S.locDetailId + '/staff');
  $('locBody').innerHTML = `
    <p class="sub" style="color:var(--muted);margin-top:0">Roster for this location. Add or reassign staff in the Staff section.</p>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Code</th><th>Email</th><th>Access level</th><th>Status</th></tr></thead><tbody>
      ${staff.length ? staff.map(u => `<tr><td><strong>${esc(u.name)}</strong></td><td class="mono">${esc(u.employee_code || '—')}</td><td class="mono">${esc(u.email)}</td><td><span class="badge ${ROLE_CHIP[u.role] || 'gray'}">${esc(roleLabel(u.role))}</span></td><td>${u.is_active ? '<span class="badge ok">Active</span>' : '<span class="badge out">Inactive</span>'}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">No staff assigned to this location yet.</td></tr>'}
    </tbody></table></div>`;
}

// ── Weekly schedule (per location) ───────────────────────────────────────────
// Local-date ISO — toISOString() would shift the date west of UTC (e.g. Pacific).
function fmtLocalIso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function mondayOf(dateStr) { const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date(); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return fmtLocalIso(d); }
function addDaysIso(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return fmtLocalIso(d); }
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (iso) => { const d = new Date(iso + 'T00:00:00'); return `${MON[d.getMonth()]} ${d.getDate()}`; };
const todayIso = () => fmtLocalIso(new Date());
// Overtime caps: max 8h/day, 40h/week (full-time). Over-cap shifts are flagged,
// not blocked — the scheduler approves an exception to keep them.
const DAILY_MAX = 8, WEEKLY_MAX = 40;
// Flag a heavy task load when assigned day-task minutes exceed this share of the
// person's worked time that day (they still have their main role to do).
const TASK_LOAD_RATIO = 0.5;
// { min, work, pct, heavy } for a day's assigned task load vs worked minutes.
const taskLoad = (shifts) => {
  const min = sumTaskMinutes(shifts);
  const work = Math.round(sumHours(shifts) * 60);
  const pct = work > 0 ? Math.round((min / work) * 100) : 0;
  return { min, work, pct, heavy: min > 0 && work > 0 && min > work * TASK_LOAD_RATIO };
};
function minutesBetween(start, end) {
  if (!start || !end) return 0;
  const [h1, m1] = start.split(':').map(Number), [h2, m2] = end.split(':').map(Number);
  let mins = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (mins < 0) mins += 1440; // crosses midnight
  return mins;
}
const shiftHours = (start, end) => minutesBetween(start, end) / 60;
// Breaks are paid (10 min each) and do NOT reduce worked hours.
// A schedule entry is a work shift, or a leave entry (sick / vacation / on-leave).
const isLeaveShift = (s) => !!(s && s.kind && s.kind !== 'work');
const leaveHoursOf = (s) => s.leave_hours != null ? s.leave_hours : (s.all_day ? 8 : shiftHours(s.start_time, s.end_time));
const LEAVE_META = { sick: { label: 'Sick', icon: '🤒', chip: 'low' }, vacation: { label: 'Vacation', icon: '🏖️', chip: 'blue' }, leave: { label: 'On-leave', icon: '🗓️', chip: 'gold' } };
const shiftWorkedHours = (s) => isLeaveShift(s) ? 0 : shiftHours(s.start_time, s.end_time);
// Break rules: 10 min each; allowed once the shift is at least 3.5h (then as many
// as the manager needs, each within the shift).
const BREAK_MIN = 10;
const MIN_BREAK_HOURS = 3.5;
const DAY_BREAK_CAP = 2;      // max breaks per day…
const LONG_DAY_HOURS = 10;    // …unless the day totals more than this many worked hours
const breaksAllowed = (hours) => hours >= MIN_BREAK_HOURS;
const addMinutes = (t, m) => { if (!t) return ''; const [h, mm] = t.split(':').map(Number); let x = (h * 60 + mm + m) % 1440; if (x < 0) x += 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const sumHours = (shifts) => shifts.reduce((t, s) => t + shiftWorkedHours(s), 0);
const breakMinutes = (s) => (s.breaks || []).reduce((t, b) => t + minutesBetween(b.start_time, b.end_time), 0);
const sumBreakMinutes = (shifts) => shifts.reduce((t, s) => t + breakMinutes(s), 0);
// Total estimated minutes of the day tasks assigned to a person that day (deduped —
// the same task can appear on more than one of the day's shifts).
const sumTaskMinutes = (shifts) => {
  const seen = new Set(); let m = 0;
  shifts.forEach(s => (s.tasks || []).forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); m += (t.est_minutes || 0); } }));
  return m;
};
const fmtDur = (m) => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`;
const fmtH = (h) => (Math.round(h * 10) / 10).toString().replace(/\.0$/, '');
const fmtBreak = (b) => `${b.start_time || '—'}–${b.end_time || '—'}${b.label ? ' ' + b.label : ''}`;

async function renderLocSchedule() {
  const canEdit = ['owner', 'admin'].includes(S.user.role) || (S.user.role === 'manager' && String(S.user.location_id) === String(S.locDetailId));
  let data, jobs;
  try {
    [data, jobs] = await Promise.all([
      api('/schedule/week?location_id=' + S.locDetailId + (S.schedWeek ? '&week=' + S.schedWeek : '')),
      api('/schedule/jobs?active=1'),
    ]);
  } catch (e) { $('locBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  S.schedWeek = data.week_start;
  const days = data.days;
  const jobChip = (j) => `<span class="jchip ${COMPLEXITY_CHIP[j.complexity] || 'gray'}" data-tip="${esc(chipTip(j))}">${esc(j.code || j.name)}</span>`;

  const cell = (st, day) => {
    const dayShifts = st.shifts.filter(s => s.shift_date === day);
    const here = dayShifts.filter(s => String(s.location_id) === String(data.location.id));
    const away = dayShifts.filter(s => String(s.location_id) !== String(data.location.id));
    const dayTotal = sumHours(dayShifts);
    const brkLine = (s) => (s.breaks && s.breaks.length)
      ? `<div class="shift-breaks">${s.breaks.map(b => `<span class="brk-chip" title="Break">☕ ${esc(fmtBreak(b))}</span>`).join('')}</div>` : '';
    const taskLine = (s) => (s.tasks && s.tasks.length)
      ? `<div class="shift-tasks">${s.tasks.map(t => `<span class="task-chip${t.done ? ' done' : ''}" data-tip="${esc(chipTip(t, t.task_time ? 'at ' + t.task_time : ''))}">📋 ${t.task_time ? esc(t.task_time) + ' ' : ''}${esc(t.code || t.name)}</span>`).join('')}</div>` : '';
    const hereCards = here.filter(s => !isLeaveShift(s)).map(s => `<div class="shift-card${canEdit ? ' editable' : ''}" data-shift="${s.id}">
        <div class="shift-time">${s.start_time || '—'}–${s.end_time || '—'} <span class="shift-h">${fmtH(shiftWorkedHours(s))}h</span></div>
        <div class="shift-jobs">${s.jobs.map(jobChip).join('') || '<span class="jchip gray">no jobs</span>'}</div>
        ${taskLine(s)}${brkLine(s)}
      </div>`).join('');
    const leaveCards = here.filter(isLeaveShift).map(s => {
      const m = LEAVE_META[s.kind] || { label: s.kind, icon: '', chip: 'gray' };
      const dur = s.all_day ? 'all day' : `${fmtH(leaveHoursOf(s))}h${s.start_time ? ` · ${s.start_time}–${s.end_time}` : ''}`;
      return `<div class="leave-card ${m.chip}${canEdit ? ' editable' : ''}" data-shift="${s.id}" title="${esc(m.label)} — ${dur}">${m.icon} <b>${esc(m.label)}</b> <span class="leave-dur">${dur}</span></div>`;
    }).join('');
    const awayCards = away.map(s => `<div class="shift-card away" title="Scheduled at ${esc(shortLoc(s.location_name))}">
        <div class="shift-time">${s.start_time || '—'}–${s.end_time || '—'} <span class="shift-h">${fmtH(shiftWorkedHours(s))}h</span></div>
        <div class="shift-away-loc">@ ${esc(shortLoc(s.location_name))}</div>
      </div>`).join('');
    const dayBreak = sumBreakMinutes(dayShifts);
    const load = taskLoad(dayShifts);
    const taskChip = load.min ? ` <span class="day-tasks-sum${load.heavy ? ' heavy' : ''}" title="${load.heavy ? '⚠ Heavy task load: ' : 'Est. day-task time: '}${fmtDur(load.min)} of tasks on ${fmtH(dayTotal)}h (${load.pct}% of the shift)">${load.heavy ? '⚠ ' : ''}📋 ${fmtDur(load.min)}</span>` : '';
    const total = dayShifts.length ? `<div class="day-total${dayTotal > DAILY_MAX ? ' over' : ''}">${dayTotal > DAILY_MAX ? '⚠ ' : ''}Σ ${fmtH(dayTotal)}h${dayBreak ? ` <span class="day-break">☕ ${dayBreak}m</span>` : ''}${taskChip}</div>` : '';
    const add = canEdit ? `<button class="shift-add" data-add="${st.id}" data-day="${day}" title="Add shift">+</button>` : '';
    return `<td class="sched-cell${dayTotal > DAILY_MAX ? ' cell-over' : ''}">${hereCards}${leaveCards}${awayCards}${total}${add}</td>`;
  };
  const weekBadge = (st) => {
    const h = sumHours(st.shifts);
    if (!h) return '<span class="hours-none">—</span>';
    return h > WEEKLY_MAX ? `<span class="badge out" title="Over the ${WEEKLY_MAX}h full-time limit">${fmtH(h)}h ⚠</span>`
      : `<span class="badge ${h === WEEKLY_MAX ? 'blue' : 'ok'}">${fmtH(h)}h</span>`;
  };

  $('locBody').innerHTML = `
    <div class="row-between sched-head">
      <div class="week-nav">
        <button class="btn sm ghost" id="wkPrev">‹ Prev</button>
        <button class="btn sm ghost" id="wkToday">This week</button>
        <button class="btn sm ghost" id="wkNext">Next ›</button>
      </div>
      <div class="week-label">Week of <strong>${fmtDay(days[0])}</strong> – <strong>${fmtDay(days[6])}</strong>, ${days[6].slice(0, 4)}</div>
      ${canEdit ? '' : '<span class="badge gray">View only</span>'}
    </div>
    <div class="table-wrap"><table class="sched-table"><thead><tr>
      <th class="sched-name">Staff</th>
      ${days.map((d, i) => `<th class="${d === (data.today || todayIso()) ? 'is-today' : ''}">${WD[i]}<div class="sched-date">${fmtDay(d)}</div></th>`).join('')}
      <th class="sched-week">Week<div class="sched-date">/ ${WEEKLY_MAX}h</div></th>
    </tr></thead><tbody>
      ${data.staff.length ? data.staff.map(st => `<tr>
        <td class="sched-name"><strong>${esc(st.name)}</strong> <span class="badge ${ROLE_CHIP[st.role] || 'gray'}">${esc(st.role)}</span>
          ${String(st.home_location_id) === String(data.location.id) ? '' : '<span class="badge blue" title="Home location is elsewhere">visiting</span>'}</td>
        ${days.map(d => cell(st, d)).join('')}
        <td class="sched-week">${weekBadge(st)}</td>
      </tr>`).join('') : `<tr><td colspan="9" class="empty">No staff assigned to this location. Add or assign staff in the Staff section first.</td></tr>`}
    </tbody></table></div>
    <p class="sub" style="color:var(--muted);margin-top:.6rem;font-size:.8rem">Complexity: <span class="badge ok">low</span> <span class="badge blue">medium</span> <span class="badge low">high</span>. Limits: <strong>${DAILY_MAX}h/day</strong>, <strong>${WEEKLY_MAX}h/week</strong> — over-limit shifts are flagged ⚠ (approve an exception when editing). Click a shift to edit; use + to add.</p>`;

  $('wkPrev').onclick = () => { S.schedWeek = addDaysIso(data.week_start, -7); renderLocSchedule(); };
  $('wkNext').onclick = () => { S.schedWeek = addDaysIso(data.week_start, 7); renderLocSchedule(); };
  $('wkToday').onclick = () => { S.schedWeek = mondayOf(null); renderLocSchedule(); };
  if (canEdit) {
    $('locBody').querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
      const st = data.staff.find(x => x.id == b.dataset.add);
      shiftModal(st, b.dataset.day, null, jobs, data.location);
    });
    $('locBody').querySelectorAll('[data-shift]').forEach(c => c.onclick = () => {
      let shift, st;
      for (const s of data.staff) { const f = s.shifts.find(x => x.id == c.dataset.shift); if (f) { shift = f; st = s; break; } }
      if (shift) shiftModal(st, shift.shift_date, shift, jobs, data.location);
    });
  }
}

function shiftModal(staff, dayIso, shift, jobs, location) {
  const isNew = !shift;
  const chosen = new Set((shift && shift.jobs ? shift.jobs : []).map(j => String(j.id)));
  const byDept = {}; jobs.forEach(j => { (byDept[j.department || 'Other'] = byDept[j.department || 'Other'] || []).push(j); });
  const depts = Object.keys(byDept).sort((a, b) => JOB_DEPTS.indexOf(a) - JOB_DEPTS.indexOf(b));
  const wd = WD[(new Date(dayIso + 'T00:00:00').getDay() + 6) % 7];
  const host = $('modalHost');
  host.innerHTML = `<div class="modal-bg"><div class="modal modal-wide"><h3>Schedule — ${esc(staff.name)}</h3>
    <p class="sub" style="color:var(--muted);margin:.1rem 0 .6rem">${wd} ${fmtDay(dayIso)} · ${esc(shortLoc(location.name))}</p>
    <div class="err" id="mErr"></div>
    <div class="form-grid"><label style="grid-column:1/-1">Type<select id="s_kind">
        <option value="work">Work shift</option>
        <option value="sick">🤒 Sick</option>
        <option value="vacation">🏖️ Vacation</option>
        <option value="leave">🗓️ On-leave</option>
      </select></label></div>
    <div class="form-grid" id="leaveDur" hidden>
      <label>Duration<select id="s_leave_mode">
        <option value="all_day">All day (8h)</option>
        <option value="hours">Number of hours</option>
        <option value="range">From – to</option>
      </select></label>
      <label id="leaveHoursWrap" hidden>Hours<input id="s_leave_hours" type="number" min="0.5" step="0.5" value="${esc(shift && shift.leave_hours != null ? shift.leave_hours : 8)}" /></label>
    </div>
    <div class="form-grid" id="timeRow">
      <label>Start<input id="s_start" type="time" value="${esc(shift && shift.start_time || '10:00')}" /></label>
      <label>End<input id="s_end" type="time" value="${esc(shift && shift.end_time || '18:00')}" /></label>
    </div>
    <div class="form-grid"><label style="grid-column:1/-1">Notes<input id="s_notes" value="${esc(shift && shift.notes || '')}" placeholder="Optional" /></label></div>
    <div id="workOnly">
    <div class="brk-head"><span class="job-pick-label" style="margin:0">Breaks <span style="color:var(--muted);font-weight:400">(10 min each, paid)</span></span>
      <button type="button" class="btn sm ghost" id="addBrk">+ Add break</button></div>
    <div id="brkHint" class="brk-hint"></div>
    <div id="brkList" class="brk-list"></div>
    <div class="job-pick-label">Assign jobs / tasks <span style="color:var(--muted);font-weight:400">(pick one or more)</span></div>
    <div class="job-pick">
      ${depts.map(d => `<div class="job-pick-dept"><div class="jpd-head">${esc(d)}</div>
        ${byDept[d].map(j => `<label class="chk jpick"><input type="checkbox" data-job="${j.id}" ${chosen.has(String(j.id)) ? 'checked' : ''}/>
          <span class="badge ${COMPLEXITY_CHIP[j.complexity] || 'gray'}">${esc(j.complexity || '')}</span> ${esc(j.name)}${j.code ? ` <span class="mono" style="color:var(--muted)">${esc(j.code)}</span>` : ''}</label>`).join('')}
      </div>`).join('')}
    </div>
    <div id="otWarn"></div>
    </div>
    <div class="actions">
      ${isNew ? '' : '<button class="btn ghost danger" id="mDelete" style="margin-right:auto">Delete shift</button>'}
      <button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">${isNew ? 'Add shift' : 'Save'}</button>
    </div>
  </div></div>`;
  const close = () => host.innerHTML = '';
  $('mCancel').onclick = close;
  host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
  if (!isNew) $('mDelete').onclick = () => {
    modal('Delete this entry?', [], async () => { await api('/schedule/shifts/' + shift.id, { method: 'DELETE' }); toast('Removed'); renderLocSchedule(); }, 'Delete');
  };

  // Toggle work-shift vs leave (sick / vacation / on-leave) and its duration mode.
  // Use style.display (not the hidden attribute) — .form-grid's display:grid would
  // otherwise override [hidden].
  const showEl = (id, on) => { const e = $(id); if (e) e.style.display = on ? '' : 'none'; };
  const applyType = () => {
    const leave = $('s_kind').value !== 'work';
    const mode = $('s_leave_mode').value;
    showEl('leaveDur', leave);
    showEl('workOnly', !leave);
    showEl('timeRow', !leave || mode === 'range');   // shown for work, or from–to leave
    showEl('leaveHoursWrap', leave && mode === 'hours');
    $('mOk').textContent = isNew ? (leave ? 'Add' : 'Add shift') : 'Save';
  };
  $('s_kind').value = (shift && shift.kind) || 'work';
  $('s_leave_mode').value = shift && isLeaveShift(shift) ? (shift.all_day ? 'all_day' : (shift.start_time ? 'range' : 'hours')) : 'all_day';
  $('s_kind').onchange = applyType; $('s_leave_mode').onchange = applyType;
  applyType();

  // Live overtime check — 8h/day and 40h/week, across every location the person works.
  const curId = shift ? shift.id : null;
  const otherDay = staff.shifts.filter(s => s.shift_date === dayIso && s.id !== curId);
  const otherWeek = staff.shifts.filter(s => s.id !== curId);
  // Breaks: manager sets only the start; each break is a fixed 10 minutes.
  const collectBreaks = () => [...host.querySelectorAll('[data-brk]')]
    .map(r => ({ start_time: r.querySelector('.brk-start').value, label: r.querySelector('.brk-label').value.trim() }))
    .filter(b => b.start_time);
  let over = false;
  const recompute = () => {
    const proposed = shiftHours($('s_start').value, $('s_end').value); // breaks don't reduce hours
    const day = sumHours(otherDay) + proposed, week = sumHours(otherWeek) + proposed;
    const msgs = [];
    if (day > DAILY_MAX) msgs.push(`This day totals <strong>${fmtH(day)}h</strong> — over the ${DAILY_MAX}h daily limit.`);
    if (week > WEEKLY_MAX) msgs.push(`This week totals <strong>${fmtH(week)}h</strong> — over the ${WEEKLY_MAX}h full-time limit.`);
    over = msgs.length > 0;
    $('otWarn').innerHTML = over
      ? `<div class="ot-banner">⚠ ${msgs.join('<br>')}<label class="chk ot-ack"><input type="checkbox" id="s_ot"> Approve overtime exception</label></div>`
      : '';
    // Breaks unlock at 3.5h; then max 2 per DAY (across the person's shifts that
    // day) unless the day totals more than 10h worked.
    const hrs = proposed;
    const otherDayBreaks = otherDay.reduce((n, s) => n + (s.breaks ? s.breaks.length : 0), 0);
    const dayHours = sumHours(otherDay) + hrs;
    const dayCap = dayHours > LONG_DAY_HOURS ? Infinity : DAY_BREAK_CAP;
    const count = host.querySelectorAll('[data-brk]').length;
    const totalDay = otherDayBreaks + count;
    const gateOk = hrs >= MIN_BREAK_HOURS;
    $('addBrk').disabled = !gateOk || totalDay >= dayCap;
    $('brkHint').textContent = !gateOk
      ? 'A break can be added once the shift is at least 3.5 hours.'
      : dayCap === Infinity
        ? `${totalDay} break${totalDay === 1 ? '' : 's'} today (10 min each) — over 10h/day, no limit.`
        : `${totalDay}/${DAY_BREAK_CAP} breaks today${otherDayBreaks ? ` (${otherDayBreaks} on another shift)` : ''} — max ${DAY_BREAK_CAP}/day unless over 10h.`;
    // Break start must stay inside the shift, leaving room for the 10-min break.
    host.querySelectorAll('.brk-start').forEach(i => { i.min = $('s_start').value || ''; i.max = addMinutes($('s_end').value, -BREAK_MIN) || ''; });
    host.querySelectorAll('.brk-end-label').forEach(sp => { const st = sp.closest('[data-brk]').querySelector('.brk-start').value; sp.textContent = st ? addMinutes(st, BREAK_MIN) : '—'; });
  };
  // Break rows — start time + optional label; end is start + 10 min (shown, not set).
  const addBreakRow = (b = {}) => {
    const row = document.createElement('div');
    row.className = 'brk-row'; row.dataset.brk = '1';
    row.innerHTML = `<input type="time" class="brk-start" value="${esc(b.start_time || '')}"/><span class="brk-auto">→ <span class="brk-end-label">—</span> · 10 min</span><input class="brk-label" placeholder="Label (optional)" value="${esc(b.label || '')}"/><button type="button" class="brk-del" title="Remove break">✕</button>`;
    row.querySelector('.brk-del').onclick = () => { row.remove(); recompute(); };
    row.querySelectorAll('input').forEach(i => i.oninput = recompute);
    $('brkList').appendChild(row);
    recompute();
  };
  (shift && shift.breaks || []).forEach(addBreakRow);
  $('addBrk').onclick = () => addBreakRow();
  $('s_start').oninput = recompute; $('s_end').oninput = recompute;
  recompute();

  $('mOk').onclick = async () => {
    // Leave entry (sick / vacation / on-leave): all day, N hours, or a from–to span.
    const kind = $('s_kind').value;
    if (kind !== 'work') {
      const mode = $('s_leave_mode').value;
      const body = { user_id: staff.id, location_id: location.id, shift_date: dayIso, kind, notes: $('s_notes').value };
      if (mode === 'all_day') body.all_day = 1;
      else if (mode === 'hours') { const n = parseFloat($('s_leave_hours').value); if (!(n > 0)) { $('mErr').textContent = 'Enter the number of leave hours.'; return; } body.leave_hours = n; }
      else { body.start_time = $('s_start').value; body.end_time = $('s_end').value; if (!body.start_time || !body.end_time) { $('mErr').textContent = 'Enter a from and a to time.'; return; } }
      try {
        if (isNew) await api('/schedule/shifts', { method: 'POST', body: JSON.stringify(body) });
        else await api('/schedule/shifts/' + shift.id, { method: 'PUT', body: JSON.stringify(body) });
        toast(isNew ? 'Leave added' : 'Leave saved'); close(); renderLocSchedule();
      } catch (e) { $('mErr').textContent = e.message; }
      return;
    }
    if (over && !($('s_ot') && $('s_ot').checked)) { $('mErr').textContent = 'Over the hour limit — tick “Approve overtime exception” to schedule anyway.'; return; }
    const job_ids = [...host.querySelectorAll('[data-job]:checked')].map(c => parseInt(c.dataset.job, 10));
    const s0 = $('s_start').value, s1 = $('s_end').value;
    const hrsSave = shiftHours(s0, s1);
    const otherDayBreaksSave = otherDay.reduce((n, s) => n + (s.breaks ? s.breaks.length : 0), 0);
    const dayCapSave = (sumHours(otherDay) + hrsSave) > LONG_DAY_HOURS ? Infinity : Math.max(0, DAY_BREAK_CAP - otherDayBreaksSave);
    let breaks = breaksAllowed(hrsSave) ? collectBreaks().slice(0, dayCapSave) : [];
    // Each 10-min break must fit inside the shift.
    const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    if (s0 && s1) {
      const st = toMin(s0), en = toMin(s1), crosses = en <= st;
      for (const b of breaks) {
        const bs = toMin(b.start_time);
        if (!crosses && (bs < st || bs + BREAK_MIN > en)) { $('mErr').textContent = `A break at ${b.start_time} must fit inside the shift (${s0}–${s1}).`; return; }
      }
    }
    const body = { user_id: staff.id, location_id: location.id, shift_date: dayIso, start_time: $('s_start').value, end_time: $('s_end').value, notes: $('s_notes').value, job_ids, breaks };
    try {
      if (isNew) await api('/schedule/shifts', { method: 'POST', body: JSON.stringify(body) });
      else await api('/schedule/shifts/' + shift.id, { method: 'PUT', body: JSON.stringify(body) });
      toast(isNew ? 'Shift added' : 'Shift saved'); close(); renderLocSchedule();
    } catch (e) { $('mErr').textContent = e.message; }
  };
}

// ── Day Tasks — assign specific tasks to the day's working staff ─────────────
async function renderLocDayTasks() {
  const canEdit = ['owner', 'admin'].includes(S.user.role) || (S.user.role === 'manager' && String(S.user.location_id) === String(S.locDetailId));
  let data;
  // No stored date → let the server default to the location's local "today".
  try { data = await api('/schedule/day-tasks?location_id=' + S.locDetailId + (S.dayTaskDate ? '&date=' + S.dayTaskDate : '')); }
  catch (e) { $('locBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  S.dayTaskDate = data.date;
  const wd = WD[(new Date(data.date + 'T00:00:00').getDay() + 6) % 7];
  const cx = (c) => `<span class="badge ${COMPLEXITY_CHIP[c] || 'gray'}">${esc(c || '')}</span>`;
  const hoursById = {}; data.working.forEach(w => { hoursById[w.id] = w; });
  const opts = (sel) => `<option value="">— unassigned —</option>` + data.working.map(w => `<option value="${w.id}" ${String(w.id) === String(sel) ? 'selected' : ''}>${esc(w.name)} · ${esc(w.start_time)}–${esc(w.end_time)}</option>`).join('');
  // Slot picker: 15-min starts within the assignee's hours, minus breaks and other tasks they already have.
  const SLOT = 15;
  const tm = (s) => (+s.slice(0, 2)) * 60 + (+s.slice(3, 5));
  const mf = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const f12 = (m) => { const h = Math.floor(m / 60), mm = m % 60, ap = h < 12 ? 'AM' : 'PM'; const hh = (h % 12) || 12; return `${hh}:${String(mm).padStart(2, '0')} ${ap}`; };
  const effDur = (est) => Math.max(SLOT, Math.ceil((Number(est) || 0) / SLOT) * SLOT);
  const clash = (a, b, c, d) => a < d && c < b;
  const slotOptions = (t, w) => {
    const dur = effDur(t.est_minutes);
    const breaks = (w.breaks || []).map(b => [tm(b.start_time), tm(b.end_time)]);
    const others = data.tasks.filter(x => x.user_id === t.user_id && x.job_id !== t.job_id && x.task_time)
      .map(x => [tm(x.task_time), tm(x.task_time) + effDur(x.est_minutes)]);
    const out = [];
    (w.hours && w.hours.length ? w.hours : [{ start_time: w.start_time, end_time: w.end_time }]).forEach(span => {
      const sEnd = tm(span.end_time);
      for (let s = tm(span.start_time); s + dur <= sEnd; s += SLOT) {
        const e = s + dur;
        if (breaks.some(([bs, be]) => clash(s, e, bs, be))) continue;
        if (others.some(([os, oe]) => clash(s, e, os, oe))) continue;
        out.push(mf(s));
      }
    });
    return out;
  };
  const whenCell = (t) => {
    if (!canEdit) return t.task_time ? `<strong>${esc(t.task_time)}</strong>` : '<span style="color:var(--muted)">—</span>';
    if (!t.user_id) return '<span style="color:var(--muted)" title="Assign someone first">—</span>';
    const w = hoursById[t.user_id];
    const slots = w ? slotOptions(t, w) : [];
    const cur = t.task_time || '';
    const options = `<option value="">— time —</option>`
      + slots.map(s => `<option value="${s}" ${s === cur ? 'selected' : ''}>${f12(tm(s))}</option>`).join('')
      + (cur && !slots.includes(cur) ? `<option value="${cur}" selected>${f12(tm(cur))} ⚠</option>` : '');
    const brk = w && w.breaks && w.breaks.length ? ` · excl. break ${w.breaks.map(b => `${esc(b.start_time)}–${esc(b.end_time)}`).join(', ')}` : '';
    const note = slots.length ? `within ${esc(w.start_time)}–${esc(w.end_time)}${brk}` : 'no free slots — all taken';
    return `<select data-time="${t.job_id}" style="margin:0;padding:.4rem .5rem;max-width:160px">${options}</select><div class="job-note">${note}</div>`;
  };
  const rows = data.tasks.map(t => `<tr class="${t.user_id ? '' : 'task-unassigned'}">
    <td><strong>${esc(t.name)}</strong>${t.code ? ` <span class="mono" style="color:var(--muted);font-size:.8rem">${esc(t.code)}</span>` : ''}${t.description ? `<div class="job-note">${esc(t.description)}</div>` : ''}</td>
    <td>${esc(t.department || '')} ${cx(t.complexity)}</td>
    <td style="white-space:nowrap;color:var(--muted)">${t.est_minutes ? `~${t.est_minutes} min` : '—'}</td>
    <td>${canEdit && data.working.length ? `<select data-assign="${t.job_id}" style="margin:0;padding:.4rem .5rem;max-width:220px">${opts(t.user_id)}</select>` : (t.assignee_name ? `<strong>${esc(t.assignee_name)}</strong>` : '<span class="badge low">unassigned</span>')}</td>
    <td>${whenCell(t)}</td>
    <td>${canEdit ? `<label class="chk"><input type="checkbox" data-done="${t.job_id}" ${t.done ? 'checked' : ''}/> done</label>` : (t.done ? '<span class="badge ok">done</span>' : '—')}</td>
    <td>${t.assignment_id && (t.photo_count || t.comment_count) ? `<button type="button" class="btn sm ghost dt-photos" data-photos="${t.assignment_id}" data-taskname="${esc(t.name)}" title="View proof photos & comments">${t.photo_count ? `📷 ${t.photo_count}` : ''}${t.photo_count && t.comment_count ? ' · ' : ''}${t.comment_count ? `💬 ${t.comment_count}` : ''}</button>` : (t.assignment_id ? '<button type="button" class="btn sm ghost dt-photos" data-photos="' + t.assignment_id + '" data-taskname="' + esc(t.name) + '" title="Add a comment">💬 +</button>' : '<span style="color:var(--muted)">—</span>')}</td>
  </tr>`).join('');
  $('locBody').innerHTML = `
    <div class="row-between sched-head">
      <div class="week-nav"><button class="btn sm ghost" id="dtPrev">‹ Prev</button><button class="btn sm ghost" id="dtToday">Today</button><button class="btn sm ghost" id="dtNext">Next ›</button></div>
      <div class="week-label">${wd} <strong>${fmtDay(data.date)}</strong>, ${data.date.slice(0, 4)}</div>
      <div style="display:flex;gap:.5rem;align-items:center">
        <span class="badge ${data.summary.unassigned ? 'out' : 'ok'}">${data.summary.assigned}/${data.summary.total} assigned</span>
        ${canEdit ? `<button class="btn sm ghost" id="dtManage">⚙ Manage list</button>` : ''}
      </div>
    </div>
    <p class="sub" style="color:var(--muted);margin:0 0 .8rem">Assign each specific task to someone working today so nothing's left behind. ${data.working.length ? `<strong>${data.working.length}</strong> scheduled today.` : '<strong style="color:var(--red)">Nobody is scheduled today — add shifts on the Schedule tab first.</strong>'}</p>
    <div class="table-wrap"><table><thead><tr><th>Task</th><th>Dept</th><th>Est.</th><th>Assigned to</th><th>When</th><th>Status</th><th>Proof</th></tr></thead><tbody>
      ${data.tasks.length ? rows : `<tr><td colspan="7" class="empty">No tasks on this location's list yet.${canEdit ? ' Click <strong>⚙ Manage list</strong> to add some.' : ''}</td></tr>`}
    </tbody></table></div>`;
  const go = (iso) => { S.dayTaskDate = iso; renderLocDayTasks(); };
  $('dtPrev').onclick = () => go(addDaysIso(data.date, -1));
  $('dtNext').onclick = () => go(addDaysIso(data.date, 1));
  $('dtToday').onclick = () => go(data.today || fmtLocalIso(new Date()));
  $('locBody').querySelectorAll('.dt-photos').forEach(b => b.onclick = () => openTaskPhotoGallery(b.dataset.photos, b.dataset.taskname));
  if (canEdit) {
    if ($('dtManage')) $('dtManage').onclick = () => openLocTaskListModal(S.locDetailId, data.location.name);
    $('locBody').querySelectorAll('[data-assign]').forEach(sel => sel.onchange = async () => {
      try { await api('/schedule/day-tasks', { method: 'PUT', body: JSON.stringify({ location_id: S.locDetailId, date: data.date, job_id: sel.dataset.assign, user_id: sel.value || null }) }); toast('Task assigned'); renderLocDayTasks(); }
      catch (e) { toast(e.message, true); renderLocDayTasks(); }
    });
    $('locBody').querySelectorAll('[data-time]').forEach(inp => inp.onchange = async () => {
      try { await api('/schedule/day-tasks', { method: 'PUT', body: JSON.stringify({ location_id: S.locDetailId, date: data.date, job_id: inp.dataset.time, time: inp.value || null }) }); toast(inp.value ? 'Time set' : 'Time cleared'); renderLocDayTasks(); }
      catch (e) { toast(e.message, true); renderLocDayTasks(); }
    });
    $('locBody').querySelectorAll('[data-done]').forEach(cb => cb.onchange = async () => {
      try { await api('/schedule/day-tasks', { method: 'PUT', body: JSON.stringify({ location_id: S.locDetailId, date: data.date, job_id: cb.dataset.done, done: cb.checked }) }); renderLocDayTasks(); }
      catch (e) { toast(e.message, true); renderLocDayTasks(); }
    });
  }
}

// Manager view of a day task: its proof photos (loaded with the session token, as
// they're private) plus the comment/feedback thread, where a manager can reply.
async function openTaskPhotoGallery(assignmentId, taskName) {
  const host = $('modalHost');
  const urls = [];
  const cleanup = () => { while (urls.length) URL.revokeObjectURL(urls.pop()); };
  const close = () => { cleanup(); host.innerHTML = ''; };
  const fmt = (iso) => { if (!iso) return ''; const d = new Date(iso.replace(' ', 'T') + 'Z'); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  host.innerHTML = `<div class="modal-bg"><div class="modal photo-gallery">
    <div class="row-between"><h3 style="margin:0">Proof &amp; comments <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${esc(taskName || 'task')}</span></h3>
      <button class="btn sm ghost" id="pgClose">Close</button></div>
    <h4 class="pg-sec">📷 Proof photos</h4>
    <div class="pg-grid" id="pgGrid"><div class="empty">Loading…</div></div>
    <h4 class="pg-sec">💬 Comments &amp; feedback</h4>
    <div id="pgComments"><div class="empty">Loading…</div></div>
    <div class="pg-cadd"><input type="text" id="pgCin" maxlength="1000" placeholder="Add feedback for the staff member…"><button class="btn sm" id="pgCadd">Comment</button></div>
  </div></div>`;
  host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
  $('pgClose').onclick = close;

  // Photos
  try {
    const data = await api(`/stafftasks/${assignmentId}/photos`);
    if (!data.photos.length) { $('pgGrid').innerHTML = '<div class="empty">No photos.</div>'; }
    else {
      $('pgGrid').innerHTML = data.photos.map(p => `<figure class="pg-item">
        <div class="pg-img-wrap"><img alt="Proof photo" data-load="${p.id}"></div>
        <figcaption>${esc(p.uploaded_by_name || 'Staff')}<span>${esc(fmt(p.uploaded_at))}</span></figcaption>
      </figure>`).join('');
      for (const p of data.photos) {
        try {
          const res = await fetch(`/api/stafftasks/${assignmentId}/photo/${p.id}`, { headers: S.token ? { Authorization: 'Bearer ' + S.token } : {} });
          if (!res.ok) continue;
          const url = URL.createObjectURL(await res.blob()); urls.push(url);
          const img = $('pgGrid').querySelector(`img[data-load="${p.id}"]`);
          if (img) { img.src = url; img.onclick = () => pgLightbox(url); }
        } catch { /* one thumbnail failing shouldn't break the grid */ }
      }
    }
  } catch (e) { $('pgGrid').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }

  // Comments
  const loadComments = async () => {
    let d;
    try { d = await api(`/stafftasks/${assignmentId}/comments`); }
    catch (e) { $('pgComments').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    $('pgComments').innerHTML = d.comments.length ? d.comments.map(c => `<div class="pg-cm">
      <div class="pg-cm-head"><strong>${esc(c.author_name || 'Staff')}</strong>${c.author_role ? ` <span class="badge ${ROLE_CHIP[c.author_role] || 'gray'}">${esc(roleLabel(c.author_role))}</span>` : ''}<span class="pg-cm-time">${esc(fmt(c.created_at))}</span><button class="pg-cm-rm" data-rmc="${c.id}" title="Remove">✕</button></div>
      <div class="pg-cm-body">${esc(c.body)}</div></div>`).join('') : '<div class="empty">No comments yet.</div>';
    $('pgComments').querySelectorAll('[data-rmc]').forEach(b => b.onclick = async () => {
      try { await api(`/stafftasks/${assignmentId}/comment/${b.dataset.rmc}`, { method: 'DELETE' }); loadComments(); }
      catch (e) { toast(e.message, true); }
    });
  };
  await loadComments();
  const addComment = async () => {
    const body = ($('pgCin').value || '').trim();
    if (!body) { toast('Write a comment first.', true); return; }
    try { await api(`/stafftasks/${assignmentId}/comment`, { method: 'POST', body: JSON.stringify({ body }) }); $('pgCin').value = ''; toast('Comment added'); loadComments(); }
    catch (e) { toast(e.message, true); }
  };
  $('pgCadd').onclick = addComment;
  $('pgCin').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addComment(); } };
}
// Full-screen view of a single proof photo (tap anywhere to dismiss).
function pgLightbox(src) {
  const o = document.createElement('div'); o.className = 'pg-lightbox';
  const img = document.createElement('img'); img.src = src; img.alt = 'Proof photo';
  o.appendChild(img); o.onclick = () => o.remove(); document.body.appendChild(o);
}

// Manage which specific tasks apply at this location (per-location task list).
async function openLocTaskListModal(locId, locName) {
  const host = $('modalHost');
  const close = () => { host.innerHTML = ''; renderLocDayTasks(); };
  const draw = async () => {
    const data = await api('/schedule/location-tasks?location_id=' + locId);
    const cx = (c) => `<span class="badge ${COMPLEXITY_CHIP[c] || 'gray'}">${esc(c || '')}</span>`;
    const rows = data.catalog.map(t => `<tr>
      <td><label class="chk" style="align-items:flex-start"><input type="checkbox" data-lt="${t.job_id}" ${t.enabled ? 'checked' : ''}/>
        <span><strong>${esc(t.name)}</strong>${t.code ? ` <span class="mono" style="color:var(--muted);font-size:.75rem">${esc(t.code)}</span>` : ''}${t.description ? `<div class="job-note">${esc(t.description)}</div>` : ''}</span></label></td>
      <td style="white-space:nowrap">${esc(t.department || '')} ${cx(t.complexity)}</td>
      <td style="white-space:nowrap;color:var(--muted)">${t.est_minutes ? `~${t.est_minutes} min` : ''}</td>
    </tr>`).join('');
    host.innerHTML = `<div class="modal-bg"><div class="modal" style="max-width:640px">
      <h3>Task list — ${esc(locName || data.location.name)}</h3>
      <p class="sub" style="color:var(--muted);margin:.2rem 0 .8rem">Check the specific tasks that apply here. <strong id="ltCount">${data.enabled}</strong> on this location's list.</p>
      <div class="table-wrap" style="max-height:46vh;overflow:auto"><table><thead><tr><th>Task</th><th>Dept</th><th>Est.</th></tr></thead><tbody>${rows}</tbody></table></div>
      <details style="margin-top:.8rem"><summary style="cursor:pointer;font-weight:600">+ Add a new task to the catalog</summary>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-top:.6rem">
          <label style="grid-column:1/3">Name<input id="ntName" placeholder="e.g. Water the patio plants"/></label>
          <label>Department<select id="ntDept"><option>Front of House</option><option>Back of House</option><option>Facilities</option><option>Packaging</option><option>Logistics</option><option>Management</option></select></label>
          <label>Complexity<select id="ntCx"><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
          <label>Est. minutes *<input id="ntEst" type="number" min="1" step="5" placeholder="required"/></label>
          <label>Code (optional)<input id="ntCode" placeholder="auto if blank"/></label>
        </div>
        <div class="err" id="ntErr"></div>
        <button class="btn sm" id="ntAdd" style="margin-top:.5rem">Add & enable here</button>
      </details>
      <div class="actions"><button class="btn" id="ltDone">Done</button></div>
    </div></div>`;
    $('ltDone').onclick = close;
    host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
    host.querySelectorAll('[data-lt]').forEach(cb => cb.onchange = async () => {
      try {
        await api('/schedule/location-tasks', { method: 'PUT', body: JSON.stringify({ location_id: locId, job_id: cb.dataset.lt, enabled: cb.checked }) });
        const n = host.querySelectorAll('[data-lt]:checked').length; $('ltCount').textContent = n;
      } catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
    });
    $('ntAdd').onclick = async () => {
      $('ntErr').textContent = '';
      const name = $('ntName').value.trim();
      if (!name) { $('ntErr').textContent = 'Name is required.'; return; }
      const est = parseInt($('ntEst').value, 10);
      if (!Number.isFinite(est) || est <= 0) { $('ntErr').textContent = 'Estimated minutes is required (a positive number).'; return; }
      const code = $('ntCode').value.trim() || ('TSK-' + Math.random().toString(36).slice(2, 6).toUpperCase());
      try {
        const job = await api('/schedule/jobs', { method: 'POST', body: JSON.stringify({ code, name, department: $('ntDept').value, complexity: $('ntCx').value, est_minutes: est, kind: 'specific' }) });
        await api('/schedule/location-tasks', { method: 'PUT', body: JSON.stringify({ location_id: locId, job_id: job.id, enabled: true }) });
        toast('Task added'); await draw();
      } catch (e) { $('ntErr').textContent = e.message; }
    };
  };
  await draw();
}

// ── Time Clock — check-in/out status for the location (manager/GM/owner) ──────
async function renderLocTimeClock() {
  const canManage = ['owner', 'admin'].includes(S.user.role) || (['manager', 'assistant_manager', 'kitchen_manager', 'general_manager', 'regional_manager'].includes(S.user.role));
  let data, alerts = { alerts: [] }, payroll = null;
  try {
    // No stored date → server defaults to the location's local "today".
    data = await api('/timeclock/board?location_id=' + S.locDetailId + (S.tcDate ? '&date=' + S.tcDate : ''));
    S.tcDate = data.date;
    if (data.date === data.today) alerts = await api('/timeclock/alerts?location_id=' + S.locDetailId).catch(() => ({ alerts: [] }));
    if (!S.payPeriod) S.payPeriod = 'weekly';
    if (!S.payAnchor) S.payAnchor = data.today;
    const pRange = payRange(S.payPeriod, S.payAnchor);
    payroll = await api(`/timeclock/payroll?location_id=${S.locDetailId}&start=${pRange.start}&end=${pRange.end}&kind=${S.payPeriod}`).catch(() => null);
  } catch (e) { $('locBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const wd = WD[(new Date(data.date + 'T00:00:00').getDay() + 6) % 7];
  const sm = data.summary;
  const statusChip = (r) => r.status === 'in' ? '<span class="badge ok">🟢 On clock</span>'
    : `<span class="badge gray">Checked out</span>${r.short ? ' <span class="badge out">⚠ short</span>' : ''}${r.overtime_minutes > 0 ? ` <span class="badge blue">+${fmtDur(r.overtime_minutes)} OT</span>` : ''}`;
  const entryRows = data.entries.map(r => `<tr>
    <td><strong>${esc(r.name)}</strong> <span class="mono" style="color:var(--muted);font-size:.75rem">${esc(r.employee_code || '')}</span></td>
    <td>${r.clock_in || '—'}</td><td>${r.clock_out || '—'}</td>
    <td>${r.scheduled_minutes ? fmtDur(r.scheduled_minutes) : '—'}</td>
    <td>${fmtDur(r.worked_minutes)}${r.status === 'in' ? ' <span style="color:var(--muted)">so far</span>' : ''}</td>
    <td>${statusChip(r)}</td></tr>`).join('');
  const notInRows = data.not_in.map(r => `<tr class="task-unassigned">
    <td><strong>${esc(r.name)}</strong> <span class="mono" style="color:var(--muted);font-size:.75rem">${esc(r.employee_code || '')}</span></td>
    <td>—</td><td>—</td><td>${fmtDur(r.scheduled_minutes)}</td><td>—</td>
    <td><span class="badge low">Not checked in</span></td></tr>`).join('');
  const alertCards = alerts.alerts.length ? `<div class="tc-alerts">${alerts.alerts.map(a => `
    <div class="tc-alert"><span>⚠ ${esc(a.message)}</span><button class="btn sm ghost" data-resolve="${a.id}">Resolve</button></div>`).join('')}</div>` : '';
  $('locBody').innerHTML = `
    <div class="row-between sched-head">
      <div class="week-nav"><button class="btn sm ghost" id="tcPrev">‹ Prev</button><button class="btn sm ghost" id="tcToday">Today</button><button class="btn sm ghost" id="tcNext">Next ›</button></div>
      <div class="week-label">${wd} <strong>${fmtDay(data.date)}</strong>, ${data.date.slice(0, 4)}</div>
      <a class="btn sm" href="/clock" target="_blank" rel="noopener">⏱ Open clock kiosk</a>
    </div>
    <div class="tc-summary">
      <span class="badge ok">${sm.on_clock} on the clock</span>
      <span class="badge gray">${sm.done} checked out</span>
      <span class="badge ${sm.not_in ? 'low' : 'gray'}">${sm.not_in} not in</span>
      ${sm.short ? `<span class="badge out">${sm.short} left early</span>` : ''}
      ${sm.overtime ? `<span class="badge blue">${sm.overtime} in overtime</span>` : ''}
    </div>
    ${alertCards}
    <div class="table-wrap"><table><thead><tr><th>Staff</th><th>Checked in</th><th>Checked out</th><th>Scheduled</th><th>Worked</th><th>Status</th></tr></thead><tbody>
      ${(entryRows + notInRows) || '<tr><td colspan="6" class="empty">No one scheduled or clocked in for this day.</td></tr>'}
    </tbody></table></div>
    <p class="sub" style="color:var(--muted);margin-top:.7rem;font-size:.8rem">Staff check in/out on the tablet kiosk (⏱). A short check-out raises an alert here for follow-up.</p>
    ${payrollSection(payroll)}`;
  const go = (iso) => { S.tcDate = iso; renderLocTimeClock(); };
  $('tcPrev').onclick = () => go(addDaysIso(data.date, -1));
  $('tcNext').onclick = () => go(addDaysIso(data.date, 1));
  $('tcToday').onclick = () => go(data.today || fmtLocalIso(new Date()));
  $('locBody').querySelectorAll('[data-resolve]').forEach(b => b.onclick = async () => {
    try { await api('/timeclock/alerts/' + b.dataset.resolve + '/resolve', { method: 'POST' }); toast('Alert resolved'); renderLocTimeClock(); }
    catch (e) { toast(e.message, true); }
  });
  if (payroll) {
    if ($('prCsv')) $('prCsv').onclick = () => exportPayrollCSV(payroll);
    $('locBody').querySelectorAll('[data-payperiod]').forEach(b => b.onclick = () => { S.payPeriod = b.dataset.payperiod; renderLocTimeClock(); });
    $('locBody').querySelectorAll('[data-paynav]').forEach(b => b.onclick = () => payNav(parseInt(b.dataset.paynav, 10)));
    const otDay = (i) => payroll.ot_days[i];
    const loc = S.locDetailId, per = payRange(S.payPeriod, S.payAnchor);
    const q = (sel, fn) => $('locBody').querySelectorAll(sel).forEach(fn);
    q('[data-otappr]', b => b.onclick = () => openOtApproveModal(otDay(+b.dataset.otappr), payroll.can_edit_ot, loc, payroll.rules));
    q('[data-otrevoke]', b => b.onclick = async () => {
      const d = otDay(+b.dataset.otrevoke);
      try { await api('/timeclock/ot-approval', { method: 'PUT', body: JSON.stringify({ location_id: loc, user_id: d.user_id, work_date: d.work_date, approved: false }) }); toast('Overtime approval revoked'); renderLocTimeClock(); }
      catch (e) { toast(e.message, true); }
    });
    q('[data-otreject]', b => b.onclick = () => otRejectModal(otDay(+b.dataset.otreject), loc));
    q('[data-otesc]', b => b.onclick = () => otEscalateModal(otDay(+b.dataset.otesc), loc));
    q('[data-adjust]', b => b.onclick = () => { const [uid, date, mins] = b.dataset.adjust.split('|'); adjustModal(+uid, date, +mins, loc); });
    q('[data-apprtotal]', b => b.onclick = async () => {
      try { await api('/timeclock/approve-total', { method: 'POST', body: JSON.stringify({ location_id: loc, user_id: +b.dataset.apprtotal, period_kind: S.payPeriod, period_start: per.start, period_end: per.end }) }); toast('Total hours approved'); renderLocTimeClock(); }
      catch (e) { toast(e.message, true); }
    });
    q('[data-undototal]', b => b.onclick = async () => {
      try { await api('/timeclock/approve-total/undo', { method: 'POST', body: JSON.stringify({ location_id: loc, user_id: +b.dataset.undototal, period_kind: S.payPeriod, period_start: per.start }) }); toast('Approval undone'); renderLocTimeClock(); }
      catch (e) { toast(e.message, true); }
    });
    q('[data-msg]', b => b.onclick = () => quickMessageModal(+b.dataset.msg, b.dataset.msgname));
  }
}

// Daily / weekly / monthly period → { start, end, label }.
function payRange(period, anchor) {
  const p2 = (n) => String(n).padStart(2, '0');
  if (period === 'daily') {
    return { start: anchor, end: anchor, label: `${WD[(new Date(anchor + 'T00:00:00').getDay() + 6) % 7]} ${fmtDay(anchor)}, ${anchor.slice(0, 4)}` };
  }
  if (period === 'monthly') {
    const d = new Date(anchor + 'T00:00:00');
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { start: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-01`, end: `${last.getFullYear()}-${p2(last.getMonth() + 1)}-${p2(last.getDate())}`, label: `${MON[d.getMonth()]} ${d.getFullYear()}` };
  }
  const start = mondayOf(anchor), end = addDaysIso(start, 6);
  return { start, end, label: `${fmtDay(start)} – ${fmtDay(end)}, ${end.slice(0, 4)}` };
}
function payNav(dir) {
  if (S.payPeriod === 'daily') S.payAnchor = addDaysIso(S.payAnchor, dir);
  else if (S.payPeriod === 'monthly') { const d = new Date(S.payAnchor + 'T00:00:00'); d.setMonth(d.getMonth() + dir); S.payAnchor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; }
  else S.payAnchor = addDaysIso(S.payAnchor, dir * 7);
  renderLocTimeClock();
}
function openOtApproveModal(d, canEdit, locId, rules) {
  if (!d) return;
  const fields = [{ key: 'note', label: `Approval note — ${d.name}, ${fmtDay(d.work_date)} (worked ${fmtDur(d.worked_minutes)})`, value: d.note || '', placeholder: 'e.g. Covered a late call-out — approved' }];
  if (canEdit) {
    fields.push({ key: 'ot_minutes', label: `Overtime minutes (${rules.ot_mult}× · worked ${d.computed_ot_minutes})`, type: 'number', value: d.ot_minutes });
    if (d.computed_dt_minutes > 0) fields.push({ key: 'dt_minutes', label: `Double-time minutes (${rules.dt_mult}× · worked ${d.computed_dt_minutes})`, type: 'number', value: d.dt_minutes });
  }
  modal(`Approve overtime`, fields, async (vals) => {
    const body = { location_id: locId, user_id: d.user_id, work_date: d.work_date, approved: true, note: vals.note };
    if (canEdit) { body.ot_minutes = vals.ot_minutes; if (vals.dt_minutes !== undefined) body.dt_minutes = vals.dt_minutes; }
    await api('/timeclock/ot-approval', { method: 'PUT', body: JSON.stringify(body) });
    toast('Overtime approved'); renderLocTimeClock();
  }, d.approved ? 'Save' : 'Approve');
}

function payrollSection(pr) {
  if (!pr) return '';
  const R = pr.rules, t = pr.totals;
  const period = S.payPeriod || 'weekly';
  const pill = (k, l) => `<button class="btn sm ${period === k ? '' : 'ghost'}" data-payperiod="${k}">${l}</button>`;
  const otc = (h, pend) => `${h ? `<strong style="color:#b4630b">${h}</strong>` : '0'}${pend ? ` <span class="badge out" title="pending approval">+${pend}?</span>` : ''}`;
  const lateCell = (s) => s.late_days ? `<span class="badge low" title="${fmtDur(s.late_minutes)} late total">${s.late_days}d</span>` : '—';
  const shortCell = (s) => s.short_days ? `<span class="badge out">${s.short_days}d</span>` : '—';
  const leaveCell = (s) => { const tot = Math.round(((s.sick_hours || 0) + (s.vacation_hours || 0) + (s.leave_hours || 0)) * 10) / 10; return tot ? `<span class="badge blue" title="Sick ${s.sick_hours || 0}h · Vacation ${s.vacation_hours || 0}h · On-leave ${s.leave_hours || 0}h">${tot}h</span>` : '—'; };
  const leaveTotal = Math.round((((t.sick_hours || 0) + (t.vacation_hours || 0) + (t.leave_hours || 0))) * 10) / 10;
  const rows = pr.staff.map(s => `<tr>
    <td><strong>${esc(s.name)}</strong> <span class="mono" style="color:var(--muted);font-size:.72rem">${esc(s.employee_code || '')}</span></td>
    <td class="num">${s.scheduled_hours}</td><td class="num">${s.total_hours}</td>
    <td>${lateCell(s)}</td><td>${shortCell(s)}</td>
    <td class="num">${otc(s.ot_hours, s.ot_pending_hours)}</td>
    <td class="num">${leaveCell(s)}</td>
    <td class="num">${s.gross_pay != null ? money(s.gross_pay) : '—'}</td>
    <td style="white-space:nowrap">${s.approved
      ? `<span class="badge ok" title="approved by ${esc(s.approved_by || '')}">✓</span> <button class="btn sm ghost" data-undototal="${s.user_id}">Undo</button>`
      : `<button class="btn sm" data-apprtotal="${s.user_id}">✓ Approve</button>`}
      <button class="btn sm ghost" data-msg="${s.user_id}" data-msgname="${esc(s.name)}" title="Message ${esc(s.name)}">✉</button></td>
  </tr>`).join('');
  // Flagged days to review (late / short / overtime).
  const flagged = [];
  pr.staff.forEach(s => (s.days || []).forEach(d => { if (d.late_min > 0 || d.short_min > 0 || d.ot_min > 0) flagged.push(Object.assign({ user_id: s.user_id, name: s.name }, d)); }));
  flagged.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const otMap = {}; pr.ot_days.forEach((o, i) => otMap[o.user_id + '|' + o.work_date] = i);
  const flagRows = flagged.map(d => {
    const flags = [
      d.late_min > 0 ? `<span class="badge low">${fmtDur(d.late_min)} late</span>` : '',
      d.short_min > 0 ? `<span class="badge out">${fmtDur(d.short_min)} short</span>` : '',
      d.ot_min > 0 ? `<span class="badge blue">${fmtDur(d.ot_min)} OT</span>` : '',
    ].filter(Boolean).join(' ');
    const i = otMap[d.user_id + '|' + d.date];
    let otAction = '';
    if (d.ot_min > 0) {
      if (d.ot_status === 'approved') otAction = `<span class="badge ok">✓ OT</span> <button class="btn sm ghost" data-otrevoke="${i}">Revoke</button>`;
      else if (d.ot_status === 'rejected') otAction = `<span class="badge gray">OT declined</span> <button class="btn sm" data-otappr="${i}">Approve</button>`;
      else if (d.ot_status === 'escalated') otAction = pr.is_leadership
        ? `<span class="badge low">escalated</span> <button class="btn sm" data-otappr="${i}">Approve</button> <button class="btn sm ghost" data-otreject="${i}">Reject</button>`
        : `<span class="badge low">escalated ⏳</span>`;
      else otAction = `<button class="btn sm" data-otappr="${i}">Approve</button> <button class="btn sm ghost" data-otreject="${i}">Reject</button>${pr.is_leadership ? '' : ` <button class="btn sm ghost" data-otesc="${i}">Escalate</button>`}`;
    }
    return `<tr>
      <td><strong>${esc(d.name)}</strong></td><td>${fmtDay(d.date)}</td>
      <td class="num">${d.scheduled_min ? fmtDur(d.scheduled_min) : '—'}</td>
      <td class="num">${fmtDur(d.effective_min)}${d.adjusted ? ' <span class="badge gray" title="manager rounded">adj</span>' : ''}</td>
      <td>${flags || '—'}</td>
      <td style="white-space:nowrap">${otAction}<button class="btn sm ghost" data-adjust="${d.user_id}|${d.date}|${d.effective_min}" title="Round the day's hours">Round</button></td>
    </tr>`;
  }).join('');
  return `<div class="section" style="margin-top:1.5rem">
    <div class="row-between"><h3 style="margin:0">Timesheet</h3>${pr.staff.length ? '<button class="btn sm" id="prCsv">⬇ CSV</button>' : ''}</div>
    <div class="row-between" style="margin:.5rem 0 .3rem;flex-wrap:wrap;gap:.5rem">
      <div style="display:flex;gap:.35rem">${pill('daily', 'Daily')}${pill('weekly', 'Weekly')}${pill('monthly', 'Monthly')}</div>
      <div class="week-nav"><button class="btn sm ghost" data-paynav="-1">‹ Prev</button><span class="week-label" style="margin:0 .4rem">${payRange(period, S.payAnchor).label}</span><button class="btn sm ghost" data-paynav="1">Next ›</button></div>
    </div>
    <p class="sub" style="color:var(--muted);margin:.1rem 0 .7rem;font-size:.8rem">Scheduled vs clocked. <span class="badge low">late</span> &gt;${R.late_grace_min}m past start · <span class="badge out">short</span> under scheduled · <span class="badge blue">OT</span> ${R.ot_mult}× after ${R.ot_after_h}h/day (counts on pay once approved). “Round” a day up; “✓ Approve” signs off the ${period} total.</p>
    <div class="table-wrap"><table><thead><tr><th>Staff</th><th class="num">Sched</th><th class="num">Worked</th><th>Late</th><th>Short</th><th class="num">OT</th><th class="num" title="Sick + Vacation + On-leave hours">Leave</th><th class="num">Gross</th><th>Approve total</th></tr></thead><tbody>
      ${rows || '<tr><td colspan="9" class="empty">No completed shifts clocked in this period.</td></tr>'}
      ${pr.staff.length ? `<tr style="font-weight:700;background:#fafafa"><td>Total · ${t.staff} staff</td><td class="num">${t.scheduled_hours}</td><td class="num">${t.total_hours}</td><td colspan="2">${t.late_minutes ? fmtDur(t.late_minutes) + ' late' : ''}</td><td class="num">${t.ot_hours}${t.ot_pending_hours ? ` <span class="badge out">+${t.ot_pending_hours}?</span>` : ''}</td><td class="num">${leaveTotal ? leaveTotal + 'h' : '—'}</td><td class="num">${t.gross_pay != null ? money(t.gross_pay) : '—'}</td><td></td></tr>` : ''}
    </tbody></table></div>
    ${flagged.length ? `<div style="margin-top:1.1rem">
      <h4 style="margin:0 0 .4rem">Days to review <span class="badge out">${flagged.length}</span></h4>
      <div class="table-wrap"><table><thead><tr><th>Staff</th><th>Day</th><th class="num">Sched</th><th class="num">Worked</th><th>Flags</th><th>Overtime · round</th></tr></thead><tbody>${flagRows}</tbody></table></div>
    </div>` : ''}
  </div>`;
}

// Round a day's worked hours up (or down) — feeds the approved total + OT.
function adjustModal(userId, date, curMin, locId) {
  modal(`Round hours — ${fmtDay(date)}`, [
    { key: 'hours', label: `Approved hours (worked ${fmtDur(curMin)})`, type: 'number', value: round2(curMin / 60), step: '0.25' },
    { key: 'note', label: 'Note (optional)', value: '' },
  ], async (vals) => {
    const mins = Math.round(parseFloat(vals.hours || 0) * 60);
    await api('/timeclock/adjust', { method: 'PUT', body: JSON.stringify({ location_id: locId, user_id: userId, work_date: date, adjusted_minutes: mins, note: vals.note }) });
    toast('Hours rounded'); renderLocTimeClock();
  }, 'Save');
}
function otRejectModal(d, locId) {
  modal('Decline overtime', [{ key: 'note', label: `Reason — ${d.name}, ${fmtDay(d.work_date)} (OT ${fmtDur(d.ot_minutes)})`, value: '' }], async (vals) => {
    await api('/timeclock/ot-approval', { method: 'PUT', body: JSON.stringify({ location_id: locId, user_id: d.user_id, work_date: d.work_date, reject: true, note: vals.note }) });
    toast('Overtime declined'); renderLocTimeClock();
  }, 'Decline');
}
function otEscalateModal(d, locId) {
  modal('Request approval from leadership', [{ key: 'note', label: `Note — ${d.name}, ${fmtDay(d.work_date)} (OT ${fmtDur(d.ot_minutes)})`, value: '', placeholder: 'Why this overtime should be approved' }], async (vals) => {
    await api('/timeclock/ot-escalate', { method: 'POST', body: JSON.stringify({ location_id: locId, user_id: d.user_id, work_date: d.work_date, note: vals.note }) });
    toast('Sent to Owner / GM / Admin'); renderLocTimeClock();
  }, 'Send request');
}
function quickMessageModal(userId, name) {
  modal(`Message ${name}`, [
    { key: 'subject', label: 'Subject', value: '', placeholder: 'e.g. About your hours' },
    { key: 'body', label: 'Message', value: '', placeholder: 'Ask about a late start or overtime…' },
  ], async (vals) => {
    if (!vals.body.trim()) throw new Error('Write a message first.');
    const r = await api('/messages', { method: 'POST', body: JSON.stringify({ recipient_ids: [userId], subject: vals.subject, body: vals.body }) });
    toast(`Message sent to ${r.recipients} recipient`);
  }, 'Send');
}

// ── My Hours (self-view): the signed-in person's own timesheet ────────────────
function hoursNavMgmt(dir) {
  const d = new Date(S.hoursAnchor + 'T00:00:00');
  if (S.hoursKind === 'daily') d.setDate(d.getDate() + dir);
  else if (S.hoursKind === 'monthly') d.setMonth(d.getMonth() + dir);
  else d.setDate(d.getDate() + dir * 7);
  S.hoursAnchor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  renderMyHoursMgmt();
}
async function renderMyHoursMgmt() {
  if (!S.hoursAnchor) S.hoursAnchor = fmtLocalIso(new Date());
  let d;
  try { d = await api(`/timeclock/my-hours?kind=${S.hoursKind}&anchor=${S.hoursAnchor}`); } catch (e) { $('view').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const t = d.totals;
  const pill = (k, l) => `<button class="btn sm ${S.hoursKind === k ? '' : 'ghost'}" data-hk="${k}">${l}</button>`;
  const rows = (d.days || []).map(x => {
    const flags = [
      x.late_min > 0 ? `<span class="badge low">⏰ ${fmtDur(x.late_min)} late</span>` : '',
      x.ot_min > 0 ? `<span class="badge blue">+${fmtDur(x.ot_min)} OT${x.ot_status === 'approved' ? ' ✓' : (x.ot_status === 'pending' || x.ot_status === 'escalated') ? ' ⏳' : ''}</span>` : '',
      x.short_min > 0 ? `<span class="badge out">${fmtDur(x.short_min)} short</span>` : '',
    ].filter(Boolean).join(' ');
    return `<tr><td>${WD[(new Date(x.date + 'T00:00:00').getDay() + 6) % 7]} ${fmtDay(x.date)}</td><td class="num">${x.scheduled_min ? fmtDur(x.scheduled_min) : '—'}</td><td class="num"><strong>${fmtDur(x.effective_min)}</strong>${x.adjusted ? ' <span class="mono" style="color:var(--muted)">adj</span>' : ''}</td><td>${flags || '—'}</td></tr>`;
  }).join('');
  $('view').innerHTML = `
    <div class="overview-hero"><h2>My Hours</h2><p>Your clocked hours, overtime and any late starts.</p></div>
    <div class="row-between" style="margin:.2rem 0 .6rem;flex-wrap:wrap;gap:.5rem">
      <div style="display:flex;gap:.35rem">${pill('daily', 'Daily')}${pill('weekly', 'Weekly')}${pill('monthly', 'Monthly')}</div>
      <div class="week-nav"><button class="btn sm ghost" data-hnav="-1">‹ Prev</button><span class="week-label" style="margin:0 .4rem">${esc(payRange(S.hoursKind, S.hoursAnchor).label)}</span><button class="btn sm ghost" data-hnav="1">Next ›</button></div>
    </div>
    <div class="kpis">
      <div class="card"><div class="label">Scheduled</div><div class="value">${t.scheduled_hours}h</div></div>
      <div class="card"><div class="label">Worked</div><div class="value">${t.total_hours}h</div></div>
      <div class="card"><div class="label">Overtime</div><div class="value">${t.ot_hours}h${t.ot_pending_hours ? ` <span class="mono" style="color:var(--muted);font-size:.7rem">+${t.ot_pending_hours}?</span>` : ''}</div></div>
      <div class="card"><div class="label">Late days</div><div class="value ${t.late_days ? 'warn' : ''}">${t.late_days}</div></div>
    </div>
    ${d.approved ? `<p class="sub" style="color:var(--ok,#16a34a);font-weight:600">✓ Total approved${d.approved_by ? ` by ${esc(d.approved_by)}` : ''}</p>` : ''}
    <div class="section" style="margin-top:.8rem"><div class="table-wrap"><table><thead><tr><th>Day</th><th class="num">Scheduled</th><th class="num">Worked</th><th>Notes</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">No clocked hours this period.</td></tr>'}</tbody></table></div></div>`;
  $('view').querySelectorAll('[data-hk]').forEach(b => b.onclick = () => { S.hoursKind = b.dataset.hk; renderMyHoursMgmt(); });
  $('view').querySelectorAll('[data-hnav]').forEach(b => b.onclick = () => hoursNavMgmt(+b.dataset.hnav));
}

// ── Performance / attendance history for a location (manager review) ──────────
async function renderLocPerformance(loc) {
  const days = S.perfDays || 90;
  const end = fmtLocalIso(new Date());
  const start = (() => { const d = new Date(); d.setDate(d.getDate() - (days - 1)); return fmtLocalIso(d); })();
  let data;
  try { data = await api(`/timeclock/performance?location_id=${S.locDetailId}&start=${start}&end=${end}`); } catch (e) { $('locBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const pill = (n, l) => `<button class="btn sm ${days === n ? '' : 'ghost'}" data-perf="${n}">${l}</button>`;
  const rows = data.staff.map(s => `<tr>
    <td><strong>${esc(s.name)}</strong> <span class="mono" style="color:var(--muted);font-size:.72rem">${esc(s.employee_code || '')}</span></td>
    <td class="num">${s.days}</td><td class="num">${s.total_hours}</td>
    <td class="num">${s.late_days ? `<span class="badge low">${s.late_days}</span> <span class="mono" style="color:var(--muted);font-size:.72rem">${fmtDur(s.late_minutes)}</span>` : '0'}</td>
    <td class="num">${s.short_days ? `<span class="badge out">${s.short_days}</span>` : '0'}</td>
    <td class="num">${s.ot_hours || 0}${s.ot_approved_hours ? ` <span class="mono" style="color:var(--muted);font-size:.72rem">(${s.ot_approved_hours} appr)</span>` : ''}</td>
    <td class="num">${s.on_time_rate != null ? `<strong style="color:${s.on_time_rate >= 95 ? 'var(--ok,#16a34a)' : s.on_time_rate >= 80 ? '#b4630b' : 'var(--red)'}">${s.on_time_rate}%</strong>` : '—'}</td>
    <td><button class="btn sm ghost" data-msg="${s.user_id}" data-msgname="${esc(s.name)}">✉</button></td>
  </tr>`).join('');
  $('locBody').innerHTML = `
    <div class="row-between"><h3 style="margin:0">Attendance & performance</h3>
      <div style="display:flex;gap:.35rem">${pill(30, '30 days')}${pill(90, '90 days')}${pill(365, '1 year')}</div></div>
    <p class="sub" style="color:var(--muted);margin:.3rem 0 .7rem;font-size:.8rem">${fmtDay(data.start)} – ${fmtDay(data.end)}. Late/short/overtime tallies from the time clock — saved for reviews. Message a staff member with ✉.</p>
    <div class="table-wrap"><table><thead><tr><th>Staff</th><th class="num">Days</th><th class="num">Hours</th><th class="num">Late</th><th class="num">Short</th><th class="num">OT hrs</th><th class="num">On-time</th><th></th></tr></thead><tbody>
      ${rows || '<tr><td colspan="8" class="empty">No clocked history in this range.</td></tr>'}
    </tbody></table></div>`;
  $('locBody').querySelectorAll('[data-perf]').forEach(b => b.onclick = () => { S.perfDays = +b.dataset.perf; renderLocPerformance(loc); });
  $('locBody').querySelectorAll('[data-msg]').forEach(b => b.onclick = () => quickMessageModal(+b.dataset.msg, b.dataset.msgname));
}

function exportPayrollCSV(pr) {
  const R = pr.rules;
  const headers = ['Employee', 'Code', 'Role', 'Days', 'Scheduled hours', 'Clocked hours', 'Regular hours',
    `Approved OT hours (${R.ot_mult}x)`, `Approved double-time hours (${R.dt_mult}x)`, 'Pending OT hours (unapproved, not paid)',
    'Sick hours', 'Vacation hours', 'On-leave hours', 'Hourly rate', 'Gross pay'];
  const lines = [
    [`Payroll ${pr.start} to ${pr.end}`, pr.location.name || ''].map(csvCell).join(','),
    headers.join(','),
  ];
  for (const s of pr.staff) lines.push([
    s.name, s.employee_code || '', roleLabel(s.role), s.days_count, s.scheduled_hours, s.total_hours, s.regular_hours,
    s.ot_hours, s.dt_hours, (s.ot_pending_hours || 0) + (s.dt_pending_hours || 0),
    s.sick_hours || 0, s.vacation_hours || 0, s.leave_hours || 0, s.rate != null ? s.rate : '', s.gross_pay != null ? s.gross_pay : '',
  ].map(csvCell).join(','));
  const t = pr.totals;
  lines.push(['TOTAL', '', '', '', t.scheduled_hours, t.total_hours, t.regular_hours, t.ot_hours, t.dt_hours, round2((t.ot_pending_hours || 0) + (t.dt_pending_hours || 0)), t.sick_hours || 0, t.vacation_hours || 0, t.leave_hours || 0, '', t.gross_pay != null ? t.gross_pay : ''].map(csvCell).join(','));
  const csv = '﻿' + lines.join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = `payroll_${(pr.location.name || 'location').replace(/[^a-z0-9]+/gi, '-')}_${pr.start}_${pr.end}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast(`Exported ${pr.staff.length} staff to CSV`);
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Floor Plan — live table status + layout editor (owner/admin/GM/manager) ──
const TABLE_STATUS = {
  available: ['Available', '#1e7e34', '#e6f4ea'],
  waiting_to_order: ['Waiting to order', '#2b5bd7', '#e7eefc'],
  served: ['Served', '#0e7490', '#e0f2fe'],
  waiting_to_pay: ['Waiting to pay', '#b4630b', '#fdecd8'],
  cleaning: ['Cleaning up', '#6b7280', '#ededed'],
};
const FP_AREA_COLORS = ['#2b5bd7', '#b4630b', '#1e7e34', '#7a1420', '#6d28d9', '#0e7490', '#be185d'];
// Guest count is optional — some managers prefer a cleaner board. The choice is a
// per-user preference (stored locally) and governs the party-size chip on every
// floor view (Details snapshot + Floor Plan status). Tooltips always keep detail.
function showGuests() { return localStorage.getItem('phn_show_guests') !== '0'; }
function toggleGuests() { localStorage.setItem('phn_show_guests', showGuests() ? '0' : '1'); }
const guestsToggleBtn = (id) => `<button class="btn sm ghost" id="${id}">${showGuests() ? '👤 Guests shown' : '👤 Guests hidden'}</button>`;
async function renderLocFloorPlan() {
  let fp;
  try { fp = await api('/floorplan?location_id=' + S.locDetailId); }
  catch (e) { $('locBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const canEdit = fp.can_edit;
  const edit = canEdit && S.fpEdit;
  const outline = fp.room_outline || [];
  const all = fp.areas.flatMap((a, ai) => a.tables.map(t => ({ ...t, _ci: ai })));
  const areaOptions = (sel) => fp.areas.map(a => `<option value="${a.id}" ${String(a.id) === String(sel) ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  const tEl = (t) => {
    if (edit) return `<div class="ftable ${t.shape === 'square' ? 'sq' : ''}${t.is_active ? '' : ' off'}" data-tid="${t.id}" style="left:${t.pos_x}%;top:${t.pos_y}%;--ac:${FP_AREA_COLORS[t._ci % FP_AREA_COLORS.length]}" title="${esc(t.label)} · ${t.seats} seats"><span class="ftable-l">${esc(t.label)}</span><span class="ftable-s">${t.seats}p</span></div>`;
    const [lbl, c, bg] = TABLE_STATUS[t.status] || TABLE_STATUS.available;
    const occ = t.status !== 'available';
    const sub = occ ? `${showGuests() && t.party_size ? t.party_size + '👤' : ''}${t.minutes_to_free != null ? ' ~' + t.minutes_to_free + 'm' : ''}`.trim() : `${t.seats}p`;
    const chk = t.stage === 'in_service' && t.minutes_to_check != null ? (t.check_due ? ` · check overdue ${Math.abs(t.minutes_to_check)}m` : ` · check in ${t.minutes_to_check}m`) : '';
    const tip = occ ? lbl + (t.guest_name ? ' · ' + esc(t.guest_name) : '') + (t.server_name ? ' · ' + esc(t.server_name) : '') + chk : 'available, ' + t.seats + ' seats';
    const srv = t.server_name ? `<span class="ftable-srv">${esc(t.server_name.split(' ')[0])}</span>` : '';
    const badge = t.check_due ? '<span class="ftable-due">⏰</span>' : '';
    return `<div class="ftable ${t.shape === 'square' ? 'sq' : ''}${t.check_due ? ' due' : ''}" data-tbl="${t.id}" style="left:${t.pos_x}%;top:${t.pos_y}%;--ac:${c};--abg:${bg}" title="${esc(t.label)} · ${tip}"><span class="ftable-l">${esc(t.label)}</span><span class="ftable-s">${esc(sub)}</span>${badge}${srv}</div>`;
  };
  const boardInner = roomSvgM(outline) + (edit ? outline.map((p, i) => `<div class="room-vtx" data-vi="${i}" style="left:${p.x}%;top:${p.y}%"></div>`).join('') : '') + all.map(tEl).join('');
  const legend = edit
    ? `<div class="fp-legend">${fp.areas.map((a, i) => `<button class="fp-leg ed" data-area="${a.id}"><span class="fp-dot" style="background:${FP_AREA_COLORS[i % FP_AREA_COLORS.length]}"></span>${esc(a.name)} <span class="fp-leg-n">${a.tables.length}</span></button>`).join('')}</div>`
    : `<div class="fp-legend">${Object.entries(TABLE_STATUS).map(([k, [l, c]]) => `<span class="fp-leg"><span class="fp-dot" style="background:${c}"></span>${l} <span class="fp-leg-n">${all.filter(t => (t.status || 'available') === k).length}</span></span>`).join('')}</div>`;
  const sm = fp.summary;
  $('locBody').innerHTML = `
    <div class="row-between sched-head">
      <div><span class="badge ok">${sm.available} available</span> <span class="badge ${sm.occupied ? 'blue' : 'gray'}">${sm.occupied} occupied</span> <span class="badge gray">${sm.tables} tables</span></div>
      <div style="display:flex;gap:.4rem;align-items:center">${!edit ? guestsToggleBtn('fpGuests') : ''}${canEdit ? `${edit ? `<button class="btn sm" id="fpEditRoom">${S.fpEditRoom ? '✓ Done room' : '▢ Edit room'}</button><button class="btn sm ghost" id="fpAddArea">+ Area</button><button class="btn sm ghost" id="fpAddTable">+ Table</button>` : ''}<button class="btn sm ${edit ? '' : 'ghost'}" id="fpToggle">${edit ? '✓ Done editing' : '✎ Edit layout'}</button>` : (edit ? '' : '<span class="badge gray">View only</span>')}</div>
    </div>
    ${legend}
    <p class="sub" style="color:var(--muted);margin:.1rem 0 .6rem;font-size:.8rem">${edit ? 'Drag tables to arrange the room; tap a table to edit; “Edit room” reshapes the walls.' : 'Tap an available table to seat a guest; tap an occupied table to change its status. Shared live with the Front Desk.'}</p>
    <div class="floor-board${edit ? ' editable' : ''}${S.fpEditRoom && edit ? ' roomedit' : ''}" id="fpBoard">${boardInner}</div>`;

  if (edit) {
    $('fpToggle').onclick = () => { S.fpEdit = false; S.fpEditRoom = false; renderLocFloorPlan(); };
    $('fpEditRoom').onclick = () => { S.fpEditRoom = !S.fpEditRoom; renderLocFloorPlan(); };
    $('fpAddArea').onclick = () => modal('Add area', [{ key: 'name', label: 'Area name', placeholder: 'e.g. Patio' }], async (v) => { await api('/floorplan/areas', { method: 'POST', body: JSON.stringify({ location_id: S.locDetailId, name: v.name }) }); toast('Area added'); renderLocFloorPlan(); }, 'Add');
    $('fpAddTable').onclick = () => { if (!fp.areas.length) return toast('Add an area first.', true); openFpTableModal(null, areaOptions); };
    $('locBody').querySelectorAll('[data-area]').forEach(b => b.onclick = () => openFpAreaModal(fp.areas.find(a => String(a.id) === String(b.dataset.area))));
    if (S.fpEditRoom) wireFpRoom(outline); else wireFpDrag();
  } else if (canEdit || true) {
    $('fpGuests') && ($('fpGuests').onclick = () => { toggleGuests(); renderLocFloorPlan(); });
    $('fpToggle') && ($('fpToggle').onclick = () => { S.fpEdit = true; renderLocFloorPlan(); });
    $('locBody').querySelectorAll('[data-tbl]').forEach(el => el.onclick = () => {
      const t = all.find(x => String(x.id) === String(el.dataset.tbl));
      if (t.status === 'available') openSeatModal(t); else openTableStatusModal(t);
    });
  }
}
function roomSvgM(outline) {
  if (!Array.isArray(outline) || outline.length < 3) return '';
  return `<svg class="room-svg" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="${outline.map(p => `${p.x},${p.y}`).join(' ')}"/></svg>`;
}
function openSeatModal(t) {
  modal(`Seat at table ${t.label}`, [{ key: 'guest_name', label: 'Guest name (optional)', value: '' }, { key: 'party_size', label: `Party size (table seats ${t.seats})`, type: 'number', value: Math.min(t.seats, 2) }],
    async (v) => { await api(`/floorplan/tables/${t.id}/seat`, { method: 'PUT', body: JSON.stringify({ guest_name: v.guest_name, party_size: v.party_size }) }); toast(`Seated at ${t.label}`); renderLocFloorPlan(); }, 'Seat');
}
function openTableStatusModal(t) {
  const host = $('modalHost');
  const [lbl] = TABLE_STATUS[t.status] || TABLE_STATUS.available;
  const btns = [['waiting_to_order', 'Waiting to order'], ['served', 'Served'], ['waiting_to_pay', 'Waiting to pay'], ['cleaning', 'Cleaning up']]
    .map(([k, l]) => `<button class="btn sm ${t.status === k ? '' : 'ghost'}" data-st="${k}" style="justify-content:flex-start">${t.status === k ? '● ' : ''}${l}</button>`).join('');
  host.innerHTML = `<div class="modal-bg"><div class="modal"><h3>Table ${esc(t.label)} — ${lbl}</h3>
    <p class="sub" style="margin:.1rem 0 .6rem">${t.guest_name ? esc(t.guest_name) + ' · ' : ''}${t.party_size ? t.party_size + ' guests · ' : ''}${t.minutes_to_free != null ? 'free in ~' + t.minutes_to_free + ' min' : ''}</p>
    <div style="display:grid;gap:.4rem">${btns}</div>
    <div class="actions"><button class="btn ghost" id="mCancel">Close</button><button class="btn" id="fpFree">✓ Free the table</button></div></div></div>`;
  const close = () => host.innerHTML = '';
  $('mCancel').onclick = close;
  host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
  const setStatus = async (s) => { try { await api(`/floorplan/tables/${t.id}/status`, { method: 'PUT', body: JSON.stringify({ status: s }) }); toast('Status updated'); close(); renderLocFloorPlan(); } catch (e) { toast(e.message, true); } };
  host.querySelectorAll('[data-st]').forEach(b => b.onclick = () => setStatus(b.dataset.st));
  $('fpFree').onclick = () => setStatus('available');
}
function openFpAreaModal(a) {
  const host = $('modalHost');
  modal(`Area — ${a.name}`, [{ key: 'name', label: 'Area name', value: a.name }], async (v) => { await api('/floorplan/areas/' + a.id, { method: 'PUT', body: JSON.stringify({ name: v.name }) }); toast('Area updated'); renderLocFloorPlan(); }, 'Save');
  const btn = document.createElement('button'); btn.className = 'btn ghost'; btn.style.cssText = 'margin-top:.5rem;color:var(--red)'; btn.textContent = `Remove area & its ${a.tables.length} tables`;
  host.querySelector('.modal .actions').before(btn);
  btn.onclick = async () => { try { await api('/floorplan/areas/' + a.id, { method: 'DELETE' }); toast('Area removed'); renderLocFloorPlan(); } catch (e) { toast(e.message, true); } };
}
function openFpTableModal(t, areaOptions) {
  const fields = [
    { key: 'label', label: 'Table label', value: t ? t.label : '', placeholder: 'e.g. 13' },
    { key: 'seats', label: 'Seats', type: 'number', value: t ? t.seats : 4 },
    { key: 'shape', label: 'Shape', type: 'select', value: t ? t.shape : 'round', options: [{ value: 'round', label: 'Round' }, { value: 'square', label: 'Square' }] },
    { key: 'area_id', label: 'Area', type: 'select', value: t ? t.area_id : '', options: [] },
  ];
  const host = $('modalHost');
  modal(t ? `Table ${t.label}` : 'Add table', fields, async (v) => {
    if (t) await api('/floorplan/tables/' + t.id, { method: 'PUT', body: JSON.stringify(v) });
    else await api('/floorplan/tables', { method: 'POST', body: JSON.stringify({ ...v, location_id: S.locDetailId }) });
    toast(t ? 'Table updated' : 'Table added'); renderLocFloorPlan();
  }, t ? 'Save' : 'Add');
  // fill the area select options (modal helper doesn't build them from html string)
  const areaSel = host.querySelector('[data-k="area_id"]'); if (areaSel) areaSel.innerHTML = areaOptions(t ? t.area_id : '');
  if (t) { const rm = document.createElement('button'); rm.className = 'btn ghost'; rm.style.cssText = 'margin-top:.5rem;color:var(--red)'; rm.textContent = 'Remove table'; host.querySelector('.modal .actions').before(rm); rm.onclick = async () => { try { await api('/floorplan/tables/' + t.id, { method: 'DELETE' }); toast('Table removed'); renderLocFloorPlan(); } catch (e) { toast(e.message, true); } }; }
}
function wireFpDrag() {
  const board = $('fpBoard');
  board.querySelectorAll('.ftable').forEach(el => el.onpointerdown = (e) => {
    e.preventDefault(); const rect = board.getBoundingClientRect(); const sx = e.clientX, sy = e.clientY; let moved = false, px, py;
    el.setPointerCapture(e.pointerId); el.classList.add('drag');
    const onMove = (ev) => { if (Math.abs(ev.clientX - sx) > 3 || Math.abs(ev.clientY - sy) > 3) moved = true; px = Math.max(2, Math.min(98, Math.round((ev.clientX - rect.left) / rect.width * 100))); py = Math.max(2, Math.min(98, Math.round((ev.clientY - rect.top) / rect.height * 100))); el.style.left = px + '%'; el.style.top = py + '%'; };
    const onUp = async () => { el.classList.remove('drag'); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp);
      if (moved && px != null) { try { await api('/floorplan/tables/' + el.dataset.tid, { method: 'PUT', body: JSON.stringify({ pos_x: px, pos_y: py }) }); } catch (err) { toast(err.message, true); } }
      else { const a = []; renderFpTableEdit(el.dataset.tid); } };
    el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp);
  });
}
async function renderFpTableEdit(tid) {
  const fp = await api('/floorplan?location_id=' + S.locDetailId);
  const t = fp.areas.flatMap(a => a.tables).find(x => String(x.id) === String(tid));
  if (t) openFpTableModal(t, (sel) => fp.areas.map(a => `<option value="${a.id}" ${String(a.id) === String(sel) ? 'selected' : ''}>${esc(a.name)}</option>`).join(''));
}
function wireFpRoom(outline) {
  const board = $('fpBoard'); const poly = board.querySelector('.room-svg polygon');
  const setPoly = () => poly && poly.setAttribute('points', outline.map(p => `${p.x},${p.y}`).join(' '));
  const save = async () => { try { await api('/floorplan/room', { method: 'PUT', body: JSON.stringify({ location_id: S.locDetailId, outline }) }); } catch (e) { toast(e.message, true); } };
  board.querySelectorAll('.room-vtx').forEach(el => el.onpointerdown = (e) => {
    e.preventDefault(); const rect = board.getBoundingClientRect(); const i = +el.dataset.vi; const sx = e.clientX, sy = e.clientY; let moved = false, px, py;
    el.setPointerCapture(e.pointerId); el.classList.add('drag');
    const onMove = (ev) => { if (Math.abs(ev.clientX - sx) > 3 || Math.abs(ev.clientY - sy) > 3) moved = true; px = Math.max(0, Math.min(100, Math.round((ev.clientX - rect.left) / rect.width * 100))); py = Math.max(0, Math.min(100, Math.round((ev.clientY - rect.top) / rect.height * 100))); el.style.left = px + '%'; el.style.top = py + '%'; outline[i] = { x: px, y: py }; setPoly(); };
    const onUp = async () => { el.classList.remove('drag'); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp);
      if (moved) await save(); else if (outline.length > 3) { outline.splice(i, 1); await save(); renderLocFloorPlan(); } else toast('A room needs 3+ corners.', true); };
    el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp);
  });
}

const equipStatusBadge = (s) => { const m = { operational: ['ok', 'operational'], needs_service: ['low', 'needs service'], out_of_order: ['out', 'out of order'] }[s] || ['gray', s]; return `<span class="badge ${m[0]}">${m[1]}</span>`; };
function nextServiceCell(d) { if (!d) return '<span style="color:var(--muted)">—</span>'; const overdue = new Date(d) < new Date(); return overdue ? `<span class="badge out">${esc(d)} ⚠</span>` : esc(d); }
async function renderLocEquipment() {
  const eq = await api('/locations/' + S.locDetailId + '/equipment');
  const canManage = ['owner', 'admin', 'manager'].includes(S.user.role);
  $('locBody').innerHTML = `
    <div class="row-between"><h3 style="margin:0">Equipment & assets <span style="font-weight:400;color:var(--muted);font-size:.85rem">— ${eq.length}</span></h3>${canManage ? '<button class="btn" id="addEq">+ Add equipment</button>' : ''}</div>
    <div class="table-wrap" style="margin-top:1rem"><table><thead><tr>
      <th>Equipment</th><th>Category</th><th>Vendor</th><th>Maintenance</th><th>Next service</th><th>Warranty</th><th>Status</th>${canManage ? '<th></th>' : ''}
    </tr></thead><tbody>
      ${eq.length ? eq.map(e => `<tr>
        <td><strong>${esc(e.name)}</strong><div class="mono" style="font-size:.72rem;color:var(--muted)">${esc(e.model || '')}${e.serial ? ' · ' + esc(e.serial) : ''}</div></td>
        <td>${esc(e.category || '—')}</td>
        <td>${esc(e.vendor || '—')}${e.vendor_phone ? `<div class="mono" style="font-size:.72rem;color:var(--muted)">${esc(e.vendor_phone)}</div>` : ''}</td>
        <td>${esc(e.maintenance_freq || '—')}</td>
        <td>${nextServiceCell(e.next_service)}</td>
        <td>${esc(e.warranty_expiry || '—')}</td>
        <td>${equipStatusBadge(e.status)}</td>
        ${canManage ? `<td><div class="actions-cell"><button class="btn sm ghost" data-eqedit="${e.id}">Edit</button><button class="btn sm ghost" data-eqdel="${e.id}">Delete</button></div></td>` : ''}
      </tr>`).join('') : `<tr><td colspan="${canManage ? 8 : 7}" class="empty">No equipment recorded.</td></tr>`}
    </tbody></table></div>`;
  if (canManage) {
    $('addEq').onclick = () => equipmentModal(null);
    $('locBody').querySelectorAll('[data-eqedit]').forEach(b => b.onclick = () => equipmentModal(eq.find(x => x.id == b.dataset.eqedit)));
    $('locBody').querySelectorAll('[data-eqdel]').forEach(b => b.onclick = () => { const e = eq.find(x => x.id == b.dataset.eqdel); modal(`Delete “${e.name}”?`, [], async () => { await api('/locations/equipment/' + e.id, { method: 'DELETE' }); toast('Equipment removed'); renderLocDetail(); }, 'Delete'); });
  }
}
function equipmentModal(e) {
  const isNew = !e;
  modal(isNew ? 'Add equipment' : `Edit — ${e.name}`, [
    { key: 'name', label: 'Equipment name', value: e ? e.name : '' },
    { key: 'category', label: 'Category', value: e ? e.category : 'Cooking' },
    { key: 'model', label: 'Model', value: e ? e.model : '' },
    { key: 'serial', label: 'Serial #', value: e ? e.serial : '' },
    { key: 'vendor', label: 'Vendor', value: e ? e.vendor : '' },
    { key: 'vendor_phone', label: 'Vendor phone', value: e ? e.vendor_phone : '' },
    { key: 'purchase_date', label: 'Purchase date (YYYY-MM-DD)', value: e ? e.purchase_date : '' },
    { key: 'warranty_expiry', label: 'Warranty expiry', value: e ? e.warranty_expiry : '' },
    { key: 'maintenance_freq', label: 'Maintenance', type: 'select', options: ['monthly', 'quarterly', 'biannual', 'annual', 'as_needed'].map(x => ({ value: x, label: x })), value: e ? e.maintenance_freq : 'quarterly' },
    { key: 'last_service', label: 'Last service (YYYY-MM-DD)', value: e ? e.last_service : '' },
    { key: 'next_service', label: 'Next service (YYYY-MM-DD)', value: e ? e.next_service : '' },
    { key: 'status', label: 'Status', type: 'select', options: [{ value: 'operational', label: 'Operational' }, { value: 'needs_service', label: 'Needs service' }, { value: 'out_of_order', label: 'Out of order' }], value: e ? e.status : 'operational' },
    { key: 'notes', label: 'Notes', value: e ? e.notes : '' },
  ], async (v) => {
    if (isNew) { await api('/locations/' + S.locDetailId + '/equipment', { method: 'POST', body: JSON.stringify(v) }); toast('Equipment added'); }
    else { await api('/locations/equipment/' + e.id, { method: 'PUT', body: JSON.stringify(v) }); toast('Equipment updated'); }
    renderLocDetail();
  }, isNew ? 'Add equipment' : 'Save');
}

// ── Section: Staff (module with tabs) ──────────────────────────────────────
// Chip colour per role — populated from the registry at boot (roleChip()).
const ROLE_CHIP = {};
// Assignable access levels, highest rank first (from the registry).
const accessLevels = () => Object.keys(ROLE_DEFS).sort((a, b) => (roleDef(b).rank || 0) - (roleDef(a).rank || 0));

// Common restaurant job titles — suggestions for the profile field (free-text still allowed).
const JOB_TITLES = [
  'Server', 'Host / Front Desk', 'Busser', 'Food Runner', 'Cashier', 'Bartender', 'Barista',
  'Line Cook', 'Prep Cook', 'Wok Cook', 'Grill Cook', 'Broth Cook', 'Chef', 'Sous Chef', 'Head Chef',
  'Kitchen Assistant', 'Dishwasher', 'Shift Lead', 'Assistant Manager', 'Kitchen Manager',
  'General Manager', 'Manager', 'Inventory Support', 'Receiving Clerk', 'Delivery Driver', 'Catering Lead',
];
// A text input backed by a <datalist> — type freely or pick a suggestion.
const dlInput = (k, label, val, opts) => `<label class="pfl">${label}<input id="pf_${k}" list="dl_${k}" value="${esc(val == null ? '' : val)}" autocomplete="off" placeholder="Type or pick…" /><datalist id="dl_${k}">${opts.map(o => `<option value="${esc(o)}"></option>`).join('')}</datalist></label>`;
const STAFF_TABS = [['overview', 'Overview'], ['directory', 'Directory'], ['jobs', 'Jobs / Tasks'], ['access', 'Access Levels'], ['activity', 'Activity Log']];
// The Activity Log (access trail) is owner/admin only.
const staffTabsFor = () => STAFF_TABS.filter(([k]) => k !== 'activity' || ['owner', 'admin'].includes(S.user.role));
function renderStaffTabs() {
  const tabs = staffTabsFor();
  if (!S.staffTab || !tabs.some(([k]) => k === S.staffTab)) S.staffTab = 'overview';
  $('tabs').innerHTML = tabs.map(([k, l]) => `<button data-stab="${k}" class="${S.staffTab === k ? 'active' : ''}">${l}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach(b => b.onclick = () => {
    if (b.dataset.stab === 'directory') { staffLetter = 'A'; staffSearch = ''; } // default to letter A
    S.staffTab = b.dataset.stab; renderStaffTabs(); renderStaffModule();
  });
}
function renderStaffModule() {
  $('view').innerHTML = '<div class="empty">Loading…</div>';
  ({ overview: renderStaffOverview, directory: renderStaffDirectory, jobs: renderJobsCatalog, access: renderAccessLevels, activity: renderActivityLog }[S.staffTab] || renderStaffOverview)();
}

let activityFilter = 'all';
async function renderActivityLog() {
  let rows;
  try { rows = await api('/activity' + (activityFilter === 'all' ? '' : '?event=' + activityFilter)); }
  catch (e) { return renderPlaceholder('Activity Log', '🧾', e.message); }
  const sBadge = (s) => s >= 500 ? 'out' : s >= 400 ? 'low' : 'ok';
  const label = (r) => {
    if (r.path === '/api/auth/login') return r.status === 200 ? 'signed in' : 'sign-in failed';
    return `${r.method} ${r.path.replace('/api', '')}`;
  };
  const tab = (k, l) => `<button class="btn sm ${activityFilter === k ? '' : 'ghost'}" data-af="${k}">${l}</button>`;
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Activity Log <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${rows.length}</span></h2>
      <div class="actions-cell">${tab('all', 'All')}${tab('logins', 'Logins')}${tab('denied', 'Denied')}<button class="btn sm" id="expCsv">⬇ Export CSV</button></div></div>
    <p class="sub" style="color:var(--muted);margin-top:0">Every sign-in, change, and blocked attempt — who, what, status and IP. (Read-only page views aren't logged.)</p>
    <div class="table-wrap"><table><thead><tr><th>When (local)</th><th>Who</th><th>Action</th><th>Status</th><th>IP</th></tr></thead><tbody>
      ${rows.length ? rows.map(r => `<tr>
        <td class="mono" style="white-space:nowrap">${esc(fmtLocalTs(r.created_at))}</td>
        <td>${r.user_name ? `<strong>${esc(r.user_name)}</strong>${r.user_role ? ` <span class="badge ${ROLE_CHIP[r.user_role] || 'gray'}">${esc(roleLabel(r.user_role))}</span>` : ''}` : '<span style="color:var(--muted)">anonymous</span>'}${r.detail && r.detail.email && !r.user_role ? ` <span class="mono" style="color:var(--muted);font-size:.8rem">${esc(r.detail.email)}</span>` : ''}</td>
        <td>${esc(label(r))}</td>
        <td><span class="badge ${sBadge(r.status)}">${r.status}</span></td>
        <td class="mono" style="color:var(--muted)">${esc(r.ip || '—')}</td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty">No activity recorded yet.</td></tr>'}
    </tbody></table></div>`;
  $('view').querySelectorAll('[data-af]').forEach(b => b.onclick = () => { activityFilter = b.dataset.af; renderActivityLog(); });
  $('expCsv').onclick = exportActivityCSV;
}

function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
async function exportActivityCSV() {
  const btn = $('expCsv'); const orig = btn.textContent; btn.textContent = 'Preparing…'; btn.disabled = true;
  try {
    const q = '/activity?' + (activityFilter === 'all' ? '' : 'event=' + activityFilter + '&') + 'limit=1000';
    const rows = await api(q);
    const act = (r) => r.path === '/api/auth/login' ? (r.status === 200 ? 'signed in' : 'sign-in failed') : `${r.method} ${r.path.replace('/api', '')}`;
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

const STATUS_CHIP = { active: 'ok', inactive: 'out', vacation: 'blue', sick: 'low', on_leave: 'gold' };
const staffStatus = (u) => (!u.is_active ? 'inactive' : (u.work_status || 'active'));

async function renderStaffOverview() {
  let overview;
  try { overview = await api('/staff/overview'); }
  catch (e) { return renderPlaceholder('Staff', '👥', e.message); }
  const sum = (k) => overview.reduce((s, l) => s + (l[k] || 0), 0);
  $('view').innerHTML = `
    <h2 class="page">Staff Overview <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${sum('total')} across ${overview.length} locations</span></h2>
    <div class="kpis" style="margin-bottom:1rem">
      <div class="card"><div class="label">Active</div><div class="value ok">${sum('active')}</div></div>
      <div class="card"><div class="label">On vacation</div><div class="value">${sum('vacation')}</div></div>
      <div class="card"><div class="label">Sick</div><div class="value">${sum('sick')}</div></div>
      <div class="card"><div class="label">Inactive</div><div class="value bad">${sum('inactive')}</div></div>
    </div>
    <div class="table-wrap"><table><thead><tr>
      <th>Location</th><th>Manager</th><th class="num">Staff</th><th class="num">Active</th><th class="num">Vacation</th><th class="num">Sick</th><th class="num">Inactive</th>
    </tr></thead><tbody>
      ${overview.map(l => `<tr>
        <td><strong>${esc((l.location_name || '').replace('Pho Ha Noi — ', ''))}</strong></td>
        <td>${l.manager ? esc(l.manager) : '<span style="color:var(--muted)">— no manager —</span>'}</td>
        <td class="num"><strong>${l.total}</strong></td>
        <td class="num"><span class="badge ok">${l.active}</span></td>
        <td class="num">${l.vacation ? `<span class="badge blue">${l.vacation}</span>` : '0'}</td>
        <td class="num">${l.sick ? `<span class="badge low">${l.sick}</span>` : '0'}</td>
        <td class="num">${l.inactive ? `<span class="badge out">${l.inactive}</span>` : '0'}</td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

// ── Job / task catalog ───────────────────────────────────────────────────────
const COMPLEXITY_CHIP = { low: 'ok', medium: 'blue', high: 'low' };
const JOB_DEPTS = ['Front of House', 'Back of House', 'Bar', 'Facilities', 'Management'];
async function renderJobsCatalog() {
  let jobs;
  try { jobs = await api('/schedule/jobs'); }
  catch (e) { return renderPlaceholder('Jobs', '🧾', e.message); }
  const canManage = ['owner', 'admin', 'manager'].includes(S.user.role);
  const active = jobs.filter(j => j.is_active);
  const byDept = {};
  active.forEach(j => { (byDept[j.department || 'Other'] = byDept[j.department || 'Other'] || []).push(j); });
  const depts = Object.keys(byDept).sort((a, b) => JOB_DEPTS.indexOf(a) - JOB_DEPTS.indexOf(b));
  const cx = (c) => `<span class="badge ${COMPLEXITY_CHIP[c] || 'gray'}">${esc(c || '—')}</span>`;
  const kindBadge = (k) => `<span class="badge ${k === 'specific' ? 'blue' : 'gray'}">${k === 'specific' ? 'specific' : 'standard'}</span>`;
  const section = (d) => `
    <h3 class="dept-head">${esc(d)} <span style="font-weight:400;color:var(--muted);font-size:.8rem">— ${byDept[d].length}</span></h3>
    <div class="table-wrap"><table><thead><tr>
      <th>Job ID</th><th>Job / task</th><th>Kind</th><th>Complexity</th><th class="num">Est.</th><th>Description &amp; instructions</th>${canManage ? '<th>Actions</th>' : ''}
    </tr></thead><tbody>
      ${byDept[d].map(j => `<tr>
        <td class="mono"><strong>${esc(j.code || '—')}</strong></td>
        <td><strong>${esc(j.name)}</strong>${j.notes ? `<div class="job-note">📌 ${esc(j.notes)}</div>` : ''}</td>
        <td>${kindBadge(j.kind)}</td>
        <td>${cx(j.complexity)}</td>
        <td class="num">${j.est_minutes != null ? j.est_minutes + 'm' : '—'}</td>
        <td class="job-desc">${esc(j.description || '—')}</td>
        ${canManage ? `<td><div class="actions-cell">
          <button class="btn sm ghost" data-jedit="${j.id}">Edit</button>
          <button class="btn sm ghost" data-jretire="${j.id}">Retire</button></div></td>` : ''}
      </tr>`).join('')}
    </tbody></table></div>`;
  const specificCount = active.filter(j => j.kind === 'specific').length;
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Jobs &amp; Tasks <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${active.length} active</span></h2>
      ${canManage ? '<button class="btn" id="addJob">+ Add job</button>' : '<span class="badge gray">View only</span>'}</div>
    <p class="sub" style="color:var(--muted);margin-top:0"><span class="badge gray">standard</span> role duties assigned when building the weekly schedule; <span class="badge blue">specific</span> (${specificCount}) day-of tasks the manager assigns to working staff on the <strong>Day Tasks</strong> tab.</p>
    ${depts.length ? depts.map(section).join('') : '<div class="empty">No jobs in the catalog yet.</div>'}`;
  if (canManage) {
    $('addJob').onclick = () => jobModal(null);
    $('view').querySelectorAll('[data-jedit]').forEach(b => b.onclick = () => jobModal(jobs.find(j => j.id == b.dataset.jedit)));
    $('view').querySelectorAll('[data-jretire]').forEach(b => b.onclick = () => {
      const j = jobs.find(x => x.id == b.dataset.jretire);
      modal(`Retire “${j.name}”?`, [], async () => { await api('/schedule/jobs/' + j.id, { method: 'DELETE' }); toast('Job retired'); renderJobsCatalog(); }, 'Retire');
    });
  }
}

function jobModal(job) {
  const isNew = !job;
  const j = job || {};
  const host = $('modalHost');
  const opt = (v, sel) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(v || '—')}</option>`;
  host.innerHTML = `<div class="modal-bg"><div class="modal modal-wide"><h3>${isNew ? 'Add job / task' : 'Edit — ' + esc(j.name)}</h3>
    <div class="err" id="mErr"></div>
    <div class="form-grid">
      <label>Job ID<input id="j_code" value="${esc(j.code || '')}" placeholder="e.g. FOH-08" /></label>
      <label>Job / task name<input id="j_name" value="${esc(j.name || '')}" /></label>
      <label>Department<select id="j_department">${['', ...JOB_DEPTS].map(d => opt(d, j.department || '')).join('')}</select></label>
      <label>Kind<select id="j_kind"><option value="standard" ${(j.kind || 'standard') === 'standard' ? 'selected' : ''}>Standard (schedule duty)</option><option value="specific" ${j.kind === 'specific' ? 'selected' : ''}>Specific (day task)</option></select></label>
      <label>Complexity<select id="j_complexity">${['low', 'medium', 'high'].map(c => opt(c, j.complexity || 'medium')).join('')}</select></label>
      <label>Est. minutes <span style="color:var(--muted);font-weight:400">(required for day tasks)</span><input id="j_est_minutes" type="number" min="0" value="${j.est_minutes != null ? j.est_minutes : ''}" /></label>
    </div>
    <label class="pfl">Description / instructions<textarea id="j_description" rows="3">${esc(j.description || '')}</textarea></label>
    <label class="pfl">Notes<textarea id="j_notes" rows="2">${esc(j.notes || '')}</textarea></label>
    <div class="actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">${isNew ? 'Create job' : 'Save'}</button></div>
  </div></div>`;
  const close = () => host.innerHTML = '';
  $('mCancel').onclick = close;
  host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
  $('mOk').onclick = async () => {
    const body = {};
    ['code', 'name', 'department', 'kind', 'complexity', 'est_minutes', 'description', 'notes'].forEach(k => { body[k] = $('j_' + k).value; });
    if (body.kind === 'specific') {
      const est = parseInt(body.est_minutes, 10);
      if (!Number.isFinite(est) || est <= 0) { $('mErr').textContent = 'Estimated minutes is required for a day task (a positive number).'; return; }
    }
    try {
      if (isNew) await api('/schedule/jobs', { method: 'POST', body: JSON.stringify(body) });
      else await api('/schedule/jobs/' + j.id, { method: 'PUT', body: JSON.stringify(body) });
      toast(isNew ? 'Job added' : 'Job updated'); close(); renderJobsCatalog();
    } catch (e) { $('mErr').textContent = e.message; }
  };
}

let staffSearch = '';
let staffLetter = 'A';
const letterOf = (u) => { const L = (u.name.trim()[0] || '#').toUpperCase(); return /[A-Z]/.test(L) ? L : '#'; };
// Editing rights in the Staff directory. Owner/admin edit anyone; managers edit
// their own store's staff (all-location managers: any store) but never an
// owner/admin account. Only owner/admin can Add staff or change access level /
// home location.
const MGR_EDIT_ROLES = ['owner', 'admin', 'general_manager', 'regional_manager', 'manager', 'assistant_manager', 'kitchen_manager'];
const ALL_SCOPE_ROLES = ['owner', 'admin', 'general_manager', 'regional_manager'];
function canEditStaffRow(u) {
  const r = S.user.role;
  if (['owner', 'admin'].includes(r)) return true;
  if (!MGR_EDIT_ROLES.includes(r)) return false;
  if (['owner', 'admin'].includes(u.role)) return false;
  if (ALL_SCOPE_ROLES.includes(r)) return true;
  return String(u.location_id) === String(S.user.location_id);
}
const canEditAccountFields = () => ['owner', 'admin'].includes(S.user.role);
// Load a person's full record, then open the combined edit form.
async function openStaffEdit(id) {
  try {
    const [d, locations, staff] = await Promise.all([
      api('/staff/' + id + '/profile'),
      api('/inventory/locations').catch(() => S.locations || []),
      api('/staff').catch(() => []),
    ]);
    staffProfileEdit(d, locations, staff);
  } catch (e) { toast(e.message, true); }
}

async function renderStaffDirectory() {
  let rows, locations;
  try { [rows, locations] = await Promise.all([api('/staff'), api('/inventory/locations').catch(() => S.locations)]); }
  catch (e) { return renderPlaceholder('Staff', '👥', e.message); }
  const canAdd = ['owner', 'admin'].includes(S.user.role);
  const isManagerish = MGR_EDIT_ROLES.includes(S.user.role);
  const q = staffSearch.trim().toLowerCase();
  const searching = q.length > 0;
  // Which first-letters actually have people (for the A–Z bar).
  const present = new Set(rows.map(letterOf));
  const shown = (searching
    ? rows.filter(u => (u.name + ' ' + u.email + ' ' + (u.phone || '') + ' ' + u.role + ' ' + (u.employee_code || '')).toLowerCase().includes(q))
    : rows.filter(u => letterOf(u) === staffLetter))
    .slice().sort((a, b) => a.name.localeCompare(b.name));

  // A–Z bar (plus '#' only if some name is non-alphabetic).
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat(present.has('#') ? ['#'] : []);
  const bar = letters.map(L => {
    const has = present.has(L);
    const active = !searching && L === staffLetter;
    return `<button type="button" class="ltr${active ? ' active' : ''}" data-ltr="${L}"${has ? '' : ' disabled'}>${L}</button>`;
  }).join('');

  let body = '';
  if (!shown.length) body = `<tr><td colspan="7" class="empty">${searching ? 'No staff match your search.' : 'No staff with names starting “' + staffLetter + '”.'}</td></tr>`;
  else {
    for (const u of shown) {
      const st = staffStatus(u);
      body += `<tr>
        <td><a href="#" class="staff-link" data-prof="${u.id}"><strong>${esc(u.name)}</strong></a>${u.job_title ? `<div class="job-title-sub">${esc(u.job_title)}</div>` : ''}</td>
        <td class="mono">${esc(u.employee_code || '—')}</td>
        <td class="mono">${esc(fmtPhone(u.phone))}</td>
        <td><span class="badge ${ROLE_CHIP[u.role] || 'gray'}">${esc(roleLabel(u.role))}</span></td>
        <td>${esc((u.location_name || 'All locations').replace('Pho Ha Noi — ', ''))}</td>
        <td><span class="badge ${STATUS_CHIP[st] || 'gray'}">${st}</span></td>
        <td><div class="actions-cell">
          <button class="btn sm" data-sact="view" data-id="${u.id}">View</button>
          ${canEditStaffRow(u) ? `<button class="btn sm ghost" data-sact="edit" data-id="${u.id}">Edit</button>
          <button class="btn sm ghost" data-sact="pw" data-id="${u.id}">Reset password</button>
          <button class="btn sm ghost" data-sact="toggle" data-id="${u.id}">${u.is_active ? 'Deactivate' : 'Activate'}</button>` : ''}
        </div></td>
      </tr>`;
    }
  }
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Staff Directory <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${rows.length} accounts</span></h2>
      ${canAdd ? '<button class="btn" id="addStaff">+ Add staff</button>' : (isManagerish ? '' : '<span class="badge gray">View only</span>')}</div>
    <div class="letter-bar">${bar}</div>
    <div style="margin:.7rem 0 1rem"><input id="staffSearch" placeholder="Search all staff by name, phone, code, email or role…" value="${esc(staffSearch)}" style="max-width:340px" />
      ${searching ? `<span style="color:var(--muted);font-size:.85rem;margin-left:.5rem">${shown.length} match${shown.length === 1 ? '' : 'es'}</span>` : ''}</div>
    <div class="table-wrap"><table><thead><tr>
      <th>Name</th><th>Code</th><th>Phone (login)</th><th>Access level</th><th>Location</th><th>Status</th><th>Actions</th>
    </tr></thead><tbody>${body}</tbody></table></div>`;

  // A–Z letter bar — clicking a letter filters to it and clears any search.
  $('view').querySelectorAll('[data-ltr]').forEach(b => b.onclick = () => {
    staffLetter = b.dataset.ltr; staffSearch = ''; renderStaffDirectory();
  });
  const search = $('staffSearch');
  search.oninput = () => { staffSearch = search.value; const pos = search.selectionStart; renderStaffDirectory().then(() => { const s = $('staffSearch'); if (s) { s.focus(); s.setSelectionRange(pos, pos); } }); };
  // Profile link + View button — available to anyone who can see the directory.
  $('view').querySelectorAll('[data-prof]').forEach(a => a.onclick = (e) => { e.preventDefault(); renderStaffProfile(a.dataset.prof); });
  $('view').querySelectorAll('[data-sact]').forEach(b => b.onclick = () => {
    const u = rows.find(x => x.id == b.dataset.id);
    const act = b.dataset.sact;
    if (act === 'view') renderStaffProfile(u.id);
    else if (act === 'edit') openStaffEdit(u.id);
    else if (act === 'pw') resetStaffPassword(u);
    else if (act === 'toggle') toggleStaff(u);
  });
  if (canAdd) $('addStaff').onclick = () => renderStaffAdd(locations);
}

// ── Staff profile (full HR record) ───────────────────────────────────────────
async function renderStaffProfile(id) {
  let d, locations, staff;
  try { [d, locations, staff] = await Promise.all([api('/staff/' + id + '/profile'), api('/inventory/locations').catch(() => S.locations || []), api('/staff').catch(() => [])]); }
  catch (e) { return renderPlaceholder('Staff', '👥', e.message); }
  const canEdit = canEditStaffRow(d);
  const p = d.profile || {};
  const shortLoc = (n) => (n || '').replace('Pho Ha Noi — ', '');
  const locName = (lid) => { const l = (locations || []).find(x => x.id == lid); return l ? shortLoc(l.name) : ''; };
  const assigned = (d.assigned_location_ids || []).map(locName).filter(Boolean).join(', ');
  const F = (l, v) => `<div class="pf"><span class="pl">${l}</span><span class="pv">${v ? esc(v) : '—'}</span></div>`;
  $('view').innerHTML = `
    <div class="row-between">
      <button class="btn sm ghost" id="backDir">← Directory</button>
      ${canEdit ? `<div class="actions-cell">
        <button class="btn sm ghost" id="profPw">Reset password</button>
        <button class="btn sm ghost" id="profToggle">${d.is_active ? 'Deactivate' : 'Activate'}</button>
        <button class="btn" id="editProf">Edit profile</button>
      </div>` : '<span class="badge gray">View only</span>'}
    </div>
    <h2 class="page" style="margin-top:.6rem">${esc(d.name)} <span class="badge ${ROLE_CHIP[d.role] || 'gray'}">${esc(roleLabel(d.role))}</span> ${d.is_active ? '<span class="badge ok">Active</span>' : '<span class="badge out">Inactive</span>'}</h2>
    <p class="sub" style="color:var(--muted);margin-top:0">${p.job_title ? '<strong>' + esc(p.job_title) + '</strong> · ' : ''}${esc(shortLoc(d.location_name) || 'All locations')} · joined ${esc((d.created_at || '').slice(0, 10))}</p>
    <div class="prof-cols">
      <div class="section"><h3>Personal</h3>${F('Preferred name', p.preferred_name)}${F('Legal name', [p.legal_first_name, p.legal_last_name].filter(Boolean).join(' '))}${F('Date of birth', p.dob)}${F('Gender', p.gender)}${F('Employee code', p.employee_code)}</div>
      <div class="section"><h3>Contact</h3>${F('Work email', d.email)}${F('Personal email', p.personal_email)}${F('Mobile', p.phone)}${F('Alt phone', p.alt_phone)}${F('Preferred contact', p.preferred_contact)}</div>
      <div class="section"><h3>Mailing address</h3>${F('Address', [p.address_line1, p.address_line2].filter(Boolean).join(', '))}${F('City', p.city)}${F('State', p.state)}${F('Postal code', p.postal_code)}${F('Country', p.country)}</div>
      <div class="section"><h3>Emergency contact</h3>${F('Name', p.emergency_name)}${F('Relationship', p.emergency_relation)}${F('Phone', p.emergency_phone)}</div>
      <div class="section"><h3>Employment</h3>${F('Job title', p.job_title)}${F('Department', p.department)}${F('Type', p.employment_type)}${F('Hire date', p.hire_date)}${F('Termination date', p.termination_date)}${F('Supervisor', d.supervisor ? d.supervisor.name : '')}${F('Home location', shortLoc(d.location_name) || 'All locations')}${F('Also works at', assigned)}</div>
      <div class="section"><h3>Payroll</h3>${F('Pay type', p.pay_type)}${F('Pay rate', d.hourly_rate ? ('$' + d.hourly_rate + '/hr') : '')}${F('Payroll ref', p.payroll_ref)}<p class="sub" style="color:var(--muted);font-size:.76rem;margin:.5rem 0 0">SSN &amp; bank details are intentionally not stored here — keep those in your payroll provider.</p></div>
      <div class="section" style="grid-column:1/-1"><h3>Skills &amp; notes</h3>${F('Skills / roles', p.skills)}${F('Notes', p.notes)}</div>
    </div>`;
  $('backDir').onclick = () => renderStaffModule();
  if (canEdit) {
    $('editProf').onclick = () => staffProfileEdit(d, locations, staff);
    $('profPw').onclick = () => resetStaffPassword({ id: d.id, name: d.name });
    $('profToggle').onclick = () => {
      modal(`${d.is_active ? 'Deactivate' : 'Activate'} ${d.name}?`, [], async () => {
        await api('/staff/' + d.id, { method: 'PUT', body: JSON.stringify({ is_active: !d.is_active }) });
        toast(d.is_active ? 'Account deactivated' : 'Account activated'); renderStaffProfile(d.id);
      }, d.is_active ? 'Deactivate' : 'Activate');
    };
  }
}

function staffProfileEdit(d, locations, staff) {
  const p = d.profile || {};
  const assigned = new Set((d.assigned_location_ids || []).map(String));
  const inp = (k, label, val, type = 'text') => `<label class="pfl">${label}<input id="pf_${k}" type="${type}" value="${esc(val == null ? '' : val)}" /></label>`;
  const selRaw = (k, label, val, opts) => `<label class="pfl">${label}<select id="pf_${k}">${opts.map(o => `<option value="${esc(o.v)}" ${String(o.v) === String(val || '') ? 'selected' : ''}>${esc(o.n)}</option>`).join('')}</select></label>`;
  const selS = (k, label, val, arr) => selRaw(k, label, val, arr.map(x => ({ v: x, n: x || '—' })));
  const supOpts = [{ v: '', n: '—' }].concat((staff || []).filter(s => s.id != d.id).map(s => ({ v: s.id, n: s.name })));
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Edit — ${esc(d.name)}</h2>
      <div><button class="btn ghost" id="cancelProf">Cancel</button> <button class="btn" id="saveProf">Save</button></div></div>
    <div class="prof-cols">
      <div class="section"><h3>Account</h3>${inp('name', 'Full name', d.name)}
        ${inp('acct_phone', 'Login phone — 10 digits', d.phone || '', 'tel')}
        <label class="pfl">Work email<input type="text" value="${esc(d.email || '')}" disabled title="Email is an optional internal identity; sign-in is by phone" /></label>
        ${canEditAccountFields()
          ? selRaw('role', 'Access level', d.role, accessLevels().filter(r => r !== 'owner' || S.user.role === 'owner').map(r => ({ v: r, n: roleLabel(r) })))
            + selRaw('location_id', 'Home location', d.location_id || '', [{ v: '', n: 'All locations (owner/admin)' }].concat((locations || []).map(l => ({ v: l.id, n: (l.name || '').replace('Pho Ha Noi — ', '') }))))
          : `<label class="pfl">Access level<input type="text" value="${esc(roleLabel(d.role))}" disabled /></label><label class="pfl">Home location<input type="text" value="${esc((d.location_name || 'All locations').replace('Pho Ha Noi — ', ''))}" disabled /></label>`}</div>
      <div class="section"><h3>Personal</h3>${inp('preferred_name', 'Preferred name', p.preferred_name)}${inp('legal_first_name', 'Legal first name', p.legal_first_name)}${inp('legal_last_name', 'Legal last name', p.legal_last_name)}${inp('dob', 'Date of birth', p.dob, 'date')}${inp('gender', 'Gender', p.gender)}${inp('employee_code', 'Employee code', p.employee_code)}</div>
      <div class="section"><h3>Contact</h3>${inp('personal_email', 'Personal email', p.personal_email, 'email')}${inp('phone', 'Mobile', p.phone)}${inp('alt_phone', 'Alt phone', p.alt_phone)}${selS('preferred_contact', 'Preferred contact', p.preferred_contact, ['', 'email', 'phone', 'text'])}</div>
      <div class="section"><h3>Mailing address</h3>${inp('address_line1', 'Address line 1', p.address_line1)}${inp('address_line2', 'Address line 2', p.address_line2)}${inp('city', 'City', p.city)}${inp('state', 'State', p.state)}${inp('postal_code', 'Postal code', p.postal_code)}${inp('country', 'Country', p.country || 'USA')}</div>
      <div class="section"><h3>Emergency contact</h3>${inp('emergency_name', 'Name', p.emergency_name)}${inp('emergency_relation', 'Relationship', p.emergency_relation)}${inp('emergency_phone', 'Phone', p.emergency_phone)}</div>
      <div class="section"><h3>Employment</h3>${dlInput('job_title', 'Job title', p.job_title, JOB_TITLES)}${inp('department', 'Department', p.department)}${selS('employment_type', 'Type', p.employment_type, ['', 'full_time', 'part_time', 'seasonal', 'contract'])}${selS('status', 'Status', p.status || 'active', ['active', 'vacation', 'sick', 'on_leave', 'inactive'])}${inp('hire_date', 'Hire date', p.hire_date, 'date')}${inp('termination_date', 'Termination date', p.termination_date, 'date')}${selRaw('supervisor_id', 'Supervisor', p.supervisor_id, supOpts)}</div>
      <div class="section"><h3>Payroll</h3>${selS('pay_type', 'Pay type', p.pay_type, ['', 'hourly', 'salary'])}${inp('hourly_rate', 'Pay rate ($/hr)', d.hourly_rate, 'number')}${inp('payroll_ref', 'Payroll reference', p.payroll_ref)}</div>
      <div class="section"><h3>Also works at (transfers)</h3><div class="loc-checks">${(locations || []).map(l => `<label class="chk"><input type="checkbox" data-loc="${l.id}" ${assigned.has(String(l.id)) ? 'checked' : ''} /> ${esc((l.name || '').replace('Pho Ha Noi — ', ''))}</label>`).join('')}</div></div>
      <div class="section" style="grid-column:1/-1"><h3>Skills &amp; notes</h3>${inp('skills', 'Skills / roles (comma-separated)', p.skills)}<label class="pfl">Notes<textarea id="pf_notes" rows="3">${esc(p.notes || '')}</textarea></label></div>
    </div>`;
  $('cancelProf').onclick = () => renderStaffProfile(d.id);
  $('saveProf').onclick = async () => {
    const body = {};
    $('view').querySelectorAll('[id^="pf_"]').forEach(el => { body[el.id.slice(3)] = el.value; });
    body.assigned_location_ids = [...$('view').querySelectorAll('[data-loc]:checked')].map(c => c.dataset.loc);
    // Split account fields (users table) from HR profile fields. Access level and
    // home location only travel when the editor is owner/admin.
    const account = {};
    if (body.name !== undefined) { account.name = body.name; delete body.name; }
    // Login phone lives on the account (users table), not the HR profile.
    if (body.acct_phone !== undefined) {
      const digits = (body.acct_phone || '').replace(/\D+/g, '');
      delete body.acct_phone;
      if (digits) { if (digits.length !== 10) { toast('Login phone must be 10 digits.', true); return; } account.phone = digits; }
    }
    if (canEditAccountFields()) {
      if (body.role !== undefined) { account.role = body.role; delete body.role; }
      if (body.location_id !== undefined) { account.location_id = body.location_id; delete body.location_id; }
    } else { delete body.role; delete body.location_id; }
    try {
      if (Object.keys(account).length) await api('/staff/' + d.id, { method: 'PUT', body: JSON.stringify(account) });
      await api('/staff/' + d.id + '/profile', { method: 'PUT', body: JSON.stringify(body) });
      toast('Staff saved'); renderStaffProfile(d.id);
    } catch (e) { toast(e.message, true); }
  };
}

function locFieldOptions(locations, selected, includeAll) {
  const opts = includeAll ? [{ value: '', label: 'All locations (owner/admin)' }] : [];
  return opts.concat(locations.map(l => ({ value: l.id, label: l.name.replace('Pho Ha Noi — ', '') })));
}
function resetStaffPassword(u) {
  modal(`Reset password — ${u.name}`, [{ key: 'new_password', label: 'New password (min 8 chars)', type: 'password' }],
    async (v) => { await api(`/staff/${u.id}/reset-password`, { method: 'POST', body: JSON.stringify(v) }); toast('Password reset'); }, 'Reset password');
}
function toggleStaff(u) {
  modal(`${u.is_active ? 'Deactivate' : 'Activate'} ${u.name}?`, [], async () => {
    await api('/staff/' + u.id, { method: 'PUT', body: JSON.stringify({ is_active: !u.is_active }) });
    toast(u.is_active ? 'Account deactivated' : 'Account activated'); renderStaffModule();
  }, u.is_active ? 'Deactivate' : 'Activate');
}

// Full add-staff form (account + complete profile in one go).
function renderStaffAdd(locations) {
  const inp = (k, label, val, type = 'text') => `<label class="pfl">${label}<input id="pf_${k}" type="${type}" value="${esc(val == null ? '' : val)}" /></label>`;
  const selRaw = (k, label, val, opts) => `<label class="pfl">${label}<select id="pf_${k}">${opts.map(o => `<option value="${esc(o.v)}" ${String(o.v) === String(val || '') ? 'selected' : ''}>${esc(o.n)}</option>`).join('')}</select></label>`;
  const selS = (k, label, val, arr) => selRaw(k, label, val, arr.map(x => ({ v: x, n: x || '—' })));
  const roleOpts = accessLevels().filter(r => r !== 'owner' || S.user.role === 'owner').map(r => ({ v: r, n: roleLabel(r) }));
  const locOpts = [{ v: '', n: 'All locations (owner/admin)' }].concat((locations || []).map(l => ({ v: l.id, n: (l.name || '').replace('Pho Ha Noi — ', '') })));
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Add staff</h2>
      <div><button class="btn ghost" id="cancelAdd">Cancel</button> <button class="btn" id="saveAdd">Create account</button></div></div>
    <div class="err" id="addErr"></div>
    <div class="prof-cols">
      <div class="section"><h3>Account</h3>${inp('name', 'Full name', '')}${inp('acct_phone', 'Phone (login) — 10 digits', '', 'tel')}${inp('email', 'Email (optional)', '', 'email')}${inp('password', 'Temporary password (min 8)', '', 'password')}${selRaw('role', 'Access level', 'employee', roleOpts)}${selRaw('location_id', 'Home location', '', locOpts)}</div>
      <div class="section"><h3>Personal</h3>${inp('preferred_name', 'Preferred name', '')}${inp('legal_first_name', 'Legal first name', '')}${inp('legal_last_name', 'Legal last name', '')}${inp('dob', 'Date of birth', '', 'date')}${inp('gender', 'Gender', '')}${inp('employee_code', 'Employee code', '')}</div>
      <div class="section"><h3>Contact</h3>${inp('personal_email', 'Personal email', '', 'email')}${inp('phone', 'Mobile', '')}${inp('alt_phone', 'Alt phone', '')}${selS('preferred_contact', 'Preferred contact', '', ['', 'email', 'phone', 'text'])}</div>
      <div class="section"><h3>Mailing address</h3>${inp('address_line1', 'Address line 1', '')}${inp('address_line2', 'Address line 2', '')}${inp('city', 'City', '')}${inp('state', 'State', '')}${inp('postal_code', 'Postal code', '')}${inp('country', 'Country', 'USA')}</div>
      <div class="section"><h3>Emergency contact</h3>${inp('emergency_name', 'Name', '')}${inp('emergency_relation', 'Relationship', '')}${inp('emergency_phone', 'Phone', '')}</div>
      <div class="section"><h3>Employment</h3>${dlInput('job_title', 'Job title', '', JOB_TITLES)}${inp('department', 'Department', '')}${selS('employment_type', 'Type', '', ['', 'full_time', 'part_time', 'seasonal', 'contract'])}${selS('status', 'Status', 'active', ['active', 'vacation', 'sick', 'on_leave', 'inactive'])}${inp('hire_date', 'Hire date', '', 'date')}</div>
      <div class="section"><h3>Payroll</h3>${selS('pay_type', 'Pay type', '', ['', 'hourly', 'salary'])}${inp('hourly_rate', 'Pay rate ($/hr)', '', 'number')}${inp('payroll_ref', 'Payroll reference', '')}</div>
      <div class="section"><h3>Also works at (transfers)</h3><div class="loc-checks">${(locations || []).map(l => `<label class="chk"><input type="checkbox" data-loc="${l.id}" /> ${esc((l.name || '').replace('Pho Ha Noi — ', ''))}</label>`).join('')}</div></div>
      <div class="section" style="grid-column:1/-1"><h3>Skills &amp; notes</h3>${inp('skills', 'Skills / roles (comma-separated)', '')}<label class="pfl">Notes<textarea id="pf_notes" rows="3"></textarea></label></div>
    </div>`;
  $('cancelAdd').onclick = () => { S.staffTab = 'directory'; renderStaffTabs(); renderStaffModule(); };
  $('saveAdd').onclick = async () => {
    $('addErr').textContent = '';
    const get = (k) => { const el = $('pf_' + k); return el ? el.value : ''; };
    const name = get('name'), email = get('email'), password = get('password'), role = get('role'), location_id = get('location_id');
    const phone = get('acct_phone'), phoneDigits = phone.replace(/\D+/g, '');
    if (!name || !phone || !password) { $('addErr').textContent = 'Name, phone number and temporary password are required.'; return; }
    if (phoneDigits.length !== 10) { $('addErr').textContent = 'Phone number must be exactly 10 digits.'; return; }
    if (password.length < 8) { $('addErr').textContent = 'Password must be at least 8 characters.'; return; }
    try {
      const created = await api('/staff', { method: 'POST', body: JSON.stringify({ name, phone: phoneDigits, email: email || undefined, password, role, location_id: location_id || undefined }) });
      const accountKeys = new Set(['name', 'acct_phone', 'email', 'password', 'role', 'location_id']);
      const body = {};
      $('view').querySelectorAll('[id^="pf_"]').forEach(el => { const k = el.id.slice(3); if (!accountKeys.has(k)) body[k] = el.value; });
      body.assigned_location_ids = [...$('view').querySelectorAll('[data-loc]:checked')].map(c => c.dataset.loc);
      await api('/staff/' + created.id + '/profile', { method: 'PUT', body: JSON.stringify(body) });
      toast('Staff account created');
      renderStaffProfile(created.id);
    } catch (e) { $('addErr').textContent = e.message; }
  };
}

function renderAccessLevels() {
  const CAP_ORDER = ['org', 'manage', 'ops', 'reports', 'central', 'delivery'];
  const rows = accessLevels().map(r => {
    const d = roleDef(r);
    const caps = CAP_ORDER.filter(c => d.caps.includes(c)).map(c => CAP_LABEL[c]);
    const summary = caps.length ? caps.join(' · ') : 'Own schedule, tasks & messages only';
    return { r, d, summary };
  });
  $('view').innerHTML = `
    <h2 class="page">Access Levels <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${rows.length}</span></h2>
    <p class="sub" style="color:var(--muted);margin-top:-.4rem">Every access level and what it can do. <strong>Scope</strong> = how much it can see: all locations, its own location, or just the person's own schedule. Job titles (Server, Chef, Front Desk, …) are self-service levels — same access, different position.</p>
    <div class="table-wrap"><table><thead><tr><th>Access level</th><th>Scope</th><th>Can do</th></tr></thead><tbody>
      ${rows.map(({ r, d, summary }) => `<tr>
        <td><span class="badge ${roleChip(r)}">${esc(d.label)}</span></td>
        <td><strong>${esc(SCOPE_LABEL[d.scope] || d.scope)}</strong></td>
        <td style="color:#374151">${esc(summary)}</td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

// ── Placeholder section (modules land here later) ──────────────────────────
function renderPlaceholder(title, icon, subtitle) {
  $('pageTitle').textContent = title;
  $('view').innerHTML = `
    <div class="placeholder">
      <div class="ph-icon">${icon}</div>
      <h2>${esc(title)}</h2>
      <p>${esc(subtitle || '')}</p>
      <p class="ph-note">This section is ready for its modules — horizontal tabs will go here, just like Inventory.</p>
    </div>`;
}

// ── Menu / Recipes module (horizontal tabs) ────────────────────────────────
const MENU_TABS = [['menu', 'Menu'], ['recipes', 'Recipes'], ['costing', 'Costing']];
function renderMenuTabs() {
  $('tabs').innerHTML = MENU_TABS.map(([k, l]) => `<button data-mtab="${k}" class="${S.menuTab === k ? 'active' : ''}">${l}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach(b => b.onclick = () => { S.menuTab = b.dataset.mtab; renderMenuTabs(); renderMenu(); });
}
function renderMenu() {
  $('view').innerHTML = '<div class="empty">Loading…</div>';
  ({ menu: renderMenuList, recipes: renderRecipes, costing: renderCosting }[S.menuTab])();
}
function foodPctBadge(pct) {
  if (pct == null) return '<span class="badge gray">—</span>';
  const tone = pct <= 30 ? 'ok' : (pct <= 40 ? 'low' : 'out');
  return `<span class="badge ${tone}">${pct}%</span>`;
}
const foodClass = (pct) => pct == null ? '' : (pct <= 30 ? '' : (pct <= 40 ? 'warn' : 'bad'));

async function renderMenuList() {
  const [items, cats] = await Promise.all([api('/menu/items'), api('/menu/categories')]);
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Menu <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${items.length} items</span></h2>
      <div style="display:flex;gap:.5rem"><button class="btn ghost" id="addCat">+ Category</button><button class="btn" id="addMenuItem">+ Menu item</button></div></div>
    <div class="table-wrap"><table><thead><tr>
      <th>Item</th><th>Category</th><th class="num">Price</th><th class="num">Recipe cost</th><th>Food %</th><th>Description</th><th>Actions</th>
    </tr></thead><tbody>
      ${items.length ? items.map(m => `<tr>
        <td><strong>${esc(m.name)}</strong>${m.is_active ? '' : ' <span class="badge gray">inactive</span>'}</td>
        <td>${esc(m.category_name || '—')}</td>
        <td class="num">${money(m.price)}</td>
        <td class="num">${m.ingredient_count ? money(m.recipe_cost) : '<span style="color:var(--muted)">no recipe</span>'}</td>
        <td>${m.ingredient_count ? foodPctBadge(m.food_cost_pct) : '—'}</td>
        <td style="max-width:240px;color:#374151">${esc(m.description || '')}</td>
        <td><div class="actions-cell">
          <button class="btn sm" data-mact="recipe" data-id="${m.id}">Recipe (${m.ingredient_count})</button>
          <button class="btn sm ghost" data-mact="edit" data-id="${m.id}">Edit</button>
          <button class="btn sm ghost" data-mact="del" data-id="${m.id}">Delete</button>
        </div></td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty">No menu items yet.</td></tr>'}
    </tbody></table></div>`;
  $('addCat').onclick = () => modal('Add category', [
    { key: 'name', label: 'Category name' }, { key: 'sort_order', label: 'Sort order', type: 'number', value: cats.length },
  ], async (v) => { await api('/menu/categories', { method: 'POST', body: JSON.stringify(v) }); toast('Category added'); renderMenu(); });
  $('addMenuItem').onclick = () => menuItemModal(null, cats);
  $('view').querySelectorAll('[data-mact]').forEach(b => b.onclick = () => {
    const m = items.find(x => x.id == b.dataset.id);
    if (b.dataset.mact === 'recipe') { recipeEdit.itemId = m.id; S.menuTab = 'recipes'; renderMenuTabs(); renderMenu(); }
    else if (b.dataset.mact === 'edit') menuItemModal(m, cats);
    else if (b.dataset.mact === 'del') modal(`Delete “${m.name}”?`, [], async () => { await api('/menu/items/' + m.id, { method: 'DELETE' }); toast('Menu item deleted'); renderMenu(); }, 'Delete');
  });
}

function menuItemModal(m, cats) {
  const isNew = !m;
  modal(isNew ? 'Add menu item' : `Edit — ${m.name}`, [
    { key: 'name', label: 'Item name', value: m ? m.name : '' },
    { key: 'category_id', label: 'Category', type: 'select', options: cats.map(c => ({ value: c.id, label: c.name })), value: m ? m.category_id : (cats[0] && cats[0].id) },
    { key: 'price', label: 'Price ($)', type: 'number', step: '0.01', value: m ? m.price : 0 },
    { key: 'description', label: 'Description', value: m ? m.description : '' },
  ], async (v) => {
    if (isNew) { await api('/menu/items', { method: 'POST', body: JSON.stringify(v) }); toast('Menu item added'); }
    else { await api('/menu/items/' + m.id, { method: 'PUT', body: JSON.stringify(v) }); toast('Menu item updated'); }
    renderMenu();
  }, isNew ? 'Add item' : 'Save');
}

// Recipes editor
let recipeEdit = { itemId: null, list: [] };
let ingCostMap = {};
async function renderRecipes() {
  const [items, ingredients] = await Promise.all([api('/menu/items'), api('/menu/ingredients')]);
  ingCostMap = {}; ingredients.forEach(i => { ingCostMap[i.item_name] = { unit: i.unit, avg_cost: i.avg_cost }; });
  if (!items.length) { $('view').innerHTML = '<div class="empty">Add a menu item first.</div>'; return; }
  const selId = items.some(m => m.id == recipeEdit.itemId) ? recipeEdit.itemId : items[0].id;
  recipeEdit.itemId = selId;
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Recipes</h2>
      <select id="recItem">${items.map(m => `<option value="${m.id}" ${m.id == selId ? 'selected' : ''}>${esc(m.name)} — ${money(m.price)}</option>`).join('')}</select></div>
    <div id="recipeEditor"><div class="empty">Loading…</div></div>`;
  $('recItem').onchange = () => { recipeEdit.itemId = $('recItem').value; loadRecipe(ingredients); };
  loadRecipe(ingredients);
}
async function loadRecipe(ingredients) {
  const data = await api(`/menu/items/${recipeEdit.itemId}/recipe`);
  recipeEdit.list = data.ingredients.map(i => ({ item_name: i.item_name, quantity: i.quantity }));
  renderRecipeEditor(ingredients, data.item);
}
const recipeCost = () => recipeEdit.list.reduce((s, i) => s + i.quantity * ((ingCostMap[i.item_name] || {}).avg_cost || 0), 0);
function renderRecipeEditor(ingredients, item) {
  const cost = recipeCost(), price = item.price;
  const foodPct = price > 0 ? Math.round(cost / price * 1000) / 10 : null;
  $('recipeEditor').innerHTML = `
    <div class="kpis">
      <div class="card"><div class="label">Menu price</div><div class="value">${money(price)}</div></div>
      <div class="card"><div class="label">Recipe cost</div><div class="value">${money(cost)}</div></div>
      <div class="card"><div class="label">Food cost %</div><div class="value ${foodClass(foodPct)}">${foodPct == null ? '—' : foodPct + '%'}</div></div>
      <div class="card"><div class="label">Margin</div><div class="value">${money(price - cost)}</div></div>
    </div>
    <div class="section">
      <div class="table-wrap"><table><thead><tr><th>Ingredient</th><th class="num">Qty</th><th>Unit</th><th class="num">Unit cost</th><th class="num">Line cost</th><th></th></tr></thead><tbody>
        ${recipeEdit.list.length ? recipeEdit.list.map((i, idx) => { const c = ingCostMap[i.item_name] || { unit: '', avg_cost: 0 }; return `<tr>
          <td>${esc(i.item_name)}</td><td class="num">${numf(i.quantity)}</td><td>${esc(c.unit)}</td><td class="num">${money(c.avg_cost)}</td><td class="num">${money(i.quantity * c.avg_cost)}</td>
          <td><button class="btn sm ghost" data-rmrec="${idx}">Remove</button></td></tr>`; }).join('') : '<tr><td colspan="6" class="empty">No ingredients yet — add some below.</td></tr>'}
      </tbody></table></div>
      <div class="rec-add">
        <select id="recIng">${ingredients.map(i => `<option value="${esc(i.item_name)}">${esc(i.item_name)} (${esc(i.unit)}, ${money(i.avg_cost)})</option>`).join('')}</select>
        <input id="recQty" type="number" step="0.01" placeholder="Qty per serving" />
        <button class="btn ghost" id="recAdd">+ Add ingredient</button>
        <button class="btn" id="recSave" style="margin-left:auto">Save recipe</button>
      </div>
    </div>`;
  $('recipeEditor').querySelectorAll('[data-rmrec]').forEach(b => b.onclick = () => { recipeEdit.list.splice(+b.dataset.rmrec, 1); renderRecipeEditor(ingredients, item); });
  $('recAdd').onclick = () => {
    const name = $('recIng').value, q = parseFloat($('recQty').value);
    if (!name || !(q > 0)) { toast('Pick an ingredient and a quantity', true); return; }
    const ex = recipeEdit.list.find(x => x.item_name === name);
    if (ex) ex.quantity = Math.round((ex.quantity + q) * 1000) / 1000; else recipeEdit.list.push({ item_name: name, quantity: q });
    renderRecipeEditor(ingredients, item);
  };
  $('recSave').onclick = async () => {
    try { await api(`/menu/items/${recipeEdit.itemId}/recipe`, { method: 'PUT', body: JSON.stringify({ ingredients: recipeEdit.list }) }); toast('Recipe saved'); }
    catch (e) { toast(e.message, true); }
  };
}

async function renderCosting() {
  const data = await api('/menu/costing');
  $('view').innerHTML = `
    <h2 class="page">Costing <span style="font-weight:400;color:var(--muted);font-size:.9rem">— recipe cost & food-cost %</span></h2>
    <div class="kpis">
      <div class="card"><div class="label">Priced items</div><div class="value">${data.priced_count}</div></div>
      <div class="card"><div class="label">Avg food cost %</div><div class="value ${foodClass(data.avg_food_cost_pct)}">${data.avg_food_cost_pct == null ? '—' : data.avg_food_cost_pct + '%'}</div></div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th>Category</th><th class="num">Price</th><th class="num">Recipe cost</th><th class="num">Margin</th><th>Food cost %</th></tr></thead><tbody>
      ${data.items.map(m => `<tr>
        <td><strong>${esc(m.name)}</strong></td>
        <td>${esc(m.category_name || '—')}</td>
        <td class="num">${money(m.price)}</td>
        <td class="num">${m.ingredient_count ? money(m.recipe_cost) : '—'}</td>
        <td class="num">${m.ingredient_count ? money(m.margin) : '—'}</td>
        <td>${m.ingredient_count ? foodPctBadge(m.food_cost_pct) : '<span class="badge gray">no recipe</span>'}</td>
      </tr>`).join('')}
    </tbody></table></div>
    <p class="sub" style="margin-top:.8rem;color:var(--muted)">Food cost % uses each ingredient's average inventory unit cost across active locations. Target: ≤ 30% (green), 30–40% (amber), &gt; 40% (red).</p>`;
}

// ── Reports module (horizontal tabs) ───────────────────────────────────────
const REPORT_TABS = [['inventory', 'Items'], ['sales', 'Sales'], ['analytics', 'Analytics'], ['timesheets', 'Timesheets'], ['payments', 'Payments']];
const reportFilter = { loc: '', start: daysAgoISO(29), end: daysAgoISO(0) };
function daysAgoISO(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

function renderReportTabs() {
  $('tabs').innerHTML = REPORT_TABS.map(([k, l]) => `<button data-rtab="${k}" class="${S.reportTab === k ? 'active' : ''}">${l}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach(b => b.onclick = () => { S.reportTab = b.dataset.rtab; renderReportTabs(); renderReportModule(); });
}
function renderReportModule() {
  $('view').innerHTML = '<div class="empty">Loading…</div>';
  ({ inventory: renderRepItems, sales: renderRepSales, analytics: renderRepAnalytics, timesheets: renderRepTimesheets, payments: renderRepPayments }[S.reportTab])();
}
const shortLoc = (s) => (s || '').replace('Pho Ha Noi — ', '');
function reportFilters(withDates) {
  const seesAll = ['owner', 'admin'].includes(S.user.role);
  const loc = seesAll ? `<div class="field"><label>Location</label><select id="rfLoc"><option value="">All 10 locations</option>${S.locations.map(l => `<option value="${l.id}" ${String(reportFilter.loc) === String(l.id) ? 'selected' : ''}>${esc(shortLoc(l.name))}</option>`).join('')}</select></div>` : '';
  const dates = withDates ? `<div class="field"><label>From</label><input id="rfStart" type="date" value="${reportFilter.start}"></div><div class="field"><label>To</label><input id="rfEnd" type="date" value="${reportFilter.end}"></div>` : '';
  return (loc || dates) ? `<div class="filters">${loc}${dates}</div>` : '';
}
function wireReportFilters(withDates) {
  const bind = () => { const l = $('rfLoc'); if (l) reportFilter.loc = l.value; if (withDates) { reportFilter.start = $('rfStart').value; reportFilter.end = $('rfEnd').value; } renderReportModule(); };
  ['rfLoc', 'rfStart', 'rfEnd'].forEach(id => { const el = $(id); if (el) el.onchange = bind; });
}
function reportQuery(withDates) {
  const p = new URLSearchParams();
  if (reportFilter.loc) p.set('location_id', reportFilter.loc);
  if (withDates) { if (reportFilter.start) p.set('start', reportFilter.start); if (reportFilter.end) p.set('end', reportFilter.end); }
  const s = p.toString(); return s ? '?' + s : '';
}
function barTable(rows) {
  return `<div class="table-wrap"><table><tbody>${rows.map(([label, val, pct]) => `<tr>
    <td style="width:32%">${esc(label)}</td><td class="num" style="width:20%">${val}</td>
    <td><div style="background:var(--gold-soft);border-radius:6px;height:14px"><div style="background:var(--gold);height:14px;border-radius:6px;width:${Math.max(1, pct).toFixed(0)}%"></div></div></td></tr>`).join('')}</tbody></table></div>`;
}

async function renderRepItems() {
  const d = await api('/reports/inventory' + reportQuery(false));
  const maxCat = Math.max(1, ...d.by_category.map(c => c.value)), maxLoc = Math.max(1, ...d.by_location.map(l => l.value));
  $('view').innerHTML = `${reportFilters(false)}
    <div class="kpis">
      <div class="card"><div class="label">Inventory value</div><div class="value">${money(d.total_value)}</div></div>
      <div class="card"><div class="label">Items tracked</div><div class="value">${d.item_count}</div></div>
      <div class="card"><div class="label">Below minimum</div><div class="value ${d.low_stock ? 'warn' : ''}">${d.low_stock}</div></div>
      <div class="card"><div class="label">Consumed (30d COGS)</div><div class="value">${money(d.consumed_cost_30d)}</div></div>
    </div>
    <div class="section"><h3>Value by category</h3>${barTable(d.by_category.map(c => [c.category, money(c.value), c.value / maxCat * 100]))}</div>
    ${d.by_location.length > 1 ? `<div class="section"><h3>Value by location</h3>${barTable(d.by_location.map(l => [shortLoc(l.location), money(l.value), l.value / maxLoc * 100]))}</div>` : ''}
    <div class="section"><h3>Top items by value</h3>
      <div class="table-wrap"><table><thead><tr><th>Item</th><th>Location</th><th class="num">Qty</th><th class="num">Value</th></tr></thead><tbody>
        ${d.top_items.map(t => `<tr><td>${esc(t.item_name)}</td><td>${esc(shortLoc(t.location))}</td><td class="num">${numf(t.quantity)} ${esc(t.unit)}</td><td class="num">${money(t.value)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  wireReportFilters(false);
}

async function renderRepSales() {
  const d = await api('/reports/sales' + reportQuery(true));
  const maxDay = Math.max(1, ...d.by_day.map(x => x.revenue)), maxLoc = Math.max(1, ...d.by_location.map(x => x.revenue));
  $('view').innerHTML = `${reportFilters(true)}
    <div class="kpis">
      <div class="card"><div class="label">Total revenue</div><div class="value">${money(d.total_revenue)}</div></div>
      <div class="card"><div class="label">Covers</div><div class="value">${numf(d.total_covers)}</div></div>
      <div class="card"><div class="label">Avg check</div><div class="value">${money(d.avg_check)}</div></div>
      <div class="card"><div class="label">Avg daily</div><div class="value">${money(d.avg_daily)}</div></div>
    </div>
    ${d.by_location.length > 1 ? `<div class="section"><h3>Revenue by location</h3>${barTable(d.by_location.map(l => [shortLoc(l.location), money(l.revenue), l.revenue / maxLoc * 100]))}</div>` : ''}
    <div class="section"><h3>Daily revenue</h3>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th class="num">Revenue</th><th class="num">Covers</th><th class="num">Food</th><th class="num">Bev</th><th style="width:28%">Trend</th></tr></thead><tbody>
        ${d.by_day.map(x => `<tr><td>${esc(x.day)}</td><td class="num">${money(x.revenue)}</td><td class="num">${numf(x.covers)}</td><td class="num">${money(x.food)}</td><td class="num">${money(x.beverage)}</td><td><div style="background:var(--gold-soft);border-radius:6px;height:12px"><div style="background:var(--gold);height:12px;border-radius:6px;width:${(x.revenue / maxDay * 100).toFixed(0)}%"></div></div></td></tr>`).join('')}
      </tbody></table></div></div>`;
  wireReportFilters(true);
}

async function renderRepAnalytics() {
  const d = await api('/reports/analytics' + reportQuery(true));
  const maxT = Math.max(1, ...d.revenue_trend.map(x => x.revenue)), maxL = Math.max(1, ...d.by_location.map(x => x.revenue));
  $('view').innerHTML = `${reportFilters(true)}
    <div class="kpis">
      <div class="card"><div class="label">Revenue</div><div class="value">${money(d.revenue)}</div></div>
      <div class="card"><div class="label">Avg daily</div><div class="value">${money(d.avg_daily)}</div></div>
      <div class="card"><div class="label">Food cost %</div><div class="value ${foodClass(d.food_cost_pct)}">${d.food_cost_pct == null ? '—' : d.food_cost_pct + '%'}</div></div>
      <div class="card"><div class="label">Labor cost %</div><div class="value ${d.labor_cost_pct > 30 ? 'warn' : ''}">${d.labor_cost_pct == null ? '—' : d.labor_cost_pct + '%'}</div></div>
      <div class="card"><div class="label">Inventory value</div><div class="value">${money(d.inventory_value)}</div></div>
    </div>
    <div class="section"><h3>Highlights</h3>
      <p style="margin:0">Best location: <strong>${esc(shortLoc(d.best_location) || '—')}</strong> · Lowest: <strong>${esc(shortLoc(d.lowest_location) || '—')}</strong> · Avg check: <strong>${money(d.avg_check)}</strong> · Labor cost: <strong>${money(d.labor_cost)}</strong></p></div>
    <div class="section"><h3>Revenue trend</h3>${barTable(d.revenue_trend.map(x => [x.day, money(x.revenue), x.revenue / maxT * 100]))}</div>
    ${d.by_location.length > 1 ? `<div class="section"><h3>Revenue by location</h3>${barTable(d.by_location.map(l => [shortLoc(l.location), money(l.revenue), l.revenue / maxL * 100]))}</div>` : ''}`;
  wireReportFilters(true);
}

async function renderRepTimesheets() {
  const d = await api('/reports/timesheets' + reportQuery(true));
  $('view').innerHTML = `${reportFilters(true)}
    <div class="kpis">
      <div class="card"><div class="label">Total hours</div><div class="value">${numf(d.total_hours)}</div></div>
      <div class="card"><div class="label">Labor cost</div><div class="value">${money(d.total_labor_cost)}</div></div>
      <div class="card"><div class="label">Staff</div><div class="value">${d.headcount}</div></div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Staff</th><th>Role</th><th>Location</th><th class="num">Shifts</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Labor cost</th></tr></thead><tbody>
      ${d.by_staff.length ? d.by_staff.map(s => `<tr><td><strong>${esc(s.name)}</strong></td><td><span class="badge ${ROLE_CHIP[s.role] || 'gray'}">${esc(roleLabel(s.role))}</span></td><td>${esc(shortLoc(s.location) || '—')}</td><td class="num">${s.shifts}</td><td class="num">${numf(s.hours)}</td><td class="num">${money(s.hourly_rate)}/hr</td><td class="num">${money(s.labor_cost)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">No timesheets in range.</td></tr>'}
    </tbody></table></div>`;
  wireReportFilters(true);
}

async function renderRepPayments() {
  const d = await api('/reports/payments' + reportQuery(true));
  const t = d.totals, total = t.total || 0, pct = (v) => total ? (v / total * 100).toFixed(1) + '%' : '—';
  $('view').innerHTML = `${reportFilters(true)}
    <div class="kpis">
      <div class="card"><div class="label">Total collected</div><div class="value">${money(total)}</div></div>
      <div class="card"><div class="label">Cash · ${pct(t.cash)}</div><div class="value">${money(t.cash)}</div></div>
      <div class="card"><div class="label">Card · ${pct(t.card)}</div><div class="value">${money(t.card)}</div></div>
      <div class="card"><div class="label">Online · ${pct(t.online)}</div><div class="value">${money(t.online)}</div></div>
    </div>
    ${d.by_location.length > 1 ? `<div class="section"><h3>By location</h3>
      <div class="table-wrap"><table><thead><tr><th>Location</th><th class="num">Cash</th><th class="num">Card</th><th class="num">Online</th><th class="num">Total</th></tr></thead><tbody>
        ${d.by_location.map(l => `<tr><td>${esc(shortLoc(l.location))}</td><td class="num">${money(l.cash)}</td><td class="num">${money(l.card)}</td><td class="num">${money(l.online)}</td><td class="num"><strong>${money(l.total)}</strong></td></tr>`).join('')}
      </tbody></table></div></div>` : ''}`;
  wireReportFilters(true);
}

// ── Messages module (horizontal tabs) ──────────────────────────────────────
// ── Floor alerts (Management side): compose + track acknowledgements ──────────
const ALERT_PRESETS = [
  'Help table {n} right away', 'Bring food from the kitchen to table {n}', 'Clear & clean table {n}',
  'Table {n} needs a refill / bus', 'Come to the front desk', 'Check on your section',
];
const ALERT_ROLE_LABEL = { server: 'Servers', host: 'Hosts', busser: 'Bussers', support: 'Support', employee: 'Staff', chef: 'Kitchen', driver: 'Drivers' };
const ALERT_SEES_ALL = ['owner', 'admin', 'general_manager', 'regional_manager'];

function alertCue() {
  try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch { /* unsupported */ }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
    const ac = new Ctx(); const o = ac.createOscillator(); const g = ac.createGain();
    o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
    g.gain.setValueAtTime(0.001, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.5);
    o.start(); o.stop(ac.currentTime + 0.5); setTimeout(() => { try { ac.close(); } catch {} }, 800);
  } catch { /* audio blocked until a gesture — the visual pop-up still shows */ }
}
const _shownAlerts = new Set();
function showAlertPopup(a) {
  if (!a || _shownAlerts.has(a.id)) return;
  _shownAlerts.add(a.id); alertCue();
  const host = document.createElement('div'); host.className = 'alert-pop';
  host.innerHTML = `<div class="alert-pop-card ${a.priority === 'urgent' ? 'urgent' : ''}">
    <div class="alert-pop-top">🔔 ${a.priority === 'urgent' ? 'URGENT ALERT' : 'Alert'}</div>
    <div class="alert-pop-body">${esc(a.body)}</div>
    <div class="alert-pop-from">from ${esc(a.sender_name || 'Management')}</div>
    <div class="alert-pop-actions"><button class="btn ghost" data-dismiss>Dismiss</button><button class="btn" data-ack>✓ On it</button></div>
  </div>`;
  document.body.appendChild(host);
  const close = () => host.remove();
  host.querySelector('[data-dismiss]').onclick = close;
  host.querySelector('[data-ack]').onclick = async () => {
    try { await api(`/alerts/${a.id}/ack`, { method: 'POST', body: '{}' }); toast('Acknowledged'); } catch (e) { toast(e.message, true); }
    close();
  };
}

async function renderFloorAlerts() {
  const v = $('view');
  if (!myCap('manage')) { v.innerHTML = '<div class="empty">Floor alerts are sent by managers and owners. Any alert sent to you will pop up on screen.</div>'; return; }
  const seesAll = ALERT_SEES_ALL.includes(S.user.role);
  const stores = (S.locations || []).filter(l => l.type !== 'central_kitchen');
  let locId = seesAll ? (S.loc || (stores[0] && stores[0].id)) : S.user.location_id;
  let data = { staff: [], roles: [] }, sent = { alerts: [] };
  try { [data, sent] = await Promise.all([api('/alerts/staff?location_id=' + encodeURIComponent(locId || '')), api('/alerts/sent')]); }
  catch (e) { /* staff may fail if no location yet */ }
  const roleOpts = (data.roles || []).map(r => `<option value="${r}">${esc(ALERT_ROLE_LABEL[r] || roleLabel(r))}</option>`).join('');
  const staffOpts = (data.staff || []).map(s => `<option value="${s.id}">${esc(s.name)} · ${esc(roleLabel(s.role))}</option>`).join('');
  const chips = ALERT_PRESETS.map(p => `<button type="button" class="al-chip" data-preset="${esc(p)}">${esc(p.replace('{n}', '#'))}</button>`).join('');
  const targetDesc = (a) => a.target_type === 'user' ? esc(a.target_user_name || 'a person') : a.target_type === 'role' ? (ALERT_ROLE_LABEL[a.target_role] || a.target_role) : 'Everyone on floor';
  v.innerHTML = `
    <h2 class="page">🔔 Floor alerts <span style="font-weight:400;color:var(--muted);font-size:.9rem">— urgent on-screen pings to working staff</span></h2>
    <div class="section" style="max-width:640px">
      <div class="err" id="alErr"></div>
      ${seesAll ? `<div class="al-field"><label>Store</label><select id="alLoc">${stores.map(l => `<option value="${l.id}" ${String(l.id) === String(locId) ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>` : ''}
      <div class="al-field"><label>Who</label>
        <div class="seg" id="alTarget">
          <button type="button" class="seg-btn active" data-t="all">Everyone on floor</button>
          <button type="button" class="seg-btn" data-t="role" ${data.roles && data.roles.length ? '' : 'disabled'}>A role</button>
          <button type="button" class="seg-btn" data-t="user" ${data.staff && data.staff.length ? '' : 'disabled'}>A person</button>
        </div>
        <select id="alRole" class="hidden" style="margin-top:.4rem">${roleOpts || '<option>—</option>'}</select>
        <select id="alUser" class="hidden" style="margin-top:.4rem">${staffOpts || '<option>—</option>'}</select>
      </div>
      <div class="al-field"><label>Quick messages</label><div class="al-chips">${chips}</div>
        <div style="display:flex;gap:.5rem;align-items:center;margin-top:.4rem"><span style="font-size:.85rem;color:var(--muted)">Table #</span><input id="alTable" inputmode="numeric" style="width:80px" placeholder="e.g. 5"></div>
      </div>
      <div class="al-field"><label>Message</label><textarea id="alBody" rows="2" placeholder="Type or pick a quick message above"></textarea></div>
      <div class="al-field"><label>Priority</label>
        <div class="seg" id="alPrio"><button type="button" class="seg-btn active" data-p="urgent">🔴 Urgent</button><button type="button" class="seg-btn" data-p="normal">Normal</button></div>
      </div>
      <button class="btn" id="alSend">🔔 Send alert</button>
    </div>
    <div class="section">
      <h3>Recent sent alerts <span style="font-weight:400;color:var(--muted);font-size:.85rem">last 24h · live acknowledgements</span></h3>
      ${sent.alerts.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>To</th><th>Message</th><th class="num">Acked</th><th></th></tr></thead><tbody>
        ${sent.alerts.map(a => `<tr><td class="mono">${esc((a.created_at || '').slice(0, 16).replace('T', ' '))}</td><td>${targetDesc(a)}</td><td>${esc(a.body)} ${a.priority === 'urgent' ? '<span class="badge out">urgent</span>' : ''}</td><td class="num"><strong>${a.ack_count}</strong></td>
          <td><div class="actions-cell"><button class="btn sm ghost" data-acks="${a.id}">Who</button>${a.active ? `<button class="btn sm ghost" data-close="${a.id}">Close</button>` : '<span class="badge gray">closed</span>'}</div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No alerts sent recently.</div>'}
    </div>`;

  const setTable = () => { const n = ($('alTable').value || '').trim(); v.querySelectorAll('.al-chip').forEach(c => c.textContent = c.dataset.preset.replace('{n}', n || '#')); };
  $('alTable').oninput = setTable;
  v.querySelectorAll('#alTarget .seg-btn').forEach(b => b.onclick = () => { if (b.disabled) return; v.querySelectorAll('#alTarget .seg-btn').forEach(x => x.classList.toggle('active', x === b)); $('alRole').classList.toggle('hidden', b.dataset.t !== 'role'); $('alUser').classList.toggle('hidden', b.dataset.t !== 'user'); });
  v.querySelectorAll('#alPrio .seg-btn').forEach(b => b.onclick = () => v.querySelectorAll('#alPrio .seg-btn').forEach(x => x.classList.toggle('active', x === b)));
  v.querySelectorAll('.al-chip').forEach(c => c.onclick = () => { const n = ($('alTable').value || '').trim(); $('alBody').value = c.dataset.preset.replace('{n}', n || ''); });
  const alLoc = $('alLoc'); if (alLoc) alLoc.onchange = () => { S.loc = alLoc.value; renderMessages(); };
  $('alSend').onclick = async () => {
    $('alErr').textContent = '';
    try {
      const target = v.querySelector('#alTarget .seg-btn.active').dataset.t;
      const priority = v.querySelector('#alPrio .seg-btn.active').dataset.p;
      const text = $('alBody').value.trim();
      if (!text) throw new Error('Type or pick a message.');
      const payload = { target_type: target, body: text, priority, location_id: locId };
      if (target === 'role') payload.target_role = $('alRole').value;
      if (target === 'user') payload.target_user_id = $('alUser').value;
      await api('/alerts', { method: 'POST', body: JSON.stringify(payload) });
      toast('Alert sent 🔔'); renderMessages();
    } catch (e) { $('alErr').textContent = e.message; }
  };
  v.querySelectorAll('[data-close]').forEach(b => b.onclick = async () => { try { await api(`/alerts/${b.dataset.close}/close`, { method: 'POST', body: '{}' }); toast('Alert closed'); renderMessages(); } catch (e) { toast(e.message, true); } });
  v.querySelectorAll('[data-acks]').forEach(b => b.onclick = async () => {
    try { const d = await api(`/alerts/${b.dataset.acks}/acks`); toast(d.acks.length ? '✓ ' + d.acks.map(a => a.name).join(', ') : 'No one has acknowledged yet'); }
    catch (e) { toast(e.message, true); }
  });
}

const MSG_TABS = [['inbox', 'Inbox'], ['sent', 'Sent'], ['compose', 'Compose'], ['alerts', '🔔 Floor alerts']];
function renderMsgTabs() {
  $('tabs').innerHTML = MSG_TABS.map(([k, l]) => `<button data-gtab="${k}" class="${S.msgTab === k ? 'active' : ''}">${l}${k === 'inbox' && S.unread ? ` <span class="tab-badge">${S.unread}</span>` : ''}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach(b => b.onclick = () => { S.msgTab = b.dataset.gtab; S.msgThread = null; S.msgArchived = false; renderMsgTabs(); renderMessages(); });
}
function renderMessages() {
  if (S.msgThread) return renderThread();
  $('view').innerHTML = '<div class="empty">Loading…</div>';
  ({ inbox: renderInbox, sent: renderSent, compose: renderCompose, alerts: renderFloorAlerts }[S.msgTab])();
}

// ── Message attachments (pictures & videos) ──────────────────────────────────
const _msgAttUrls = [];
function revokeMsgAtts() { while (_msgAttUrls.length) URL.revokeObjectURL(_msgAttUrls.pop()); }
// A short caption when the sender attaches media but types no text.
function msgFilesCaption(files) {
  const a = [...files]; if (!a.length) return '';
  if (a.length === 1) return /^video\//.test(a[0].type) ? '🎥 Video' : '📷 Photo';
  const v = a.filter(f => /^video\//.test(f.type)).length, i = a.length - v;
  return ['📎', i ? `${i} photo${i > 1 ? 's' : ''}` : '', i && v ? '+' : '', v ? `${v} video${v > 1 ? 's' : ''}` : ''].filter(Boolean).join(' ');
}
// POST each selected file's bytes to a message. Returns {ok, err}.
async function uploadMsgAttachments(messageId, files) {
  const list = [...files].filter(f => /^(image|video)\//.test(f.type));
  let ok = 0, err = '';
  for (const f of list) {
    try {
      const res = await fetch(`/api/messages/${messageId}/attachment?filename=${encodeURIComponent(f.name || '')}`, {
        method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream', Authorization: 'Bearer ' + S.token }, body: f,
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); err = d.error || 'Upload failed'; break; }
      ok++;
    } catch (e) { err = e.message; break; }
  }
  return { ok, err };
}
// Load a message's attachments into a container: images (click to zoom) + video players.
async function loadMsgAttachments(messageId, el) {
  let d;
  try { d = await api(`/messages/${messageId}/attachments`); } catch { return; }
  if (!d.attachments.length) { el.remove(); return; }
  el.innerHTML = '';
  for (const a of d.attachments) {
    const wrap = document.createElement('div'); wrap.className = 'msg-att';
    el.appendChild(wrap);
    try {
      const res = await fetch(`/api/messages/${messageId}/attachment/${a.id}`, { headers: S.token ? { Authorization: 'Bearer ' + S.token } : {} });
      if (!res.ok) continue;
      const url = URL.createObjectURL(await res.blob()); _msgAttUrls.push(url);
      if (a.kind === 'video') {
        const vid = document.createElement('video'); vid.src = url; vid.controls = true; vid.preload = 'metadata'; vid.className = 'msg-att-video';
        wrap.appendChild(vid);
      } else {
        const img = document.createElement('img'); img.src = url; img.className = 'msg-att-img'; img.alt = a.filename || 'Attachment'; img.onclick = () => pgLightbox(url);
        wrap.appendChild(img);
      }
    } catch { /* one attachment failing shouldn't break the rest */ }
  }
}
// Wire a hidden file input + its label to show the chosen file count.
function wireAttachInput(inputId, labelId) {
  const inp = $(inputId), lbl = labelId && $(labelId);
  if (inp && lbl) inp.onchange = () => { lbl.textContent = inp.files && inp.files.length ? `📎 ${inp.files.length} file${inp.files.length > 1 ? 's' : ''} attached` : ''; };
}

async function renderThread() {
  revokeMsgAtts();
  $('view').innerHTML = '<div class="empty">Loading…</div>';
  let t;
  try { t = await api(`/messages/thread/${S.msgThread}`); } catch (e) { $('view').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  refreshUnread(); renderMsgTabs();
  const me = t.me;
  const tid = S.msgThread;
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">${esc(t.subject || 'Conversation')}</h2>
      <div style="display:flex;gap:.4rem;flex-wrap:wrap">
        ${S.msgArchived
          ? '<button class="btn sm ghost" id="thUnarch">📥 Unarchive</button>'
          : '<button class="btn sm ghost" id="thUnread">◍ Mark unread</button><button class="btn sm ghost" id="thArch">🗄️ Archive</button>'}
        <button class="btn sm ghost" id="thBack">← Back to inbox</button>
      </div></div>
    <div class="thread">${t.messages.map(m => `
      <div class="thread-msg ${m.sender_id === me ? 'mine' : ''}">
        <div class="thread-meta">${esc(m.sender_name)} <span class="badge ${ROLE_CHIP[m.sender_role] || 'gray'}">${esc(roleLabel(m.sender_role))}</span> · ${msgTime(m.created_at)}</div>
        <div class="thread-body">${esc(m.body)}</div>
        ${m.attachment_count ? `<div class="msg-atts" data-atts="${m.id}"></div>` : ''}
      </div>`).join('')}</div>
    <div class="reply-box"><textarea id="thBody" rows="2" placeholder="Write a reply…"></textarea>
      <label class="msg-attach-btn" title="Attach photos or a video">📎<input type="file" accept="image/*,video/*" multiple hidden id="thFiles"></label>
      <button class="btn" id="thSend">Reply</button></div>
    <div id="thFileNames" class="msg-attach-names"></div>`;
  $('view').querySelectorAll('[data-atts]').forEach(el => loadMsgAttachments(el.dataset.atts, el));
  wireAttachInput('thFiles', 'thFileNames');
  const backToList = () => { S.msgThread = null; renderMsgTabs(); renderMessages(); };
  $('thBack').onclick = backToList;
  const threadAction = async (path, msg) => { try { await api(`/messages/thread/${tid}/${path}`, { method: 'POST' }); toast(msg); refreshUnread(); backToList(); } catch (e) { toast(e.message, true); } };
  if ($('thUnread')) $('thUnread').onclick = () => threadAction('unread', 'Marked unread');
  if ($('thArch')) $('thArch').onclick = () => threadAction('archive', 'Archived');
  if ($('thUnarch')) $('thUnarch').onclick = () => threadAction('unarchive', 'Moved to inbox');
  const last = t.messages[t.messages.length - 1];
  $('thSend').onclick = async () => {
    const files = $('thFiles').files;
    const body = $('thBody').value.trim() || msgFilesCaption(files);
    if (!body) return;
    $('thSend').disabled = true;
    try {
      const r = await api(`/messages/${last.id}/reply`, { method: 'POST', body: JSON.stringify({ body }) });
      if (files && files.length) { const u = await uploadMsgAttachments(r.id, files); if (u.err) toast(u.err, true); }
      renderThread();
    } catch (e) { toast(e.message, true); $('thSend').disabled = false; }
  };
}
function msgTime(iso) {
  const d = new Date((iso || '').replace(' ', 'T') + 'Z');
  const m = Math.floor((Date.now() - d.getTime()) / 60000);
  if (m < 60) return m + 'm ago';
  if (m < 1440) return Math.floor(m / 60) + 'h ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
const audBadge = (a) => a === 'all' ? '<span class="badge gray">broadcast</span>' : (a === 'location' ? '<span class="badge gray">location</span>' : '');

async function renderInbox() {
  const arch = S.msgArchived;
  const msgs = await api('/messages/inbox' + (arch ? '?archived=1' : ''));
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">${arch ? 'Archived' : 'Inbox'} ${!arch ? `<span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${msgs.reduce((s, m) => s + (m.unread || 0), 0)} unread</span>` : ''}</h2>
      <button class="btn sm ghost" id="inbToggle">${arch ? '← Back to inbox' : '🗄️ Archived'}</button></div>
    ${msgs.length ? `<div class="msg-list">${msgs.map(m => `
      <div class="msg-card ${m.is_read ? '' : 'unread'}" data-tid="${m.thread_id}" data-unread="${m.unread || 0}">
        <div class="msg-head">
          <span class="msg-from">${m.is_read ? '' : '<span class="dot"></span>'}${esc(m.sender_name)} <span class="badge ${ROLE_CHIP[m.sender_role] || 'gray'}">${esc(roleLabel(m.sender_role))}</span> ${audBadge(m.audience)}${m.thread_count > 1 ? ` <span class="badge gray">💬 ${m.thread_count}</span>` : ''}</span>
          <span class="msg-time">${msgTime(m.created_at)}</span>
        </div>
        <div class="msg-subj">${esc(m.subject || '(no subject)')}</div>
        <div class="msg-body">${esc(m.body)}</div>
      </div>`).join('')}</div>` : `<div class="empty">${arch ? 'No archived conversations.' : 'No messages yet.'}</div>`}`;
  $('inbToggle').onclick = () => { S.msgArchived = !S.msgArchived; renderMessages(); };
  $('view').querySelectorAll('.msg-card').forEach(card => card.onclick = () => {
    const u = parseInt(card.dataset.unread || '0', 10);   // opening reads the whole thread — reflect it at once
    if (u > 0) { S.unread = Math.max(0, S.unread - u); card.classList.remove('unread'); card.querySelector('.dot')?.remove(); renderSidebar(); }
    S.msgThread = card.dataset.tid; renderMessages();
  });
}

async function renderSent() {
  const msgs = await api('/messages/sent');
  $('view').innerHTML = `
    <h2 class="page">Sent</h2>
    ${msgs.length ? `<div class="msg-list">${msgs.map(m => `
      <div class="msg-card">
        <div class="msg-head">
          <span class="msg-from">To ${m.audience === 'all' ? 'all staff' : m.audience === 'location' ? esc(shortLoc(m.location_name) || 'a location') : `${m.recipients} recipient`} ${audBadge(m.audience)}</span>
          <span class="msg-time">${msgTime(m.created_at)}</span>
        </div>
        <div class="msg-subj">${esc(m.subject || '(no subject)')}</div>
        <div class="msg-body">${esc(m.body)}</div>
        <div class="msg-meta">Read by ${m.read_count} of ${m.recipients}</div>
      </div>`).join('')}</div>` : '<div class="empty">You haven’t sent any messages.</div>'}`;
}

const MSG_LEADERSHIP = ['owner', 'admin', 'general_manager'];
const MSG_MANAGERS = ['manager', 'assistant_manager', 'kitchen_manager', 'regional_manager', 'general_manager'];

async function renderCompose() {
  const role = S.user.role;
  const canBroadcast = ['owner', 'admin', 'manager'].includes(role);
  const recips = await api('/messages/recipients');
  const myLoc = String(S.user.location_id || '');
  const inLoc = (u) => String(u.location_id || '') === myLoc;
  const isLead = MSG_LEADERSHIP.includes(role), isMgr = MSG_MANAGERS.includes(role);
  // Role-appropriate quick groups: each [label, [ids]].
  const groups = [];
  if (isLead) groups.push(['Everyone', recips.map(u => u.id)]);
  if (isMgr && !isLead) groups.push(['My staff (my location)', recips.filter(u => inLoc(u) && !MSG_MANAGERS.includes(u.role) && !MSG_LEADERSHIP.includes(u.role)).map(u => u.id)]);
  groups.push(['Owner / Admin', recips.filter(u => u.role === 'owner' || u.role === 'admin').map(u => u.id)]);
  if (!isLead) groups.push(['My manager', recips.filter(u => MSG_MANAGERS.includes(u.role) && (inLoc(u) || u.role === 'general_manager')).map(u => u.id)]);
  groups.push(['My peers (same role)', recips.filter(u => u.role === role && u.id !== S.user.id).map(u => u.id)]);
  const shown = groups.filter(g => g[1].length);
  $('view').innerHTML = `
    <h2 class="page">New message</h2>
    <div class="section" style="max-width:640px">
      <div class="err" id="cErr"></div>
      <label class="fld-label">To</label>
      <select id="cAud" class="fld">
        ${shown.map((g, i) => `<option value="g:${i}">${esc(g[0])} (${g[1].length})</option>`).join('')}
        <option value="direct">A specific person…</option>
        ${canBroadcast ? '<option value="all">📣 All staff (broadcast)</option><option value="location">A whole location…</option>' : ''}
      </select>
      <div id="cDirect" class="hidden"><label class="fld-label">Recipient</label><select id="cRecip" class="fld">${recips.map(u => `<option value="${u.id}">${esc(u.name)} — ${esc(roleLabel(u.role))}${u.location ? ' · ' + esc(shortLoc(u.location)) : ''}</option>`).join('')}</select></div>
      <div id="cLoc" class="hidden"><label class="fld-label">Location</label><select id="cLocSel" class="fld">${S.locations.map(l => `<option value="${l.id}">${esc(shortLoc(l.name))}</option>`).join('')}</select></div>
      <label class="fld-label">Subject</label><input id="cSubj" class="fld" placeholder="Subject (optional)" />
      <label class="fld-label">Message</label><textarea id="cBody" class="fld" rows="5" placeholder="Write your message…"></textarea>
      <div class="msg-compose-attach">
        <label class="msg-attach-btn" title="Attach photos or a video">📎 Add photos / video<input type="file" accept="image/*,video/*" multiple hidden id="cFiles"></label>
        <span id="cFileNames" class="msg-attach-names"></span>
      </div>
      <button class="btn" id="cSend">Send message</button>
    </div>`;
  const aud = $('cAud');
  aud.onchange = () => { $('cDirect').classList.toggle('hidden', aud.value !== 'direct'); $('cLoc').classList.toggle('hidden', aud.value !== 'location'); };
  wireAttachInput('cFiles', 'cFileNames');
  $('cSend').onclick = async () => {
    $('cErr').textContent = '';
    const val = aud.value;
    const files = $('cFiles').files;
    const payload = { subject: $('cSubj').value, body: $('cBody').value.trim() || msgFilesCaption(files) };
    if (!payload.body) { $('cErr').textContent = 'Write a message or attach a photo/video.'; return; }
    if (val.startsWith('g:')) payload.recipient_ids = shown[parseInt(val.slice(2), 10)][1];
    else if (val === 'direct') { payload.audience = 'direct'; payload.recipient_id = $('cRecip').value; }
    else if (val === 'location') { payload.audience = 'location'; payload.location_id = $('cLocSel').value; }
    else payload.audience = 'all';
    $('cSend').disabled = true;
    try {
      const r = await api('/messages', { method: 'POST', body: JSON.stringify(payload) });
      if (files && files.length) { const u = await uploadMsgAttachments(r.id, files); if (u.err) toast(u.err, true); }
      toast(`Message sent to ${r.recipients} recipient${r.recipients > 1 ? 's' : ''}`);
      S.msgTab = 'sent'; renderMsgTabs(); renderMessages();
    } catch (e) { $('cErr').textContent = e.message; $('cSend').disabled = false; }
  };
}

// ── Central Kitchen module (production & supply hub) ────────────────────────
const CK_TABS = [['overview', 'Overview'], ['demand', 'Demand'], ['production', 'Production'], ['distribution', 'Distribution'], ['recipes', 'Recipes'], ['fulfillment', 'Fulfillment'], ['staff', 'CK Staff']];
function renderCkTabs() {
  $('tabs').innerHTML = CK_TABS.map(([k, l]) => `<button data-ck="${k}" class="${S.ckTab === k ? 'active' : ''}">${l}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach(b => b.onclick = () => { S.ckTab = b.dataset.ck; renderCkTabs(); renderCentral(); });
}
function renderCentral() {
  $('view').innerHTML = '<div class="empty">Loading…</div>';
  ({ overview: renderCkOverview, demand: renderCkDemand, production: renderCkProduction, distribution: renderCkDistribution, recipes: renderCkRecipes, fulfillment: renderCkFulfillment, staff: renderCkStaff }[S.ckTab])();
}

async function renderCkOverview() {
  const d = await api('/central/summary');
  $('view').innerHTML = `
    <div class="overview-hero"><h2>🏭 Central Kitchen</h2><p>${esc(d.location ? d.location.city + ', ' + d.location.state : '')} · production & supply hub for all locations</p></div>
    <div class="kpis">
      <div class="card"><div class="label">Products</div><div class="value">${d.products}</div></div>
      <div class="card"><div class="label">Low stock</div><div class="value ${d.low_stock ? 'bad' : ''}">${d.low_stock}</div></div>
      <div class="card"><div class="label">Stores requesting today</div><div class="value">${d.pending_stores}</div></div>
      <div class="card"><div class="label">Batches produced today</div><div class="value">${d.produced_today}</div></div>
      <div class="card"><div class="label">CK staff</div><div class="value">${d.staff}</div></div>
      <div class="card"><div class="label">Open tasks</div><div class="value ${d.open_tasks ? 'warn' : ''}">${d.open_tasks}</div></div>
    </div>
    <div class="section"><h3>What the Central Kitchen does</h3>
      <div class="quick-grid">
        <button class="quick-card" data-ckgo="demand"><span class="q-icon">📥</span><span>Demand aggregation</span></button>
        <button class="quick-card" data-ckgo="production"><span class="q-icon">🍲</span><span>Batch production</span></button>
        <button class="quick-card" data-ckgo="recipes"><span class="q-icon">📖</span><span>Master recipes</span></button>
        <button class="quick-card" data-ckgo="fulfillment"><span class="q-icon">🚚</span><span>Fulfillment</span></button>
        <button class="quick-card" data-ckgo="staff"><span class="q-icon">👥</span><span>CK staff & clock</span></button>
      </div></div>`;
  $('view').querySelectorAll('[data-ckgo]').forEach(b => b.onclick = () => { S.ckTab = b.dataset.ckgo; renderCkTabs(); renderCentral(); });
}

async function renderCkDemand() {
  const d = await api('/central/demand');
  const max = Math.max(1, ...d.products.map(p => p.total_requested));
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Demand Aggregation <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${d.date}, all stores</span></h2>
      <button class="btn sm" id="ckGenReq" title="Rebuild today's requests from each store's recent sales">⚡ Generate from sales</button></div>
    <div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Requested</th><th class="num">Stores</th><th class="num">On hand</th><th class="num">Safety</th><th style="width:26%">Demand</th></tr></thead><tbody>
      ${d.products.map(p => `<tr class="ck-demand-row" data-pid="${p.id}">
        <td><strong>${esc(p.name)}</strong></td>
        <td class="num"><strong>${numf(p.total_requested)}</strong> ${esc(p.unit)}</td>
        <td class="num">${p.store_count}</td>
        <td class="num ${p.on_hand < p.safety_stock ? 'ck-low' : ''}">${numf(p.on_hand)}</td>
        <td class="num">${numf(p.safety_stock)}</td>
        <td><div style="background:var(--gold-soft);border-radius:6px;height:14px"><div style="background:var(--gold);height:14px;border-radius:6px;width:${(p.total_requested / max * 100).toFixed(0)}%"></div></div></td>
      </tr>
      <tr class="ck-stores hidden" data-for="${p.id}"><td colspan="6" style="background:var(--bg)"><div class="ck-store-chips">${p.by_store.length ? p.by_store.map(s => `<span class="chip">${esc(shortLoc(s.location))}: <strong>${numf(s.quantity)}</strong></span>`).join('') : '<span style="color:var(--muted)">No store requests</span>'}</div></td></tr>`).join('')}
    </tbody></table></div>
    <p class="sub" style="color:var(--muted);margin-top:.6rem">Click a product to see the per-store breakdown. <strong>Generate from sales</strong> rebuilds today's requests from each store's 7-day average covers.</p>`;
  $('view').querySelectorAll('.ck-demand-row').forEach(r => r.onclick = () => { const t = $('view').querySelector(`.ck-stores[data-for="${r.dataset.pid}"]`); t.classList.toggle('hidden'); });
  $('ckGenReq').onclick = async () => {
    try { const r = await api('/central/generate-requests', { method: 'POST', body: '{}' }); toast(`Generated ${r.generated} requests across ${r.stores} stores`); renderCentral(); }
    catch (e) { toast(e.message, true); }
  };
}

async function renderCkProduction() {
  const [plan, runs] = await Promise.all([api('/central/batch-plan'), api('/central/production')]);
  const toProduce = plan.sheets.filter(s => s.batches > 0);
  $('view').innerHTML = `
    <h2 class="page">Production <span style="font-weight:400;color:var(--muted);font-size:.9rem">— batch planning, scaling & yield</span></h2>
    ${plan.alerts.length ? `<div class="ck-alert"><strong>⚠ ${plan.alerts.length} safety-stock alert${plan.alerts.length > 1 ? 's' : ''}:</strong> ${plan.alerts.map(a => `${esc(a.name)} (${numf(a.on_hand)}/${numf(a.safety_stock)} ${esc(a.unit)})`).join(' · ')}</div>` : ''}
    <div class="section"><h3>Production batch sheets</h3>
      ${toProduce.length ? toProduce.map(s => `
        <div class="ck-sheet">
          <div class="ck-sheet-head">
            <div><strong>${esc(s.name)}</strong> ${s.low_stock ? '<span class="badge low">low</span>' : ''}
              <div class="sub" style="color:var(--muted)">Demand ${numf(s.demand)} · on hand ${numf(s.on_hand)} · safety ${numf(s.safety_stock)} ${esc(s.unit)}</div></div>
            <button class="btn sm" data-produce="${s.product_id}" data-batches="${s.batches}" data-name="${esc(s.name)}">Record production</button>
          </div>
          <div class="ck-sheet-stats">
            <div><span>Batches</span><strong>${s.batches}</strong></div>
            <div><span>Gross output</span><strong>${numf(s.gross_output)} ${esc(s.unit)}</strong></div>
            <div><span>Usable (after ${(s.shrinkage_pct * 100).toFixed(0)}% shrink)</span><strong>${numf(s.usable_output)} ${esc(s.unit)}</strong></div>
            <div><span>Yield loss</span><strong>${numf(s.shrinkage_loss)} ${esc(s.unit)}</strong></div>
            <div><span>Est. cost</span><strong>${money(s.est_cost)}</strong></div>
          </div>
          <div class="table-wrap" style="margin-top:.6rem"><table><thead><tr><th>Ingredient (scaled ×${s.batches})</th><th class="num">Per batch</th><th class="num">Total</th><th class="num">Cost</th></tr></thead><tbody>
            ${s.ingredients.map(i => `<tr><td>${esc(i.item_name)}</td><td class="num">${numf(i.per_batch)}</td><td class="num"><strong>${numf(i.total)}</strong></td><td class="num">${money(i.cost)}</td></tr>`).join('')}
          </tbody></table></div>
        </div>`).join('') : '<div class="empty">Nothing to produce — all products meet demand and safety stock.</div>'}
    </div>
    <div class="section"><h3>Recent production runs</h3>
      <div class="table-wrap"><table><thead><tr><th>When</th><th>Product</th><th class="num">Batches</th><th class="num">Output</th><th class="num">Yield loss</th><th>By</th></tr></thead><tbody>
        ${runs.length ? runs.map(r => `<tr><td class="mono">${esc((r.produced_at || '').slice(0, 16))}</td><td>${esc(r.product_name)}</td><td class="num">${numf(r.batches)}</td><td class="num">${numf(r.actual_output)} ${esc(r.unit)}</td><td class="num">${numf(r.shrinkage_loss)}</td><td>${esc(r.produced_by_name || '—')}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No production runs yet.</td></tr>'}
      </tbody></table></div></div>`;
  $('view').querySelectorAll('[data-produce]').forEach(b => b.onclick = () => modal(`Record production — ${b.dataset.name}`, [
    { key: 'batches', label: 'Batches produced', type: 'number', value: b.dataset.batches },
    { key: 'actual_output', label: 'Actual usable output (blank = expected)', type: 'number' },
    { key: 'reason', label: 'Reason / note (for audit)' },
  ], async (v) => { const r = await api('/central/production', { method: 'POST', body: JSON.stringify({ product_id: b.dataset.produce, ...v }) }); toast(`Produced ${numf(r.produced)} units`); renderCentral(); }, 'Record'));
}

async function renderCkDistribution() {
  const [q, stock] = await Promise.all([api('/distribution/orders?scope=ck'), api('/distribution/ck-stock')]);
  const open = q.orders.filter(o => ['requested', 'approved', 'shipped'].includes(o.status));
  const recent = q.orders.filter(o => ['received', 'cancelled'].includes(o.status)).slice(0, 8);
  const lowCount = stock.items.filter(i => i.low).length;
  $('view').innerHTML = `
    <h2 class="page">Distribution <span style="font-weight:400;color:var(--muted);font-size:.9rem">— raw food to the stores</span></h2>
    <p class="sub" style="color:var(--muted);margin-top:-.3rem">Stores order raw items from the Central Kitchen first. Shipping an order deducts CK stock; the store confirms receipt to land it in their inventory. Whatever the CK can't cover is auto-routed to a vendor by the store.</p>
    <div class="section"><h3>Incoming store orders ${open.length ? `<span class="badge gold">${open.length} open</span>` : ''}</h3>
      ${open.length ? `<div class="table-wrap"><table><thead><tr><th>Store</th><th>Item</th><th class="num">CK qty</th><th>Requested by</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        ${open.map(o => `<tr><td><strong>${esc(o.store_name)}</strong></td><td>${esc(o.item_name)}</td><td class="num">${numf(o.ck_qty)} ${esc(o.unit)}</td><td>${esc(o.requested_by_name || '—')}</td><td>${distBadge(o.status)}</td>
          <td><div class="actions-cell">${ckOrderActions(o)}</div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No open store orders.</div>'}
    </div>
    <div class="section"><div class="row-between"><h3>Warehouse raw stock ${lowCount ? `<span class="badge low">${lowCount} low</span>` : ''}</h3></div>
      <div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Reserved</th><th class="num">Free</th><th class="num">Min</th><th>Offered to stores</th></tr></thead><tbody>
        ${stock.items.map(i => `<tr><td>${esc(i.item_name)}${i.low ? ' <span class="badge low">low</span>' : ''}</td><td class="num">${numf(i.quantity)} ${esc(i.unit)}</td><td class="num">${i.reserved > 0 ? numf(i.reserved) : '—'}</td><td class="num"><strong>${numf(i.free)}</strong></td><td class="num">${numf(i.min_quantity)}</td>
          <td><button class="btn sm ${i.distributable ? '' : 'ghost'}" data-dist-toggle="${i.id}" data-on="${i.distributable}">${i.distributable ? '✓ Offered' : 'Withheld'}</button></td></tr>`).join('')}
      </tbody></table></div>
      <p class="sub" style="color:var(--muted);margin:.4rem 0 0">The Central Kitchen restocks itself from vendors on the <strong>Inventory</strong> page (scoped to the Central Kitchen).</p>
    </div>
    ${recent.length ? `<div class="section"><h3>Recently settled</h3><div class="table-wrap"><table><thead><tr><th>Store</th><th>Item</th><th class="num">CK qty</th><th>Status</th></tr></thead><tbody>
      ${recent.map(o => `<tr><td>${esc(o.store_name)}</td><td>${esc(o.item_name)}</td><td class="num">${numf(o.ck_qty)}</td><td>${distBadge(o.status)}</td></tr>`).join('')}
    </tbody></table></div></div>` : ''}`;
  $('view').querySelectorAll('[data-dship]').forEach(b => b.onclick = () => ckOrderAct(b.dataset.dship, 'shipped'));
  $('view').querySelectorAll('[data-drecv]').forEach(b => b.onclick = () => ckOrderAct(b.dataset.drecv, 'received'));
  $('view').querySelectorAll('[data-dcancel]').forEach(b => b.onclick = () => ckOrderAct(b.dataset.dcancel, 'cancelled'));
  $('view').querySelectorAll('[data-dist-toggle]').forEach(b => b.onclick = async () => {
    try { await api('/distribution/ck-stock/' + b.dataset.distToggle, { method: 'PUT', body: JSON.stringify({ distributable: b.dataset.on === '1' ? 0 : 1 }) }); renderCentral(); }
    catch (e) { toast(e.message, true); }
  });
}
function ckOrderActions(o) {
  if (o.status === 'requested' || o.status === 'approved') return `<button class="btn sm" data-dship="${o.id}">Ship</button><button class="btn sm ghost" data-dcancel="${o.id}">Cancel</button>`;
  if (o.status === 'shipped') return `<button class="btn sm" data-drecv="${o.id}">Mark received</button>`;
  return '';
}
async function ckOrderAct(id, status) {
  try { await api('/distribution/orders/' + id, { method: 'PUT', body: JSON.stringify({ status }) }); toast('Order ' + status); renderCentral(); }
  catch (e) { toast(e.message, true); }
}

async function renderCkRecipes() {
  const products = await api('/central/products');
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Master Recipes <span style="font-weight:400;color:var(--muted);font-size:.9rem">— batch yield, shrinkage & ingredients</span></h2>
      <button class="btn sm" id="ckAddProd">+ Add product</button></div>
    <p class="sub" style="color:var(--muted);margin-top:-.3rem">Edit each product's batch yield, shrinkage and safety stock, and the ingredients consumed per batch. These drive batch scaling, yield/loss and cost across the module.</p>
    <div class="table-wrap"><table><thead><tr>
      <th>Product</th><th class="num">Batch yield</th><th class="num">Shrink</th><th class="num">Usable / batch</th>
      <th class="num">Safety</th><th class="num">On hand</th><th class="num">Batch cost</th><th class="num">Ingredients</th><th></th>
    </tr></thead><tbody>
      ${products.map(p => `<tr>
        <td><strong>${esc(p.name)}</strong> <span style="color:var(--muted)">${esc(p.unit)}</span></td>
        <td class="num">${numf(p.batch_yield)}</td>
        <td class="num">${(p.shrinkage_pct * 100).toFixed(0)}%</td>
        <td class="num">${numf(p.usable_per_batch)}</td>
        <td class="num">${numf(p.safety_stock)}</td>
        <td class="num ${p.on_hand < p.safety_stock ? 'ck-low' : ''}">${numf(p.on_hand)}</td>
        <td class="num">${money(p.batch_cost)}</td>
        <td class="num">${p.ingredients.length}</td>
        <td><div class="row-actions"><button class="btn sm ghost" data-editprod="${p.id}">Edit</button><button class="btn sm" data-editrec="${p.id}">Recipe</button></div></td>
      </tr>`).join('')}
    </tbody></table></div>`;
  const byId = (id) => products.find(p => p.id == id);
  $('ckAddProd').onclick = () => ckProductModal(null);
  $('view').querySelectorAll('[data-editprod]').forEach(b => b.onclick = () => ckProductModal(byId(b.dataset.editprod)));
  $('view').querySelectorAll('[data-editrec]').forEach(b => b.onclick = () => ckRecipeModal(byId(b.dataset.editrec)));
}

function ckProductModal(p) {
  const isNew = !p;
  modal(isNew ? 'Add CK product' : `Edit — ${p.name}`, [
    { key: 'name', label: 'Product name', value: p ? p.name : '' },
    { key: 'unit', label: 'Unit (gal, lb, each, bottle…)', value: p ? p.unit : 'each' },
    { key: 'batch_yield', label: 'Batch yield (gross output per batch)', type: 'number', step: '0.1', value: p ? p.batch_yield : 0 },
    { key: 'shrinkage_pct', label: 'Shrinkage (0–0.9, e.g. 0.06 = 6%)', type: 'number', step: '0.01', value: p ? p.shrinkage_pct : 0 },
    { key: 'safety_stock', label: 'Safety stock', type: 'number', value: p ? p.safety_stock : 0 },
    { key: 'on_hand', label: 'On hand', type: 'number', value: p ? p.on_hand : 0 },
    { key: 'reason', label: 'Reason / note (for audit)' },
  ], async (v) => {
    if (isNew) { await api('/central/products', { method: 'POST', body: JSON.stringify(v) }); toast('Product added — add its recipe next'); }
    else { await api('/central/products/' + p.id, { method: 'PUT', body: JSON.stringify(v) }); toast('Product updated'); }
    renderCentral();
  }, isNew ? 'Add' : 'Save');
}

async function ckRecipeModal(p) {
  const ingredients = await api('/central/ingredients');
  let list = p.ingredients.map(i => ({ item_name: i.item_name, quantity: i.quantity }));
  let reasonVal = '';   // preserved across the modal's re-renders when ingredients change
  const host = $('modalHost');
  const render = () => {
    host.innerHTML = `<div class="modal-bg"><div class="modal" style="max-width:560px"><h3>Recipe — ${esc(p.name)}</h3><div class="err" id="mErr"></div>
      <p class="sub" style="color:var(--muted);margin-top:0">Ingredients consumed <strong>per batch</strong> (one batch yields ${numf(p.batch_yield)} ${esc(p.unit)}).</p>
      <div class="table-wrap"><table><tbody>
        ${list.length ? list.map((i, idx) => `<tr><td>${esc(i.item_name)}</td><td class="num">${numf(i.quantity)}</td><td style="width:1%"><button class="btn sm ghost" data-rm="${idx}">✕</button></td></tr>`).join('') : '<tr><td colspan="3" class="empty">No ingredients yet.</td></tr>'}
      </tbody></table></div>
      <div class="ck-rec-add"><select id="ckIng">${ingredients.map(i => `<option value="${esc(i.item_name)}">${esc(i.item_name)} · ${money(i.avg_cost)}</option>`).join('')}</select>
        <input id="ckQty" type="number" step="0.01" min="0" placeholder="Qty / batch"><button class="btn ghost" id="ckAddIng">+ Add</button></div>
      <label>Reason / note (for audit)</label><input id="ckReason" placeholder="why the recipe changed" value="${esc(reasonVal)}" />
      <div class="actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">Save recipe</button></div>
    </div></div>`;
    const close = () => host.innerHTML = '';
    $('mCancel').onclick = close;
    host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
    $('ckReason').oninput = (e) => { reasonVal = e.target.value; };
    host.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { list.splice(+b.dataset.rm, 1); render(); });
    $('ckAddIng').onclick = () => {
      const name = $('ckIng').value, q = parseFloat($('ckQty').value);
      if (!name || !(q > 0)) { toast('Pick an ingredient and a quantity', true); return; }
      const ex = list.find(x => x.item_name === name);
      if (ex) ex.quantity += q; else list.push({ item_name: name, quantity: q });
      render();
    };
    $('mOk').onclick = async () => {
      try { await api('/central/products/' + p.id + '/recipe', { method: 'PUT', body: JSON.stringify({ ingredients: list, reason: reasonVal.trim() }) }); toast('Recipe saved'); close(); renderCentral(); }
      catch (e) { $('mErr').textContent = e.message; }
    };
  };
  render();
}

async function renderCkFulfillment() {
  const d = await api('/central/fulfillment');
  $('view').innerHTML = `
    <h2 class="page">Fulfillment & Logistics <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${d.date}</span></h2>
    <p class="sub" style="color:var(--muted);margin-top:-.3rem">Fulfilling a store deducts Central Kitchen on-hand and delivers the stock into that store's own inventory (a logged <em>in</em> transfer).</p>
    <div class="section"><h3>Consolidated pick list</h3>
      <div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Total to pick</th></tr></thead><tbody>
        ${d.pick_list.map(p => `<tr><td><strong>${esc(p.product)}</strong></td><td class="num">${numf(p.quantity)} ${esc(p.unit)}</td></tr>`).join('')}
      </tbody></table></div></div>
    <div class="section"><h3>Delivery manifests</h3>
      ${d.manifests.map(m => `<div class="ck-manifest"><div class="ck-manifest-head">🚚 ${esc(m.route)} route <span class="badge gray">${m.stops.length} stop${m.stops.length > 1 ? 's' : ''}</span></div>
        <div class="ck-manifest-stops">${m.stops.map(s => `${esc(s.short)} (${s.lines.length} items)`).join(' → ')}</div></div>`).join('')}
    </div>
    <div class="section"><h3>Packing slips by store</h3>
      <div class="ck-slips">${d.stores.map(s => `<div class="ck-slip">
        <div class="ck-slip-head"><strong>${esc(s.short)}</strong> ${s.status === 'fulfilled' ? '<span class="badge ok">fulfilled</span>' : `<button class="btn sm" data-fulfill="${s.location_id || ''}" data-name="${esc(s.short)}">Fulfill</button>`}</div>
        ${s.lines.map(l => `<div class="ck-slip-line"><span>${esc(l.product)}</span><strong>${numf(l.quantity)} ${esc(l.unit)}</strong></div>`).join('')}
      </div>`).join('')}</div>
    </div>`;
  // attach location ids (stores carry location_id via by_store? fetch fresh with ids)
  $('view').querySelectorAll('[data-fulfill]').forEach(b => b.onclick = async () => {
    try { const r = await api('/central/fulfill/' + b.dataset.fulfill, { method: 'POST', body: '{}' }); toast(`Fulfilled ${r.fulfilled} lines for ${b.dataset.name}`); renderCentral(); }
    catch (e) { toast(e.message, true); }
  });
}

async function renderCkStaff() {
  const [staff, tasks, sched, clock] = await Promise.all([api('/central/staff'), api('/central/tasks'), api('/central/schedule'), api('/central/timeclock')]);
  $('view').innerHTML = `
    <h2 class="page">Central Kitchen HR</h2>
    <div class="acct-grid">
      <div class="section"><h3>PIN time clock <span style="font-weight:400;color:var(--muted);font-size:.82rem">terminal</span></h3>
        <div class="err" id="ckClockErr"></div>
        <div class="ck-clock"><input id="ckPin" inputmode="numeric" placeholder="Enter PIN" maxlength="8"><button class="btn" id="ckClockBtn">Clock in / out</button></div>
        <div class="ck-clock-log">${clock.slice(0, 6).map(c => `<div class="ck-clock-row"><span>${esc(c.name)}</span><span class="mono">${esc((c.clock_in || '').slice(11, 16))}${c.clock_out ? '–' + esc((c.clock_out || '').slice(11, 16)) : ' <span class="badge ok">on shift</span>'}</span></div>`).join('') || '<span style="color:var(--muted)">No clock activity.</span>'}</div>
      </div>
      <div class="section"><h3>Today's schedule</h3>
        ${sched.length ? sched.map(s => `<div class="profile-row"><span>${esc(s.name)}</span><strong>${esc(s.start_time || '')}–${esc(s.end_time || '')}</strong></div>`).join('') : '<div class="empty">No shifts scheduled.</div>'}
      </div>
    </div>
    <div class="section"><div class="row-between"><h3>Task assignments</h3><button class="btn sm" id="ckAddTask">+ Add task</button></div>
      <div class="table-wrap"><table><thead><tr><th>Task</th><th>Assigned to</th><th>Verify</th><th>Status</th><th></th></tr></thead><tbody>
        ${tasks.map(t => `<tr><td><strong>${esc(t.title)}</strong></td><td>${esc(t.assigned_name || '—')}</td><td>${t.requires_photo ? '<span class="badge gold">📷 photo</span>' : '—'}</td><td>${t.status === 'done' ? '<span class="badge ok">done</span>' : '<span class="badge low">assigned</span>'}</td><td>${t.status === 'done' ? '' : `<button class="btn sm ghost" data-ckdone="${t.id}" data-photo="${t.requires_photo}">Complete</button>`}</td></tr>`).join('')}
      </tbody></table></div></div>
    <div class="section"><h3>Staff</h3>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th class="num">Rate</th><th>PIN</th></tr></thead><tbody>
        ${staff.map(u => `<tr><td><strong>${esc(u.name)}</strong></td><td><span class="badge ${ROLE_CHIP[u.role] || 'gray'}">${esc(roleLabel(u.role))}</span></td><td class="num">${money(u.hourly_rate)}/hr</td><td>${u.has_pin ? '<span class="badge ok">set</span>' : '—'}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  $('ckClockBtn').onclick = async () => {
    $('ckClockErr').textContent = '';
    try { const r = await api('/central/clock', { method: 'POST', body: JSON.stringify({ pin: $('ckPin').value }) }); toast(`${r.name}: ${r.action === 'clock_in' ? 'clocked in' : 'clocked out (' + numf(r.hours) + 'h)'}`); renderCentral(); }
    catch (e) { $('ckClockErr').textContent = e.message; }
  };
  $('ckAddTask').onclick = () => modal('Add task', [
    { key: 'title', label: 'Task' },
    { key: 'assigned_to', label: 'Assign to', type: 'select', options: staff.map(u => ({ value: u.id, label: u.name })) },
    { key: 'requires_photo', label: 'Requires photo?', type: 'select', options: [{ value: '', label: 'No' }, { value: '1', label: 'Yes' }] },
    { key: 'reason', label: 'Reason / note (for audit)' },
  ], async (v) => { await api('/central/tasks', { method: 'POST', body: JSON.stringify(v) }); toast('Task added'); renderCentral(); });
  $('view').querySelectorAll('[data-ckdone]').forEach(b => b.onclick = () => {
    if (b.dataset.photo === '1') modal('Complete task (photo required)', [{ key: 'photo_url', label: 'Photo URL / reference' }],
      async (v) => { await api(`/central/tasks/${b.dataset.ckdone}/complete`, { method: 'PUT', body: JSON.stringify(v) }); toast('Task completed'); renderCentral(); }, 'Complete');
    else api(`/central/tasks/${b.dataset.ckdone}/complete`, { method: 'PUT', body: '{}' }).then(() => { toast('Task completed'); renderCentral(); });
  });
}

// ── Account Settings ───────────────────────────────────────────────────────
async function openAccount() {
  $('tabs').classList.add('hidden');
  $('locPicker').classList.add('hidden');
  $('pageTitle').textContent = 'Account Settings';
  S.section = 'account';
  let me = S.user;
  try { me = await api('/auth/me'); } catch { /* use cached */ }
  $('view').innerHTML = `
    <h2 class="page">Account Settings</h2>
    <div class="acct-grid">
      <div class="section"><h3>My profile</h3>
        <div class="profile-row"><span>Name</span><strong>${esc(me.name || S.user.name)}</strong></div>
        <div class="profile-row"><span>Phone (sign-in)</span><strong>${esc(fmtPhone(me.phone))}</strong></div>
        <div class="profile-row"><span>Email</span><strong>${esc(me.email || '—')}</strong></div>
        <div class="profile-row"><span>Access level</span><span class="badge ${ROLE_CHIP[me.role] || 'gray'}">${esc(roleLabel(me.role || S.user.role))}</span></div>
        <div class="profile-row"><span>Location</span><strong>${esc((me.location_name || 'All locations').replace('Pho Ha Noi — ', ''))}</strong></div>
      </div>
      <div class="section"><h3>Change password</h3>
        <div class="err" id="pwErr"></div>
        <label class="fld-label">Current password</label><input id="pwCur" type="password" class="fld" />
        <label class="fld-label">New password (min 8 chars)</label><input id="pwNew" type="password" class="fld" />
        <label class="fld-label">Confirm new password</label><input id="pwCon" type="password" class="fld" />
        <button class="btn" id="pwSave" style="margin-top:.5rem">Update password</button>
      </div>
    </div>`;
  $('pwSave').onclick = async () => {
    $('pwErr').textContent = '';
    const cur = $('pwCur').value, nw = $('pwNew').value, con = $('pwCon').value;
    if (nw !== con) { $('pwErr').textContent = 'New passwords do not match.'; return; }
    try {
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: cur, new_password: nw }) });
      toast('Password updated');
      $('pwCur').value = $('pwNew').value = $('pwCon').value = '';
    } catch (e) { $('pwErr').textContent = e.message; }
  };
}

// ── Restore session ────────────────────────────────────────────────────────
(function init() {
  try { if (sessionStorage.getItem('phn_expired')) { sessionStorage.removeItem('phn_expired'); showSessionBanner(); } } catch { /* private mode */ }
  const t = localStorage.getItem('phn_token'), u = localStorage.getItem('phn_user');
  if (t && u) { S.token = t; S.user = JSON.parse(u); boot().catch(() => { localStorage.clear(); location.reload(); }); }
})();
