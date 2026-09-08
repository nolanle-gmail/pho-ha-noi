// Web Push (Staff app) — a thin proxy to the Management app, which owns the VAPID
// keys and the subscription store. The device subscribes with the public key, then
// registers/drops its subscription here; we forward over the service key acting as
// the signed-in staff member (by email), exactly like My Tasks and messaging do.
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);
const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

const asParam = (req) => encodeURIComponent(String(req.user.email || '').toLowerCase());

router.get('/key', async (req, res) => {
  try {
    const r = await fetch(`${MGMT_URL}/api/push/key`, { headers: { 'X-Service-Key': KEY } });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch { res.status(502).json({ error: 'Push is unavailable.' }); }
});

async function forward(res, path, body) {
  try {
    const r = await fetch(`${MGMT_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: JSON.stringify(body),
    });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch { res.status(502).json({ error: 'Push is unavailable.' }); }
}

router.post('/subscribe', (req, res) =>
  forward(res, `/api/push/subscribe?as=${asParam(req)}`, { subscription: req.body && req.body.subscription }));

router.post('/unsubscribe', (req, res) =>
  forward(res, `/api/push/unsubscribe?as=${asParam(req)}`, { endpoint: req.body && req.body.endpoint }));

module.exports = router;
