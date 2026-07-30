// Pho Ha Noi — Inventory SPA
const S = { token: null, user: null, locations: [], loc: null, tab: 'dashboard' };
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
  S.locations = await api('/inventory/locations');
  const picker = $('locPicker');
  if (S.user.role === 'owner') {
    picker.classList.remove('hidden');
    picker.innerHTML = S.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    S.loc = String(S.locations[0].id);
    picker.value = S.loc;
    picker.onchange = () => { S.loc = picker.value; render(); };
  } else {
    S.loc = String(S.user.location_id);
    picker.classList.add('hidden');
  }
  renderTabs();
  render();
}

const TABS = [
  ['dashboard', 'Dashboard'], ['stock', 'Stock'], ['glossary', 'Glossary'],
  ['orders', 'Orders & Reorder'], ['transfers', 'Transfers'], ['lots', 'Lots & Expiry'],
  ['vendors', 'Vendors'], ['reports', 'Reports'], ['activity', 'Activity'],
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

// ── Restore session ────────────────────────────────────────────────────────
(function init() {
  const t = localStorage.getItem('phn_token'), u = localStorage.getItem('phn_user');
  if (t && u) { S.token = t; S.user = JSON.parse(u); boot().catch(() => { localStorage.clear(); location.reload(); }); }
})();
