// Web Push endpoints — expose the VAPID public key, and register / drop a device's
// push subscription. Auth mirrors the messaging stream: a Management JWT (a manager
// on the console PWA) or the Waitlist service key acting "as" a staff member by
// email / user_id (the Staff PWA proxies here). The public key needs no auth.
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const { SECRET } = require('../lib/auth');
const push = require('../lib/push');

const router = express.Router();
const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

// Resolve the acting user id from a service key (+ ?as=email or user_id) or a JWT.
function actingUserId(req) {
  const key = req.headers['x-service-key'] || req.query.key;
  if (key && key === SERVICE_KEY) {
    const email = String(req.query.as || (req.body && req.body.as) || '').toLowerCase().trim();
    if (email) {
      const u = db.prepare(`SELECT id FROM users WHERE lower(email)=? AND is_active=1`).get(email);
      if (u) return u.id;
    }
    const uid = req.query.user_id || (req.body && req.body.user_id);
    return uid ? parseInt(uid, 10) : null;
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || '');
  try { return jwt.verify(token, SECRET).id; } catch { return null; }
}

// The browser needs this to subscribe (applicationServerKey). Public by design.
router.get('/key', (req, res) => res.json({ key: push.publicKey(), enabled: push.enabled() }));

router.post('/subscribe', (req, res) => {
  const uid = actingUserId(req);
  if (!uid) return res.status(401).json({ error: 'Authentication required.' });
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ error: 'Invalid subscription.' });
  const ok = push.saveSubscription(uid, sub, req.headers['user-agent']);
  if (!ok) return res.status(400).json({ error: 'Invalid subscription.' });
  res.json({ success: true, enabled: push.enabled() });
});

router.post('/unsubscribe', (req, res) => {
  const ep = req.body && req.body.endpoint;
  push.removeSubscription(ep);
  res.json({ success: true });
});

module.exports = router;
