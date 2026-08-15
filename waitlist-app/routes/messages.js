// Staff-app messaging is a thin proxy over the Management messaging service
// (the single shared directory + inbox). We forward each call with the service
// key and ?as=<the signed-in staff member's email>, so Management acts on their
// behalf. Front-desk hosts exist in the Management directory too (by email).
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);

const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

async function fwd(req, res, method, path, body) {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No messaging identity for this account.' });
  const sep = path.includes('?') ? '&' : '?';
  const url = `${MGMT_URL}/api/messages${path}${sep}as=${encodeURIComponent(email)}`;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch {
    res.status(502).json({ error: 'Messaging is temporarily unavailable.' });
  }
}

router.get('/recipients', (req, res) => fwd(req, res, 'GET', '/recipients'));
router.get('/unread-count', (req, res) => fwd(req, res, 'GET', '/unread-count'));
router.get('/inbox', (req, res) => fwd(req, res, 'GET', '/inbox'));
router.get('/sent', (req, res) => fwd(req, res, 'GET', '/sent'));
router.get('/thread/:id', (req, res) => fwd(req, res, 'GET', `/thread/${encodeURIComponent(req.params.id)}`));
router.post('/:id/read', (req, res) => fwd(req, res, 'POST', `/${encodeURIComponent(req.params.id)}/read`));
router.post('/:id/reply', (req, res) => fwd(req, res, 'POST', `/${encodeURIComponent(req.params.id)}/reply`, req.body));
router.post('/', (req, res) => fwd(req, res, 'POST', '/', req.body));

module.exports = router;
