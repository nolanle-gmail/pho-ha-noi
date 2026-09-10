// My Schedule (Staff app) — a thin proxy to the Management schedule service, which
// owns the shifts. We forward over the service key acting "as" the signed-in staff
// email, so Management returns that person's own schedule for the chosen period.
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);
const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

async function proxy(res, path, opts = {}) {
  try {
    const r = await fetch(`${MGMT_URL}${path}`, {
      method: opts.method || 'GET',
      headers: { 'X-Service-Key': KEY, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body,
    });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch { res.status(502).json({ error: 'Schedule is temporarily unavailable.' }); }
}
const qp = (req) => `kind=${encodeURIComponent(String(req.query.kind || 'weekly'))}&anchor=${encodeURIComponent(String(req.query.anchor || ''))}`;
const asParam = (req) => `as=${encodeURIComponent((req.user.email || '').toLowerCase())}`;
const hasEmail = (req, res) => { if ((req.user.email || '').toLowerCase()) return true; res.status(400).json({ error: 'No staff identity for this account.' }); return false; };

// My own schedule.
router.get('/', (req, res) => {
  if (!hasEmail(req, res)) return;
  proxy(res, `/api/schedule/mine?${asParam(req)}&${qp(req)}`);
});
// The whole location's schedule (leads/managers only — Management enforces the cap).
router.get('/team', (req, res) => {
  if (!hasEmail(req, res)) return;
  proxy(res, `/api/schedule/location?${asParam(req)}&${qp(req)}`);
});

// ── Time-off requests (proxied to Management, acting "as" the signed-in staff) ──
router.post('/leave-requests', (req, res) => {
  if (!hasEmail(req, res)) return;
  proxy(res, `/api/schedule/leave-requests?${asParam(req)}`, { method: 'POST', body: JSON.stringify(req.body || {}) });
});
router.get('/leave-requests/mine', (req, res) => {
  if (!hasEmail(req, res)) return;
  proxy(res, `/api/schedule/leave-requests/mine?${asParam(req)}`);
});
router.get('/leave-requests/pending-count', (req, res) => {
  if (!hasEmail(req, res)) return;
  proxy(res, `/api/schedule/leave-requests/pending-count?${asParam(req)}`);
});
router.get('/leave-requests', (req, res) => {
  if (!hasEmail(req, res)) return;
  const status = encodeURIComponent(String(req.query.status || 'pending'));
  proxy(res, `/api/schedule/leave-requests?${asParam(req)}&status=${status}`);
});
router.post('/leave-requests/:id/decide', (req, res) => {
  if (!hasEmail(req, res)) return;
  proxy(res, `/api/schedule/leave-requests/${encodeURIComponent(req.params.id)}/decide?${asParam(req)}`, { method: 'POST', body: JSON.stringify(req.body || {}) });
});

module.exports = router;
