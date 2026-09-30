// Customer self-check-in kiosk — no login. Pick a location (or land on one via a
// per-store QR at /checkin?loc=<id>), see the current wait, add your party, then
// track your spot live by reference code.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const KV = () => $('kview');

async function api(path, opts = {}) {
  const res = await fetch('/api/public' + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

const K = { locations: [], loc: null, size: 2, fixed: false, pollTimer: null };

// Route: /checkin/<slug> is the join form; /checkin/<slug>/current is the public
// live waitlist (who's waiting, in order) linked from the confirmation text.
const ROUTE = (() => {
  const raw = decodeURIComponent(location.pathname.replace(/^\/checkin\/?/, '')).toLowerCase().replace(/\/+$/, '');
  const current = raw === 'current' || raw.endsWith('/current');
  const slug = current ? raw.replace(/\/?current$/, '').replace(/\/+$/, '') : raw;
  return { current, slug };
})();

function stopPolling() { if (K.pollTimer) { clearInterval(K.pollTimer); K.pollTimer = null; } }
// Kiosk: after a guest joins, show their confirmation briefly, then reset the
// form (keeping this device's location) so it's ready for the next guest.
function resetKiosk() {
  if (K.resetTimer) { clearTimeout(K.resetTimer); K.resetTimer = null; }
  stopPolling();
  sessionStorage.removeItem('phnw_ref');
  K.size = 2;
  renderForm();
}

const SAVED_LOC = 'phnw_kiosk_loc';
async function start() {
  try { K.locations = await api('/locations'); }
  catch (e) { KV().innerHTML = `<div class="k-error">${esc(e.message)}</div>`; return; }
  const params = new URLSearchParams(location.search);
  const byId = (v) => K.locations.find(l => String(l.id) === String(v));
  // Match slugs case/hyphen-insensitively so /checkin/fountainvalley and
  // /checkin/fountain-valley both resolve (same as the /sflow, /clock, /scanner kiosks).
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // Pin the store: a /checkin/<slug> path is an EXPLICIT choice — only use the store it names
  // (never silently fall back to this device's saved store, which showed the wrong location).
  // With no slug in the path, fall back to ?loc=<id>, then this device's saved location.
  const chosen = ROUTE.slug
    ? (K.locations.find(l => norm(l.slug) === norm(ROUTE.slug)) || null)
    : (byId(params.get('loc')) || byId(localStorage.getItem(SAVED_LOC)) || (K.locations.length === 1 ? K.locations[0] : null));
  if (chosen) {
    K.loc = String(chosen.id); K.fixed = true;
    try { localStorage.setItem(SAVED_LOC, K.loc); } catch { /* private mode */ }
  }
  renderForm();
}

async function renderForm() {
  stopPolling();
  const locName = (K.locations.find(l => String(l.id) === String(K.loc)) || {}).name || '';
  KV().innerHTML = `
    <div class="k-card">
      ${K.fixed
        ? `<div class="k-loc-fixed">${esc((locName || '').replace('Pho Ha Noi — ', '')) || 'Select a location'}</div>`
        : `<label class="k-label">Location</label>
           <select id="kLoc" class="k-input">
             <option value="">Choose your location…</option>
             ${K.locations.map(l => `<option value="${l.id}" ${String(l.id) === String(K.loc) ? 'selected' : ''}>${esc(l.name.replace('Pho Ha Noi — ', ''))}</option>`).join('')}
           </select>`}
      <div id="kWait" class="k-wait"></div>
      <label class="k-label">Your name</label>
      <input id="kName" class="k-input" placeholder="e.g. Kim" autocomplete="name" />
      <label class="k-label">Party size</label>
      <div class="k-stepper"><button type="button" id="kMinus">−</button><span id="kSize">${K.size}</span><button type="button" id="kPlus">+</button></div>
      <label class="k-label">Mobile number</label>
      <input id="kPhone" class="k-input" inputmode="tel" placeholder="(408) 555-0100" autocomplete="tel" />
      <div class="k-err" id="kErr"></div>
      <button class="k-btn" id="kJoin">Join the waitlist</button>
    </div>`;
  const setSize = () => { $('kSize').textContent = K.size; };
  $('kPlus').onclick = () => { K.size = Math.min(50, K.size + 1); setSize(); };
  $('kMinus').onclick = () => { K.size = Math.max(1, K.size - 1); setSize(); };
  if ($('kLoc')) $('kLoc').onchange = () => {
    K.loc = $('kLoc').value || null;
    if (K.loc) { try { localStorage.setItem(SAVED_LOC, K.loc); } catch { /* private mode */ } } // remember this store on the device
    refreshWait();
  };
  $('kJoin').onclick = join;
  refreshWait();
}

async function refreshWait() {
  const el = $('kWait'); if (!el) return;
  if (!K.loc) { el.innerHTML = ''; return; }
  try {
    const s = await api('/status?location_id=' + K.loc);
    el.innerHTML = s.parties_ahead
      ? `<span class="k-dot"></span> ${s.parties_ahead} ${s.parties_ahead === 1 ? 'party' : 'parties'} ahead · about <strong>${s.quoted_minutes} min</strong>`
      : `<span class="k-dot ok"></span> No wait right now — come on in!`;
  } catch { el.innerHTML = ''; }
}

async function join() {
  const err = $('kErr'); err.textContent = '';
  const loc = K.loc || ($('kLoc') && $('kLoc').value);
  if (!loc) { err.textContent = 'Please choose your location.'; return; }
  const name = $('kName').value.trim();
  if (!name) { err.textContent = 'Please enter your name.'; return; }
  const phone = $('kPhone').value.trim();
  if ((phone.match(/\d/g) || []).length < 10) { err.textContent = 'Please enter your mobile number so we can text you when your table is ready.'; return; }
  $('kJoin').disabled = true;
  try {
    const r = await api('/checkin', { method: 'POST', body: JSON.stringify({
      location_id: loc, guest_name: name, party_size: K.size, phone,
      sms_consent: true, notes: null }) });
    sessionStorage.setItem('phnw_ref', r.ref);
    renderConfirm(r.ref, r);
    // Hand the kiosk back to the next guest after a short confirmation.
    K.resetTimer = setTimeout(resetKiosk, 7000);
  } catch (e) { err.textContent = e.message; $('kJoin').disabled = false; }
}

function renderConfirm(ref, initial) {
  stopPolling();
  KV().innerHTML = `<div class="k-card" id="kConfirm"></div>`;
  const paint = (p) => {
    const seated = p.status === 'seated';
    const left = p.status === 'left';
    let body;
    if (seated) {
      body = `<div class="k-big ok">🎉 You're seated${p.table_number ? ' — table ' + esc(p.table_number) : ''}!</div><p class="k-note">Enjoy your meal.</p>`;
    } else if (left) {
      body = `<div class="k-big">This check-in is closed.</div><button class="k-btn" id="kAgain">Join again</button>`;
    } else if (p.notified) {
      body = `<div class="k-big ok">🔔 Your table is ready!</div><p class="k-note">Please see the host to be seated.</p>`;
    } else if (p.position != null && p.position <= 1 && !p.quoted_minutes) {
      // No one ahead + no wait → a walk-in: come right in.
      body = `<div class="k-big ok">🚶 Come on in — no wait!</div>
        <p class="k-note">Party of ${p.party_size} · a host will seat you shortly.</p>`;
    } else {
      body = `<div class="k-you">You're on the list</div>
        <div class="k-pos"><span class="k-pos-num">#${p.position != null ? p.position : '—'}</span><span class="k-pos-lbl">in line</span></div>
        <p class="k-note">Party of ${p.party_size} · about <strong>${p.quoted_minutes} min</strong>. Keep this screen open — we'll update it and text you when your table is ready.</p>`;
    }
    $('kConfirm').innerHTML = `
      <div class="k-hi">Hi, ${esc(p.guest_name || (initial && initial.guest_name) || '')}!</div>
      ${body}
      <div class="k-ref">Reference: <strong>${esc(ref)}</strong></div>`;
    const again = $('kAgain'); if (again) again.onclick = () => { sessionStorage.removeItem('phnw_ref'); K.size = 2; renderForm(); };
  };
  paint({ status: 'waiting', position: initial.position, quoted_minutes: initial.quoted_minutes, party_size: initial.party_size, guest_name: initial.guest_name, notified: false });
  const poll = async () => { try { paint(await api('/position/' + ref)); } catch { /* keep last */ } };
  poll();
  K.pollTimer = setInterval(poll, 12000);
}

// Public live waitlist view (/checkin/<slug>/current) — read-only, auto-refreshing.
async function renderCurrent() {
  let d; try { d = await api('/waitlist/' + encodeURIComponent(ROUTE.slug)); }
  catch (e) { KV().innerHTML = `<div class="k-card"><div class="k-big">Waitlist unavailable</div><p class="k-note">${esc(e.message)}</p></div>`; return; }
  const locName = (d.location.name || '').replace('Pho Ha Noi — ', '');
  const rows = d.parties.map(p => `<div class="k-wl-row">
      <span class="k-wl-pos">#${p.position}</span>
      <span class="k-wl-name">${esc(p.name)}</span>
      <span class="k-wl-meta">party of ${p.party_size}${p.waiting_min > 0 ? ` · ${p.waiting_min} min` : ''}</span>
    </div>`).join('');
  KV().innerHTML = `<div class="k-card">
    <div class="k-loc-fixed">${esc(locName)}</div>
    <div class="k-you">Current waitlist</div>
    <p class="k-note" style="margin-top:.15rem">${d.count
      ? `${d.count} ${d.count === 1 ? 'party' : 'parties'} waiting · about <strong>${d.quoted_minutes} min</strong> for the next table`
      : 'No one is waiting right now.'}</p>
    <div class="k-wl">${rows || '<p class="k-note">The list is empty right now.</p>'}</div>
    <p class="k-note" style="margin-top:.9rem;font-size:.78rem;color:#888">Find your name to see your spot. This list updates automatically.</p>
  </div>`;
}
async function startCurrent() {
  KV().innerHTML = '<div class="k-loading">Loading…</div>';
  await renderCurrent();
  stopPolling();
  K.pollTimer = setInterval(renderCurrent, 15000);
}

// Boot: the public live-list route, a restored check-in, or the join form.
const savedRef = sessionStorage.getItem('phnw_ref');
if (ROUTE.current) {
  startCurrent();
} else if (savedRef) {
  api('/position/' + savedRef).then(p => {
    if (p.status === 'waiting') renderConfirm(savedRef, { position: p.position, quoted_minutes: p.quoted_minutes, party_size: p.party_size, guest_name: p.guest_name });
    else { sessionStorage.removeItem('phnw_ref'); start(); }
  }).catch(() => { sessionStorage.removeItem('phnw_ref'); start(); });
} else {
  start();
}
