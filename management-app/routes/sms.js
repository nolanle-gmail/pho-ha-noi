// Compose & blast SMS — a manager/owner/admin texts a staff member, a whole
// role at a store, or everyone. Delivery is via lib/sms.js (log-only until an
// SMS provider is configured); every blast is archived for audit. Managers are
// scoped to their own store; owner/admin/GM/regional may address any store or,
// with no location, the whole group.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const { sendSms, smsEnabled, SMS_PROVIDER } = require('../lib/sms');

const router = express.Router();
router.use(verifyToken);

const CAN_SEND = ['owner', 'admin', 'hr', 'general_manager', 'regional_manager', 'manager', 'assistant_manager', 'kitchen_manager'];
const canSend = (role) => CAN_SEND.includes(role);
const ownsLoc = (req, locId) => seesAllLocations(req.user.role) || String(req.user.location_id) === String(locId);

// Whether SMS is actually wired, so the UI can warn "log-only" mode.
router.get('/status', (req, res) => {
  res.json({ enabled: smsEnabled(), provider: SMS_PROVIDER, can_send: canSend(req.user.role) });
});

// Recipients a sender can target at a store: active staff (with a flag for who
// has a phone on file) plus the roles present.
router.get('/staff', (req, res) => {
  if (!canSend(req.user.role)) return res.status(403).json({ error: 'Not allowed to send texts.' });
  const locId = parseInt(req.query.location_id, 10) || req.user.location_id;
  if (!locId && !seesAllLocations(req.user.role)) return res.status(400).json({ error: 'A location is required.' });
  if (locId && !ownsLoc(req, locId)) return res.status(403).json({ error: 'Not your location.' });
  const rows = locId
    ? db.prepare(`SELECT id, name, role, phone FROM users WHERE location_id=? AND is_active=1 ORDER BY name`).all(locId)
    : db.prepare(`SELECT id, name, role, phone FROM users WHERE is_active=1 ORDER BY name`).all();
  const staff = rows.map(r => ({ id: r.id, name: r.name, role: r.role, has_phone: !!r.phone }));
  const roles = [...new Set(staff.map(s => s.role))].sort();
  res.json({ location_id: locId || null, staff, roles, with_phone: staff.filter(s => s.has_phone).length });
});

// Resolve the set of recipients {id, name, phone} for a blast.
function resolveRecipients(req, body) {
  const type = body.target_type;
  const locId = parseInt(body.location_id, 10) || (seesAllLocations(req.user.role) ? null : req.user.location_id);
  if (type === 'user') {
    const u = db.prepare(`SELECT id, name, phone, location_id FROM users WHERE id=? AND is_active=1`).get(parseInt(body.target_user_id, 10));
    if (!u) return { error: 'Pick a staff member to text.' };
    if (!ownsLoc(req, u.location_id)) return { error: 'Not your location.' };
    return { locId: u.location_id, list: [u] };
  }
  // role / all need a location unless the caller sees all locations
  if (!locId && !seesAllLocations(req.user.role)) return { error: 'A location is required.' };
  if (locId && !ownsLoc(req, locId)) return { error: 'Not your location.' };
  const where = ['is_active=1'], args = [];
  if (locId) { where.push('location_id=?'); args.push(locId); }
  if (type === 'role') {
    const role = String(body.target_role || '').trim();
    if (!role) return { error: 'Pick a role to text.' };
    where.push('role=?'); args.push(role);
  } else if (type !== 'all') {
    return { error: 'Choose who to text.' };
  }
  const list = db.prepare(`SELECT id, name, phone, location_id FROM users WHERE ${where.join(' AND ')} ORDER BY name`).all(...args);
  return { locId, list };
}

// Send a blast.
router.post('/send', async (req, res) => {
  if (!canSend(req.user.role)) return res.status(403).json({ error: 'Not allowed to send texts.' });
  const body = (req.body.body || '').toString().trim().slice(0, 600);
  if (!body) return res.status(400).json({ error: 'A text message is required.' });
  const type = ['user', 'role', 'all'].includes(req.body.target_type) ? req.body.target_type : null;
  if (!type) return res.status(400).json({ error: 'Choose who to text.' });

  const r = resolveRecipients(req, req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  if (!r.list.length) return res.status(400).json({ error: 'No staff match that selection.' });

  const ins = db.prepare(`INSERT INTO sms_messages (sender_id, location_id, target_type, target_user_id, target_role, body, recipient_count, provider)
    VALUES (?,?,?,?,?,?,?,?)`).run(req.user.id, r.locId || null, type,
    type === 'user' ? r.list[0].id : null, type === 'role' ? String(req.body.target_role) : null,
    body, r.list.length, SMS_PROVIDER);
  const smsId = Number(ins.lastInsertRowid);

  const recStmt = db.prepare(`INSERT INTO sms_recipients (sms_id, user_id, name, phone, status, error) VALUES (?,?,?,?,?,?)`);
  const results = await Promise.all(r.list.map(async (u) => {
    if (!u.phone) { recStmt.run(smsId, u.id, u.name, null, 'no_phone', null); return { sent: false, no_phone: true }; }
    const out = await sendSms(u.phone, body);
    const status = out.sent ? 'sent' : (out.logged ? 'logged' : 'failed');
    recStmt.run(smsId, u.id, u.name, out.to || u.phone, status, out.error || null);
    return { sent: out.sent, logged: !!out.logged };
  }));
  const sentCount = results.filter(x => x.sent).length;
  db.prepare(`UPDATE sms_messages SET sent_count=? WHERE id=?`).run(sentCount, smsId);
  auditLog(req, 'sms_blast', 'sms', smsId, { target: type, recipients: r.list.length, sent: sentCount, provider: SMS_PROVIDER });

  res.json({
    success: true, id: smsId, recipients: r.list.length, sent: sentCount,
    no_phone: results.filter(x => x.no_phone).length,
    logged_only: !smsEnabled(),
  });
});

// Recent blasts (for audit) — the sender's own, or all for leadership.
router.get('/recent', (req, res) => {
  const all = seesAllLocations(req.user.role);
  const rows = all
    ? db.prepare(`SELECT m.*, u.name AS sender_name FROM sms_messages m LEFT JOIN users u ON u.id=m.sender_id ORDER BY m.id DESC LIMIT 50`).all()
    : db.prepare(`SELECT m.*, u.name AS sender_name FROM sms_messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.sender_id=? ORDER BY m.id DESC LIMIT 50`).all(req.user.id);
  res.json({ messages: rows });
});

module.exports = router;
