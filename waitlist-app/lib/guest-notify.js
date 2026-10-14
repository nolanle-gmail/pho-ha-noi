// Text a guest and record it in notify_log. Fire-and-forget: the attempt is
// logged immediately (so the queue / audit shows it right away) and the row is
// patched with the real send outcome when the provider responds. Never blocks
// the request and never throws.
const db = require('../db/database');
const { sendSms, smsEnabled, gsm7 } = require('./sms');

function notifyGuest(waitlistId, phone, body, kind) {
  // Keep the text in the cheap GSM-7 encoding (so a guest's accented name doesn't double the cost),
  // and log exactly what we send. The 'ready' page is a transactional follow-up, so it skips the
  // auto opt-out suffix (the guest already got it on the join text; STOP still works).
  const safe = gsm7(body);
  const noStop = kind === 'ready';
  const initial = phone ? (smsEnabled() ? 'pending' : 'logged') : 'none';
  const info = db.prepare(`INSERT INTO notify_log (waitlist_id, channel, recipient, body, status, kind) VALUES (?,?,?,?,?,?)`)
    .run(waitlistId, phone ? 'sms' : 'none', phone || null, safe, initial, kind || null);
  const logId = Number(info.lastInsertRowid);
  if (phone && smsEnabled()) {
    sendSms(phone, safe, { noStop }).then(r => {
      try { db.prepare(`UPDATE notify_log SET status=? WHERE id=?`).run(r.sent ? 'sent' : 'failed', logId); } catch { /* row gone */ }
    }).catch(() => { try { db.prepare(`UPDATE notify_log SET status='failed' WHERE id=?`).run(logId); } catch {} });
  }
  return { logId, status: initial, willSend: !!(phone && smsEnabled()) };
}

module.exports = { notifyGuest };
