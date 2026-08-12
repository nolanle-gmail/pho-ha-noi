// Table map for the Front Desk — proxies to the Management app (the source of
// truth) using a shared service key, scoped to the signed-in host's location.
// The Front Desk can view live table status and seat guests; layout editing
// happens in the Management app.
const express = require('express');
const { verifyToken, requireRole } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);
const HOST = ['owner', 'manager', 'frontdesk'];
const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

const locOf = (req) => (req.user.role === 'owner' ? (req.query.location_id || req.body.location_id) : req.user.location_id) || null;

async function fwd(res, method, path, locId, body) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${MGMT_URL}/api/floorplan${path}${sep}location_id=${encodeURIComponent(locId)}`;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: body !== undefined ? JSON.stringify({ ...body, location_id: locId }) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    res.status(r.status).json(d);
  } catch { res.status(502).json({ error: 'Floor plan service is unavailable.' }); }
}

router.get('/', requireRole(...HOST), (req, res) => {
  const l = locOf(req); if (!l) return res.status(400).json({ error: 'A location is required.' });
  fwd(res, 'GET', '', l);
});
router.put('/tables/:id/seat', requireRole(...HOST), (req, res) => {
  const l = locOf(req); if (!l) return res.status(400).json({ error: 'A location is required.' });
  fwd(res, 'PUT', `/tables/${encodeURIComponent(req.params.id)}/seat`, l, req.body);
});
router.put('/tables/:id/status', requireRole(...HOST), (req, res) => {
  const l = locOf(req); if (!l) return res.status(400).json({ error: 'A location is required.' });
  fwd(res, 'PUT', `/tables/${encodeURIComponent(req.params.id)}/status`, l, req.body);
});

module.exports = router;
