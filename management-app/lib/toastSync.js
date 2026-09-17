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

module.exports = { syncOrders, salesSummary };
