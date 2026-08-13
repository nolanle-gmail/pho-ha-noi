// Front-of-house activity feed. Read by the Management app (via the shared service
// key) to merge into a location's Activity tab, and by the Staff app's own
// owner-only Activity Log view (today's slice). Scoped by location + time range.
const express = require('express');
const db = require('../db/database');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
const SERVICE_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

// The Management proxy carries the service key; a direct viewer must be an owner.
function auth(req, res, next) {
  const key = req.headers['x-service-key'];
  if (key && key === SERVICE_KEY) { req.service = true; return next(); }
  return verifyToken(req, res, () => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only.' });
    next();
  });
}
router.use(auth);

// Rolling windows: day = last 24h, week = 7d, month = 30d, all = everything.
const sinceFor = (range) => { const days = { day: 1, week: 7, month: 30 }[range]; return days ? new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19) : null; };

router.get('/', (req, res) => {
  const locId = req.query.location_id ? parseInt(req.query.location_id, 10) : null;
  const since = sinceFor(req.query.range);
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 500);
  const conds = [], args = [];
  if (locId) { conds.push('location_id=?'); args.push(locId); }
  if (since) { conds.push('created_at >= ?'); args.push(since); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = db.prepare(`SELECT id, user_id, user_name, user_role, method, path, status, ip, detail, location_id, created_at
    FROM activity_log ${where} ORDER BY id DESC LIMIT ${limit}`).all(...args);
  res.json(rows.map(r => { let d = null; try { d = r.detail ? JSON.parse(r.detail) : null; } catch { d = null; } return { ...r, detail: d, source: 'frontdesk' }; }));
});

module.exports = router;
