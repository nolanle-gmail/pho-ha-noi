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
  const kind = ['daily', 'weekly', 'biweekly', 'monthly'].includes(req.query.kind) ? req.query.kind : 'weekly';
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.anchor || '') ? req.query.anchor : '';
  const url = `${MGMT_URL}/api/timeclock/my-hours?as=${encodeURIComponent(email)}&kind=${kind}${anchor ? `&anchor=${anchor}` : ''}`;
  try {
    const r = await fetch(url, { headers: { 'X-Service-Key': KEY } });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch {
    res.status(502).json({ error: 'Hours are temporarily unavailable.' });
  }
});

// End-of-day sign-off: confirm a day's hours, or report an issue (which messages the manager).
// Both forward to Management acting as the signed-in staff member.
for (const action of ['confirm', 'dispute']) {
  router.post(`/my-hours/${action}`, async (req, res) => {
    const email = (req.user.email || '').toLowerCase();
    if (!email) return res.status(400).json({ error: 'No timesheet identity for this account.' });
    const url = `${MGMT_URL}/api/timeclock/my-hours/${action}?as=${encodeURIComponent(email)}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
        body: JSON.stringify({ date: req.body && req.body.date, note: req.body && req.body.note }),
      });
      res.status(r.status).json(await r.json().catch(() => ({})));
    } catch {
      res.status(502).json({ error: 'Hours are temporarily unavailable.' });
    }
  });
}

module.exports = router;
