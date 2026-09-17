// Toast → local mirror sync (read-only pulls). Phase 1: sales orders for a business
// date. Idempotent: every row is upserted by its Toast GUID, so re-running a day
// simply refreshes it. Writes an auditable row into toast_sync_log per run.
const db = require('../db/database');
const toast = require('./toast');

const sum = (arr, f) => (arr || []).reduce((t, x) => t + (Number(f(x)) || 0), 0);
const bool = (v) => (v ? 1 : 0);
// 'YYYY-MM-DD' → 'YYYYMMDD' for the Toast businessDate query param.
const toBusinessParam = (iso) => String(iso || '').replace(/-/g, '');

const upOrder = db.prepare(`INSERT INTO toast_orders
  (guid,location_id,business_date,opened_at,closed_at,paid_at,source,voided,deleted,num_guests,dining_option_guid,revenue_center_guid,service_area_guid,table_guid,server_guid,synced_at)
  VALUES (@guid,@location_id,@business_date,@opened_at,@closed_at,@paid_at,@source,@voided,@deleted,@num_guests,@dining_option_guid,@revenue_center_guid,@service_area_guid,@table_guid,@server_guid,datetime('now'))
  ON CONFLICT(guid) DO UPDATE SET location_id=excluded.location_id,business_date=excluded.business_date,opened_at=excluded.opened_at,closed_at=excluded.closed_at,paid_at=excluded.paid_at,source=excluded.source,voided=excluded.voided,deleted=excluded.deleted,num_guests=excluded.num_guests,dining_option_guid=excluded.dining_option_guid,revenue_center_guid=excluded.revenue_center_guid,service_area_guid=excluded.service_area_guid,table_guid=excluded.table_guid,server_guid=excluded.server_guid,synced_at=datetime('now')`);

const upCheck = db.prepare(`INSERT INTO toast_checks
  (guid,order_guid,location_id,business_date,amount,tax_amount,total_amount,tip_amount,discount_amount,service_charge_amount,payment_status,voided,synced_at)
  VALUES (@guid,@order_guid,@location_id,@business_date,@amount,@tax_amount,@total_amount,@tip_amount,@discount_amount,@service_charge_amount,@payment_status,@voided,datetime('now'))
  ON CONFLICT(guid) DO UPDATE SET order_guid=excluded.order_guid,location_id=excluded.location_id,business_date=excluded.business_date,amount=excluded.amount,tax_amount=excluded.tax_amount,total_amount=excluded.total_amount,tip_amount=excluded.tip_amount,discount_amount=excluded.discount_amount,service_charge_amount=excluded.service_charge_amount,payment_status=excluded.payment_status,voided=excluded.voided,synced_at=datetime('now')`);

const upPayment = db.prepare(`INSERT INTO toast_payments
  (guid,check_guid,order_guid,location_id,business_date,amount,tip_amount,type,card_type,card_entry_mode,refund_amount,paid_at,synced_at)
  VALUES (@guid,@check_guid,@order_guid,@location_id,@business_date,@amount,@tip_amount,@type,@card_type,@card_entry_mode,@refund_amount,@paid_at,datetime('now'))
  ON CONFLICT(guid) DO UPDATE SET check_guid=excluded.check_guid,order_guid=excluded.order_guid,location_id=excluded.location_id,business_date=excluded.business_date,amount=excluded.amount,tip_amount=excluded.tip_amount,type=excluded.type,card_type=excluded.card_type,card_entry_mode=excluded.card_entry_mode,refund_amount=excluded.refund_amount,paid_at=excluded.paid_at,synced_at=datetime('now')`);

function mapping(locationId) {
  return db.prepare(`SELECT * FROM toast_locations WHERE location_id=? AND active=1`).get(locationId);
}

// Pull one business day of orders for one location into the mirror tables.
// businessDate: 'YYYY-MM-DD'. Returns { orders, checks, payments }.
async function syncOrders(locationId, businessDate) {
  const map = mapping(locationId);
  if (!map) throw new Error('That location is not mapped to a Toast restaurant.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate || '')) throw new Error('businessDate must be YYYY-MM-DD.');
  const guid = map.toast_guid;
  const log = db.prepare(`INSERT INTO toast_sync_log (domain,location_id,toast_guid,window_start,window_end,status) VALUES ('orders',?,?,?,?, 'running')`)
    .run(locationId, guid, businessDate, businessDate);
  const logId = log.lastInsertRowid;
  try {
    // Page through ordersBulk (numeric paging; stop when a short/empty page returns).
    const pageSize = 100; let page = 1; const orders = [];
    for (;;) {
      const { body } = await toast.toastGet('/orders/v2/ordersBulk', { guid, query: { businessDate: toBusinessParam(businessDate), page, pageSize } });
      const arr = Array.isArray(body) ? body : [];
      orders.push(...arr);
      if (arr.length < pageSize || page > 200) break;
      page++;
    }
    let nChecks = 0, nPays = 0;
    db.exec('BEGIN');
    try {
      for (const o of orders) {
        upOrder.run({
          guid: o.guid, location_id: locationId, business_date: businessDate,
          opened_at: o.openedDate || null, closed_at: o.closedDate || null, paid_at: o.paidDate || null,
          source: o.source || null, voided: bool(o.voided), deleted: bool(o.deleted),
          num_guests: o.numberOfGuests != null ? o.numberOfGuests : null,
          dining_option_guid: o.diningOption && o.diningOption.guid || null,
          revenue_center_guid: o.revenueCenter && o.revenueCenter.guid || null,
          service_area_guid: o.serviceArea && o.serviceArea.guid || null,
          table_guid: o.table && o.table.guid || null,
          server_guid: o.server && o.server.guid || null,
        });
        for (const c of (o.checks || [])) {
          upCheck.run({
            guid: c.guid, order_guid: o.guid, location_id: locationId, business_date: businessDate,
            amount: c.amount != null ? c.amount : null,
            tax_amount: c.taxAmount != null ? c.taxAmount : null,
            total_amount: c.totalAmount != null ? c.totalAmount : null,
            tip_amount: sum(c.payments, (p) => p.tipAmount),
            discount_amount: sum(c.appliedDiscounts, (d) => d.discountAmount != null ? d.discountAmount : d.amount),
            service_charge_amount: sum(c.appliedServiceCharges, (s) => s.chargeAmount != null ? s.chargeAmount : s.amount),
            payment_status: c.paymentStatus || null, voided: bool(c.voided),
          });
          nChecks++;
          for (const p of (c.payments || [])) {
            upPayment.run({
              guid: p.guid, check_guid: c.guid, order_guid: o.guid, location_id: locationId, business_date: businessDate,
              amount: p.amount != null ? p.amount : null, tip_amount: p.tipAmount != null ? p.tipAmount : null,
              type: p.type || null, card_type: p.cardType || null, card_entry_mode: p.cardEntryMode || null,
              refund_amount: (p.refund && (p.refund.refundAmount || p.refund.tipRefundAmount)) || 0,
              paid_at: p.paidDate || null,
            });
            nPays++;
          }
        }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    db.prepare(`UPDATE toast_locations SET last_synced_at=datetime('now') WHERE location_id=?`).run(locationId);
    db.prepare(`UPDATE toast_sync_log SET status='ok', record_count=?, detail=?, finished_at=datetime('now') WHERE id=?`)
      .run(orders.length, `${orders.length} orders · ${nChecks} checks · ${nPays} payments`, logId);
    return { orders: orders.length, checks: nChecks, payments: nPays };
  } catch (e) {
    db.prepare(`UPDATE toast_sync_log SET status='error', detail=?, finished_at=datetime('now') WHERE id=?`).run(String(e.message).slice(0, 500), logId);
    throw e;
  }
}

// Roll up the mirrored checks into a per-day sales summary for a location.
function salesSummary(locationId, businessDate) {
  return db.prepare(`SELECT
      COUNT(DISTINCT o.guid) AS orders,
      COALESCE(SUM(o.num_guests),0) AS guests,
      COALESCE(SUM(c.amount),0) AS net_sales,
      COALESCE(SUM(c.tax_amount),0) AS tax,
      COALESCE(SUM(c.tip_amount),0) AS tips,
      COALESCE(SUM(c.discount_amount),0) AS discounts,
      COALESCE(SUM(c.total_amount),0) AS total
    FROM toast_orders o LEFT JOIN toast_checks c ON c.order_guid=o.guid
    WHERE o.location_id=? AND o.business_date=? AND o.voided=0`).get(locationId, businessDate);
}

// ── Labor: staff roster & job catalog ─────────────────────────────────────────
const digits = (s) => String(s || '').replace(/\D+/g, '').slice(-10);

const upEmp = db.prepare(`INSERT INTO toast_employees
  (guid,location_id,first_name,last_name,chosen_name,email,phone,external_employee_id,deleted,user_id,match_by,synced_at)
  VALUES (@guid,@location_id,@first_name,@last_name,@chosen_name,@email,@phone,@external_employee_id,@deleted,@user_id,@match_by,datetime('now'))
  ON CONFLICT(guid) DO UPDATE SET location_id=excluded.location_id,first_name=excluded.first_name,last_name=excluded.last_name,chosen_name=excluded.chosen_name,email=excluded.email,phone=excluded.phone,external_employee_id=excluded.external_employee_id,deleted=excluded.deleted,user_id=excluded.user_id,match_by=excluded.match_by,synced_at=datetime('now')`);

const upJob = db.prepare(`INSERT INTO toast_jobs (guid,location_id,title,tipped,default_wage,wage_frequency,deleted,synced_at)
  VALUES (@guid,@location_id,@title,@tipped,@default_wage,@wage_frequency,@deleted,datetime('now'))
  ON CONFLICT(guid) DO UPDATE SET location_id=excluded.location_id,title=excluded.title,tipped=excluded.tipped,default_wage=excluded.default_wage,wage_frequency=excluded.wage_frequency,deleted=excluded.deleted,synced_at=datetime('now')`);

// Match a Toast employee to one of our users: email, then phone, then full name.
function matchUser(emp) {
  const email = (emp.email || '').toLowerCase().trim();
  if (email) { const u = db.prepare(`SELECT id FROM users WHERE lower(email)=?`).get(email); if (u) return { user_id: u.id, match_by: 'email' }; }
  const ph = digits(emp.phoneNumber);
  if (ph.length === 10) { const u = db.prepare(`SELECT id FROM users WHERE phone=?`).get(ph); if (u) return { user_id: u.id, match_by: 'phone' }; }
  const name = [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim();
  if (name) { const u = db.prepare(`SELECT id FROM users WHERE lower(name)=?`).get(name.toLowerCase()); if (u) return { user_id: u.id, match_by: 'name' }; }
  return { user_id: null, match_by: null };
}

// Pull the Toast staff roster + job catalog for a location and match employees to
// our users. Read-only. Returns { employees, jobs, matched }.
async function syncLabor(locationId) {
  const map = mapping(locationId);
  if (!map) throw new Error('That location is not mapped to a Toast restaurant.');
  const guid = map.toast_guid;
  const log = db.prepare(`INSERT INTO toast_sync_log (domain,location_id,toast_guid,status) VALUES ('labor',?,?, 'running')`).run(locationId, guid);
  const logId = log.lastInsertRowid;
  try {
    const employees = await toast.toastGetAll('/labor/v1/employees', { guid, pageSize: 100 });
    const jobs = await toast.toastGetAll('/labor/v1/jobs', { guid, pageSize: 100 });
    let matched = 0;
    db.exec('BEGIN');
    try {
      for (const e of employees) {
        const m = matchUser(e); if (m.user_id) matched++;
        upEmp.run({
          guid: e.guid, location_id: locationId,
          first_name: e.firstName || null, last_name: e.lastName || null, chosen_name: e.chosenName || null,
          email: (e.email || '').toLowerCase() || null, phone: digits(e.phoneNumber) || null,
          external_employee_id: e.externalEmployeeId || null, deleted: e.deleted ? 1 : 0,
          user_id: m.user_id, match_by: m.match_by,
        });
      }
      for (const j of jobs) {
        upJob.run({ guid: j.guid, location_id: locationId, title: j.title || null, tipped: j.tipped ? 1 : 0,
          default_wage: j.defaultWage != null ? j.defaultWage : null, wage_frequency: j.wageFrequency || null, deleted: j.deleted ? 1 : 0 });
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    db.prepare(`UPDATE toast_sync_log SET status='ok', record_count=?, detail=?, finished_at=datetime('now') WHERE id=?`)
      .run(employees.length, `${employees.length} employees (${matched} matched) · ${jobs.length} jobs`, logId);
    return { employees: employees.length, jobs: jobs.length, matched };
  } catch (e) {
    db.prepare(`UPDATE toast_sync_log SET status='error', detail=?, finished_at=datetime('now') WHERE id=?`).run(String(e.message).slice(0, 500), logId);
    throw e;
  }
}

// ── Menu & pricing ────────────────────────────────────────────────────────────
const insMenuItem = db.prepare(`INSERT INTO toast_menu_items
  (location_id,guid,multi_location_id,name,pos_name,menu_name,group_name,price,pricing_strategy,sku,plu,calories,visible,synced_at)
  VALUES (@location_id,@guid,@multi_location_id,@name,@pos_name,@menu_name,@group_name,@price,@pricing_strategy,@sku,@plu,@calories,@visible,datetime('now'))
  ON CONFLICT(location_id,guid) DO UPDATE SET multi_location_id=excluded.multi_location_id,name=excluded.name,pos_name=excluded.pos_name,menu_name=excluded.menu_name,group_name=excluded.group_name,price=excluded.price,pricing_strategy=excluded.pricing_strategy,sku=excluded.sku,plu=excluded.plu,calories=excluded.calories,visible=excluded.visible,synced_at=datetime('now')`);

// Walk a menu group tree (groups can nest) collecting every item with its menu +
// immediate group name.
function collectItems(group, menuName, out) {
  for (const it of (group.menuItems || [])) out.push({ item: it, menuName, groupName: group.name || null });
  for (const sub of (group.menuGroups || [])) collectItems(sub, menuName, out);
}

// Pull the published Toast menu for a location and replace that location's item
// snapshot. Read-only. Returns { items, groups, menus }.
async function syncMenus(locationId) {
  const map = mapping(locationId);
  if (!map) throw new Error('That location is not mapped to a Toast restaurant.');
  const guid = map.toast_guid;
  const log = db.prepare(`INSERT INTO toast_sync_log (domain,location_id,toast_guid,status) VALUES ('menus',?,?, 'running')`).run(locationId, guid);
  const logId = log.lastInsertRowid;
  try {
    const { body } = await toast.toastGet('/menus/v2/menus', { guid });
    const menus = (body && body.menus) || (Array.isArray(body) ? body : []);
    const rows = [];
    let groups = 0;
    for (const menu of menus) {
      for (const g of (menu.menuGroups || [])) { groups++; collectItems(g, menu.name || null, rows); }
    }
    db.exec('BEGIN');
    try {
      db.prepare(`DELETE FROM toast_menu_items WHERE location_id=?`).run(locationId);
      for (const { item, menuName, groupName } of rows) {
        insMenuItem.run({
          location_id: locationId, guid: item.guid, multi_location_id: item.multiLocationId || null,
          name: item.name || null, pos_name: item.posName || null, menu_name: menuName, group_name: groupName,
          price: item.price != null ? item.price : null, pricing_strategy: item.pricingStrategy || null,
          sku: item.sku || null, plu: item.plu || null, calories: item.calories != null ? item.calories : null,
          visible: (Array.isArray(item.visibility) && item.visibility.length) ? 1 : 0,
        });
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    db.prepare(`UPDATE toast_sync_log SET status='ok', record_count=?, detail=?, finished_at=datetime('now') WHERE id=?`)
      .run(rows.length, `${rows.length} items · ${groups} groups · ${menus.length} menus`, logId);
    return { items: rows.length, groups, menus: menus.length };
  } catch (e) {
    db.prepare(`UPDATE toast_sync_log SET status='error', detail=?, finished_at=datetime('now') WHERE id=?`).run(String(e.message).slice(0, 500), logId);
    throw e;
  }
}

// ── Automatic sync during operating hours ─────────────────────────────────────
// A background sweep keeps each mapped location's sales current: it finalizes the
// prior business day once per local day, and re-pulls "today" every interval while
// the store is open (plus a grace window after close for closeout). Read-only,
// idempotent, and per-location opt-out via toast_locations.auto_sync.
const { localDate, localTime } = require('./tz');
// Every Pho Ha Noi restaurant operates on Pacific Time, so all Toast business-date
// boundaries ("today" / "yesterday") are computed in Pacific — independent of the
// server's timezone, any location's timezone column, or whose browser is open.
const PACIFIC = 'America/Los_Angeles';
const pacificToday = () => localDate(PACIFIC);
const toMin = (hhmm) => { const m = /^(\d{2}):(\d{2})/.exec(hhmm || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const addDaysIso = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// day_of_week 0=Mon…6=Sun for a local YYYY-MM-DD.
const weekdayMon0 = (iso) => (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7;

const _swState = {};  // { [locId]: { lastLive: ms, settled: 'YYYY-MM-DD' } }

// Is the store open now (or within the post-close grace), per its operating hours?
function openWindow(locId, weekday, nowMin, graceMin) {
  const h = db.prepare(`SELECT open_time, close_time, open_time2, close_time2, is_closed FROM location_hours WHERE location_id=? AND day_of_week=?`).get(locId, weekday);
  if (!h || h.is_closed) return false;
  const opens = [toMin(h.open_time), toMin(h.open_time2)].filter((x) => x != null);
  const closes = [toMin(h.close_time), toMin(h.close_time2)].filter((x) => x != null);
  if (!opens.length || !closes.length) return false;
  return nowMin >= Math.min(...opens) && nowMin <= Math.max(...closes) + graceMin;
}

async function sweepOnce({ graceMin = 90, liveThrottleMin = 20 } = {}) {
  if (!toast.toastEnabled()) return;
  const maps = db.prepare(`SELECT tl.location_id FROM toast_locations tl
    JOIN locations l ON l.id=tl.location_id WHERE tl.active=1 AND tl.auto_sync=1`).all();
  const today = pacificToday(), nowMin = toMin(localTime(PACIFIC));   // Pacific for all stores
  for (const m of maps) {
    const st = _swState[m.location_id] || (_swState[m.location_id] = { lastLive: 0, settled: null });
    try {
      // Finalize yesterday once at the first sweep of a new local day, and refresh
      // the staff roster / job catalog (they change rarely) at the same time.
      if (st.settled !== today) {
        await syncOrders(m.location_id, addDaysIso(today, -1));
        try { await syncLabor(m.location_id); } catch (e) { console.error(`[toast-sweep] labor loc ${m.location_id}:`, e.message); }
        try { await syncMenus(m.location_id); } catch (e) { console.error(`[toast-sweep] menus loc ${m.location_id}:`, e.message); }
        st.settled = today;
      }
      // Keep today fresh while open (throttled).
      if (openWindow(m.location_id, weekdayMon0(today), nowMin, graceMin) && (Date.now() - st.lastLive) >= liveThrottleMin * 60000) {
        await syncOrders(m.location_id, today); st.lastLive = Date.now();
      }
    } catch (e) { console.error(`[toast-sweep] loc ${m.location_id}:`, e.message); }
  }
}

let _sweepTimer = null;
function startToastSweep() {
  if (_sweepTimer) return;
  if (!toast.toastEnabled()) { console.log('[toast-sweep] Toast not configured — auto-sync off.'); return; }
  const intervalMin = Math.max(5, parseInt(process.env.TOAST_SYNC_INTERVAL_MIN, 10) || 20);
  const graceMin = parseInt(process.env.TOAST_CLOSE_GRACE_MIN, 10) || 90;
  const run = () => sweepOnce({ graceMin, liveThrottleMin: intervalMin }).catch((e) => console.error('[toast-sweep]', e.message));
  setTimeout(run, 30000);                       // first pass shortly after boot
  _sweepTimer = setInterval(run, intervalMin * 60000);
  console.log(`[toast-sweep] auto-sync every ${intervalMin} min (grace ${graceMin} min).`);
}

module.exports = { syncOrders, salesSummary, syncLabor, syncMenus, sweepOnce, startToastSweep, pacificToday };
