// My Schedule (Staff app) — a thin proxy to the Management schedule service, which
// owns the shifts. We forward over the service key acting "as" the signed-in staff
// email, so Management returns that person's own schedule for the chosen period.
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);
const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

async function proxy(res, path) {
  try {
    const r = await fetch(`${MGMT_URL}${path}`, { headers: { 'X-Service-Key': KEY } });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch { res.status(502).json({ error: 'Schedule is temporarily unavailable.' }); }
}
const qp = (req) => `kind=${encodeURIComponent(String(req.query.kind || 'weekly'))}&anchor=${encodeURIComponent(String(req.query.anchor || ''))}`;

// My own schedule.
router.get('/', (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No staff identity for this account.' });
  proxy(res, `/api/schedule/mine?as=${encodeURIComponent(email)}&${qp(req)}`);
});
// The whole location's schedule (leads/managers only — Management enforces the cap).
router.get('/team', (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No staff identity for this account.' });
  proxy(res, `/api/schedule/location?as=${encodeURIComponent(email)}&${qp(req)}`);
});

module.exports = router;
