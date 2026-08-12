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
  S.locations = await api('/waitlist/locations');
  const picker = $('locPicker');
  const short = (id) => ((S.locations.find(l => String(l.id) === String(id)) || {}).name || '').replace('Pho Ha Noi — ', '');
  if (S.user.role === 'owner') {
    // Owner can view any store; remember the last one they were looking at.
    picker.classList.remove('hidden');
    picker.innerHTML = S.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    const saved = localStorage.getItem('phnw_fd_loc');
    S.loc = (saved && S.locations.some(l => String(l.id) === saved)) ? saved : String(S.locations[0].id);
    picker.value = S.loc;
    picker.onchange = () => { S.loc = picker.value; try { localStorage.setItem('phnw_fd_loc', S.loc); } catch { /* private mode */ } render(); };
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
  // Live refresh — only the board auto-refreshes (history/report keep filter state).
  setInterval(() => { if (S.view === 'board' && !$('modalHost').innerHTML) render(); }, 15000);
}

// Owner-only sub-navigation between the host board, guest history and report.
function renderNav() {
  const nav = $('subnav');
  if (S.user.role !== 'owner') { nav.classList.add('hidden'); nav.innerHTML = ''; return; }
  nav.classList.remove('hidden');
  const items = [['board', '🍜 Front Desk'], ['history', '📜 Guest History'], ['report', '📊 Daily Report'], ['activity', '🧾 Activity Log']];
  nav.innerHTML = items.map(([k, l]) => `<button class="navbtn ${S.view === k ? 'active' : ''}" data-view="${k}">${l}</button>`).join('');
  nav.querySelectorAll('button').forEach(b => b.onclick = () => { S.view = b.dataset.view; renderNav(); render(); });
}

// Dispatch to the active view.
function render() {
  if (S.view === 'history') return renderHistory();
  if (S.view === 'report') return renderReport();
  if (S.view === 'activity') return renderActivity();
  return renderBoard();
}

let activityFilter = 'all';
async function renderActivity() {
  let rows;
  try { rows = await api('/waitlist/activity-log' + (activityFilter === 'all' ? '' : '?event=' + activityFilter)); }
  catch (e) { $('view').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const sBadge = (s) => s >= 500 ? 'left' : s >= 400 ? 'waiting' : 'seated';
  const label = (r) => {
    if (r.path === '/api/auth/login') return r.status === 200 ? 'signed in' : 'sign-in failed';
    if (r.path === '/api/public/checkin') return 'customer self check-in';
    return `${r.method} ${r.path.replace('/api/waitlist', '').replace('/api', '')}`;
  };
  const tab = (k, l) => `<button class="navbtn ${activityFilter === k ? 'active' : ''}" data-af="${k}">${l}</button>`;
  $('view').innerHTML = `
    <div class="section-head"><h2>Activity Log <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${rows.length}</span></h2>
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
    const q = '/waitlist/activity-log?' + (activityFilter === 'all' ? '' : 'event=' + activityFilter + '&') + 'limit=1000';
    const rows = await api(q);
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

const ACTION_LABEL = {
  party_added: ['Added', 'gold'], party_notified: ['Notified', 'gold'],
  party_seated: ['Seated', 'seated'], party_left: ['Removed', 'left'],
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
  const [queue, stats, history, audit] = await Promise.all([api(q('/waitlist/')), api(q('/waitlist/stats')), api(q('/waitlist/history')), api(q('/waitlist/audit'))]);
  $('view').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="label">Waiting now</div><div class="value">${stats.waiting}</div></div>
      <div class="stat"><div class="label">Longest wait</div><div class="value ${stats.longest_wait_min >= 30 ? 'warn' : ''}">${stats.longest_wait_min}m</div></div>
      <div class="stat"><div class="label">Quote next party</div><div class="value">${stats.next_quote_min}m</div></div>
      <div class="stat"><div class="label">Seated today</div><div class="value">${stats.seated_today}</div></div>
    </div>
    <div class="section-head"><h2>Waiting (${queue.length})</h2><button class="btn big" id="addBtn">+ Add party</button></div>
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
  $('view').querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act, b.dataset.id, b.dataset.name));
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
      return modal(`Seat ${name}`, `<label>Table number (optional)</label><input id="fTable" placeholder="e.g. 12" />`,
        async () => { await api(`/waitlist/${id}/seat`, { method: 'PUT', body: JSON.stringify({ table_number: $('fTable').value.trim() }) }); toast(`${name} seated`); render(); }, 'Seat party');
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
