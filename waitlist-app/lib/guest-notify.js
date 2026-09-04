// Text a guest and record it in notify_log. Fire-and-forget: the attempt is
// logged immediately (so the queue / audit shows it right away) and the row is
// patched with the real send outcome when the provider responds. Never blocks
// the request and never throws.
const db = require('../db/database');
const { sendSms, smsEnabled } = require('./sms');

function notifyGuest(waitlistId, phone, body, kind) {
  const initial = phone ? (smsEnabled() ? 'pending' : 'logged') : 'none';
  const info = db.prepare(`INSERT INTO notify_log (waitlist_id, channel, recipient, body, status, kind) VALUES (?,?,?,?,?,?)`)
    .run(waitlistId, phone ? 'sms' : 'none', phone || null, body, initial, kind || null);
  const logId = Number(info.lastInsertRowid);
  if (phone && smsEnabled()) {
    sendSms(phone, body).then(r => {
      try { db.prepare(`UPDATE notify_log SET status=? WHERE id=?`).run(r.sent ? 'sent' : 'failed', logId); } catch { /* row gone */ }
    }).catch(() => { try { db.prepare(`UPDATE notify_log SET status='failed' WHERE id=?`).run(logId); } catch {} });
  }
  return { logId, status: initial, willSend: !!(phone && smsEnabled()) };
}

module.exports = { notifyGuest };
