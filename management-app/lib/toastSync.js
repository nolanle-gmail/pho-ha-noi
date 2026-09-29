// Toast → local mirror sync (read-only pulls). Phase 1: sales orders for a business
// date. Idempotent: every row is upserted by its Toast GUID, so re-running a day
// simply refreshes it. Writes an auditable row into toast_sync_log per run.
const db = require('../db/database');
const toast = require('./toast');

const sum = (arr, f) => (arr || []).reduce((t, x) => t + (Number(f(x)) || 0), 0);
const bool = (v) => (v ? 1 : 0);
// Minutes from order open to payment, computed once at sync time. Toast timestamps
// look like "2026-09-16T17:49:22.817+0000"; Date parses them directly. Returns null
// when either end is missing/unparseable (open/voided orders never reach paid_at).
function payMinutes(opened, paid) {
  if (!opened || !paid) return null;
  const a = Date.parse(opened), b = Date.parse(paid);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 60000 * 10) / 10;
}
// 'YYYY-MM-DD' → 'YYYYMMDD' for the Toast businessDate query param.
const toBusinessParam = (iso) => String(iso || '').replace(/-/g, '');

const upOrder = db.prepare(`INSERT INTO toast_orders
  (guid,location_id,business_date,opened_at,closed_at,paid_at,pay_minutes,source,voided,deleted,num_guests,dining_option_guid,revenue_center_guid,service_area_guid,table_guid,server_guid,synced_at)
  VALUES (@guid,@location_id,@business_date,@opened_at,@closed_at,@paid_at,@pay_minutes,@source,@voided,@deleted,@num_guests,@dining_option_guid,@revenue_center_guid,@service_area_guid,@table_guid,@server_guid,datetime('now'))
  ON CONFLICT(guid) DO UPDATE SET location_id=excluded.location_id,business_date=excluded.business_date,opened_at=excluded.opened_at,closed_at=excluded.closed_at,paid_at=excluded.paid_at,pay_minutes=excluded.pay_minutes,source=excluded.source,voided=excluded.voided,deleted=excluded.deleted,num_guests=excluded.num_guests,dining_option_guid=excluded.dining_option_guid,revenue_center_guid=excluded.revenue_center_guid,service_area_guid=excluded.service_area_guid,table_guid=excluded.table_guid,server_guid=excluded.server_guid,synced_at=datetime('now')`);

const upCheck = db.prepare(`INSERT INTO toast_checks
  (guid,order_guid,location_id,business_date,amount,tax_amount,total_amount,tip_amount,discount_amount,service_charge_amount,payment_status,voided,synced_at)
  VALUES (@guid,@order_guid,@location_id,@business_date,@amount,@tax_amount,@total_amount,@tip_amount,@discount_amount,@service_charge_amount,@payment_status,@voided,datetime('now'))
  ON CONFLICT(guid) DO UPDATE SET order_guid=excluded.order_guid,location_id=excluded.location_id,business_date=excluded.business_date,amount=excluded.amount,tax_amount=excluded.tax_amount,total_amount=excluded.total_amount,tip_amount=excluded.tip_amount,discount_amount=excluded.discount_amount,service_charge_amount=excluded.service_charge_amount,payment_status=excluded.payment_status,voided=excluded.voided,synced_at=datetime('now')`);

const upSelection = db.prepare(`INSERT INTO toast_selections
  (location_id,guid,check_guid,order_guid,business_date,item_name,item_guid,sales_category_guid,selection_type,quantity,price,pre_discount_price,voided,synced_at)
  VALUES (@location_id,@guid,@check_guid,@order_guid,@business_date,@item_name,@item_guid,@sales_category_guid,@selection_type,@quantity,@price,@pre_discount_price,@voided,datetime('now'))
  ON CONFLICT(location_id,guid) DO UPDATE SET check_guid=excluded.check_guid,order_guid=excluded.order_guid,business_date=excluded.business_date,item_name=excluded.item_name,item_guid=excluded.item_guid,sales_category_guid=excluded.sales_category_guid,selection_type=excluded.selection_type,quantity=excluded.quantity,price=excluded.price,pre_discount_price=excluded.pre_discount_price,voided=excluded.voided,synced_at=datetime('now')`);

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
    let nChecks = 0, nPays = 0, nSel = 0;
    db.exec('BEGIN');
    try {
      for (const o of orders) {
        upOrder.run({
          guid: o.guid, location_id: locationId, business_date: businessDate,
          opened_at: o.openedDate || null, closed_at: o.closedDate || null, paid_at: o.paidDate || null,
          pay_minutes: payMinutes(o.openedDate, o.paidDate),
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
          for (const s of (c.selections || [])) {
            upSelection.run({
              guid: s.guid, check_guid: c.guid, order_guid: o.guid, location_id: locationId, business_date: businessDate,
              item_name: s.displayName || null, item_guid: (s.item && s.item.guid) || null,
              sales_category_guid: (s.salesCategory && s.salesCategory.guid) || null, selection_type: s.selectionType || null,
              quantity: s.quantity != null ? s.quantity : null, price: s.price != null ? s.price : null,
              pre_discount_price: s.preDiscountPrice != null ? s.preDiscountPrice : null, voided: bool(s.voided),
            });
            nSel++;
          }
        }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    db.prepare(`UPDATE toast_locations SET last_synced_at=datetime('now') WHERE location_id=?`).run(locationId);
    db.prepare(`UPDATE toast_sync_log SET status='ok', record_count=?, detail=?, finished_at=datetime('now') WHERE id=?`)
      .run(orders.length, `${orders.length} orders · ${nChecks} checks · ${nPays} payments · ${nSel} items`, logId);
    return { orders: orders.length, checks: nChecks, payments: nPays, items: nSel };
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

// Dine In first, then plain Take Out / To Go, then everything else (third-party
// delivery like "DoorDash - Takeout") alphabetically, with Unspecified last. The
// exact-match anchors keep "DoorDash - Takeout" out of the plain Take-Out slot.
const diningRank = (n) => {
  const s = String(n || '').trim().toLowerCase();
  if (/^dine[\s-]*in$/.test(s)) return 0;
  if (/^(take[\s-]*out|to[\s-]*go)$/.test(s)) return 1;
  if (s === 'unspecified') return 9;
  return 2;
};
const diningSort = (a, b) => diningRank(a.name) - diningRank(b.name) || a.name.localeCompare(b.name);

// Sales split by Toast dining option (Dine In / Take Out / DoorDash …) over a date
// span for one location, or all locations when locationId is null (names merge across
// stores). Mirrors salesSummary's join/aggregation so the parts reconcile with the
// headline totals. `from`/`to` are inclusive 'YYYY-MM-DD'; pass the same date twice
// for a single day.
function salesByDiningOption(locationId, from, to) {
  const lc = locationId ? 'AND o.location_id=?' : '';
  const args = locationId ? [from, to, locationId] : [from, to];
  const rows = db.prepare(`SELECT
      COALESCE(dopt.name, 'Unspecified') AS name,
      COUNT(DISTINCT o.guid) AS orders,
      COALESCE(SUM(o.num_guests),0) AS guests,
      COALESCE(SUM(c.amount),0) AS net_sales,
      COALESCE(SUM(c.tax_amount),0) AS tax,
      COALESCE(SUM(c.tip_amount),0) AS tips,
      COALESCE(SUM(c.total_amount),0) AS total
    FROM toast_orders o
    LEFT JOIN toast_checks c ON c.order_guid=o.guid
    LEFT JOIN toast_config dopt ON dopt.location_id=o.location_id AND dopt.type='dining_option' AND dopt.guid=o.dining_option_guid
    WHERE o.voided=0 AND o.business_date BETWEEN ? AND ? ${lc}
    GROUP BY name`).all(...args);
  return rows.sort(diningSort);
}

// Sales split by payment tender over a date span for one location, or all locations when
// locationId is null. Credit is broken down by card brand (Visa / Mastercard / Amex …);
// other tenders stay at type level. Sums the actual payments on non-voided orders; tips
// are the gratuity on each tender. Sorted by amount.
const PAY_LABELS = { CREDIT: 'Credit card', CASH: 'Cash', GIFTCARD: 'Gift card', HOUSE_ACCOUNT: 'House account', REWARDCARD: 'Reward card', OTHER: 'Other', UNDETERMINED: 'Other' };
const CARD_LABELS = { VISA: 'Visa', MASTERCARD: 'Mastercard', AMEX: 'Amex', DISCOVER: 'Discover', JCB: 'JCB', DINERS: 'Diners' };
const titleCase = (t) => (t ? t[0] + t.slice(1).toLowerCase() : '');
function salesByPaymentType(locationId, from, to) {
  const lc = locationId ? 'AND o.location_id=?' : '';
  const args = locationId ? [from, to, locationId] : [from, to];
  const rows = db.prepare(`SELECT p.type AS type, p.card_type AS card_type,
      COUNT(*) AS payments,
      COALESCE(SUM(p.amount),0) AS amount,
      COALESCE(SUM(p.tip_amount),0) AS tips
    FROM toast_payments p
    JOIN toast_orders o ON o.guid=p.order_guid
    WHERE o.voided=0 AND o.business_date BETWEEN ? AND ? ${lc}
    GROUP BY p.type, p.card_type`).all(...args);
  // Label each row: credit → card brand (fall back to "Credit card"); else the tender type.
  const label = (r) => r.type === 'CREDIT'
    ? (CARD_LABELS[r.card_type] || titleCase(r.card_type) || 'Credit card')
    : (PAY_LABELS[r.type] || titleCase(r.type) || 'Other');
  const byName = {};
  for (const r of rows) {
    const n = label(r);
    const b = byName[n] || (byName[n] = { name: n, payments: 0, amount: 0, tips: 0, credit: r.type === 'CREDIT' });
    b.payments += r.payments; b.amount += r.amount; b.tips += r.tips;
  }
  return Object.values(byName).sort((a, b) => b.amount - a.amount);
}

// Cross-tab: amount collected per payment tender (Credit card / Cash / Gift card / Other)
// for each dining option, over the span + scope. Rows are dining options (same sort as the
// dining breakdown); columns are the four tender buckets, with per-row and column totals.
function salesPaymentByDining(locationId, from, to) {
  const lc = locationId ? 'AND o.location_id=?' : '';
  const args = locationId ? [from, to, locationId] : [from, to];
  const rows = db.prepare(`SELECT COALESCE(dopt.name,'Unspecified') AS dining, p.type AS ptype,
      COALESCE(SUM(p.amount),0) AS amount
    FROM toast_payments p
    JOIN toast_orders o ON o.guid=p.order_guid
    LEFT JOIN toast_config dopt ON dopt.location_id=o.location_id AND dopt.type='dining_option' AND dopt.guid=o.dining_option_guid
    WHERE o.voided=0 AND o.business_date BETWEEN ? AND ? ${lc}
    GROUP BY dining, ptype`).all(...args);
  const colKey = (t) => (t === 'CREDIT' || t === 'CASH' || t === 'GIFTCARD') ? t : 'OTHER';
  const byDining = {};
  const totals = { CREDIT: 0, CASH: 0, GIFTCARD: 0, OTHER: 0, total: 0 };
  for (const r of rows) {
    const d = byDining[r.dining] || (byDining[r.dining] = { name: r.dining, CREDIT: 0, CASH: 0, GIFTCARD: 0, OTHER: 0, total: 0 });
    const k = colKey(r.ptype); d[k] += r.amount; d.total += r.amount; totals[k] += r.amount; totals.total += r.amount;
  }
  return { columns: [{ key: 'CREDIT', name: 'Credit card' }, { key: 'CASH', name: 'Cash' }, { key: 'GIFTCARD', name: 'Gift card' }, { key: 'OTHER', name: 'Other' }],
    rows: Object.values(byDining).sort(diningSort), totals };
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

// ── Config: tables, dining options, service areas, revenue centers ────────────
const insConfig = db.prepare(`INSERT INTO toast_config (location_id,type,guid,name,synced_at)
  VALUES (?,?,?,?,datetime('now'))
  ON CONFLICT(location_id,type,guid) DO UPDATE SET name=excluded.name, synced_at=datetime('now')`);

// Pull Toast config reference data so order GUIDs (table, dining option, …) can be
// shown as names. Read-only; replaces each type's snapshot per location.
async function syncConfig(locationId) {
  const map = mapping(locationId);
  if (!map) throw new Error('That location is not mapped to a Toast restaurant.');
  const guid = map.toast_guid;
  const log = db.prepare(`INSERT INTO toast_sync_log (domain,location_id,toast_guid,status) VALUES ('config',?,?, 'running')`).run(locationId, guid);
  const logId = log.lastInsertRowid;
  try {
    const sets = [['table', '/config/v2/tables'], ['dining_option', '/config/v2/diningOptions'], ['service_area', '/config/v2/serviceAreas'], ['revenue_center', '/config/v2/revenueCenters']];
    let total = 0;
    db.exec('BEGIN');
    try {
      for (const [type, path] of sets) {
        const rows = await toast.toastGetAll(path, { guid, pageSize: 100 });
        db.prepare(`DELETE FROM toast_config WHERE location_id=? AND type=?`).run(locationId, type);
        for (const r of rows) { insConfig.run(locationId, type, r.guid, r.name || null); total++; }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    db.prepare(`UPDATE toast_sync_log SET status='ok', record_count=?, detail=?, finished_at=datetime('now') WHERE id=?`).run(total, `${total} config records`, logId);
    return { records: total };
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

// Toast pull window: the API is only called between these Pacific hours (default
// 10:00–22:00). Every automatic sweep and the history backfill honor it, so no data
// is pulled before 10am or after 10pm Pacific. Overridable via env if hours change.
const PULL_START_MIN = (parseInt(process.env.TOAST_PULL_START_HOUR, 10) || 10) * 60;   // 10:00
const PULL_END_MIN = (parseInt(process.env.TOAST_PULL_END_HOUR, 10) || 22) * 60;       // 22:00 (10pm)
function withinPullWindow() {
  const nowMin = toMin(localTime(PACIFIC));            // minutes since Pacific midnight
  return nowMin != null && nowMin >= PULL_START_MIN && nowMin < PULL_END_MIN;
}

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
  if (!withinPullWindow()) return;                     // no pulls before 10am / after 10pm PT
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
        try { await syncConfig(m.location_id); } catch (e) { console.error(`[toast-sweep] config loc ${m.location_id}:`, e.message); }
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

// ── Historical backfill ───────────────────────────────────────────────────────
// Pull N days of history (default ~6 months) for every mapped location into the
// mirror, oldest missing day first, gently throttled to respect Toast rate limits.
// Idempotent + resumable: each location's backfilled_from records how far back it
// goes, so re-running continues where it left off. Runs in the background.
const _backfill = { running: false, startedAt: null, finishedAt: null, days: 0, total: 0, done: 0, errors: 0, currentLoc: null, currentName: null, currentDate: null, cancel: false, paused: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backfillStatus() { return { ..._backfill }; }
function cancelBackfill() { if (_backfill.running) _backfill.cancel = true; }

async function runBackfill({ days = 190, throttleMs = 300 } = {}) {
  if (_backfill.running) return { started: false, reason: 'already_running', status: backfillStatus() };
  if (!toast.toastEnabled()) return { started: false, reason: 'not_configured' };
  days = Math.max(1, Math.min(800, parseInt(days, 10) || 190));
  const yesterday = addDaysIso(pacificToday(), -1);
  const target = addDaysIso(pacificToday(), -days);
  const maps = db.prepare(`SELECT tl.location_id, l.name FROM toast_locations tl JOIN locations l ON l.id=tl.location_id WHERE tl.active=1 ORDER BY tl.location_id`).all();
  // Build the task list: for each location, the dates it still needs (from its current
  // earliest edge back to target). New locations start at yesterday.
  const tasks = [];
  for (const m of maps) {
    const bf = (db.prepare(`SELECT backfilled_from FROM toast_locations WHERE location_id=?`).get(m.location_id) || {}).backfilled_from;
    let from = bf ? addDaysIso(bf, -1) : yesterday;        // resume just below the covered edge
    for (let d = from; d >= target; d = addDaysIso(d, -1)) tasks.push({ loc: m.location_id, name: m.name, date: d });
  }
  Object.assign(_backfill, { running: true, startedAt: new Date().toISOString(), finishedAt: null, days, total: tasks.length, done: 0, errors: 0, cancel: false, paused: false, currentLoc: null, currentName: null, currentDate: null });
  const logId = db.prepare(`INSERT INTO toast_sync_log (domain, window_start, window_end, status) VALUES ('backfill', ?, ?, 'running')`).run(target, yesterday).lastInsertRowid;
  (async () => {
    for (const t of tasks) {
      if (_backfill.cancel) break;
      // Pause overnight: only pull between 10am–10pm Pacific, resuming when back in window.
      while (!withinPullWindow() && !_backfill.cancel) {
        if (!_backfill.paused) { _backfill.paused = true; console.log('[toast-backfill] outside 10am–10pm PT pull window — pausing.'); }
        await sleep(60000);
      }
      if (_backfill.cancel) break;
      if (_backfill.paused) { _backfill.paused = false; console.log('[toast-backfill] back in pull window — resuming.'); }
      _backfill.currentLoc = t.loc; _backfill.currentName = t.name; _backfill.currentDate = t.date;
      try {
        await syncOrders(t.loc, t.date);
        db.prepare(`UPDATE toast_locations SET backfilled_from=? WHERE location_id=? AND (backfilled_from IS NULL OR backfilled_from > ?)`).run(t.date, t.loc, t.date);
      } catch (e) { _backfill.errors++; console.error(`[toast-backfill] loc ${t.loc} ${t.date}:`, e.message); }
      _backfill.done++;
      if (_backfill.done % 10 === 0) db.prepare(`UPDATE toast_sync_log SET record_count=?, detail=? WHERE id=?`).run(_backfill.done, `${_backfill.done}/${_backfill.total} days · ${_backfill.errors} errors`, logId);
      await sleep(throttleMs);
    }
    _backfill.running = false; _backfill.finishedAt = new Date().toISOString();
    db.prepare(`UPDATE toast_sync_log SET status=?, record_count=?, detail=?, finished_at=datetime('now') WHERE id=?`)
      .run(_backfill.cancel ? 'error' : 'ok', _backfill.done, `${_backfill.done}/${_backfill.total} days pulled · ${_backfill.errors} errors${_backfill.cancel ? ' · cancelled' : ''}`, logId);
  })().catch((e) => { _backfill.running = false; console.error('[toast-backfill]', e.message); });
  return { started: true, total: tasks.length, days, target, status: backfillStatus() };
}

// Resume the history backfill on server boot if any location isn't covered back to
// the target yet — so a machine restart (deploy, idle) never leaves it half-done.
function startToastBackfillResume() {
  if (!toast.toastEnabled()) return;
  const days = Math.max(1, Math.min(800, parseInt(process.env.TOAST_BACKFILL_DAYS, 10) || 190));
  const target = addDaysIso(pacificToday(), -days);
  let need = 0;
  try { need = db.prepare(`SELECT COUNT(*) c FROM toast_locations WHERE active=1 AND (backfilled_from IS NULL OR backfilled_from > ?)`).get(target).c; } catch { return; }
  if (!need) { console.log('[toast-backfill] history complete — nothing to resume.'); return; }
  console.log(`[toast-backfill] ${need} location(s) not yet back to ${target}; resuming in 60s.`);
  setTimeout(() => { runBackfill({ days }).then((r) => console.log('[toast-backfill] auto-resume started:', r.total, 'day-pulls')).catch((e) => console.error('[toast-backfill] resume:', e.message)); }, 60000);
}

// ── Service flow: derive live table state from open Toast orders ──────────────
const minsSince = (iso) => { if (!iso) return null; const t = Date.parse(String(iso).slice(0, 19) + 'Z'); return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 60000)) : null; };

// Live Service Flow board for a location. One row per dine-in order today (has a real
// table, not an employee tab), not voided, not yet bussed. Excludes to-go / delivery /
// online (no table). Each table carries the manual Served/Bussed state and Toast's Paid
// state, and the escalation the user defined:
//   • not served & open > flow_served_min  → 'awaiting_food'  (alert: food_late)
//   • served, not paid & open > flow_pay_min → 'in_service'   (alert: lingering)
//   • paid & not bussed                     → 'ready_to_bus'  (alert: ready_to_bus)
//   • bussed                                → cleared from the board
// Only genuinely-current tables belong on the board. A dine-in order open longer than
// ACTIVE_MIN with no payment is stale (abandoned/comped/left open), and a table paid
// more than BUS_GRACE_MIN ago is assumed already bussed — both drop off so the board
// (and the alerts) reflect the live floor, not the whole day's backlog.
const FLOW_ACTIVE_MIN = Math.max(30, parseInt(process.env.TOAST_FLOW_ACTIVE_MIN, 10) || 120);
const FLOW_BUS_GRACE_MIN = Math.max(2, parseInt(process.env.TOAST_FLOW_BUS_GRACE_MIN, 10) || 20);
function computeServiceFlow(locationId) {
  const loc = db.prepare(`SELECT flow_served_min, flow_pay_min, flow_food_renudge_min, flow_pay_renudge_min FROM toast_locations WHERE location_id=?`).get(locationId) || {};
  const servedMin = loc.flow_served_min || 10, payMin = loc.flow_pay_min || 15;   // pay window counts from SERVED
  const foodRenudge = loc.flow_food_renudge_min || 5, payRenudge = loc.flow_pay_renudge_min || 7;
  const today = pacificToday();
  const rows = db.prepare(`SELECT o.guid, o.opened_at, o.paid_at, o.num_guests, tbl.name AS table_name,
      COALESCE(NULLIF(TRIM(COALESCE(u.name,'')),''), NULLIF(TRIM(COALESCE(e.chosen_name,e.first_name)||' '||COALESCE(e.last_name,'')),'')) AS server_name,
      e.user_id AS server_user_id, fs.served_at, fs.bussed_at, fs.paid_at AS m_paid_at, fs.bus_claimed_at
    FROM toast_orders o
    JOIN toast_config tbl ON tbl.location_id=o.location_id AND tbl.type='table' AND tbl.guid=o.table_guid
    LEFT JOIN toast_employees e ON e.guid=o.server_guid
    LEFT JOIN users u ON u.id=e.user_id
    LEFT JOIN toast_flow_state fs ON fs.order_guid=o.guid
    WHERE o.location_id=? AND o.business_date=? AND o.voided=0
      AND o.table_guid IS NOT NULL AND lower(tbl.name) NOT LIKE '%employee%'
      AND fs.bussed_at IS NULL`).all(locationId, today);
  const tables = rows.map(r => {
    // Paid can come from Toast (o.paid_at) OR a staff "Paid" tap on the pay alert (fs.paid_at).
    const paidAt = r.paid_at || r.m_paid_at;
    const t = minsSince(r.opened_at), p = minsSince(paidAt), sMin = minsSince(r.served_at);
    const served = !!r.served_at, paid = !!paidAt;
    let state = null, alert = null, drop = false;
    if (paid) {
      if (p != null && p <= FLOW_BUS_GRACE_MIN) { state = 'ready_to_bus'; alert = 'ready_to_bus'; }
      else drop = true;                                   // paid a while ago → assume bussed
    } else if (t != null && t > FLOW_ACTIVE_MIN) {
      drop = true;                                        // open too long, never paid → stale
    } else if (!served) { state = 'awaiting_food'; if (t != null && t > servedMin && t <= servedMin + 20) alert = 'food_late'; }
    // Served, not paid: start the pay clock from served_at — alert past payMin (15 min).
    else { state = 'in_service'; if (sMin != null && sMin > payMin) alert = 'lingering'; }
    return { order_guid: r.guid, table_name: r.table_name, server_name: r.server_name, server_user_id: r.server_user_id || null,
      guests: r.num_guests, opened_at: r.opened_at, minutes_open: t, served, served_at: r.served_at, minutes_served: sMin,
      paid, paid_at: paidAt, minutes_paid: p, state, alert, drop,
      bus_claimed_at: r.bus_claimed_at || null, minutes_claimed: minsSince(r.bus_claimed_at) };
  }).filter(x => !x.drop).sort((a, b) => (b.minutes_open || 0) - (a.minutes_open || 0));
  const counts = { total: tables.length, seated: 0, awaiting_food: 0, in_service: 0, ready_to_bus: 0, alerting: 0 };
  tables.forEach(t => { counts[t.state]++; if (t.alert) counts.alerting++; });
  // "Seated" — host-seated parties who haven't opened a Toast order yet. Sourced from the
  // service-visit spine (stage='seated', a real floor table); each one clears the moment a
  // Toast order opens for that same table number, at which point it flows on as awaiting_food.
  // Kept as its OWN array (not in `tables`) so the alert sweep and Toast board are untouched.
  let seated = [];
  try {
    const norm = (s) => String(s || '').trim().toLowerCase();
    const svs = db.prepare(`SELECT v.id, v.seated_at, v.guest_name, v.party_size, v.source, t.label
      FROM service_visits v JOIN restaurant_tables t ON t.id=v.table_id
      WHERE v.location_id=? AND v.stage='seated' AND v.table_id IS NOT NULL`).all(locationId);
    if (svs.length) {
      // Every Toast order today keyed by table name → the times it was opened. A seated party
      // is "picked up" once any order on its table opened at/after it was seated (turnover-safe:
      // an earlier party's order on the same table won't clear a later seating).
      const ord = db.prepare(`SELECT tbl.name, o.opened_at FROM toast_orders o
        JOIN toast_config tbl ON tbl.location_id=o.location_id AND tbl.type='table' AND tbl.guid=o.table_guid
        WHERE o.location_id=? AND o.business_date=? AND o.voided=0 AND o.table_guid IS NOT NULL`).all(locationId, today);
      const opens = {};
      ord.forEach(r => { const k = norm(r.name); const ms = Date.parse(r.opened_at); if (Number.isFinite(ms)) (opens[k] = opens[k] || []).push(ms); });
      seated = svs.filter(v => {
        const seatedMs = Date.parse(v.seated_at);
        const os = opens[norm(v.label)] || [];
        // 2-min grace absorbs clock skew between the app server and Toast.
        return !os.some(ms => Number.isFinite(seatedMs) && ms >= seatedMs - 120000);
      }).map(v => ({ order_guid: 'seated:' + v.id, visit_id: v.id, table_name: v.label, server_name: v.guest_name || null,
        guests: v.party_size, seated_at: v.seated_at, minutes_open: minsSince(v.seated_at), minutes_seated: minsSince(v.seated_at),
        state: 'seated', served: false, paid: false, alert: null, drop: false, is_seated: true, source: v.source }))
        .sort((a, b) => (b.minutes_open || 0) - (a.minutes_open || 0));
    }
  } catch (e) { console.error('[serviceflow] seated:', e.message); seated = []; }
  counts.seated = seated.length;
  return { served_min: servedMin, pay_min: payMin, food_renudge_min: foodRenudge, pay_renudge_min: payRenudge, unclaimed_min: FLOW_UNCLAIMED_MIN, tables, seated, counts, updated_at: new Date().toISOString() };
}

// Two re-fire cadences, both driven by the marker's next_at:
//   • an UNCLAIMED alert re-pops every ~3 min so it's never missed (any kind);
//   • a claimed alert set to "Waiting"/"Not yet" snoozes for its kind's window
//     (food ~5 min, pay ~7 min) before coming back to the pool.
const FLOW_UNCLAIMED_MIN = Math.max(1, parseInt(process.env.TOAST_FLOW_UNCLAIMED_MIN, 10) || 3);
const FLOW_RENUDGE_MIN = { food_late: Math.max(2, parseInt(process.env.TOAST_FLOW_FOOD_RENUDGE_MIN, 10) || 5),
  lingering: Math.max(2, parseInt(process.env.TOAST_FLOW_PAY_RENUDGE_MIN, 10) || 7) };
const _flowRow = db.prepare(`SELECT next_at, mode FROM toast_flow_alerts WHERE order_guid=? AND alert_type=?`);
const _flowInsert = db.prepare(`INSERT OR IGNORE INTO toast_flow_alerts (order_guid, alert_type, location_id) VALUES (?,?,?)`);
const _flowSetNextMode = db.prepare(`UPDATE toast_flow_alerts SET next_at=?, mode=? WHERE order_guid=? AND alert_type=?`);
const _flowSetNext = db.prepare(`UPDATE toast_flow_alerts SET next_at=? WHERE order_guid=? AND alert_type=?`);
const _renudgeAt = (mins) => new Date(Date.now() + mins * 60000).toISOString();
// The re-alert cadence (minutes) for a kind after "Waiting"/"Not yet", per store.
function renudgeMinFor(guid, kind) {
  const loc = (db.prepare(`SELECT location_id FROM toast_orders WHERE guid=?`).get(guid) || {}).location_id || null;
  const col = kind === 'lingering' ? 'flow_pay_renudge_min' : 'flow_food_renudge_min';
  const cfg = loc && db.prepare(`SELECT ${col} AS m FROM toast_locations WHERE location_id=?`).get(loc);
  return Math.max(2, (cfg && cfg.m) || FLOW_RENUDGE_MIN[kind] || 5);
}
// Decide whether to (re)fire an escalation for a table this sweep, and schedule the next
// ping. Returns true when a fresh ping is due:
//   • no marker yet                → first fire, mode 'unclaimed', ~3-min re-pop
//   • due & mode 'unclaimed'        → re-pop (nobody's claimed it), ~3-min cadence
//   • due & mode 'waiting'          → re-alert (a staffer said Not yet/Waiting), ON the
//                                     kind's ~5/7-min cadence, kept until the table advances
//   • next_at NULL                  → skip (claimed / being handled — no auto re-fire)
//   • next_at in the future         → skip (outstanding, or snoozed)
function flowAlertDue(guid, type, locId) {
  const row = _flowRow.get(guid, type);
  if (!row) { _flowInsert.run(guid, type, locId); _flowSetNextMode.run(_renudgeAt(FLOW_UNCLAIMED_MIN), 'unclaimed', guid, type); return true; }
  if (row.next_at && row.next_at <= new Date().toISOString()) {
    const mins = row.mode === 'waiting' ? renudgeMinFor(guid, type) : FLOW_UNCLAIMED_MIN;
    _flowSetNextMode.run(_renudgeAt(mins), row.mode || 'unclaimed', guid, type);   // keep the same mode/cadence
    return true;
  }
  return false;
}
// "Waiting" (food) / "Not yet" (pay): re-alert on the kind's window (per-store), recurring
// at that cadence until the table advances. Returns the minutes so the caller can say so.
function markFlowWaiting(guid, kind) {
  const loc = (db.prepare(`SELECT location_id FROM toast_orders WHERE guid=?`).get(guid) || {}).location_id || null;
  const mins = renudgeMinFor(guid, kind);
  _flowInsert.run(guid, kind, loc);
  _flowSetNextMode.run(_renudgeAt(mins), 'waiting', guid, kind);
  return mins;
}
// Claimed ("On It") or resolved: stop the auto re-fire (someone's handling / it's done).
function clearFlowRenudge(guid, kind) { try { _flowInsert.run(guid, kind, (db.prepare(`SELECT location_id FROM toast_orders WHERE guid=?`).get(guid) || {}).location_id || null); _flowSetNext.run(null, guid, kind); } catch { /* best-effort */ } }
const FLOW_MSG = {
  food_late: (t) => `🍽 Table ${t.table_name}: ordered ${t.minutes_open} min ago and not served yet — run the food.`,
  lingering: (t) => `🧾 Table ${t.table_name}: served ${t.minutes_served != null ? t.minutes_served + ' min ago' : 'a while ago'}, not paid — check on the guest / bring the check.`,
  ready_to_bus: (t) => `🧽 Table ${t.table_name}: paid — ready to bus & reset.`,
};
// Send an in-app floor alert (no SMS) to one staff member, from the "Service Flow"
// system sender. Best-effort live push; never throws into the sweep.
let _flowDeps = null;
function flowDeps() {
  if (!_flowDeps) { _flowDeps = {}; try { _flowDeps.emitAlert = require('./events').emitAlert; } catch { /* optional */ } try { _flowDeps.pushToUsers = require('./push').pushToUsers; } catch { /* optional */ } }
  return _flowDeps;
}
function sendFlowAlert(locationId, userId, body, flow) {
  const guid = flow && flow.guid || null, kind = flow && flow.kind || null;
  // A fresh nudge supersedes any earlier open alert for the same table+escalation, so
  // a re-nudged food alert doesn't stack duplicates in the inbox.
  if (guid && kind) { try { db.prepare(`UPDATE floor_alerts SET active=0 WHERE flow_guid=? AND flow_kind=? AND active=1`).run(guid, kind); } catch { /* best-effort */ } }
  const r = db.prepare(`INSERT INTO floor_alerts (location_id, sender_id, target_type, target_user_id, target_role, body, priority, flow_guid, flow_kind, status)
    VALUES (?, 1, 'user', ?, NULL, ?, 'urgent', ?, ?, 'open')`).run(locationId, userId, body, guid, kind);   // sender 1 = owner (system)
  const { emitAlert, pushToUsers } = flowDeps();
  const alert = { id: r.lastInsertRowid, location_id: locationId, target_type: 'user', target_user_id: userId, target_role: null, body, priority: 'urgent', flow_guid: guid, flow_kind: kind, status: 'open', sender_name: 'Service Flow', created_at: new Date().toISOString() };
  try { if (emitAlert) emitAlert(alert); } catch { /* best-effort */ }
  try { if (pushToUsers) pushToUsers([userId], { title: '⏱ Service Flow', body, tag: 'flow-' + r.lastInsertRowid, url: '/?n=alert' }); } catch { /* best-effort */ }
  return r.lastInsertRowid;
}

// Fire one escalation for a table immediately, outside the 3-min sweep — used when a
// staffer marks a table Paid, so the busser is alerted "right away" instead of on the
// next pass. No-op (marker only) if the store is dry-run or already has this alert out.
function raiseFlowAlert(guid, kind) {
  const o = db.prepare(`SELECT location_id, table_guid FROM toast_orders WHERE guid=?`).get(guid);
  if (!o) return false;
  const cfg = db.prepare(`SELECT service_flow_on, service_alerts_live, flow_alert_user_id FROM toast_locations WHERE location_id=? AND active=1`).get(o.location_id);
  if (!cfg || !cfg.service_flow_on) return false;
  // Don't double up if one is already outstanding, but always (re)arm the re-pop marker.
  const already = db.prepare(`SELECT 1 FROM floor_alerts WHERE flow_guid=? AND flow_kind=? AND active=1`).get(guid, kind);
  _flowInsert.run(guid, kind, o.location_id);
  _flowSetNext.run(_renudgeAt(FLOW_UNCLAIMED_MIN), guid, kind);
  if (already) return false;
  if (!(cfg.service_alerts_live && cfg.flow_alert_user_id)) {   // dry-run store → marker only
    console.log(`[toast-serviceflow] DRY-RUN loc ${o.location_id} ${kind} (immediate) guid ${guid}`);
    return false;
  }
  const tbl = o.table_guid && db.prepare(`SELECT name FROM toast_config WHERE location_id=? AND type='table' AND guid=?`).get(o.location_id, o.table_guid);
  const t = { table_name: tbl ? tbl.name : '?' };
  try { sendFlowAlert(o.location_id, cfg.flow_alert_user_id, FLOW_MSG[kind](t), { guid, kind }); } catch (e) { console.error('[toast-serviceflow] immediate alert:', e.message); return false; }
  console.log(`[toast-serviceflow] LIVE loc ${o.location_id} ${kind} (immediate) table ${t.table_name} → user ${cfg.flow_alert_user_id}`);
  return true;
}

// One live pass: refresh today's orders for each open, service-flow-enabled location,
// then raise each table's escalation once. When a location has flow_alert_user_id set
// AND service_alerts_live=1, alerts are delivered as in-app floor alerts to that person;
// otherwise the pass is dry-run (logged only, no one pinged).
async function runServiceFlowSweep({ graceMin = 30 } = {}) {
  if (!toast.toastEnabled()) return;
  if (!withinPullWindow()) return;                     // no pulls before 10am / after 10pm PT
  const maps = db.prepare(`SELECT location_id, service_alerts_live, flow_alert_user_id FROM toast_locations WHERE active=1 AND service_flow_on=1`).all();
  const today = pacificToday(), nowMin = toMin(localTime(PACIFIC)), weekday = weekdayMon0(today);
  for (const m of maps) {
    if (!openWindow(m.location_id, weekday, nowMin, graceMin)) continue;   // only while open
    try { await syncOrders(m.location_id, today); } catch (e) { console.error(`[toast-serviceflow] sync loc ${m.location_id}:`, e.message); continue; }
    const flow = computeServiceFlow(m.location_id);
    const live = !!(m.service_alerts_live && m.flow_alert_user_id);
    let sent = 0;
    for (const t of flow.tables) {
      if (!t.alert) continue;
      if (!flowAlertDue(t.order_guid, t.alert, m.location_id)) continue;   // not due (outstanding / waiting-not-yet)
      if (live && sent < 15) {                            // cap per sweep — a safety valve
        try { sendFlowAlert(m.location_id, m.flow_alert_user_id, FLOW_MSG[t.alert](t), { guid: t.order_guid, kind: t.alert }); sent++; } catch (e) { console.error('[toast-serviceflow] alert:', e.message); }
        console.log(`[toast-serviceflow] LIVE loc ${m.location_id} ${t.alert} table ${t.table_name || '?'} ${t.minutes_open}m → user ${m.flow_alert_user_id}`);
      } else {
        console.log(`[toast-serviceflow] DRY-RUN loc ${m.location_id} ${t.alert} table ${t.table_name || '?'} ${t.minutes_open}m`);
      }
    }
  }
}

let _liveTimer = null;
function startToastLiveSweep() {
  if (_liveTimer || !toast.toastEnabled()) { if (!toast.toastEnabled()) console.log('[toast-serviceflow] Toast not configured.'); return; }
  const min = Math.max(2, parseInt(process.env.TOAST_LIVE_INTERVAL_MIN, 10) || 3);
  const run = () => runServiceFlowSweep().catch((e) => console.error('[toast-serviceflow]', e.message));
  setTimeout(run, 90000);                       // after backfill-resume, staggered
  _liveTimer = setInterval(run, min * 60000);
  console.log(`[toast-serviceflow] live service-flow sweep every ${min} min (dry-run alerts).`);
}

// One-time chunked backfill of pay_minutes for orders synced before the column
// existed. Runs in the background after boot so a 247k-row date-parse UPDATE never
// blocks startup or the deploy health check. Idempotent + self-terminating: each
// pass fills a batch of still-NULL rows, and it stops once none remain.
let _payBackfillDone = false;
function startPayMinutesBackfill() {
  if (_payBackfillDone) return;
  const batch = Math.max(500, parseInt(process.env.TOAST_PAY_BACKFILL_BATCH, 10) || 20000);
  const step = () => {
    try {
      const pending = db.prepare(`SELECT COUNT(*) n FROM toast_orders WHERE pay_minutes IS NULL AND opened_at IS NOT NULL AND paid_at IS NOT NULL`).get().n;
      if (!pending) { _payBackfillDone = true; console.log('[toast-paymin] backfill complete.'); return; }
      const r = db.prepare(`UPDATE toast_orders SET pay_minutes = ROUND((julianday(substr(paid_at,1,19)) - julianday(substr(opened_at,1,19)))*24*60, 1)
        WHERE rowid IN (SELECT rowid FROM toast_orders WHERE pay_minutes IS NULL AND opened_at IS NOT NULL AND paid_at IS NOT NULL LIMIT ${batch})`).run();
      console.log(`[toast-paymin] filled ${r.changes} rows, ${pending - r.changes} remaining.`);
      if (r.changes > 0) return setTimeout(step, 1500);   // yield between batches
      _payBackfillDone = true;                              // nothing changed → done/stuck
    } catch (e) { console.error('[toast-paymin]', e.message); }
  };
  setTimeout(step, 120000);   // start ~2 min after boot, once other sweeps have settled
  console.log('[toast-paymin] pay_minutes backfill scheduled.');
}

module.exports = { syncOrders, salesSummary, salesByDiningOption, salesByPaymentType, salesPaymentByDining, syncLabor, syncMenus, syncConfig, sweepOnce, startToastSweep, pacificToday, runBackfill, backfillStatus, cancelBackfill, startToastBackfillResume, computeServiceFlow, runServiceFlowSweep, startToastLiveSweep, startPayMinutesBackfill, markFlowWaiting, clearFlowRenudge, raiseFlowAlert };
