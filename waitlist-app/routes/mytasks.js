// My Tasks — the signed-in staff member's day-task assignments, proxied to the
// Management app (source of truth) via the shared service key and scoped to them.
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);
const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

async function fwd(res, method, path, req, body) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${MGMT_URL}/api/stafftasks${path}${sep}user_id=${encodeURIComponent(req.user.id)}`;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: method === 'GET' ? undefined : JSON.stringify({ ...(body || {}), user_id: req.user.id }),
    });
    const d = await r.json().catch(() => ({}));
    res.status(r.status).json(d);
  } catch { res.status(502).json({ error: 'Tasks are unavailable.' }); }
}

router.get('/', (req, res) => fwd(res, 'GET', '', req));
router.put('/:id/done', (req, res) => fwd(res, 'PUT', `/${encodeURIComponent(req.params.id)}/done`, req, req.body));

module.exports = router;
