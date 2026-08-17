// Staff-app "My Hours" — a thin proxy to Management's self timesheet, acting as
// the signed-in staff member (service key + ?as=email), like the messages proxy.
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);

const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

router.get('/my-hours', async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No timesheet identity for this account.' });
  const kind = ['daily', 'weekly', 'monthly'].includes(req.query.kind) ? req.query.kind : 'weekly';
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.anchor || '') ? req.query.anchor : '';
  const url = `${MGMT_URL}/api/timeclock/my-hours?as=${encodeURIComponent(email)}&kind=${kind}${anchor ? `&anchor=${anchor}` : ''}`;
  try {
    const r = await fetch(url, { headers: { 'X-Service-Key': KEY } });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch {
    res.status(502).json({ error: 'Hours are temporarily unavailable.' });
  }
});

module.exports = router;
