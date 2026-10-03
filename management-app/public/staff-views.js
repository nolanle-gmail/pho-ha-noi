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
