// Pho Ha Noi Management System — SPA
const S = { token: null, user: null, locations: [], loc: null, section: 'overview', tab: 'dashboard', menuTab: 'menu', staffTab: 'directory', reportTab: 'inventory', msgTab: 'inbox', unread: 0, locView: 'list', locDetailId: null, locTab: 'details', ckTab: 'overview' };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numf = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });

// ── API ────────────────────────────────────────────────────────────────────
async function api(pathOrPath, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  const res = await fetch('/api' + pathOrPath, Object.assign({}, opts, { headers }));
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
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

// ── Auth ────────────────────────────────────────────────────────────────
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  try {
    const d = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
    S.token = d.token; S.user = d.user;
    localStorage.setItem('phn_token', d.token);
    localStorage.setItem('phn_user', JSON.stringify(d.user));
    await boot();
  } catch (err) { $('loginErr').textContent = err.message; }
};
$('logout').onclick = () => { localStorage.clear(); location.reload(); };

async function boot() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('who').textContent = `${S.user.name} · ${S.user.role}`;
  $('sbUser').innerHTML = `<div class="user-name">${esc(S.user.name)}</div><div class="user-role">${esc(S.user.role)}</div>`;
  S.locations = await api('/inventory/locations');
  const picker = $('locPicker');
  const seesAll = S.user.role === 'owner' || S.user.role === 'admin';
  if (seesAll) {
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
}

// ── Left-menu sections ─────────────────────────────────────────────────────
const ROLE_ALL = ['owner', 'admin', 'manager', 'support', 'employee'];
const SECTIONS = [
  ['overview', '📊', 'Overview', ROLE_ALL],
  ['locations', '📍', 'Locations', ['owner', 'admin', 'manager']],
  ['staff', '👥', 'Staff', ['owner', 'admin', 'manager']],
  ['inventory', '📦', 'Inventory', ROLE_ALL],
  ['central', '🏭', 'Central Kitchen', ['owner', 'admin']],
  ['menu', '🍽️', 'Menu/Recipes', ['owner', 'admin', 'manager']],
  ['reports', '📈', 'Reports', ['owner', 'admin', 'manager']],
  ['messages', '💬', 'Messages', ROLE_ALL],
];
const allowedSections = () => SECTIONS.filter(s => s[3].includes(S.user.role));

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
function setActiveNav(section) {
  $('sidebarNav').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.section === section));
}

function showSection(section) {
  S.section = section;
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
  $('locPicker').classList.toggle('hidden', !(isInv && (S.user.role === 'owner' || S.user.role === 'admin')));
  $('view').innerHTML = '<div class="empty">Loading…</div>';
  if (isInv) { renderTabs(); render(); return; }
  if (isMenu) { renderMenuTabs(); renderMenu(); return; }
  if (isStaff) { renderStaffTabs(); renderStaffModule(); return; }
  if (isReports) { renderReportTabs(); renderReportModule(); return; }
  if (isMessages) { renderMsgTabs(); renderMessages(); return; }
  if (isCentral) { renderCkTabs(); renderCentral(); return; }
  if (section === 'locations') { S.locView = 'list'; S.locDetailId = null; renderLocationsSection(); return; }
  const fn = { overview: renderOverview }[section];
  (fn || (() => renderPlaceholder(meta ? meta[2] : 'Section', '📄', '')))();
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

  $('addItem').onclick = () => modal('Add item', [
    { key: 'item_name', label: 'Item name' }, { key: 'category', label: 'Category', value: 'Produce' },
    { key: 'unit', label: 'Unit', value: 'lbs' }, { key: 'quantity', label: 'Opening qty', type: 'number', value: 0 },
    { key: 'min_quantity', label: 'Min (reorder trigger)', type: 'number', value: 0 },
    { key: 'par_level', label: 'Par (target level)', type: 'number' },
    { key: 'unit_cost', label: 'Unit cost ($)', type: 'number', step: '0.01', value: 0 },
    { key: 'sku', label: 'SKU (optional)' },
  ], async (v) => { await api('/inventory/', { method: 'POST', body: JSON.stringify(Object.assign({ location_id: S.loc }, v)) }); toast('Item added'); render(); });

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
    ], async (v) => { await api('/inventory/' + id, { method: 'PUT', body: JSON.stringify(v) }); toast('Item updated'); render(); });
  }
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
  modal(isNew ? 'Add item' : `Edit — ${it.item_name}`, fields, async (v) => {
    if (isNew) { await api('/inventory/', { method: 'POST', body: JSON.stringify(Object.assign({ location_id: S.loc }, v)) }); toast('Item added'); }
    else { await api('/inventory/' + it.id, { method: 'PUT', body: JSON.stringify(v) }); toast('Item updated'); }
    render();
  }, isNew ? 'Add item' : 'Save');
}

function confirmDelete(it) {
  modal(`Remove “${it.item_name}”?`, [
    { key: '_', label: 'This hides the item from stock & glossary. History is preserved. Type REMOVE to confirm.', placeholder: 'REMOVE' },
  ], async (v) => {
    if ((v._ || '').trim().toUpperCase() !== 'REMOVE') throw new Error('Type REMOVE to confirm.');
    await api('/inventory/' + it.id, { method: 'DELETE' }); toast('Item removed'); render();
  }, 'Remove');
}

// ── Create order (PO) — pick existing item or add a new one ────────────────
async function openOrderModal(prefill) {
  prefill = prefill || {};
  const [items, vendors] = await Promise.all([api(invQ('/')), api('/inventory/vendors')]);
  const iOpts = items.map(i => `<option value="${i.id}" ${prefill.item_id == i.id ? 'selected' : ''}>${esc(i.item_name)} — ${numf(i.quantity)} ${esc(i.unit)} on hand</option>`).join('');
  const vOpts = '<option value="">— No vendor —</option>' + vendors.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  const host = $('modalHost');
  host.innerHTML = `<div class="modal-bg"><div class="modal">
    <h3>Create order (PO)</h3><div class="err" id="mErr"></div>
    <div class="seg"><button type="button" class="seg-btn active" data-mode="existing">Existing item</button><button type="button" class="seg-btn" data-mode="new">+ New item</button></div>
    <div id="existBlock"><label>Item</label><select id="oItem">${iOpts}</select></div>
    <div id="newBlock" class="hidden">
      <label>New item name</label><input id="nName" placeholder="e.g. Chili Oil" />
      <div style="display:flex;gap:.6rem"><div style="flex:1"><label>Category</label><input id="nCat" value="Pantry" /></div><div style="flex:1"><label>Unit</label><input id="nUnit" value="bottle" /></div></div>
      <label>Unit cost ($)</label><input id="nCost" type="number" step="0.01" value="0" />
    </div>
    <label>Quantity to order</label><input id="oQty" type="number" value="${prefill.suggested_qty || ''}" />
    <label>Vendor (optional)</label><select id="oVendor">${vOpts}</select>
    <label>Expected date (optional)</label><input id="oDate" type="date" />
    <label>Notes</label><input id="oNotes" placeholder="optional" />
    <div class="actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">Create order</button></div>
  </div></div>`;
  let mode = 'existing';
  const close = () => host.innerHTML = '';
  $('mCancel').onclick = close;
  host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
  host.querySelectorAll('.seg-btn').forEach(b => b.onclick = () => {
    mode = b.dataset.mode;
    host.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
    $('existBlock').classList.toggle('hidden', mode !== 'existing');
    $('newBlock').classList.toggle('hidden', mode !== 'new');
  });
  $('mOk').onclick = async () => {
    try {
      const qty = parseFloat($('oQty').value);
      if (!(qty > 0)) throw new Error('Enter a quantity greater than 0.');
      const vendor_id = $('oVendor').value || null, expected_date = $('oDate').value || null, notes = $('oNotes').value.trim() || null;
      let item_id;
      if (mode === 'new') {
        const name = $('nName').value.trim();
        if (!name) throw new Error('Enter the new item name.');
        const created = await api('/inventory/', { method: 'POST', body: JSON.stringify({ location_id: S.loc, item_name: name, category: $('nCat').value.trim() || 'Other', unit: $('nUnit').value.trim() || 'units', unit_cost: $('nCost').value, quantity: 0, min_quantity: 0 }) });
        item_id = created.id;
      } else { item_id = $('oItem').value; }
      await api('/inventory/order', { method: 'POST', body: JSON.stringify({ location_id: S.loc, item_id, quantity: qty, vendor_id, expected_date, notes }) });
      toast('Order created'); close();
      if (['orders', 'glossary', 'stock'].includes(S.tab)) render();
    } catch (e) { $('mErr').textContent = e.message; }
  };
}

// ── Orders & Reorder ─────────────────────────────────────────────────────
async function renderOrders() {
  const [sugg, orders, vendors] = await Promise.all([
    api(invQ('/reorder-suggestions')), api(invQ('/supply-orders')), api('/inventory/vendors'),
  ]);
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Orders & Reorder</h2>
      <button class="btn" id="newOrder">+ New order</button></div>
    <div class="section">
      <div class="row-between"><h3>Auto-reorder suggestions (below par)</h3>
        ${sugg.length ? `<button class="btn" id="createPO">Create PO for all (${sugg.length})</button>` : ''}</div>
      ${sugg.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Min</th><th class="num">Build to</th><th class="num">Suggested</th><th class="num">Est. cost</th></tr></thead><tbody>
        ${sugg.map(s => `<tr><td>${esc(s.item_name)}</td><td class="num">${numf(s.quantity)}</td><td class="num">${numf(s.min_quantity)}</td><td class="num">${numf(s.build_to)}</td><td class="num"><strong>${numf(s.suggested_qty)} ${esc(s.unit)}</strong></td><td class="num">${money(s.est_cost)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No items below par. Nothing to reorder.</div>'}
    </div>
    <div class="section">
      <h3>Purchase / supply orders</h3>
      ${orders.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Qty</th><th>Vendor</th><th>Status</th><th>Ordered by</th><th>Actions</th></tr></thead><tbody>
        ${orders.map(o => `<tr><td>${esc(o.item_name)}</td><td class="num">${numf(o.quantity)} ${esc(o.unit)}</td><td>${esc(o.vendor_name || '—')}</td><td>${orderBadge(o.status)}</td><td>${esc(o.ordered_by_name)}</td>
          <td><div class="actions-cell">${nextOrderActions(o)}</div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No orders yet.</div>'}
    </div>`;

  $('newOrder').onclick = () => openOrderModal();
  const createPO = $('createPO');
  if (createPO) createPO.onclick = () => {
    const vOpts = [{ value: '', label: '— No vendor —' }].concat(vendors.map(v => ({ value: v.id, label: v.name })));
    modal('Create purchase order', [{ key: 'vendor_id', label: 'Vendor', type: 'select', options: vOpts, value: '' }],
      async (v) => { const r = await api('/inventory/reorder/create', { method: 'POST', body: JSON.stringify({ location_id: S.loc, vendor_id: v.vendor_id || null, items: sugg.map(s => ({ item_id: s.id, quantity: s.suggested_qty })) }) }); toast(`Created ${r.created} order lines`); render(); }, 'Create PO');
  };
  $('view').querySelectorAll('[data-order]').forEach(b => b.onclick = async () => {
    try { await api('/inventory/order/' + b.dataset.order, { method: 'PUT', body: JSON.stringify({ status: b.dataset.status }) }); toast('Order ' + b.dataset.status); render(); }
    catch (e) { toast(e.message, true); }
  });
}
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
  order_create: ['Order created', 'gold'], order_status: ['Order updated', 'gold'], order_received: ['Order received', 'ok'],
  reorder_create: ['Reorder → PO', 'gold'], transfer: ['Transfer', 'gold'], transfer_status: ['Transfer updated', 'gold'],
  transfer_received: ['Transfer received', 'ok'], stock_received: ['Stock received', 'ok'], item_create: ['Item added', 'gray'],
  item_update: ['Item edited', 'gray'], item_delete: ['Item removed', 'out'], waste_logged: ['Waste', 'out'],
  cycle_count: ['Cycle count', 'gray'], lot_discarded: ['Lot discarded', 'out'], vendor_create: ['Vendor added', 'gray'],
};
function auditSummary(a) {
  const d = a.detail || {};
  const bits = [];
  if (d.item) bits.push(esc(d.item));
  if (d.quantity != null) bits.push('qty ' + numf(d.quantity));
  if (d.status) bits.push('→ ' + esc(d.status));
  if (d.count) bits.push(d.count + ' lines');
  if (d.reason) bits.push(esc(d.reason));
  return bits.join(' · ');
}

async function renderActivity() {
  const [txns, waste, counts, audit] = await Promise.all([api(invQ('/transactions')), api(invQ('/waste')), api(invQ('/counts')), api('/inventory/audit')]);
  const typeBadge = (t) => ({ in: '<span class="badge ok">IN</span>', out: '<span class="badge out">OUT</span>', transfer_sent: '<span class="badge gold">TRANSFER</span>' }[t] || t);
  const orderish = audit.filter(a => ['order_create', 'order_status', 'order_received', 'reorder_create', 'transfer', 'transfer_status', 'transfer_received', 'stock_received'].includes(a.action));
  $('view').innerHTML = `
    <h2 class="page">Activity</h2>
    <div class="section"><h3>Activity log — who did what <span style="font-weight:400;color:var(--muted);font-size:.85rem">(orders · transfers · reorders · receiving)</span></h3>
      <div class="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>Details</th><th>Who</th></tr></thead><tbody>
        ${orderish.length ? orderish.map(a => { const [lbl, tone] = ACTION_LABEL[a.action] || [a.action, 'gray']; return `<tr><td class="mono">${esc((a.created_at || '').slice(0, 16))}</td><td><span class="badge ${tone}">${lbl}</span></td><td>${auditSummary(a)}</td><td><strong>${esc(a.user_name || '—')}</strong>${a.user_role ? ` <span style="color:var(--muted)">· ${esc(a.user_role)}</span>` : ''}</td></tr>`; }).join('') : '<tr><td colspan="4" class="empty">No order/transfer/receive activity yet.</td></tr>'}
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
async function renderOverview() {
  let dash = null;
  try { dash = await api(invQ('/dashboard')); } catch { /* employee etc. */ }
  let staffCount = null;
  if (['owner', 'admin', 'manager'].includes(S.user.role)) {
    try { staffCount = (await api('/staff')).length; } catch { staffCount = null; }
  }
  const locName = (S.locations.find(l => String(l.id) === String(S.loc)) || {}).name || '';
  const quick = allowedSections().filter(s => s[0] !== 'overview');
  $('view').innerHTML = `
    <div class="overview-hero">
      <h2>Welcome, ${esc(S.user.name.split(' ')[0])}</h2>
      <p>Enterprise Restaurant Management System · <span class="role-chip">${esc(S.user.role)}</span></p>
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

const LOC_DETAIL_TABS = [['details', 'Details'], ['staff', 'Staff'], ['equipment', 'Equipment']];
function renderLocDetailTabs() {
  $('tabs').innerHTML = LOC_DETAIL_TABS.map(([k, l]) => `<button data-ltab="${k}" class="${S.locTab === k ? 'active' : ''}">${l}</button>`).join('');
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
  ({ details: () => renderLocInfo(loc), staff: renderLocStaff, equipment: renderLocEquipment }[S.locTab])();
}

function renderLocInfo(loc) {
  const canEdit = ['owner', 'admin'].includes(S.user.role);
  const canEditHours = ['owner', 'admin', 'manager'].includes(S.user.role);
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
    </div>`;
  if (canEdit) $('editLoc').onclick = () => locationModal(loc);
  if (canEditHours) $('editHours').onclick = () => editHoursModal(loc);
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
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Access level</th><th>Status</th></tr></thead><tbody>
      ${staff.length ? staff.map(u => `<tr><td><strong>${esc(u.name)}</strong></td><td class="mono">${esc(u.email)}</td><td><span class="badge ${ROLE_CHIP[u.role] || 'gray'}">${esc(u.role)}</span></td><td>${u.is_active ? '<span class="badge ok">Active</span>' : '<span class="badge out">Inactive</span>'}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No staff assigned to this location yet.</td></tr>'}
    </tbody></table></div>`;
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
const ROLE_CHIP = { owner: 'gold', admin: 'gold', manager: 'blue', support: 'ok', employee: 'gray' };
const ACCESS_LEVELS = ['owner', 'admin', 'manager', 'support', 'employee'];
const STAFF_TABS = [['directory', 'Directory'], ['access', 'Access Levels']];
function renderStaffTabs() {
  $('tabs').innerHTML = STAFF_TABS.map(([k, l]) => `<button data-stab="${k}" class="${S.staffTab === k ? 'active' : ''}">${l}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach(b => b.onclick = () => { S.staffTab = b.dataset.stab; renderStaffTabs(); renderStaffModule(); });
}
function renderStaffModule() {
  $('view').innerHTML = '<div class="empty">Loading…</div>';
  ({ directory: renderStaffDirectory, access: renderAccessLevels }[S.staffTab])();
}

let staffSearch = '';
async function renderStaffDirectory() {
  let rows, locations;
  try { [rows, locations] = await Promise.all([api('/staff'), api('/inventory/locations').catch(() => S.locations)]); }
  catch (e) { return renderPlaceholder('Staff', '👥', e.message); }
  const canManage = ['owner', 'admin'].includes(S.user.role);
  const q = staffSearch.toLowerCase();
  const shown = q ? rows.filter(u => (u.name + ' ' + u.email + ' ' + u.role).toLowerCase().includes(q)) : rows;
  $('view').innerHTML = `
    <div class="row-between"><h2 class="page">Staff Directory <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${rows.length} accounts</span></h2>
      ${canManage ? '<button class="btn" id="addStaff">+ Add staff</button>' : '<span class="badge gray">View only</span>'}</div>
    <div style="margin-bottom:1rem"><input id="staffSearch" placeholder="Search name, email or role…" value="${esc(staffSearch)}" style="max-width:320px" /></div>
    <div class="table-wrap"><table><thead><tr>
      <th>Name</th><th>Email</th><th>Access level</th><th>Location</th><th>Status</th>${canManage ? '<th>Actions</th>' : ''}
    </tr></thead><tbody>
      ${shown.length ? shown.map(u => `<tr>
        <td><a href="#" class="staff-link" data-prof="${u.id}"><strong>${esc(u.name)}</strong></a></td>
        <td class="mono">${esc(u.email)}</td>
        <td><span class="badge ${ROLE_CHIP[u.role] || 'gray'}">${esc(u.role)}</span></td>
        <td>${esc((u.location_name || 'All locations').replace('Pho Ha Noi — ', ''))}</td>
        <td>${u.is_active ? '<span class="badge ok">Active</span>' : '<span class="badge out">Inactive</span>'}</td>
        ${canManage ? `<td><div class="actions-cell">
          <button class="btn sm ghost" data-sact="edit" data-id="${u.id}">Edit</button>
          <button class="btn sm ghost" data-sact="pw" data-id="${u.id}">Reset password</button>
          <button class="btn sm ghost" data-sact="toggle" data-id="${u.id}">${u.is_active ? 'Deactivate' : 'Activate'}</button>
        </div></td>` : ''}
      </tr>`).join('') : `<tr><td colspan="${canManage ? 6 : 5}" class="empty">No staff match your search.</td></tr>`}
    </tbody></table></div>`;

  const search = $('staffSearch');
  search.oninput = () => { staffSearch = search.value; const pos = search.selectionStart; renderStaffDirectory().then(() => { const s = $('staffSearch'); if (s) { s.focus(); s.setSelectionRange(pos, pos); } }); };
  // Profile link — available to anyone who can see the directory.
  $('view').querySelectorAll('[data-prof]').forEach(a => a.onclick = (e) => { e.preventDefault(); renderStaffProfile(a.dataset.prof); });
  if (canManage) {
    $('addStaff').onclick = () => staffModal(null, locations);
    $('view').querySelectorAll('[data-sact]').forEach(b => b.onclick = () => {
      const u = rows.find(x => x.id == b.dataset.id);
      if (b.dataset.sact === 'edit') staffModal(u, locations);
      else if (b.dataset.sact === 'pw') resetStaffPassword(u);
      else if (b.dataset.sact === 'toggle') toggleStaff(u);
    });
  }
}

// ── Staff profile (full HR record) ───────────────────────────────────────────
async function renderStaffProfile(id) {
  let d, locations, staff;
  try { [d, locations, staff] = await Promise.all([api('/staff/' + id + '/profile'), api('/inventory/locations').catch(() => S.locations || []), api('/staff').catch(() => [])]); }
  catch (e) { return renderPlaceholder('Staff', '👥', e.message); }
  const canEdit = ['owner', 'admin'].includes(S.user.role);
  const p = d.profile || {};
  const shortLoc = (n) => (n || '').replace('Pho Ha Noi — ', '');
  const locName = (lid) => { const l = (locations || []).find(x => x.id == lid); return l ? shortLoc(l.name) : ''; };
  const assigned = (d.assigned_location_ids || []).map(locName).filter(Boolean).join(', ');
  const F = (l, v) => `<div class="pf"><span class="pl">${l}</span><span class="pv">${v ? esc(v) : '—'}</span></div>`;
  $('view').innerHTML = `
    <div class="row-between">
      <button class="btn sm ghost" id="backDir">← Directory</button>
      ${canEdit ? '<button class="btn" id="editProf">Edit profile</button>' : '<span class="badge gray">View only</span>'}
    </div>
    <h2 class="page" style="margin-top:.6rem">${esc(d.name)} <span class="badge ${ROLE_CHIP[d.role] || 'gray'}">${esc(d.role)}</span> ${d.is_active ? '<span class="badge ok">Active</span>' : '<span class="badge out">Inactive</span>'}</h2>
    <p class="sub" style="color:var(--muted);margin-top:0">${esc(shortLoc(d.location_name) || 'All locations')} · joined ${esc((d.created_at || '').slice(0, 10))}</p>
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
  if (canEdit) $('editProf').onclick = () => staffProfileEdit(d, locations, staff);
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
      <div><button class="btn ghost" id="cancelProf">Cancel</button> <button class="btn" id="saveProf">Save profile</button></div></div>
    <div class="prof-cols">
      <div class="section"><h3>Personal</h3>${inp('preferred_name', 'Preferred name', p.preferred_name)}${inp('legal_first_name', 'Legal first name', p.legal_first_name)}${inp('legal_last_name', 'Legal last name', p.legal_last_name)}${inp('dob', 'Date of birth', p.dob, 'date')}${inp('gender', 'Gender', p.gender)}${inp('employee_code', 'Employee code', p.employee_code)}</div>
      <div class="section"><h3>Contact</h3>${inp('personal_email', 'Personal email', p.personal_email, 'email')}${inp('phone', 'Mobile', p.phone)}${inp('alt_phone', 'Alt phone', p.alt_phone)}${selS('preferred_contact', 'Preferred contact', p.preferred_contact, ['', 'email', 'phone', 'text'])}</div>
      <div class="section"><h3>Mailing address</h3>${inp('address_line1', 'Address line 1', p.address_line1)}${inp('address_line2', 'Address line 2', p.address_line2)}${inp('city', 'City', p.city)}${inp('state', 'State', p.state)}${inp('postal_code', 'Postal code', p.postal_code)}${inp('country', 'Country', p.country || 'USA')}</div>
      <div class="section"><h3>Emergency contact</h3>${inp('emergency_name', 'Name', p.emergency_name)}${inp('emergency_relation', 'Relationship', p.emergency_relation)}${inp('emergency_phone', 'Phone', p.emergency_phone)}</div>
      <div class="section"><h3>Employment</h3>${inp('job_title', 'Job title', p.job_title)}${inp('department', 'Department', p.department)}${selS('employment_type', 'Type', p.employment_type, ['', 'full_time', 'part_time', 'seasonal', 'contract'])}${inp('hire_date', 'Hire date', p.hire_date, 'date')}${inp('termination_date', 'Termination date', p.termination_date, 'date')}${selRaw('supervisor_id', 'Supervisor', p.supervisor_id, supOpts)}</div>
      <div class="section"><h3>Payroll</h3>${selS('pay_type', 'Pay type', p.pay_type, ['', 'hourly', 'salary'])}${inp('hourly_rate', 'Pay rate ($/hr)', d.hourly_rate, 'number')}${inp('payroll_ref', 'Payroll reference', p.payroll_ref)}</div>
      <div class="section"><h3>Also works at (transfers)</h3><div class="loc-checks">${(locations || []).map(l => `<label class="chk"><input type="checkbox" data-loc="${l.id}" ${assigned.has(String(l.id)) ? 'checked' : ''} /> ${esc((l.name || '').replace('Pho Ha Noi — ', ''))}</label>`).join('')}</div></div>
      <div class="section" style="grid-column:1/-1"><h3>Skills &amp; notes</h3>${inp('skills', 'Skills / roles (comma-separated)', p.skills)}<label class="pfl">Notes<textarea id="pf_notes" rows="3">${esc(p.notes || '')}</textarea></label></div>
    </div>`;
  $('cancelProf').onclick = () => renderStaffProfile(d.id);
  $('saveProf').onclick = async () => {
    const body = {};
    $('view').querySelectorAll('[id^="pf_"]').forEach(el => { body[el.id.slice(3)] = el.value; });
    body.assigned_location_ids = [...$('view').querySelectorAll('[data-loc]:checked')].map(c => c.dataset.loc);
    try { await api('/staff/' + d.id + '/profile', { method: 'PUT', body: JSON.stringify(body) }); toast('Profile saved'); renderStaffProfile(d.id); }
    catch (e) { toast(e.message, true); }
  };
}

function locFieldOptions(locations, selected, includeAll) {
  const opts = includeAll ? [{ value: '', label: 'All locations (owner/admin)' }] : [];
  return opts.concat(locations.map(l => ({ value: l.id, label: l.name.replace('Pho Ha Noi — ', '') })));
}
function staffModal(u, locations) {
  const isNew = !u;
  const roleOpts = ACCESS_LEVELS
    .filter(r => r !== 'owner' || S.user.role === 'owner') // only owner can assign owner
    .map(r => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1) }));
  const fields = [
    { key: 'name', label: 'Full name', value: u ? u.name : '' },
    { key: 'email', label: 'Email', value: u ? u.email : '', type: isNew ? 'email' : 'text' },
    { key: 'role', label: 'Access level', type: 'select', options: roleOpts, value: u ? u.role : 'employee' },
    { key: 'location_id', label: 'Location', type: 'select', options: locFieldOptions(locations, u ? u.location_id : '', true), value: u ? (u.location_id || '') : '' },
  ];
  if (isNew) fields.splice(2, 0, { key: 'password', label: 'Temporary password (min 8)', type: 'password' });
  modal(isNew ? 'Add staff' : `Edit — ${u.name}`, fields, async (v) => {
    if (v.email !== undefined && !isNew) delete v.email; // email is immutable on edit
    if (isNew) { await api('/staff', { method: 'POST', body: JSON.stringify(v) }); toast('Staff account created'); }
    else { await api('/staff/' + u.id, { method: 'PUT', body: JSON.stringify(v) }); toast('Staff updated'); }
    renderStaffModule();
  }, isNew ? 'Create account' : 'Save');
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

const ACCESS_MATRIX = [
  ['owner', 'gold', 'Everything', 'All locations · all modules · manage staff & access levels'],
  ['admin', 'gold', 'Everything (for now)', 'Same as Owner across all locations; cannot create Owner accounts'],
  ['manager', 'blue', 'Their location', 'Inventory + Menu/Recipes; view staff; manage vendors & purchase orders'],
  ['support', 'ok', 'Stock operations', 'Receive, transfer, waste & cycle-count at their location; view inventory'],
  ['employee', 'gray', 'View / request', 'View stock & overview; request orders — no management actions'],
];
function renderAccessLevels() {
  $('view').innerHTML = `
    <h2 class="page">Access Levels</h2>
    <p class="sub" style="color:var(--muted);margin-top:-.4rem">What each access level can do. Owner and Admin see everything; others are scoped to their location.</p>
    <div class="table-wrap"><table><thead><tr><th>Level</th><th>Scope</th><th>Capabilities</th></tr></thead><tbody>
      ${ACCESS_MATRIX.map(([role, chip, scope, caps]) => `<tr>
        <td><span class="badge ${chip}">${role}</span></td>
        <td><strong>${esc(scope)}</strong></td>
        <td style="color:#374151">${esc(caps)}</td>
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
      ${d.by_staff.length ? d.by_staff.map(s => `<tr><td><strong>${esc(s.name)}</strong></td><td><span class="badge ${ROLE_CHIP[s.role] || 'gray'}">${esc(s.role)}</span></td><td>${esc(shortLoc(s.location) || '—')}</td><td class="num">${s.shifts}</td><td class="num">${numf(s.hours)}</td><td class="num">${money(s.hourly_rate)}/hr</td><td class="num">${money(s.labor_cost)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">No timesheets in range.</td></tr>'}
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
const MSG_TABS = [['inbox', 'Inbox'], ['sent', 'Sent'], ['compose', 'Compose']];
function renderMsgTabs() {
  $('tabs').innerHTML = MSG_TABS.map(([k, l]) => `<button data-gtab="${k}" class="${S.msgTab === k ? 'active' : ''}">${l}${k === 'inbox' && S.unread ? ` <span class="tab-badge">${S.unread}</span>` : ''}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach(b => b.onclick = () => { S.msgTab = b.dataset.gtab; renderMsgTabs(); renderMessages(); });
}
function renderMessages() {
  $('view').innerHTML = '<div class="empty">Loading…</div>';
  ({ inbox: renderInbox, sent: renderSent, compose: renderCompose }[S.msgTab])();
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
  const msgs = await api('/messages/inbox');
  $('view').innerHTML = `
    <h2 class="page">Inbox <span style="font-weight:400;color:var(--muted);font-size:.9rem">— ${msgs.filter(m => !m.is_read).length} unread</span></h2>
    ${msgs.length ? `<div class="msg-list">${msgs.map(m => `
      <div class="msg-card ${m.is_read ? '' : 'unread'}" data-mid="${m.id}">
        <div class="msg-head">
          <span class="msg-from">${m.is_read ? '' : '<span class="dot"></span>'}${esc(m.sender_name)} <span class="badge ${ROLE_CHIP[m.sender_role] || 'gray'}">${esc(m.sender_role)}</span> ${audBadge(m.audience)}</span>
          <span class="msg-time">${msgTime(m.created_at)}</span>
        </div>
        <div class="msg-subj">${esc(m.subject || '(no subject)')}</div>
        <div class="msg-body">${esc(m.body)}</div>
      </div>`).join('')}</div>` : '<div class="empty">No messages yet.</div>'}`;
  $('view').querySelectorAll('.msg-card.unread').forEach(card => card.onclick = async () => {
    try {
      await api(`/messages/${card.dataset.mid}/read`, { method: 'POST' });
      card.classList.remove('unread');
      card.querySelector('.dot')?.remove();
      refreshUnread(); renderMsgTabs();
    } catch { /* ignore */ }
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

async function renderCompose() {
  const canBroadcast = ['owner', 'admin', 'manager'].includes(S.user.role);
  const recips = await api('/messages/recipients');
  $('view').innerHTML = `
    <h2 class="page">New message</h2>
    <div class="section" style="max-width:640px">
      <div class="err" id="cErr"></div>
      <label class="fld-label">To</label>
      <select id="cAud" class="fld">
        <option value="direct">A person</option>
        ${canBroadcast ? '<option value="all">All staff (broadcast)</option><option value="location">A whole location</option>' : ''}
      </select>
      <div id="cDirect"><label class="fld-label">Recipient</label><select id="cRecip" class="fld">${recips.map(u => `<option value="${u.id}">${esc(u.name)} — ${esc(u.role)}${u.location ? ' · ' + esc(shortLoc(u.location)) : ''}</option>`).join('')}</select></div>
      <div id="cLoc" class="hidden"><label class="fld-label">Location</label><select id="cLocSel" class="fld">${S.locations.map(l => `<option value="${l.id}">${esc(shortLoc(l.name))}</option>`).join('')}</select></div>
      <label class="fld-label">Subject</label><input id="cSubj" class="fld" placeholder="Subject (optional)" />
      <label class="fld-label">Message</label><textarea id="cBody" class="fld" rows="5" placeholder="Write your message…"></textarea>
      <button class="btn" id="cSend">Send message</button>
    </div>`;
  const aud = $('cAud');
  aud.onchange = () => { $('cDirect').classList.toggle('hidden', aud.value !== 'direct'); $('cLoc').classList.toggle('hidden', aud.value !== 'location'); };
  $('cSend').onclick = async () => {
    $('cErr').textContent = '';
    const payload = { audience: aud.value, subject: $('cSubj').value, body: $('cBody').value };
    if (aud.value === 'direct') payload.recipient_id = $('cRecip').value;
    if (aud.value === 'location') payload.location_id = $('cLocSel').value;
    try {
      const r = await api('/messages', { method: 'POST', body: JSON.stringify(payload) });
      toast(`Message sent to ${r.recipients} recipient${r.recipients > 1 ? 's' : ''}`);
      S.msgTab = 'sent'; renderMsgTabs(); renderMessages();
    } catch (e) { $('cErr').textContent = e.message; }
  };
}

// ── Central Kitchen module (production & supply hub) ────────────────────────
const CK_TABS = [['overview', 'Overview'], ['demand', 'Demand'], ['production', 'Production'], ['recipes', 'Recipes'], ['fulfillment', 'Fulfillment'], ['staff', 'CK Staff']];
function renderCkTabs() {
  $('tabs').innerHTML = CK_TABS.map(([k, l]) => `<button data-ck="${k}" class="${S.ckTab === k ? 'active' : ''}">${l}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach(b => b.onclick = () => { S.ckTab = b.dataset.ck; renderCkTabs(); renderCentral(); });
}
function renderCentral() {
  $('view').innerHTML = '<div class="empty">Loading…</div>';
  ({ overview: renderCkOverview, demand: renderCkDemand, production: renderCkProduction, recipes: renderCkRecipes, fulfillment: renderCkFulfillment, staff: renderCkStaff }[S.ckTab])();
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
  ], async (v) => { const r = await api('/central/production', { method: 'POST', body: JSON.stringify({ product_id: b.dataset.produce, ...v }) }); toast(`Produced ${numf(r.produced)} units`); renderCentral(); }, 'Record'));
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
  ], async (v) => {
    if (isNew) { await api('/central/products', { method: 'POST', body: JSON.stringify(v) }); toast('Product added — add its recipe next'); }
    else { await api('/central/products/' + p.id, { method: 'PUT', body: JSON.stringify(v) }); toast('Product updated'); }
    renderCentral();
  }, isNew ? 'Add' : 'Save');
}

async function ckRecipeModal(p) {
  const ingredients = await api('/central/ingredients');
  let list = p.ingredients.map(i => ({ item_name: i.item_name, quantity: i.quantity }));
  const host = $('modalHost');
  const render = () => {
    host.innerHTML = `<div class="modal-bg"><div class="modal" style="max-width:560px"><h3>Recipe — ${esc(p.name)}</h3><div class="err" id="mErr"></div>
      <p class="sub" style="color:var(--muted);margin-top:0">Ingredients consumed <strong>per batch</strong> (one batch yields ${numf(p.batch_yield)} ${esc(p.unit)}).</p>
      <div class="table-wrap"><table><tbody>
        ${list.length ? list.map((i, idx) => `<tr><td>${esc(i.item_name)}</td><td class="num">${numf(i.quantity)}</td><td style="width:1%"><button class="btn sm ghost" data-rm="${idx}">✕</button></td></tr>`).join('') : '<tr><td colspan="3" class="empty">No ingredients yet.</td></tr>'}
      </tbody></table></div>
      <div class="ck-rec-add"><select id="ckIng">${ingredients.map(i => `<option value="${esc(i.item_name)}">${esc(i.item_name)} · ${money(i.avg_cost)}</option>`).join('')}</select>
        <input id="ckQty" type="number" step="0.01" min="0" placeholder="Qty / batch"><button class="btn ghost" id="ckAddIng">+ Add</button></div>
      <div class="actions"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn" id="mOk">Save recipe</button></div>
    </div></div>`;
    const close = () => host.innerHTML = '';
    $('mCancel').onclick = close;
    host.querySelector('.modal-bg').onclick = (e) => { if (e.target.classList.contains('modal-bg')) close(); };
    host.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { list.splice(+b.dataset.rm, 1); render(); });
    $('ckAddIng').onclick = () => {
      const name = $('ckIng').value, q = parseFloat($('ckQty').value);
      if (!name || !(q > 0)) { toast('Pick an ingredient and a quantity', true); return; }
      const ex = list.find(x => x.item_name === name);
      if (ex) ex.quantity += q; else list.push({ item_name: name, quantity: q });
      render();
    };
    $('mOk').onclick = async () => {
      try { await api('/central/products/' + p.id + '/recipe', { method: 'PUT', body: JSON.stringify({ ingredients: list }) }); toast('Recipe saved'); close(); renderCentral(); }
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
        ${staff.map(u => `<tr><td><strong>${esc(u.name)}</strong></td><td><span class="badge ${ROLE_CHIP[u.role] || 'gray'}">${esc(u.role)}</span></td><td class="num">${money(u.hourly_rate)}/hr</td><td>${u.has_pin ? '<span class="badge ok">set</span>' : '—'}</td></tr>`).join('')}
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
        <div class="profile-row"><span>Email</span><strong>${esc(me.email || '—')}</strong></div>
        <div class="profile-row"><span>Access level</span><span class="badge ${ROLE_CHIP[me.role] || 'gray'}">${esc(me.role || S.user.role)}</span></div>
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
  const t = localStorage.getItem('phn_token'), u = localStorage.getItem('phn_user');
  if (t && u) { S.token = t; S.user = JSON.parse(u); boot().catch(() => { localStorage.clear(); location.reload(); }); }
})();
