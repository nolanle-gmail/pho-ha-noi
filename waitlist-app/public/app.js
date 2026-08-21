// Pho Ha Noi — Host Check-in / Waitlist
const S = { token: null, user: null, locations: [], loc: null, view: 'board', unread: 0, msgThread: null, msgArchived: false, hoursKind: 'weekly', hoursAnchor: null };
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
  if (res.status === 401 && S.token) { forceRelogin(); throw new Error('Session expired'); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// A 401 while we hold a token means the JWT expired or was revoked. Tear the
// session down cleanly — a reload kills every timer and the SSE stream — and
// return to the login screen with a note, rather than showing stale data and
// silently retrying a dead token.
function forceRelogin() {
  if (S._expiring) return;   // one 401 wins even if several fire at once
  S._expiring = true;
  try { sessionStorage.setItem('phnw_expired', '1'); } catch { /* private mode */ }
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
const q = (p) => `${p}${p.includes('?') ? '&' : '?'}${S.loc ? 'location_id=' + S.loc : ''}`;
// Everyone gets My Tasks; roles then add their own tools. Servers/bussers land on
// My Tables, front-desk roles on the Front Desk, everyone else on My Tasks.
const SERVER_ROLES = ['server', 'busser'];
const FD_ROLES = ['owner', 'manager', 'assistant_manager', 'general_manager', 'regional_manager', 'frontdesk', 'host'];
// Self-service / position roles (front & back of house). Every one of these gets
// their own tables view + the live floor; managers/owner keep the Front Desk board.
const SELF_SERVICE_ROLES = ['server', 'busser', 'host', 'frontdesk', 'cashier', 'bartender', 'barista', 'chef', 'line_cook', 'prep_cook', 'dishwasher', 'employee'];
const isServerRole = (r) => SERVER_ROLES.includes(r);
const isFrontDeskRole = (r) => FD_ROLES.includes(r);
const isSelfServiceRole = (r) => SELF_SERVICE_ROLES.includes(r);
// Back-of-house kitchen roles can see the floor but not seat / change tables.
const KITCHEN_ROLES = ['chef', 'line_cook', 'prep_cook', 'dishwasher'];
const canEditFloor = (r) => !KITCHEN_ROLES.includes(r);
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
  const sb = $('sessionBanner'); if (sb) sb.hidden = true;   // clear the expiry notice once signed in
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
  refreshMsgUnread(); setInterval(refreshMsgUnread, 30000);   // messages badge
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
  es.onmessage = (e) => {
    setStaffLive('live');   // any event means the pipe is healthy
    let type = ''; try { type = JSON.parse(e.data).type; } catch { /* comment/heartbeat */ }
    if (type === 'message') {   // a message arrived for me → update badge + open inbox
      refreshMsgUnread();
      if (S.view === 'messages' && !S.msgThread && !$('modalHost').innerHTML) renderMessages();
      return;
    }
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
  if (isSelfServiceRole(role)) items.push(['server', '🛎️ My Tables']);
  if (isFrontDeskRole(role)) items.push(['board', '🍜 Front Desk']);
  if (isSelfServiceRole(role) || isFrontDeskRole(role)) items.push(['tables', '🍽️ Floor']);
  items.push(['messages', '✉️ Messages']);   // team messaging for everyone, next to Floor
  items.push(['myhours', '⏱ My Hours']);   // each staff member's own timesheet
  if (role === 'owner') items.push(['history', '📜 Guest History'], ['report', '📊 Daily Report'], ['activity', '🧾 Activity Log']);
  nav.classList.remove('hidden');
  const cur = items.find(([k]) => k === S.view) || items[0];
  const open = nav.classList.contains('open');
  const btns = items.map(([k, l]) => `<button class="navbtn ${S.view === k ? 'active' : ''}" data-view="${k}">${l}${k === 'messages' && S.unread ? ` <span class="nav-badge">${S.unread}</span>` : ''}</button>`).join('');
  // Desktop/tablet keep the horizontal strip; mobile (CSS ≤560px) collapses these into a
  // hamburger that drops the same items down as a left-anchored menu.
  nav.innerHTML = `<button class="nav-toggle" id="navToggle" aria-label="Menu" aria-expanded="${open}"><span class="nav-burger">${open ? '✕' : '☰'}</span><span class="nav-cur">${cur[1]}</span>${S.unread && S.view !== 'messages' ? ` <span class="nav-badge">${S.unread}</span>` : ''}</button><div class="nav-items" id="navItems">${btns}</div>`;
  const toggle = $('navToggle'), burger = nav.querySelector('.nav-burger');
  toggle.onclick = (e) => { e.stopPropagation(); const o = nav.classList.toggle('open'); toggle.setAttribute('aria-expanded', o); burger.textContent = o ? '✕' : '☰'; };
  nav.querySelectorAll('.navbtn').forEach(b => b.onclick = () => { S.view = b.dataset.view; S.msgThread = null; S.msgArchived = false; nav.classList.remove('open'); renderNav(); render(); });
  if (!window._navOutsideBound) {   // tap anywhere outside closes the mobile dropdown
    window._navOutsideBound = true;
    document.addEventListener('click', (e) => {
      if (nav.classList.contains('open') && !nav.contains(e.target)) {
        nav.classList.remove('open');
        const t = $('navToggle'); if (t) { t.setAttribute('aria-expanded', 'false'); const bb = nav.querySelector('.nav-burger'); if (bb) bb.textContent = '☰'; }
      }
    });
  }
}

// Dispatch to the active view.
function render() {
  setStaffLive(STAFF_LIVE);   // keep the live pill in sync with the current view
  if (S.view === 'messages') return renderMessages();
  if (S.view === 'myhours') return renderMyHours();
  if (S.view === 'mytasks') return renderMyTasks();
  if (S.view === 'server') return renderServer();
  if (S.view === 'history') return renderHistory();
  if (S.view === 'report') return renderReport();
  if (S.view === 'activity') return renderActivity();
  if (S.view === 'tables') return renderTables();
  return renderBoard();
}

// ── Messages: team inbox + compose, proxied to the shared Management directory ─
const MSG_LEADERSHIP = ['owner', 'admin', 'general_manager'];
const MSG_MANAGERS = ['manager', 'assistant_manager', 'kitchen_manager', 'regional_manager', 'general_manager'];
const roleWord = (r) => ({ owner: 'Owner', admin: 'Admin', general_manager: 'General Manager', regional_manager: 'Regional Manager', manager: 'Manager', assistant_manager: 'Assistant Manager', kitchen_manager: 'Kitchen Manager', frontdesk: 'Front Desk', host: 'Host', server: 'Server', busser: 'Busser', chef: 'Chef', line_cook: 'Line Cook', employee: 'Staff' }[r] || r);
const msgAgo = (iso) => { const d = new Date((iso || '').replace(' ', 'T') + 'Z'); const m = Math.floor((Date.now() - d.getTime()) / 60000); return m < 60 ? Math.max(0, m) + 'm ago' : m < 1440 ? Math.floor(m / 60) + 'h ago' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };

// Poll the unread count and refresh the nav badge (no full re-render).
async function refreshMsgUnread() {
  try { S.unread = (await api('/messages/unread-count')).count || 0; } catch { /* offline */ return; }
  if (S.user) renderNav();
}

async function renderMessages() {
  if (S.msgThread) return renderThreadView();
  const v = $('view');
  v.innerHTML = '<div class="empty">Loading…</div>';
  const arch = S.msgArchived;
  let msgs;
  try { msgs = await api('/messages/inbox' + (arch ? '?archived=1' : '')); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const unread = msgs.reduce((s, m) => s + (m.unread || 0), 0);
  v.innerHTML = `
    <div class="section-head"><h2>${arch ? 'Archived' : 'Messages'} ${!arch && unread ? `<span class="muted" style="font-weight:400;font-size:.9rem">· ${unread} unread</span>` : ''}</h2>
      <div style="display:flex;gap:.5rem">
        <button class="btn ghost" id="msgToggle">${arch ? '← Inbox' : '🗄️ Archived'}</button>
        ${arch ? '' : '<button class="btn big" id="msgNew">✉️ New</button>'}
      </div></div>
    <div class="msg-list">${msgs.length ? msgs.map(m => `
      <div class="msg-card ${m.is_read ? '' : 'unread'}" data-tid="${m.thread_id}" data-unread="${m.unread || 0}">
        <div class="msg-top"><span class="msg-from">${m.is_read ? '' : '<span class="msg-dot"></span>'}${esc(m.sender_name)} <span class="msg-role">${esc(roleWord(m.sender_role))}</span>${m.audience === 'all' ? ' <span class="msg-role bc">broadcast</span>' : ''}${m.thread_count > 1 ? ` <span class="msg-role">💬 ${m.thread_count}</span>` : ''}</span><span class="msg-when">${msgAgo(m.created_at)}</span></div>
        <div class="msg-subj">${esc(m.subject || '(no subject)')}</div>
        <div class="msg-text">${esc(m.body)}</div>
      </div>`).join('') : `<div class="empty">${arch ? 'No archived conversations.' : 'No messages yet.'}</div>`}</div>`;
  $('msgToggle').onclick = () => { S.msgArchived = !S.msgArchived; renderMessages(); };
  if ($('msgNew')) $('msgNew').onclick = composeModal;
  v.querySelectorAll('.msg-card').forEach(card => card.onclick = () => {
    const u = parseInt(card.dataset.unread || '0', 10);   // opening reads the whole thread — reflect it at once
    if (u > 0) { S.unread = Math.max(0, S.unread - u); card.classList.remove('unread'); card.querySelector('.msg-dot')?.remove(); renderNav(); }
    S.msgThread = card.dataset.tid; renderThreadView();
  });
}

async function renderThreadView() {
  const v = $('view');
  v.innerHTML = '<div class="empty">Loading…</div>';
  let t;
  try { t = await api(`/messages/thread/${S.msgThread}`); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  refreshMsgUnread();
  const me = t.me;
  const tid = S.msgThread;
  v.innerHTML = `
    <div class="section-head"><h2>${esc(t.subject || 'Conversation')}</h2>
      <div style="display:flex;gap:.4rem;flex-wrap:wrap">
        ${S.msgArchived
          ? '<button class="btn ghost" id="msgUnarch">📥 Unarchive</button>'
          : '<button class="btn ghost" id="msgUnread">◍ Mark unread</button><button class="btn ghost" id="msgArch">🗄️ Archive</button>'}
        <button class="btn ghost" id="msgBack">← Back</button>
      </div></div>
    <div class="thread">${t.messages.map(m => `
      <div class="thread-msg ${m.sender_id === me ? 'mine' : ''}">
        <div class="thread-meta">${esc(m.sender_name)} <span class="msg-role">${esc(roleWord(m.sender_role))}</span> · ${msgAgo(m.created_at)}</div>
        <div class="thread-body">${esc(m.body)}</div>
      </div>`).join('')}</div>
    <div class="reply-box"><textarea id="rBody" rows="2" placeholder="Write a reply…"></textarea><button class="btn" id="rSend">Reply</button></div>`;
  const backToList = () => { S.msgThread = null; renderMessages(); };
  $('msgBack').onclick = backToList;
  const threadAction = async (path, msg) => { try { await api(`/messages/thread/${tid}/${path}`, { method: 'POST' }); toast(msg); refreshMsgUnread(); backToList(); } catch (e) { toast(e.message, true); } };
  if ($('msgUnread')) $('msgUnread').onclick = () => threadAction('unread', 'Marked unread');
  if ($('msgArch')) $('msgArch').onclick = () => threadAction('archive', 'Archived');
  if ($('msgUnarch')) $('msgUnarch').onclick = () => threadAction('unarchive', 'Moved to inbox');
  const last = t.messages[t.messages.length - 1];
  $('rSend').onclick = async () => {
    const body = $('rBody').value.trim();
    if (!body) return;
    $('rSend').disabled = true;
    try { await api(`/messages/${last.id}/reply`, { method: 'POST', body: JSON.stringify({ body }) }); renderThreadView(); }
    catch (e) { toast(e.message, true); $('rSend').disabled = false; }
  };
}

async function composeModal() {
  let recips;
  try { recips = await api('/messages/recipients'); } catch (e) { toast(e.message, true); return; }
  const role = S.user.role;
  const myLoc = String(S.loc || S.user.location_id || '');
  const inLoc = (u) => String(u.location_id || '') === myLoc;
  const isMgr = MSG_MANAGERS.includes(role);
  const isLead = MSG_LEADERSHIP.includes(role);
  // Role-appropriate quick groups (each: [label, [ids]]).
  const groups = [];
  if (isLead) groups.push(['Everyone', recips.map(u => u.id)]);
  if (isMgr || isLead) groups.push(['My staff (this location)', recips.filter(u => inLoc(u) && !MSG_MANAGERS.includes(u.role) && !MSG_LEADERSHIP.includes(u.role)).map(u => u.id)]);
  groups.push(['Owner / Admin', recips.filter(u => u.role === 'owner' || u.role === 'admin').map(u => u.id)]);
  if (!isLead) groups.push(['My manager', recips.filter(u => MSG_MANAGERS.includes(u.role) && inLoc(u)).map(u => u.id)]);
  groups.push(['My peers (same role)', recips.filter(u => u.role === role && u.id !== S.user.id).map(u => u.id)]);
  const shown = groups.filter(g => g[1].length);
  const groupOpts = shown.map((g, i) => `<option value="g:${i}">${esc(g[0])} (${g[1].length})</option>`).join('');
  const personOpts = recips.map(u => `<option value="${u.id}">${esc(u.name)} — ${esc(roleWord(u.role))}${u.location ? ' · ' + esc(u.location.replace('Pho Ha Noi — ', '')) : ''}</option>`).join('');
  modal('New message', `
    <label>Send to</label>
    <select id="mTo">${groupOpts}<option value="person">A specific person…</option></select>
    <div id="mPersonWrap" class="hidden"><label>Person</label><select id="mPerson">${personOpts}</select></div>
    <label>Subject</label><input id="mSubj" placeholder="Subject (optional)" />
    <label>Message</label><textarea id="mBody" rows="4" placeholder="Write your message…"></textarea>
  `, async () => {
    const to = $('mTo').value, subject = $('mSubj').value, bodyTxt = $('mBody').value;
    if (!bodyTxt.trim()) throw new Error('Write a message first.');
    let ids;
    if (to === 'person') ids = [parseInt($('mPerson').value, 10)];
    else ids = shown[parseInt(to.split(':')[1], 10)][1];
    if (!ids.length) throw new Error('No recipients in that group.');
    const r = await api('/messages', { method: 'POST', body: JSON.stringify({ recipient_ids: ids, subject, body: bodyTxt }) });
    toast(`Sent to ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'}`);
  }, 'Send');
  $('mTo').onchange = () => $('mPersonWrap').classList.toggle('hidden', $('mTo').value !== 'person');
}

// ── My Hours: the staff member's own timesheet (proxied to Management) ─────────
const fmtHrs = (min) => { min = Math.max(0, Math.round(min)); const hh = Math.floor(min / 60), mm = min % 60; return mm ? `${hh}h ${mm}m` : `${hh}h`; };
function hoursRangeLabel(kind, anchor) {
  const d = new Date(anchor + 'T00:00:00');
  if (kind === 'daily') return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (kind === 'monthly') return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7)); const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const f = (x) => x.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${f(mon)} – ${f(sun)}`;
}
function hoursNav(dir) {
  const d = new Date(S.hoursAnchor + 'T00:00:00');
  if (S.hoursKind === 'daily') d.setDate(d.getDate() + dir);
  else if (S.hoursKind === 'monthly') d.setMonth(d.getMonth() + dir);
  else d.setDate(d.getDate() + dir * 7);
  S.hoursAnchor = d.toISOString().slice(0, 10); renderMyHours();
}
async function renderMyHours() {
  if (!S.hoursAnchor) S.hoursAnchor = new Date().toISOString().slice(0, 10);
  const v = $('view'); v.innerHTML = '<div class="empty">Loading…</div>';
  let d;
  try { d = await api(`/timeclock/my-hours?kind=${S.hoursKind}&anchor=${S.hoursAnchor}`); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const t = d.totals;
  const pill = (k, l) => `<button class="navbtn ${S.hoursKind === k ? 'active' : ''}" data-hk="${k}">${l}</button>`;
  const dayRows = (d.days || []).map(x => {
    const flags = [
      x.late_min > 0 ? `<span class="badge" style="background:var(--warn-bg);color:#92400e">⏰ ${fmtHrs(x.late_min)} late</span>` : '',
      x.ot_min > 0 ? `<span class="badge" style="background:#dbeafe;color:#1d4ed8">＋${fmtHrs(x.ot_min)} OT${x.ot_status === 'approved' ? ' ✓' : x.ot_status === 'pending' ? ' ⏳' : x.ot_status === 'escalated' ? ' ⏳' : ''}</span>` : '',
      x.short_min > 0 ? `<span class="badge left">${fmtHrs(x.short_min)} short</span>` : '',
    ].filter(Boolean).join(' ');
    return `<tr><td>${new Date(x.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</td><td>${x.scheduled_min ? fmtHrs(x.scheduled_min) : '—'}</td><td><strong>${fmtHrs(x.effective_min)}</strong>${x.adjusted ? ' <span class="muted" style="font-size:.8rem" title="rounded by manager">(adj)</span>' : ''}</td><td>${flags || '—'}</td></tr>`;
  }).join('');
  v.innerHTML = `
    <div class="section-head"><h2>My Hours</h2>
      <div style="display:flex;gap:.3rem;align-items:center"><button class="btn ghost" data-hnav="-1">‹</button><span style="font-weight:700">${esc(hoursRangeLabel(S.hoursKind, S.hoursAnchor))}</span><button class="btn ghost" data-hnav="1">›</button></div></div>
    <div class="subnav" style="margin:0 0 1rem;position:static">${pill('daily', 'Day')}${pill('weekly', 'Week')}${pill('monthly', 'Month')}</div>
    <div class="stats">
      <div class="stat"><div class="label">Scheduled</div><div class="value">${t.scheduled_hours}h</div></div>
      <div class="stat"><div class="label">Worked</div><div class="value">${t.total_hours}h</div></div>
      <div class="stat"><div class="label">Overtime</div><div class="value">${t.ot_hours}h${t.ot_pending_hours ? ` <span class="muted" style="font-size:.8rem">+${t.ot_pending_hours}?</span>` : ''}</div></div>
      <div class="stat"><div class="label">Late days</div><div class="value ${t.late_days ? 'warn' : ''}">${t.late_days}</div></div>
      ${t.sick_hours ? `<div class="stat"><div class="label">Sick</div><div class="value">${t.sick_hours}h</div></div>` : ''}
      ${t.vacation_hours ? `<div class="stat"><div class="label">Vacation</div><div class="value">${t.vacation_hours}h</div></div>` : ''}
      ${t.leave_hours ? `<div class="stat"><div class="label">On-leave</div><div class="value">${t.leave_hours}h</div></div>` : ''}
    </div>
    ${d.approved ? `<p class="sub" style="color:var(--ok)">✓ Total approved${d.approved_by ? ` by ${esc(d.approved_by)}` : ''}</p>` : ''}
    <div class="hist"><table><thead><tr><th>Day</th><th>Scheduled</th><th>Worked</th><th>Notes</th></tr></thead><tbody>${dayRows || '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:1.5rem">No clocked hours this period.</td></tr>'}</tbody></table></div>`;
  v.querySelectorAll('[data-hk]').forEach(b => b.onclick = () => { S.hoursKind = b.dataset.hk; renderMyHours(); });
  v.querySelectorAll('[data-hnav]').forEach(b => b.onclick = () => hoursNav(+b.dataset.hnav));
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
  while (_mtPhotoUrls.length) URL.revokeObjectURL(_mtPhotoUrls.pop());   // free the last render's blob URLs
  const cards = d.tasks.length ? d.tasks.map(mtCard).join('') : '<div class="sv-empty">No tasks assigned for today — enjoy your shift.</div>';
  v.innerHTML = `
    <div class="sv-head">
      <div><div class="sv-hi">My Tasks</div><div class="muted">${esc(day)} · ${done}/${total} done</div></div>
      ${total ? `<div class="mt-ring${done === total ? ' full' : ''}">${pct}%</div>` : ''}
    </div>
    ${cards}`;
  v.querySelectorAll('[data-start]').forEach(b => b.onclick = () => mtStart(b.dataset.start));
  v.querySelectorAll('[data-done]').forEach(b => b.onclick = () => mtDone(b.dataset.done, true));
  v.querySelectorAll('[data-undo]').forEach(b => b.onclick = () => mtDone(b.dataset.undo, false));
  v.querySelectorAll('[data-up]').forEach(i => i.onchange = () => { if (i.files && i.files[0]) mtUpload(i.dataset.up, i.files[0]); });
  v.querySelectorAll('[data-photo]').forEach(img => { loadTaskPhoto(img.dataset.photo, img); img.onclick = () => mtLightbox(img.src); });
}

// A day task moves to-do → (Start) in progress → (Done) done. A proof photo can be
// attached any time before Done and is shown as a thumbnail once stored.
function mtCard(t) {
  const time = t.task_time ? `<span class="mt-time">${esc(t.task_time)}</span>` : '';
  const meta = [t.department, t.est_minutes ? `~${t.est_minutes}m` : '', t.complexity].filter(Boolean).join(' · ');
  const inProgress = !t.done && t.started_at;
  const photo = t.has_photo ? `<img class="mt-photo" data-photo="${t.id}" alt="Proof photo" title="View proof">` : '';
  let status = '';
  if (t.done) status = `<span class="mt-stamp ok">✓ Done ${esc(fmtT(t.done_at))}</span>`;
  else if (inProgress) status = `<span class="mt-stamp">▶ Started ${esc(fmtT(t.started_at))}</span>`;
  let actions;
  if (t.done) {
    actions = `<button class="mt-btn ghost" data-undo="${t.id}">Undo</button>`;
  } else if (inProgress) {
    actions = `<label class="mt-btn photo">${t.has_photo ? '📷 Replace photo' : '📷 Add proof photo'}<input type="file" accept="image/*" capture="environment" data-up="${t.id}" hidden></label>
      <button class="mt-btn done" data-done="${t.id}">✓ Done</button>`;
  } else {
    actions = `<button class="mt-btn start" data-start="${t.id}">▶ Start</button>`;
  }
  return `<div class="mt-card${t.done ? ' done' : inProgress ? ' active' : ''}">
    <div class="mt-body">
      <div class="mt-name">${time}${esc(t.name)}</div>
      ${meta ? `<div class="muted mt-meta">${esc(meta)}</div>` : ''}
      ${t.description ? `<div class="mt-desc">${esc(t.description)}</div>` : ''}
      ${status ? `<div class="mt-status">${status}</div>` : ''}
      <div class="mt-actions">${actions}</div>
    </div>
    ${photo ? `<div class="mt-side">${photo}</div>` : ''}
  </div>`;
}
function fmtT(iso) { if (!iso) return ''; const d = new Date(iso.replace(' ', 'T') + 'Z'); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
async function mtStart(id) { try { await api(`/mytasks/${id}/start`, { method: 'PUT', body: '{}' }); renderMyTasks(); } catch (e) { toast(e.message, true); } }
async function mtDone(id, done) { try { await api(`/mytasks/${id}/done`, { method: 'PUT', body: JSON.stringify({ done }) }); renderMyTasks(); } catch (e) { toast(e.message, true); } }

// Upload a proof photo: send the raw image bytes (Content-Type = the file's type)
// so the server stores them as-is. Not through api() because that forces JSON.
async function mtUpload(id, file) {
  if (!file || !/^image\//.test(file.type)) { toast('Please choose an image.', true); return; }
  toast('Uploading photo…');
  try {
    const res = await fetch(`/api/mytasks/${id}/photo`, {
      method: 'POST',
      headers: { 'Content-Type': file.type, Authorization: 'Bearer ' + S.token },
      body: file,
    });
    if (res.status === 401 && S.token) { forceRelogin(); return; }
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'Upload failed');
    toast('Proof photo added'); renderMyTasks();
  } catch (e) { toast(e.message, true); }
}
const _mtPhotoUrls = [];
async function loadTaskPhoto(id, img) {
  try {
    const res = await fetch(`/api/mytasks/${id}/photo`, { headers: { Authorization: 'Bearer ' + S.token } });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob()); _mtPhotoUrls.push(url); img.src = url;
  } catch { /* thumbnail just won't load */ }
}
function mtLightbox(src) {
  if (!src) return;
  const o = document.createElement('div'); o.className = 'mt-lightbox';
  const img = document.createElement('img'); img.src = src; img.alt = 'Proof photo';
  o.appendChild(img); o.onclick = () => o.remove(); document.body.appendChild(o);
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
      <div class="sv-stats"><div><b>${tally.covers}</b><span>covers</span></div><div><b>$${(tally.tips || 0).toFixed(2)}</b><span>tips</span></div><div><b>🚶 ${(data.summary && data.summary.walkins_today) || 0}</b><span>walk-ins</span></div></div>
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
  const canEdit = canEditFloor(S.user.role);   // kitchen roles get a read-only floor
  $('view').innerHTML = `
    <div class="section-head"><h2>Table Map</h2>
      <div style="display:flex;gap:.4rem;align-items:center"><span class="badge seated">${sm.available} available</span> <span class="badge ${sm.occupied ? 'waiting' : 'left'}">${sm.occupied} occupied</span><button class="btn sm ghost" id="tmGuests">${showGuests() ? '👤 Guests shown' : '👤 Guests hidden'}</button></div></div>
    ${statusLegend(fp)}
    <p class="sub" style="margin:.1rem 0 .6rem">${canEdit ? 'Tap an available table to seat a guest; tap an occupied table to change its status.' : 'Live table status — view only.'}</p>
    <div class="floor-board${canEdit ? '' : ' readonly'}" id="fpBoard">${fpBoardHtml(fp)}</div>`;
  $('tmGuests').onclick = () => { toggleGuests(); renderTables(); };
  if (canEdit) $('view').querySelectorAll('[data-tbl]').forEach(el => el.onclick = () => {
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
  // Walk-ins today = staff-registered walk-ins only (Front Desk / Table Map);
  // the kiosk offers no walk-in option.
  const walkins = (svc.summary && svc.summary.walkins_today) || 0;
  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="label">Waiting now</div><div class="value">${stats.waiting}</div></div>
      <div class="stat"><div class="label">Longest wait</div><div class="value ${stats.longest_wait_min >= 30 ? 'warn' : ''}">${stats.longest_wait_min}m</div></div>
      <div class="stat"><div class="label">Quote next party</div><div class="value">${stats.next_quote_min}m</div></div>
      <div class="stat"><div class="label">Seated today</div><div class="value">${stats.seated_today}</div></div>
      <div class="stat"><div class="label">Staff walk-ins today</div><div class="value">🚶 ${walkins}</div></div>
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

// Walk-in: a guest the host walks in and seats right away (no waiting list) —
// pick a free table and go. Seats directly onto the visit lifecycle, so it
// flows into the Service lists for a server.
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
  try { if (sessionStorage.getItem('phnw_expired')) { sessionStorage.removeItem('phnw_expired'); showSessionBanner(); } } catch { /* private mode */ }
  const t = localStorage.getItem('phnw_token'), u = localStorage.getItem('phnw_user');
  if (t && u) { S.token = t; S.user = JSON.parse(u); boot().catch(() => { localStorage.clear(); location.reload(); }); }
})();
