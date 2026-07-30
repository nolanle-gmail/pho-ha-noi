// Pho Ha Noi — Host Check-in / Waitlist
const S = { token: null, user: null, locations: [], loc: null };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
  if (S.user.role === 'owner') {
    picker.classList.remove('hidden');
    picker.innerHTML = S.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    S.loc = String(S.locations[0].id); picker.value = S.loc;
    picker.onchange = () => { S.loc = picker.value; render(); };
  } else { S.loc = String(S.user.location_id); picker.classList.add('hidden'); }
  render();
  setInterval(() => { if (!$('modalHost').innerHTML) render(); }, 15000); // live refresh
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

async function render() {
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
      ${audit.length ? audit.map(a => { const [lbl, tone] = ACTION_LABEL[a.action] || [a.action, 'left']; return `<tr><td>${esc((a.created_at || '').slice(11, 16))}</td><td><span class="badge ${tone === 'gold' ? 'seated' : tone}" style="${tone === 'gold' ? 'background:var(--gold-soft);color:#92400e' : ''}">${lbl}</span></td><td>${auditSummary(a)}</td><td><strong>${esc(a.user_name || '—')}</strong>${a.user_role ? ` <span style="color:var(--muted)">· ${esc(a.user_role)}</span>` : ''}</td></tr>`; }).join('') : '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:1.5rem">No activity logged yet today.</td></tr>'}
    </tbody></table></div>`;

  $('addBtn').onclick = openAdd;
  $('view').querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act, b.dataset.id, b.dataset.name));
}

function partyCard(p, i) {
  const notified = !!p.notified_at;
  return `<div class="party ${notified ? 'notified' : ''}">
    <div class="pos">${i + 1}</div>
    <div class="info">
      <div class="name">${esc(p.guest_name)}${notified ? '<span class="tag">NOTIFIED</span>' : ''}</div>
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
  let quote = 0;
  try { quote = (await api(q('/waitlist/quote'))).suggested_minutes; } catch {}
  let size = 2;
  modal('Add party', `
    <label>Guest name</label><input id="fName" placeholder="e.g. Nguyen, Kim" />
    <label>Phone (for SMS page)</label><input id="fPhone" inputmode="tel" placeholder="+1 408 555 0100" />
    <label>Party size</label>
    <div class="stepper"><button type="button" id="minus">−</button><span class="n" id="sizeN">2</span><button type="button" id="plus">+</button></div>
    <label>Quoted wait (minutes)</label><input id="fQuote" type="number" value="${quote}" />
    <label>Notes</label><input id="fNotes" placeholder="Booth, high chair, birthday…" />
  `, async () => {
    const name = $('fName').value.trim();
    if (!name) throw new Error('Guest name is required.');
    await api('/waitlist/', { method: 'POST', body: JSON.stringify({
      location_id: S.loc, guest_name: name, party_size: size, phone: $('fPhone').value.trim() || null,
      quoted_minutes: $('fQuote').value, notes: $('fNotes').value.trim() || null }) });
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

(function init() {
  const t = localStorage.getItem('phnw_token'), u = localStorage.getItem('phnw_user');
  if (t && u) { S.token = t; S.user = JSON.parse(u); boot().catch(() => { localStorage.clear(); location.reload(); }); }
})();
