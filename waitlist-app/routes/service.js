// Staff-app service board — proxies the guest-visit lifecycle in the Management
// app (the source of truth) via the shared service key, scoped to the signed-in
// staff member's location and attributed to them. Front Desk creates/seats;
// servers claim, check, and close out their tables.
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);

const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';
const isServer = (req) => ['server', 'busser'].includes(req.user.role);

// The staff member's location (Front-Desk/servers are pinned); an owner may pass one.
const locOf = (req) => req.user.location_id || req.query.location_id || req.body.location_id || null;

async function fwd(res, method, path, req, body) {
  const locId = locOf(req);
  if (!locId) return res.status(400).json({ error: 'A location is required.' });
  const sep = path.includes('?') ? '&' : '?';
  const url = `${MGMT_URL}/api/visits${path}${sep}location_id=${encodeURIComponent(locId)}`;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: method === 'GET' ? undefined : JSON.stringify({ ...(body || {}), location_id: locId, actor_id: req.user.id, actor_name: req.user.name, actor_role: req.user.role }),
    });
    const d = await r.json().catch(() => ({}));
    res.status(r.status).json(d);
  } catch { res.status(502).json({ error: 'The service board is unavailable.' }); }
}
const id = (req) => encodeURIComponent(req.params.id);

router.get('/', (req, res) => fwd(res, 'GET', '?include=done', req));
router.post('/', (req, res) => fwd(res, 'POST', '', req, req.body));
router.put('/:id/seat', (req, res) => fwd(res, 'PUT', `/${id(req)}/seat`, req, req.body));
// A server claiming a table is always claiming it for themselves.
router.put('/:id/claim', (req, res) => fwd(res, 'PUT', `/${id(req)}/claim`, req, isServer(req) ? { server_id: req.user.id, server_name: req.user.name } : req.body));
router.put('/:id/assign', (req, res) => fwd(res, 'PUT', `/${id(req)}/assign`, req, req.body));
router.put('/:id/check', (req, res) => fwd(res, 'PUT', `/${id(req)}/check`, req, req.body));
router.put('/:id/interval', (req, res) => fwd(res, 'PUT', `/${id(req)}/interval`, req, req.body));
router.put('/:id/pay', (req, res) => fwd(res, 'PUT', `/${id(req)}/pay`, req, req.body));
router.put('/:id/done', (req, res) => fwd(res, 'PUT', `/${id(req)}/done`, req, req.body));
router.put('/:id/transfer', (req, res) => fwd(res, 'PUT', `/${id(req)}/transfer`, req, req.body));
router.put('/:id/cancel', (req, res) => fwd(res, 'PUT', `/${id(req)}/cancel`, req, req.body));

module.exports = router;
