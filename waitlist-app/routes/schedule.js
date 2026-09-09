// My Schedule (Staff app) — a thin proxy to the Management schedule service, which
// owns the shifts. We forward over the service key acting "as" the signed-in staff
// email, so Management returns that person's own schedule for the chosen period.
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);
const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

router.get('/', async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No staff identity for this account.' });
  const kind = String(req.query.kind || 'weekly');
  const anchor = String(req.query.anchor || '');
  const url = `${MGMT_URL}/api/schedule/mine?as=${encodeURIComponent(email)}&kind=${encodeURIComponent(kind)}&anchor=${encodeURIComponent(anchor)}`;
  try {
    const r = await fetch(url, { headers: { 'X-Service-Key': KEY } });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch { res.status(502).json({ error: 'Schedule is temporarily unavailable.' }); }
});

module.exports = router;
