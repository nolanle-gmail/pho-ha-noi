// Management-facing read feed for the Front Desk waitlist. Service-key auth only
// (the Management app calls this server-to-server) — no guest/staff tokens. Read-only.
const express = require('express');
const db = require('../db/database');

const router = express.Router();
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';
router.use((req, res, next) => {
  const k = req.headers['x-service-key'] || req.query.key;
  if (k && k === KEY) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

const notifyCount = `(SELECT COUNT(*) FROM notify_log n WHERE n.waitlist_id=w.id)`;

// Active queue (parties still waiting) — all locations, or one via ?location_id.
router.get('/active', (req, res) => {
  const loc = parseInt(req.query.location_id, 10) || null;
  const rows = db.prepare(`SELECT w.id, w.location_id, l.name AS location_name, w.guest_name, w.party_size, w.phone,
      w.quoted_minutes, w.notes, w.source, w.sms_consent, w.notified_at, w.created_at, ${notifyCount} AS notify_count
    FROM waitlist w LEFT JOIN locations l ON l.id=w.location_id
    WHERE w.status='waiting' ${loc ? 'AND w.location_id=?' : ''} ORDER BY w.created_at`).all(...(loc ? [loc] : []));
  res.json({ parties: rows });
});

// History — every party that was ever on the waitlist (any status), with phone +
// notification counts. Optional location_id, from/to (YYYY-MM-DD), status filters.
router.get('/history', (req, res) => {
  const loc = parseInt(req.query.location_id, 10) || null;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
  const where = [], args = [];
  if (loc) { where.push('w.location_id=?'); args.push(loc); }
  if (from) { where.push('substr(w.created_at,1,10)>=?'); args.push(from); }
  if (to) { where.push('substr(w.created_at,1,10)<=?'); args.push(to); }
  if (['waiting', 'seated', 'left'].includes(req.query.status)) { where.push('w.status=?'); args.push(req.query.status); }
  const rows = db.prepare(`SELECT w.id, w.location_id, l.name AS location_name, w.guest_name, w.party_size, w.phone, w.status,
      w.source, w.sms_consent, w.created_at, w.seated_at, w.notified_at, ${notifyCount} AS notify_count,
      (SELECT MAX(created_at) FROM notify_log n WHERE n.waitlist_id=w.id) AS last_notified
    FROM waitlist w LEFT JOIN locations l ON l.id=w.location_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY w.created_at DESC LIMIT 5000`).all(...args);
  const contactable = rows.filter(r => r.phone && r.sms_consent).length;
  res.json({ guests: rows, total: rows.length, contactable });
});

// Every notification logged for one party (join confirmation + ready pages).
router.get('/notifications/:id', (req, res) => {
  const rows = db.prepare(`SELECT channel, recipient, body, status, kind, created_at FROM notify_log WHERE waitlist_id=? ORDER BY id`).all(req.params.id);
  res.json({ notifications: rows });
});

module.exports = router;
