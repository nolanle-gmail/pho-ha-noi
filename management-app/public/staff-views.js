// Staff self-service views in the Management console — so store staff can use ONE app.
// Ported from the Staff app (waitlist-app/public/app.js): My Tasks, My Tables, Alerts.
// The backend is the same Management API, so these call it directly with the JWT:
//   /mytasks  -> /stafftasks      /service -> /visits      /alerts/* is identical.
// Relies on globals from app.js: $, S, api, esc, toast, modal, forceRelogin, renderSidebar.

// Relative "x min ago" for alert timestamps (SQLite UTC "YYYY-MM-DD HH:MM:SS").
function msgAgo(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return '';
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
}

// ── My Tasks ─────────────────────────────────────────────────────────────────
async function renderMyTasks() {
  const v = $('view');
  let d;
  try { d = await api('/stafftasks'); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const { done, total } = d.summary;
  const pct = total ? Math.round(done / total * 100) : 0;
  const day = (() => { const dt = new Date(d.date + 'T00:00:00'); return isNaN(dt) ? d.date : dt.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }); })();
  while (_mtPhotoUrls.length) URL.revokeObjectURL(_mtPhotoUrls.pop());
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
  v.querySelectorAll('[data-check]').forEach(b => b.onclick = () => mtDone(b.dataset.check, b.getAttribute('aria-checked') !== 'true'));
  v.querySelectorAll('[data-up]').forEach(i => i.onchange = () => { if (i.files && i.files.length) mtUpload(i.dataset.up, i.files); });
  v.querySelectorAll('[data-photos]').forEach(el => loadTaskPhotos(el.dataset.photos, el, el.dataset.editable === '1'));
  v.querySelectorAll('[data-comments]').forEach(el => loadTaskComments(el.dataset.comments, el, el.dataset.editable === '1'));
}

function mtCard(t) {
  const time = t.task_time ? `<span class="mt-time">${esc(t.task_time)}</span>` : '';
  const meta = [t.department, t.est_minutes ? `~${t.est_minutes}m` : '', t.complexity].filter(Boolean).join(' · ');
  const inProgress = !t.done && t.started_at;
  const nphotos = t.photo_count || 0;
  const ncomments = t.comment_count || 0;
  const photos = nphotos ? `<div class="mt-photos" data-photos="${t.id}" data-editable="${!t.done && inProgress ? 1 : 0}"></div>` : '';
  const comments = (ncomments || !t.done) ? `<div class="mt-comments" data-comments="${t.id}" data-editable="${!t.done ? 1 : 0}"></div>` : '';
  let status = '';
  if (t.done) status = `<span class="mt-stamp ok">✓ Done ${esc(fmtT(t.done_at))}</span>`;
  else if (inProgress) status = `<span class="mt-stamp">▶ Started ${esc(fmtT(t.started_at))}</span>`;
  let actions;
  if (t.done) {
    actions = `<button class="mt-btn ghost" data-undo="${t.id}">Undo</button>`;
  } else if (inProgress) {
    actions = `<label class="mt-btn photo">${nphotos ? '📷 Add more' : '📷 Add proof photos'}<input type="file" accept="image/*" capture="environment" multiple data-up="${t.id}" hidden></label>
      <button class="mt-btn done" data-done="${t.id}">✓ Done</button>`;
  } else {
    actions = `<button class="mt-btn start" data-start="${t.id}">▶ Start</button>`;
  }
  return `<div class="mt-card${t.done ? ' done' : inProgress ? ' active' : ''}" data-id="${t.id}">
    <div class="mt-body">
      <div class="mt-name">${time}${esc(t.name)}</div>
      ${meta ? `<div class="muted mt-meta">${esc(meta)}</div>` : ''}
      ${t.description ? `<div class="mt-desc">${esc(t.description)}</div>` : ''}
      ${status ? `<div class="mt-status">${status}</div>` : ''}
      ${photos}
      ${comments}
      <div class="mt-actions">${actions}</div>
    </div>
    <button type="button" class="mt-check${t.done ? ' on' : ''}" data-check="${t.id}" role="checkbox" aria-checked="${t.done ? 'true' : 'false'}" title="${t.done ? 'Done — tap to undo' : 'Mark done'}">
      <span class="mt-box">${t.done ? '✓' : ''}</span>
      <span class="mt-check-lbl">Done</span>
    </button>
  </div>`;
}
function fmtT(iso) { if (!iso) return ''; const d = new Date(iso.replace(' ', 'T') + 'Z'); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
async function mtStart(id) { try { await api(`/stafftasks/${id}/start`, { method: 'PUT', body: '{}' }); renderMyTasks(); } catch (e) { toast(e.message, true); } }
async function mtDone(id, done) {
  mtMarkDone(id, done);
  try { await api(`/stafftasks/${id}/done`, { method: 'PUT', body: JSON.stringify({ done }) }); renderMyTasks(); }
  catch (e) { toast(e.message, true); renderMyTasks(); }
}
function mtMarkDone(id, done) {
  const card = document.querySelector(`.mt-card[data-id="${id}"]`);
  if (!card) return;
  const wasDone = card.classList.contains('done');
  if (wasDone === done) return;
  card.classList.toggle('done', done);
  card.classList.remove('active');
  const box = card.querySelector('.mt-check');
  if (box) {
    box.classList.toggle('on', done);
    box.setAttribute('aria-checked', done ? 'true' : 'false');
    box.title = done ? 'Done — tap to undo' : 'Mark done';
    const mark = box.querySelector('.mt-box'); if (mark) mark.textContent = done ? '✓' : '';
  }
  const sub = document.querySelector('.sv-head .muted');
  if (sub) {
    const m = sub.textContent.match(/(\d+)\/(\d+) done/);
    if (m) { const n = Math.max(0, Math.min(+m[2], +m[1] + (done ? 1 : -1))); sub.textContent = sub.textContent.replace(/\d+\/\d+ done/, `${n}/${m[2]} done`); }
  }
}
async function mtUpload(id, files) {
  const list = [...files].filter(f => /^image\//.test(f.type));
  if (!list.length) { toast('Please choose image files.', true); return; }
  toast(list.length > 1 ? `Uploading ${list.length} photos…` : 'Uploading photo…');
  let ok = 0, err = '';
  for (const file of list) {
    try {
      const res = await fetch(`/api/stafftasks/${id}/photo`, {
        method: 'POST',
        headers: { 'Content-Type': file.type, Authorization: 'Bearer ' + S.token },
        body: file,
      });
      if (res.status === 401 && S.token) { forceRelogin(); return; }
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { err = d.error || 'Upload failed'; break; }
      ok++;
    } catch (e) { err = e.message; break; }
  }
  if (err) toast(err, true); else toast(ok > 1 ? `${ok} photos added` : 'Proof photo added');
  renderMyTasks();
}
const _mtPhotoUrls = [];
async function loadTaskPhotos(id, el, editable) {
  let d;
  try { d = await api(`/stafftasks/${id}/photos`); } catch { return; }
  if (!d.photos || !d.photos.length) { el.remove(); return; }
  el.innerHTML = '';
  for (const p of d.photos) {
    const fig = document.createElement('div'); fig.className = 'mt-thumb';
    const img = document.createElement('img'); img.className = 'mt-photo'; img.alt = 'Proof photo';
    fig.appendChild(img);
    if (editable) {
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'mt-thumb-rm'; x.textContent = '✕'; x.title = 'Remove photo';
      x.onclick = (e) => { e.stopPropagation(); mtRemovePhoto(id, p.id); };
      fig.appendChild(x);
    }
    el.appendChild(fig);
    try {
      const res = await fetch(`/api/stafftasks/${id}/photo/${p.id}`, { headers: { Authorization: 'Bearer ' + S.token } });
      if (!res.ok) continue;
      const url = URL.createObjectURL(await res.blob()); _mtPhotoUrls.push(url);
      img.src = url; img.onclick = () => mtLightbox(url);
    } catch { /* one thumbnail failing is fine */ }
  }
}
async function mtRemovePhoto(id, pid) {
  try { await api(`/stafftasks/${id}/photo/${pid}`, { method: 'DELETE' }); toast('Photo removed'); renderMyTasks(); }
  catch (e) { toast(e.message, true); }
}
async function loadTaskComments(id, el, editable) {
  let d;
  try { d = await api(`/stafftasks/${id}/comments`); } catch { return; }
  const list = (d.comments || []).map(c => {
    const mine = String(c.author_id) === String(S.user.id);
    const rm = (editable && mine) ? `<button type="button" class="mt-cm-rm" title="Remove" data-rmc="${c.id}">✕</button>` : '';
    return `<div class="mt-cm"><div class="mt-cm-head"><strong>${esc(c.author_name || 'Staff')}</strong><span>${esc(mtCommentTime(c.created_at))}</span>${rm}</div><div class="mt-cm-body">${esc(c.body)}</div></div>`;
  }).join('');
  const composer = editable
    ? `<div class="mt-cm-add"><input type="text" class="mt-cm-input" maxlength="1000" placeholder="Add a comment or feedback…" data-cin="${id}"><button type="button" class="mt-btn ghost mt-cm-send" data-caddid="${id}">Comment</button></div>`
    : '';
  if (!list && !composer) { el.remove(); return; }
  el.innerHTML = `<div class="mt-cm-label">💬 Comments &amp; feedback</div>${list}${composer}`;
  el.querySelectorAll('[data-rmc]').forEach(b => b.onclick = () => mtRemoveComment(id, b.dataset.rmc));
  const input = el.querySelector('[data-cin]');
  const send = el.querySelector('[data-caddid]');
  if (send && input) {
    send.onclick = () => mtAddComment(id, input);
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); mtAddComment(id, input); } };
  }
}
function mtCommentTime(iso) { if (!iso) return ''; const d = new Date(iso.replace(' ', 'T') + 'Z'); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
async function mtAddComment(id, input) {
  const body = (input.value || '').trim();
  if (!body) { toast('Write a comment first.', true); return; }
  try { await api(`/stafftasks/${id}/comment`, { method: 'POST', body: JSON.stringify({ body }) }); input.value = ''; toast('Comment added'); renderMyTasks(); }
  catch (e) { toast(e.message, true); }
}
async function mtRemoveComment(id, cid) {
  try { await api(`/stafftasks/${id}/comment/${cid}`, { method: 'DELETE' }); toast('Comment removed'); renderMyTasks(); }
  catch (e) { toast(e.message, true); }
}
function mtLightbox(src) {
  if (!src) return;
  const o = document.createElement('div'); o.className = 'mt-lightbox';
  const img = document.createElement('img'); img.src = src; img.alt = 'Proof photo';
  o.appendChild(img); o.onclick = () => o.remove(); document.body.appendChild(o);
}

// ── My Tables (server view: my tables, checks, claim queue, covers + tips) ─────
async function renderMyTables() {
  const v = $('view');
  let data, tally;
  try { [data, tally] = await Promise.all([api('/visits'), api('/visits/me/tally')]); }
  catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
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
      <span class="sv-row-info">${esc(t.guest_name || 'Guest')} · ${t.party_size}👤<br><span class="muted">seated ${t.seated_min_ago ?? 0}m ago</span></span>
      <button class="sv-btn claim" data-act="claim" data-vid="${t.id}">Claim</button></div>`).join('') : '<div class="sv-empty">No open tables to claim.</div>';
  const busSection = toBus.length ? `<div class="sv-sec-h">To bus <span class="sv-n">${toBus.length}</span></div>${toBus.map(t => `<div class="sv-row">
      <span class="sv-tnum sm">T${esc(t.table_label || '?')}</span>
      <span class="sv-row-info">${esc(t.guest_name || '')} <span class="muted">· ready to clear</span></span>
      <button class="sv-btn" data-act="bussed" data-vid="${t.id}">✓ Bussed</button></div>`).join('')}` : '';

  v.innerHTML = `
    <div class="sv-head">
      <div><div class="sv-hi">My Tables</div><div class="muted">${mine.length} table${mine.length !== 1 ? 's' : ''} · ${tally.open_tables} open</div></div>
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
  const actions = paying
    ? `<button class="sv-btn go wide" data-act="done" data-vid="${t.id}">✓ Done</button>`
    : `<button class="sv-btn go" data-act="check" data-vid="${t.id}">✓ Check</button><button class="sv-btn" data-act="pay" data-vid="${t.id}">To pay</button><button class="sv-btn" data-act="done" data-vid="${t.id}">Done</button>`;
  return `<div class="sv-card${t.check_due ? ' due' : ''}">
    <div class="sv-card-top"><span class="sv-tnum">T${esc(t.table_label || '?')}</span>
      <div class="sv-card-info"><div class="sv-g">${esc(t.guest_name || 'Guest')} · ${t.party_size}👤</div><div class="muted">${chk}</div></div></div>
    <div class="sv-actions">${actions}</div>
    <div class="sv-flags">
      <button class="sv-flag${t.help_flag ? ' on' : ''}" data-act="help" data-vid="${t.id}">${t.help_flag ? '✋ Help raised' : '✋ Call for help'}</button>
      <button class="sv-flag${t.bus_flag ? ' on' : ''}" data-act="bus" data-vid="${t.id}">${t.bus_flag ? '🧹 Bus pinged' : '🧹 Ready to bus'}</button>
    </div></div>`;
}
async function svAction(act, vid) {
  const t = (S.svById || {})[vid] || {};
  const put = (path, body) => api(`/visits/${vid}/${path}`, { method: 'PUT', body: JSON.stringify(body || {}) });
  try {
    if (act === 'done') return svDoneModal(vid);
    if (act === 'check') { await put('check'); toast('Checked'); }
    else if (act === 'pay') { await put('pay'); toast('Moved to paying'); }
    else if (act === 'claim') { await put('claim'); toast('Table claimed'); }
    else if (act === 'help') { await put('help', { on: !t.help_flag }); toast(t.help_flag ? 'Help cleared' : 'Manager notified'); }
    else if (act === 'bus') { await put('bus', { on: !t.bus_flag }); toast(t.bus_flag ? 'Bus canceled' : 'Busser pinged'); }
    else if (act === 'bussed') { await put('bus', { on: false }); toast('Table cleared'); }
    renderMyTables();
  } catch (e) { toast(e.message, true); }
}
function svDoneModal(vid) {
  modal('Close table', [{ key: 'tip', label: 'Tip (optional, $)', type: 'number', step: '0.01' }],
    async (v) => { const tip = String(v.tip || '').trim(); await api(`/visits/${vid}/done`, { method: 'PUT', body: JSON.stringify(tip ? { tip_amount: tip } : {}) }); toast('Table done'); renderMyTables(); }, 'Done');
}

// ── Alerts (received floor / system alerts — the staffer's inbox) ──────────────
const FLOW_ACT_LABEL = { served: '✅ Mark Served', paid: '💳 Paid', bussed: '🧽 Mark Bussed', waiting: '⏳ Waiting', notyet: '⏳ Not yet' };
const FLOW_WAIT_ACTS = ['waiting', 'notyet'];
const flowActToast = (act) => ({
  served: 'Marked served — updated on the board', paid: 'Marked paid — busser alerted',
  bussed: 'Bussed — table cleared', waiting: 'Waiting — the floor will be re-alerted soon.',
  notyet: 'Not yet — we’ll re-check the table shortly.',
}[act] || 'Updated');
async function refreshAlertCount() {
  try { const d = await api('/alerts/inbox'); S.alertCount = d.active_count || 0; } catch { /* keep last */ }
  renderSidebar();
}
async function renderMyAlerts() {
  const v = $('view');
  if (!S.alertTab) S.alertTab = 'active';
  v.innerHTML = `<div class="section-head"><h2>🔔 Alerts</h2></div>
    <div class="seg" style="margin-bottom:.7rem"><button class="seg-btn ${S.alertTab === 'active' ? 'active' : ''}" data-at="active">Active${S.alertCount ? ` (${S.alertCount})` : ''}</button><button class="seg-btn ${S.alertTab === 'history' ? 'active' : ''}" data-at="history">History</button></div>
    <div id="alBody"><div class="empty">Loading…</div></div>`;
  v.querySelectorAll('[data-at]').forEach(b => b.onclick = () => { S.alertTab = b.dataset.at; renderMyAlerts(); });
  let d; try { d = await api('/alerts/inbox'); } catch (e) { const el = $('alBody'); if (el) el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (S.section !== 'alerts') return;
  S.alertCount = d.active_count || 0; renderSidebar();
  const at = $('view').querySelector('[data-at="active"]'); if (at) at.textContent = 'Active' + (S.alertCount ? ` (${S.alertCount})` : '');
  const list = S.alertTab === 'active' ? d.active : d.history;
  if (!list.length) { $('alBody').innerHTML = `<div class="empty">${S.alertTab === 'active' ? 'No active alerts — you’re all caught up. 🎉' : 'No past alerts yet.'}</div>`; return; }
  const srcOf = (a) => /^(🍽|🧾|🧽|⏱)/.test(a.body || '') ? 'Service Flow' : a.sender_name;
  $('alBody').innerHTML = list.map(a => `<div class="al-card${a.priority === 'urgent' ? ' al-urgent' : ''}${a.status === 'waiting' ? ' al-waiting' : ''}">
    <div class="al-body">${a.priority === 'urgent' ? '🔴 ' : ''}${esc(a.body)}</div>
    <div class="al-meta">from ${esc(srcOf(a))} · ${msgAgo(a.created_at)}${a.mine_done_at ? ` · ✅ done ${msgAgo(a.mine_done_at)}` : ''}</div>
    ${alertActions(a)}
  </div>`).join('');
  const body = $('alBody');
  body.querySelectorAll('[data-ack]').forEach(b => b.onclick = () => { b.disabled = true; api(`/alerts/${b.dataset.ack}/ack`, { method: 'POST', body: '{}' }).then(() => { toast('Acknowledged — tap Done when finished'); renderMyAlerts(); }).catch(e => { toast(e.message, true); b.disabled = false; }); });
  body.querySelectorAll('[data-done]').forEach(b => b.onclick = () => { b.disabled = true; api(`/alerts/${b.dataset.done}/complete`, { method: 'POST', body: '{}' }).then(() => { toast('Marked done — moved to History'); try { _shownAlerts.delete(+b.dataset.done); } catch { /* ignore */ } refreshAlertCount(); renderMyAlerts(); }).catch(e => { toast(e.message, true); b.disabled = false; }); });
  body.querySelectorAll('[data-claim]').forEach(b => b.onclick = () => { b.disabled = true; api(`/alerts/${b.dataset.claim}/claim`, { method: 'POST', body: '{}' }).then(() => { toast('You’ve got it — check the table & kitchen'); renderMyAlerts(); }).catch(e => { toast(e.message, true); refreshAlertCount(); renderMyAlerts(); }); });
  body.querySelectorAll('[data-flow]').forEach(b => b.onclick = () => {
    b.disabled = true;
    const act = b.dataset.act;
    api(`/alerts/${b.dataset.flow}/flow`, { method: 'POST', body: JSON.stringify({ action: act }) })
      .then(() => {
        toast(flowActToast(act));
        if (!FLOW_WAIT_ACTS.includes(act)) { try { _shownAlerts.delete(+b.dataset.flow); } catch { /* ignore */ } }
        refreshAlertCount(); renderMyAlerts();
      })
      .catch(e => { toast(e.message, true); b.disabled = false; });
  });
}
function alertActions(a) {
  if (S.alertTab !== 'active') return '';
  if (a.flow_kind && a.actions) {
    if (!a.mine_claim) return `<div class="al-act"><button class="btn" data-claim="${a.id}">🙋 On It</button></div>`;
    const waiting = a.status === 'waiting';
    const btns = a.actions.map(act => `<button class="btn ${act === 'waiting' ? 'ghost' : ''}" data-flow="${a.id}" data-act="${act}">${FLOW_ACT_LABEL[act] || act}</button>`).join('');
    return `${waiting ? '<div class="al-wait">⏳ Waiting — the floor is re-alerted every ~5 min until it’s served.</div>' : ''}<div class="al-act">${btns}</div>`;
  }
  return `<div class="al-act">${a.mine_ack ? '<span class="muted">✓ On it</span>' : `<button class="btn ghost" data-ack="${a.id}">✓ On it</button>`}<button class="btn" data-done="${a.id}">✓ Done</button></div>`;
}

// ── Scan (staff self-service) ─────────────────────────────────────────────────
// The Staff-app scanner, ported into the console so store staff scan from the one app they now use.
// Everything goes through /api/invscan/* (the dual-auth proxy) which scopes to the signed-in
// staffer's OWN store via their JWT. Shared helpers (scanLangs/scanSection/boxDiffNote,
// comboHTML/comboWire/comboVal, CATEGORY_OPTIONS/UOM_OPTIONS, numf, esc, api, toast) come from app.js.
function renderStaffScan() {
  $('view').innerHTML = `<div class="section-head"><h2>📠 Scan Inventory</h2></div>
    <div class="empty" style="text-align:left;line-height:1.6">
      <p>Scan a product barcode with your scanner to <strong>receive</strong> stock, <strong>transfer</strong> it to another location, <strong>check</strong> stock across every location, or mark stock <strong>used</strong> in the kitchen. Actions apply to <strong>your store</strong>.</p>
      <button class="btn primary" id="scanStart" style="margin-top:.6rem">📠 Open scanner</button>
    </div>`;
  $('scanStart').onclick = svOpenScanner;
}

async function svOpenScanner() {
  // Central Kitchen / Warehouse staff additionally get a Shipping (load) mode to fulfil store orders.
  const hub = await api('/invscan/hub').catch(() => ({ is_hub: false }));
  const isHub = !!(hub && hub.is_hub);
  const hubName = ((hub && hub.hub && hub.hub.name) || '').replace('Pho Ha Noi — ', '');
  const host = document.createElement('div'); host.className = 'scan-overlay';
  host.innerHTML = `<div class="scan-card">
    <div class="scan-head"><strong>📠 Scan</strong><button class="btn sm ghost" data-x>✕ Close</button></div>
    <div class="scan-modes"><button class="btn sm" data-mode="receive">📥 Receiving</button>${isHub ? '<button class="btn sm ghost" data-mode="ship">📤 Shipping</button>' : ''}<button class="btn sm ghost" data-mode="transfer">🔁 Transferring</button><button class="btn sm ghost" data-mode="check">📋 Checking Inventory</button><button class="btn sm ghost" data-mode="use">🍳 Use</button></div>
    <div id="shipBar" class="ship-bar" hidden></div>
    <div id="scanMsg" class="scan-msg">📠 Ready — scan a barcode with your scanner.</div>
    <div id="scanPanel"></div>
    <div class="scan-manual"><input id="scanManual" placeholder="📠 Scan with your scanner — or type a code" inputmode="numeric" autocomplete="off"><button class="btn sm" id="scanManualGo">Go</button></div>
  </div>`;
  document.body.appendChild(host);
  // A USB/Bluetooth barcode scanner is a keyboard-wedge: it types the code + Enter. Keep this field
  // focused so scans land here hands-free (phone, tablet or PC — no camera needed).
  const focusManual = () => { const m = $('scanManual'); if (m) { try { m.focus(); } catch { /* ignore */ } } };
  setTimeout(focusManual, 60);
  let busy = false, mode = 'receive', shipStore = null;
  const close = () => { host.remove(); };
  host.querySelector('[data-x]').onclick = close;
  const shipTo = () => { const s = $('shipTo'); return s ? s.value : ''; };
  const shipToName = () => { const s = $('shipTo'); return s && s.selectedOptions[0] ? s.selectedOptions[0].textContent : ''; };
  // ── Load mode (hub): the queue of stores with approved orders → tap a store → scan items ──
  async function renderShipQueue() {
    const box = $('shipBar'); if (!box || mode !== 'ship') return;
    if (shipStore) return renderShipStore();
    box.innerHTML = '<div class="muted" style="font-size:.82rem">Loading orders…</div>';
    let d; try { d = await api('/invscan/ship-queue'); } catch (e) { box.innerHTML = `<div class="muted" style="font-size:.82rem">${esc(e.message)}</div>`; return; }
    if (mode !== 'ship') return;
    const ords = d.orders || [];
    box.innerHTML = `<div class="ship-ord-h">📦 Approved orders to load from <strong>${esc(hubName)}</strong></div>`
      + (ords.length ? `<div class="ship-queue">${ords.map(o => `<button class="ship-ord pick" data-store="${o.store_id}" data-name="${esc(o.store_name)}"><span>${esc((o.store_name || '').replace('Pho Ha Noi — ', ''))}</span><span class="mono">${o.lines} item${o.lines === 1 ? '' : 's'}${o.started ? ' · started' : ''} ›</span></button>`).join('')}</div>`
        : '<div class="muted" style="font-size:.82rem">No approved orders to load. ✅</div>');
    box.querySelectorAll('[data-store]').forEach(b => b.onclick = () => { shipStore = { id: b.dataset.store, name: b.dataset.name }; renderShipStore(); });
  }
  async function renderShipStore() {
    const box = $('shipBar'); if (!box || !shipStore) return;
    box.innerHTML = '<div class="muted" style="font-size:.82rem">Loading order…</div>';
    let d; try { d = await api('/invscan/ship-queue/' + shipStore.id); } catch (e) { box.innerHTML = `<div class="muted" style="font-size:.82rem">${esc(e.message)}</div>`; return; }
    const lines = d.lines || [], sn = (shipStore.name || '').replace('Pho Ha Noi — ', '');
    box.innerHTML = `<div class="ship-ord-h"><button class="btn sm ghost" id="shipBack">← Orders</button> &nbsp;📤 <strong>${esc(sn)}</strong> — scan items to load</div>`
      + (lines.length ? `<div class="ship-queue">${lines.map(o => `<div class="ship-ord${o.remaining <= 0.0005 ? ' done' : ''}"><span>${esc(o.item_name)}</span><span class="mono">${numf(o.shipped_qty)} loaded / ${numf(o.requested_qty)} ordered ${esc(o.unit || '')}${o.on_hand <= 0.0005 ? ' · ⚠ none here' : ''}</span></div>`).join('')}</div>`
        : '<div class="muted" style="font-size:.82rem">This order is fully loaded. ✅</div>');
    const bk = $('shipBack'); if (bk) bk.onclick = () => { shipStore = null; renderShipQueue(); };
  }
  const refreshShip = () => { if (mode === 'ship') { shipStore ? renderShipStore() : renderShipQueue(); } };
  async function setMode(m) {
    mode = m;
    host.querySelectorAll('[data-mode]').forEach(b => b.className = 'btn sm' + (b.dataset.mode === m ? '' : ' ghost'));
    const wantsBar = (m === 'transfer' || m === 'ship');
    $('shipBar').hidden = !wantsBar;
    $('scanMsg').textContent = m === 'ship' ? 'Pick an order below, then scan the items to load.' : m === 'transfer' ? 'Choose a destination, then scan to transfer stock there.' : (m === 'check' ? 'Scan an item to see stock across all locations.' : (m === 'use' ? 'Scan an item to record kitchen use.' : '📠 Ready — scan a barcode with your scanner.'));
    if (m === 'ship') { $('shipBar').dataset.loaded = ''; await renderShipQueue(); }
    else if (m === 'transfer' && !$('shipBar').dataset.loaded) {
      $('shipBar').dataset.loaded = '1';
      let tgts = []; try { tgts = await api('/invscan/ship/targets'); } catch { /* ignore */ }
      // Ad-hoc transfer: destination only, no open-order fill list (store staff don't fulfil orders).
      $('shipBar').innerHTML = `<label class="ship-lbl">Transfer to</label>
        <select id="shipTo"><option value="">— choose destination —</option>${tgts.map(t => `<option value="${t.id}">${esc(t.name)}${t.type === 'central_kitchen' ? ' (CK)' : t.type === 'warehouse' ? ' (WH)' : ''}</option>`).join('')}</select>
        <div id="shipOrders"></div>`;
    }
  }
  host.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  const onCode = async (code) => {
    if (busy) return; busy = true;
    try { navigator.vibrate && navigator.vibrate(50); } catch { /* ignore */ }
    $('scanMsg').textContent = 'Scanned: ' + code;
    const done = () => { busy = false; $('scanPanel').innerHTML = ''; $('scanMsg').textContent = mode === 'ship' ? (shipStore ? 'Scan the next item to load.' : 'Pick an order below, then scan its items.') : mode === 'transfer' ? 'Scan the next item to transfer.' : (mode === 'check' ? 'Scan another to check.' : (mode === 'use' ? 'Scan another to record use.' : '📠 Ready — scan the next barcode.')); focusManual(); };
    if (mode === 'ship') await svHandleShipOrder(code, $('scanPanel'), done, shipStore, refreshShip);
    else if (mode === 'transfer') await svHandleShip(code, $('scanPanel'), done, shipTo(), shipToName(), () => {}, 'Transfer');
    else if (mode === 'check') await svHandleCheck(code, $('scanPanel'), done);
    else if (mode === 'use') await svHandleUse(code, $('scanPanel'), done);
    else await svHandleScan(code, $('scanPanel'), done);
  };
  $('scanManualGo').onclick = () => { const el = $('scanManual'); const c = (el.value || '').trim(); el.value = ''; if (c) onCode(c); focusManual(); };
  $('scanManual').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('scanManualGo').click(); } };
}

// Scan an item to LOAD a line of the picked store's approved order (hub staff). Decrements the hub;
// the order advances to 'loaded' once every approved item is scanned on.
async function svHandleShipOrder(code, panel, next, shipStore, refreshShip) {
  if (!shipStore) { panel.innerHTML = `<div class="scan-err">Pick an order above first, then scan its items.</div>`; setTimeout(() => next && next(), 1400); return; }
  panel.innerHTML = '<div class="scan-msg">Looking up…</div>';
  let d; try { d = await api('/invscan/resolve/' + encodeURIComponent(code)); } catch (e) { panel.innerHTML = `<div class="scan-err">${esc(e.message)}</div><button class="btn sm ghost" id="shAgain">OK</button>`; $('shAgain').onclick = next; return; }
  const key = d.code || code;
  if (!d.item) { panel.innerHTML = `<div class="scan-found">🚫 <strong>Not stocked here</strong> <span class="mono">${esc(key)}</span><div class="sub">Nothing to load.</div></div><button class="btn sm ghost" id="shAgain">Scan another</button>`; $('shAgain').onclick = next; return; }
  const it = d.item, sn = (shipStore.name || '').replace('Pho Ha Noi — ', '');
  let line = null;
  try { const q = await api('/invscan/ship-queue/' + shipStore.id); line = ((q && q.lines) || []).find(l => l.item_name === it.item_name && l.remaining > 0.0005); } catch { /* ignore */ }
  if (!line) { panel.innerHTML = `<div class="scan-found">⚠ <strong>${esc(it.item_name)}</strong><div class="sub">isn't on ${esc(sn)}'s approved order (or already fully loaded).</div></div><button class="btn sm ghost" id="shAgain">Scan another</button>`; $('shAgain').onclick = next; return; }
  const dflt = (d.parsed && d.parsed.weightLb) || line.remaining || 1;
  panel.innerHTML = `<div class="scan-found">📤 <strong>${esc(it.item_name)}</strong><div class="sub">${numf(it.quantity)} ${esc(it.unit)} on hand · order needs ${numf(line.remaining)} ${esc(line.unit || it.unit)} → <strong>${esc(sn)}</strong></div>${scanLangs(d.glossary)}${scanSection(it)}
    <div class="scan-act"><input id="shq" type="number" value="${dflt}" min="0" step="any"></div>
    <div class="scan-act"><button class="btn" id="shGo">📤 Load</button><button class="btn ghost" id="shAgain">Cancel</button></div></div>`;
  $('shAgain').onclick = next;
  $('shGo').onclick = async () => {
    $('shGo').disabled = true;
    const body = { to_location_id: shipStore.id, code: key, quantity: $('shq').value };
    let r; try { r = await api('/invscan/ship-scan', { method: 'POST', body: JSON.stringify(body) }); } catch (e) { $('shGo').disabled = false; toast(e.message); return; }
    if (r && r.over) { if (!window.confirm(r.message)) { $('shGo').disabled = false; return; } try { r = await api('/invscan/ship-scan', { method: 'POST', body: JSON.stringify(Object.assign({}, body, { confirm: true })) }); } catch (e) { $('shGo').disabled = false; toast(e.message); return; } }
    if (r && r.not_on_order) { $('shGo').disabled = false; toast(r.error || 'That item is not on this order.'); return; }
    if (!r || !r.ok) { $('shGo').disabled = false; toast((r && r.error) || 'Could not load that item.'); return; }
    const o = r.order;
    panel.innerHTML = `<div class="scan-found">✓ Loaded ${numf(r.shipped)} ${esc(r.unit || it.unit)} → ${esc(sn)}${o ? (o.done ? ' · line complete ✅' : ` · ${numf(o.shipped_qty)}/${numf(o.requested_qty)}`) : ''}${o && o.raised ? ' · over, original kept' : ''}</div><button class="btn sm" id="shAgain">Scan another</button>`;
    $('shAgain').onclick = next;
    refreshShip && refreshShip();
  };
}

async function svHandleScan(code, panel, next, skipInbound) {
  panel.innerHTML = '<div class="scan-msg">Looking up…</div>';
  let r; try { r = await api('/invscan/resolve/' + encodeURIComponent(code)); } catch (e) { panel.innerHTML = `<div class="scan-err">${esc(e.message)}</div>`; return; }
  const p = r.parsed || {};
  const key = r.code || code;
  const packed = p.packDate || p.prodDate || '';
  const labelExpiry = p.expiry || packed || '';
  const labelLot = p.lot || '';
  const wt = p.weightLb || '';
  const gs1 = (p.isGs1 || wt || labelExpiry || labelLot || p.serial) ? `<div class="scan-gs1">🏷️ Label${wt ? ` · <strong>${numf(wt)} lb</strong>` : ''}${packed ? ` · packed ${esc(packed)}` : ''}${p.expiry ? ` · exp ${esc(p.expiry)}` : ''}${labelLot ? ` · lot ${esc(labelLot)}` : ''}${p.serial ? ` · #${esc(p.serial)}` : ''}</div>` : '';
  // Order/transfer-aware receiving: receive against an open shipped order / in-transit transfer first.
  const inboundLines = (r.inbound ? [...(r.inbound.orders || []), ...(r.inbound.transfers || [])] : []);
  if (!skipInbound && inboundLines.length) {
    const name = (r.item && r.item.item_name) || (r.glossary && r.glossary.name) || key;
    const unit = (r.item && r.item.unit) || (inboundLines[0] && inboundLines[0].unit) || '';
    const cw = !!(r.item && r.item.is_catch_weight);
    const sl = (s) => (s || '').replace('Pho Ha Noi — ', '');
    const showOne = (L) => {
      const shipped = L.kind === 'order' ? L.shipped_qty : L.quantity;
      const dflt = wt || L.remaining;
      panel.innerHTML = `<div class="scan-found">📦 <strong>${esc(name)}</strong> — incoming ${L.kind === 'order' ? 'order' : 'transfer'} from <strong>${esc(sl(L.source_name || ''))}</strong>${gs1}
        <div class="muted" style="font-size:.85rem;margin:.3rem 0">${L.kind === 'order' ? `Ordered ${numf(L.requested_qty)} ${esc(unit)} · ` : ''}Shipped <strong>${numf(shipped)} ${esc(unit)}</strong> · received ${numf(L.received_qty)} · <strong>remaining ${numf(L.remaining)}</strong> — closes on an exact match</div>
        <div class="scan-act"><input id="riQty" type="number" value="${dflt}" min="0" step="any" placeholder="${cw ? 'weight received' : 'qty received'}"><button class="btn" id="riGo">📦 Receive</button></div>
        <div class="scan-act">${inboundLines.length > 1 ? '<button class="btn ghost" id="riBack">← Other lines</button>' : ''}<button class="btn ghost" id="riNew">Not on an order — add as new</button></div></div>`;
      $('riGo').onclick = async () => {
        const btn = $('riGo'); btn.disabled = true;
        const body = { code };
        body[L.kind === 'order' ? 'order_id' : 'transfer_id'] = L.id;
        if (cw) body.weight = $('riQty').value; else body.quantity = $('riQty').value;
        try {
          const rr = await api('/invscan/receive-inbound', { method: 'POST', body: JSON.stringify(body) });
          const o = rr.order || rr.transfer;
          toast(o.closed ? `✅ ${L.kind === 'order' ? 'Order' : 'Transfer'} received & closed` : (o.over ? `Received ${numf(rr.received)} — over; left open` : `Received ${numf(rr.received)} — ${numf(o.remaining)} still due`));
          next();
        } catch (e) { toast(e.message, true); btn.disabled = false; }
      };
      if ($('riBack')) $('riBack').onclick = showChooser;
      $('riNew').onclick = () => svHandleScan(code, panel, next, true);
    };
    const showChooser = () => {
      panel.innerHTML = `<div class="scan-found">📦 <strong>${esc(name)}</strong> — ${inboundLines.length} incoming lines:
        <div class="ship-orders" style="margin:.5rem 0">${inboundLines.map((L, i) => `<button class="ship-ord" data-ri="${i}" style="width:100%;text-align:left;cursor:pointer"><span>${L.kind === 'order' ? '📦 Order' : '🔁 Transfer'} from ${esc(sl(L.source_name || ''))}</span><span class="mono">${numf(L.remaining)} ${esc(unit)} left</span></button>`).join('')}</div>
        <button class="btn ghost" id="riNew">Not on these — add as new</button></div>`;
      panel.querySelectorAll('[data-ri]').forEach(b => b.onclick = () => showOne(inboundLines[+b.dataset.ri]));
      $('riNew').onclick = () => svHandleScan(code, panel, next, true);
    };
    return inboundLines.length === 1 ? showOne(inboundLines[0]) : showChooser();
  }
  if (r.in_stock) {
    const it = r.item;
    const cw = !!it.is_catch_weight;
    panel.innerHTML = `<div class="scan-found">✅ <strong>${esc(it.item_name)}</strong> <span class="muted">· on hand ${numf(it.quantity)} ${esc(it.unit)}${cw ? ' ⚖' : ''}${it.vendor_name ? ' · ' + esc(it.vendor_name) : ''}</span>${scanLangs(r.glossary)}${scanSection(it)}${gs1}${boxDiffNote(r)}
      <div class="scan-act"><input id="scQty" type="number" value="${cw ? (wt || '') : (wt || 1)}" min="0" step="any" placeholder="${cw ? 'net weight' : 'qty'}"><select id="scMode"><option value="in">${cw ? '➕ Add weight' : '➕ Add stock'}</option><option value="count">🔢 Set count</option></select><span class="scan-total" id="scTotal"></span></div>
      <div class="scan-act"><input id="scExp" type="date" title="Expiry / use-by (optional)" value="${esc(labelExpiry)}"><input id="scLot" placeholder="Lot / batch (optional)" value="${esc(labelLot)}"></div>
      <div class="scan-act"><button class="btn" id="scGo">Apply</button><button class="btn ghost" id="scNext">Skip</button></div></div>`;
    const updTotal = () => { const q = parseFloat($('scQty').value) || 0; const m = $('scMode').value; $('scTotal').textContent = m === 'count' ? `= ${numf(q)} ${it.unit}` : `→ ${numf((+it.quantity || 0) + q)} ${it.unit}`; };
    $('scQty').oninput = updTotal; $('scMode').onchange = updTotal; updTotal();
    $('scGo').onclick = async () => {
      const btn = $('scGo'); if (btn.disabled) return; btn.disabled = true;
      const qv = $('scQty').value, m = $('scMode').value;
      try {
        if (m === 'count') {
          const rr = await api('/invscan/scan', { method: 'POST', body: JSON.stringify({ code: key, quantity: qv, mode: 'count', expiry_date: $('scExp').value || undefined, lot_code: $('scLot').value.trim() || undefined }) });
          toast(`${it.item_name} count → ${numf(rr.item.quantity)} ${it.unit}`);
        } else {
          const body = { code: code, expiry_date: $('scExp').value || undefined, lot_code: $('scLot').value.trim() || undefined };
          if (cw) body.weight = qv; else body.quantity = qv;
          let rr = await api('/invscan/receive', { method: 'POST', body: JSON.stringify(body) });
          if (rr.duplicate) { if (!confirm(rr.message)) { btn.disabled = false; return; } rr = await api('/invscan/receive', { method: 'POST', body: JSON.stringify(Object.assign({}, body, { confirm: true })) }); }
          toast(`${it.item_name} → ${numf(rr.item.quantity)} ${it.unit}`);
        }
        next();
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    };
    $('scNext').onclick = next;
  } else {
    // Show the add panel immediately; look the name up online in the BACKGROUND (non-blocking).
    let g = r.glossary || null;
    let lookupPending = !g && !!code && !(p.isGs1 && p.weightLb) && !r.scale_code;
    const renderNote = () => {
      const el = $('niNote'); if (!el) return;
      el.innerHTML = (g && g.name) ? ` — in Glossary as <strong>${esc(g.name)}</strong>${g.size ? ` · <span class="muted">${esc(g.size)}</span>` : ''}`
        : (g && g._weighed) ? ` — <strong>weighed in-store item</strong>; name it below`
        : lookupPending ? ` <span class="muted">· 🔎 looking up name…</span>` : '';
    };
    panel.innerHTML = `<div class="scan-unknown">🆕 New to stock <span class="muted mono">${esc(key)}</span><span id="niNote"></span>${gs1}
      <div class="scan-tabs"><button class="btn sm" data-new>Add to stock + glossary</button><button class="btn sm ghost" data-link>Link to existing</button><button class="btn sm ghost" data-skip>Skip</button></div>
      <div id="scSub"></div></div>`;
    renderNote();
    panel.querySelector('[data-skip]').onclick = next;
    panel.querySelector('[data-new]').onclick = () => {
      const cwDefault = g && g.is_catch_weight ? '1' : '0';
      $('scSub').innerHTML = `<div class="scan-form">
        <input id="niName" placeholder="Item name / description" value="${esc(g && g.name ? g.name : '')}">
        ${comboHTML('niCat', CATEGORY_OPTIONS, (g && g.category) || 'Produce', 'Category')}
        ${comboHTML('niUnit', UOM_OPTIONS, (g && g.unit) || (wt ? 'lb' : 'each'), 'Unit of measure')}
        <input id="niDesc" placeholder="Description (optional)" value="${esc(g && g.description ? g.description : '')}">
        <div class="scan-row"><label class="scan-lbl" style="flex:1">Catch-weight? <select id="niCW"><option value="0" ${cwDefault === '0' ? 'selected' : ''}>No — count</option><option value="1" ${cwDefault === '1' ? 'selected' : ''}>Yes — by weight</option></select></label></div>
        <div class="scan-row"><input id="niSku" placeholder="SKU (optional)"><input id="niCost" type="number" placeholder="Unit cost $" step="0.01" value="${g && g.default_unit_cost ? g.default_unit_cost : ''}"></div>
        <div class="scan-row"><input id="niQty" type="number" placeholder="Opening qty / weight" value="${wt || 0}" step="any"><input id="niMin" type="number" placeholder="Reorder at" step="any"><input id="niPar" type="number" placeholder="Par" step="any"></div>
        <div class="scan-row"><input id="niExp" type="date" title="Expiry" value="${esc(labelExpiry)}"><input id="niLot" placeholder="Lot / batch" value="${esc(labelLot)}"></div>
        <div class="scan-row"><input id="niShelf" list="niShelfList" placeholder="Shelf / Section (optional)"></div><datalist id="niShelfList"></datalist>
        <div class="scan-row"><input id="niVendor" list="niVendorList" placeholder="Supplier / vendor"><input id="niVCode" placeholder="Supplier item code"></div><datalist id="niVendorList"></datalist>
        <label class="scan-lbl" style="display:flex;align-items:center;gap:.4rem;margin:.3rem 0"><input type="checkbox" id="niGloss" checked> Also save to the Glossary (all locations)</label>
        <button class="btn" id="niSave">✓ Confirm &amp; add to stock</button></div>`;
      comboWire($('scSub'));
      api('/invscan/vendors/list').then(vs => { const dl = $('niVendorList'); if (dl) dl.innerHTML = (vs || []).map(v => `<option value="${esc(v.name)}">`).join(''); }).catch(() => {});
      api('/invscan/sections').then(ss => { const dl = $('niShelfList'); if (dl) dl.innerHTML = (ss || []).map(s => `<option value="${esc(s.name)}">`).join(''); }).catch(() => {});
      $('niSave').onclick = async () => {
        const name = ($('niName').value || '').trim(); if (!name) return toast('Enter an item name', true);
        const cw = $('niCW').value === '1';
        const body = { barcode: code, item_name: name, category: comboVal('niCat') || 'Other', unit: comboVal('niUnit') || (cw ? 'lb' : 'each'),
          description: $('niDesc').value.trim() || undefined, is_catch_weight: cw ? 1 : 0, sku: $('niSku').value.trim() || undefined,
          unit_cost: $('niCost').value || 0, min_quantity: $('niMin').value || 0, par_level: $('niPar').value || undefined,
          expiry_date: $('niExp').value || undefined, lot_code: $('niLot').value.trim() || undefined,
          section_name: $('niShelf').value.trim() || undefined,
          vendor_name: $('niVendor').value.trim() || undefined, vendor_code: $('niVCode').value.trim() || undefined,
          scale_code: r.scale_code || undefined, save_to_glossary: $('niGloss').checked };
        if (cw) body.weight = $('niQty').value; else body.quantity = $('niQty').value;
        try { await api('/invscan/receive-create', { method: 'POST', body: JSON.stringify(body) }); toast(`Added ${name}${$('niGloss').checked ? ' · glossary updated' : ''}`); next(); } catch (e) { toast(e.message, true); }
      };
    };
    if (lookupPending) {
      api('/invscan/lookup/' + encodeURIComponent(code)).then(look => {
        if (look && look.found) {
          g = { name: look.name, category: look.category, unit: look.unit, description: look.description, default_unit_cost: look.default_unit_cost || look.price, is_catch_weight: look.is_catch_weight, size: look.size };
          const nn = $('niName'); if (nn && !nn.value.trim()) nn.value = look.name;
          const nd = $('niDesc'); if (nd && !nd.value.trim() && look.description) nd.value = look.description;
          const nc = $('niCost'); if (nc && !nc.value && (look.default_unit_cost || look.price)) nc.value = look.default_unit_cost || look.price;
        } else if (look && look.weighed) { g = { _weighed: true, default_unit_cost: look.price }; }
        lookupPending = false; renderNote();
      }).catch(() => { lookupPending = false; renderNote(); });
    }
    panel.querySelector('[data-link]').onclick = async () => {
      $('scSub').innerHTML = '<div class="scan-msg">Loading items…</div>';
      let items = []; try { items = await api('/invscan/items/list'); } catch { /* ignore */ }
      $('scSub').innerHTML = `<div class="scan-form"><select id="niItem">${items.map(i => `<option value="${i.id}">${esc(i.item_name)}</option>`).join('')}</select><button class="btn" id="niLink">Link barcode</button></div>`;
      $('niLink').onclick = async () => { try { await api('/invscan/link', { method: 'POST', body: JSON.stringify({ code: key, item_id: $('niItem').value }) }); toast('Barcode linked'); next(); } catch (e) { toast(e.message, true); } };
    };
  }
}

// Scan-to-check: how much of the scanned product each location holds (read-only, all sites).
async function svHandleCheck(code, panel, next) {
  panel.innerHTML = '<div class="scan-msg">Looking up…</div>';
  let r; try { r = await api('/invscan/check/' + encodeURIComponent(code)); } catch (e) { panel.innerHTML = `<div class="scan-err">${esc(e.message)}</div>`; return; }
  if (!r.found) { panel.innerHTML = `<div class="scan-unknown">🔍 <span class="mono">${esc(r.code)}</span> — not stocked anywhere yet. <button class="btn sm ghost" id="ckNext">OK</button></div>`; $('ckNext').onclick = next; return; }
  panel.innerHTML = `<div class="scan-found">📋 <strong>${esc(r.item_name)}</strong> <span class="muted">· ${numf(r.total)} ${esc(r.unit)} across all locations</span>
    <div class="scan-stock">${r.by_location.map(l => `<div class="scan-stock-row${l.location_id === r.mine ? ' mine' : ''}"><span>${esc(l.location)}${l.type === 'central_kitchen' ? ' (CK)' : ''}${l.location_id === r.mine ? ' · you' : ''}${l.section ? ` <span class="stock-shelf">📍 ${esc(l.section)}</span>` : ''}</span><span class="mono${l.quantity < l.min_quantity ? ' low' : ''}">${numf(l.quantity)} ${esc(l.unit)}</span></div>`).join('')}</div>
    <button class="btn ghost" id="ckNext">Scan another</button></div>`;
  $('ckNext').onclick = next;
}

// Scan-to-transfer: move from THIS store to a chosen destination (the server still fills an open
// order at the destination if one matches). `verb` labels the action ('Transfer', or 'Ship').
async function svHandleShip(code, panel, next, to, toName, refreshOrders, verb) {
  verb = verb || 'Transfer';
  const vIcon = verb === 'Ship' ? '📤' : '🔁';
  const vPast = verb === 'Ship' ? 'Shipped' : 'Transferred';
  if (!to) { panel.innerHTML = `<div class="scan-unknown">Pick a destination above, then scan an item to ${verb.toLowerCase()}.</div>`; setTimeout(next, 1400); return; }
  panel.innerHTML = '<div class="scan-msg">Looking up…</div>';
  let r; try { r = await api('/invscan/resolve/' + encodeURIComponent(code)); } catch (e) { panel.innerHTML = `<div class="scan-err">${esc(e.message)}</div>`; return; }
  const key = r.code || code;
  if (!r.in_stock) { panel.innerHTML = `<div class="scan-unknown">🚫 <span class="mono">${esc(key)}</span> isn't stocked at your store, so there's nothing to ${verb.toLowerCase()}. <button class="btn sm ghost" id="shSkip">Skip</button></div>`; $('shSkip').onclick = next; return; }
  const it = r.item; const cw = !!it.is_catch_weight;
  const dest = (toName || '').replace(/\s*\((CK|WH)\)\s*$/, '').trim();
  let dflt = (r.parsed && r.parsed.weightLb) || 1;
  if (verb === 'Ship') { try { const ords = await api('/invscan/ship/orders?to_location_id=' + to); const m = ords.find(o => o.item_name === it.item_name && o.remaining > 0); if (m) dflt = m.remaining; } catch { /* ignore */ } }
  panel.innerHTML = `<div class="scan-found">${vIcon} <strong>${esc(it.item_name)}</strong> <span class="muted">· ${numf(it.quantity)} ${esc(it.unit)} on hand${cw ? ' ⚖' : ''}</span>${scanLangs(r.glossary)}${scanSection(it)}
    <div class="scan-act"><input id="shQty" type="number" value="${dflt}" min="0" step="any"><span class="muted">→ ${esc(dest)}</span></div>
    <div class="scan-act"><button class="btn" id="shGo">${vIcon} ${verb}</button><button class="btn ghost" id="shNext">Skip</button></div></div>`;
  $('shNext').onclick = next;
  $('shGo').onclick = async () => {
    const btn = $('shGo'); if (btn.disabled) return; btn.disabled = true;
    const qv = $('shQty').value;
    const body = { to_location_id: to, code: key, quantity: qv };
    try {
      let rr = await api('/invscan/ship', { method: 'POST', body: JSON.stringify(body) });
      if (rr.duplicate) { if (!confirm(rr.message)) { btn.disabled = false; return; } rr = await api('/invscan/ship', { method: 'POST', body: JSON.stringify(Object.assign({}, body, { confirm: true })) }); }
      toast(`${vPast} ${numf(qv)} ${it.unit} → ${dest}${rr.order ? (rr.order.shipped ? ' · order complete ✅' : ` · order ${numf(rr.order.ck_qty)}/${numf(rr.order.requested_qty)}`) : ''}`);
      if (refreshOrders) refreshOrders(); next();
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  };
}

// Scan-to-use: consume stock at THIS store (kitchen prep / to serve).
async function svHandleUse(code, panel, next) {
  panel.innerHTML = '<div class="scan-msg">Looking up…</div>';
  let r; try { r = await api('/invscan/resolve/' + encodeURIComponent(code)); } catch (e) { panel.innerHTML = `<div class="scan-err">${esc(e.message)}</div>`; return; }
  const key = r.code || code;
  if (!r.in_stock) { panel.innerHTML = `<div class="scan-unknown">🚫 <span class="mono">${esc(key)}</span> isn't stocked at your store. <button class="btn sm ghost" id="uSkip">Skip</button></div>`; $('uSkip').onclick = next; return; }
  const it = r.item; const cw = !!it.is_catch_weight;
  const wt = (r.parsed && r.parsed.weightLb) || '';
  panel.innerHTML = `<div class="scan-found">🍳 <strong>${esc(it.item_name)}</strong> <span class="muted">· ${numf(it.quantity)} ${esc(it.unit)} on hand${cw ? ' ⚖' : ''}</span>${scanLangs(r.glossary)}${scanSection(it)}
    <div class="scan-act"><input id="uQty" type="number" value="${cw ? (wt || '') : (wt || 1)}" min="0" step="any" placeholder="${cw ? 'weight used' : 'qty used'}"><input id="uReason" placeholder="Reason (e.g. prep, serve)"></div>
    <div class="scan-act"><button class="btn" id="uGo">🍳 Record use</button><button class="btn ghost" id="uNext">Skip</button></div></div>`;
  $('uNext').onclick = next;
  $('uGo').onclick = async () => {
    const btn = $('uGo'); if (btn.disabled) return; btn.disabled = true;
    const qv = $('uQty').value;
    const body = { code: key, reason: $('uReason').value.trim() || undefined };
    if (cw) body.weight = qv; else body.quantity = qv;
    try { const rr = await api('/invscan/use', { method: 'POST', body: JSON.stringify(body) }); toast(`Used ${numf(qv)} ${it.unit} · ${it.item_name} → ${numf(rr.item.quantity)} left`); next(); } catch (e) { toast(e.message, true); btn.disabled = false; }
  };
}
