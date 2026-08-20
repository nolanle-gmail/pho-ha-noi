// My Tasks — the signed-in staff member's day-task assignments, proxied to the
// Management app (source of truth) via the shared service key and scoped to them.
// Start/Done are JSON calls; the proof photo streams raw image bytes both ways.
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);
const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';
const MAX_PHOTO_BYTES = parseInt(process.env.TASK_PHOTO_MAX || '', 10) || 8 * 1024 * 1024;

const mgmtUrl = (path, uid) => {
  const sep = path.includes('?') ? '&' : '?';
  return `${MGMT_URL}/api/stafftasks${path}${sep}user_id=${encodeURIComponent(uid)}`;
};

async function fwd(res, method, path, req, body) {
  try {
    const r = await fetch(mgmtUrl(path, req.user.id), {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: method === 'GET' ? undefined : JSON.stringify({ ...(body || {}), user_id: req.user.id }),
    });
    const d = await r.json().catch(() => ({}));
    res.status(r.status).json(d);
  } catch { res.status(502).json({ error: 'Tasks are unavailable.' }); }
}

router.get('/', (req, res) => fwd(res, 'GET', '', req));
router.put('/:id/start', (req, res) => fwd(res, 'PUT', `/${encodeURIComponent(req.params.id)}/start`, req, req.body));
router.put('/:id/done', (req, res) => fwd(res, 'PUT', `/${encodeURIComponent(req.params.id)}/done`, req, req.body));

// Proof photo — forward the raw image bytes to Management (which stores them).
router.post('/:id/photo', express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }), async (req, res) => {
  try {
    const r = await fetch(mgmtUrl(`/${encodeURIComponent(req.params.id)}/photo`, req.user.id), {
      method: 'POST',
      headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream', 'X-Service-Key': KEY },
      body: req.body,
    });
    const d = await r.json().catch(() => ({}));
    res.status(r.status).json(d);
  } catch { res.status(502).json({ error: 'Photo upload is unavailable.' }); }
});

// Stream the stored photo back to the staff app.
router.get('/:id/photo', async (req, res) => {
  try {
    const r = await fetch(mgmtUrl(`/${encodeURIComponent(req.params.id)}/photo`, req.user.id), {
      headers: { 'X-Service-Key': KEY },
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(r.status).json(d); }
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).json({ error: 'Photo is unavailable.' }); }
});

module.exports = router;
