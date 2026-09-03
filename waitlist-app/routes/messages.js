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
router.get('/inbox', (req, res) => fwd(req, res, 'GET', '/inbox' + (req.query.archived === '1' ? '?archived=1' : '')));
router.get('/sent', (req, res) => fwd(req, res, 'GET', '/sent'));
router.get('/thread/:id', (req, res) => fwd(req, res, 'GET', `/thread/${encodeURIComponent(req.params.id)}`));
router.post('/thread/:id/unread', (req, res) => fwd(req, res, 'POST', `/thread/${encodeURIComponent(req.params.id)}/unread`));
router.post('/thread/:id/archive', (req, res) => fwd(req, res, 'POST', `/thread/${encodeURIComponent(req.params.id)}/archive`));
router.post('/thread/:id/unarchive', (req, res) => fwd(req, res, 'POST', `/thread/${encodeURIComponent(req.params.id)}/unarchive`));
router.post('/:id/read', (req, res) => fwd(req, res, 'POST', `/${encodeURIComponent(req.params.id)}/read`));
router.post('/:id/reply', (req, res) => fwd(req, res, 'POST', `/${encodeURIComponent(req.params.id)}/reply`, req.body));
router.post('/', (req, res) => fwd(req, res, 'POST', '/', req.body));

// Attachments (pictures & videos). List is JSON; upload and download stream bytes.
const MAX_VID = parseInt(process.env.MESSAGE_VID_MAX || '', 10) || 25 * 1024 * 1024;
const asUrl = (email, path) => `${MGMT_URL}/api/messages${path}${path.includes('?') ? '&' : '?'}as=${encodeURIComponent(email)}`;

router.get('/:id/attachments', (req, res) => fwd(req, res, 'GET', `/${encodeURIComponent(req.params.id)}/attachments`));

router.post('/:id/attachment', express.raw({ type: () => true, limit: MAX_VID }), async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No messaging identity for this account.' });
  try {
    const qs = req.query.filename ? `?filename=${encodeURIComponent(req.query.filename)}` : '';
    const r = await fetch(asUrl(email, `/${encodeURIComponent(req.params.id)}/attachment${qs}`), {
      method: 'POST',
      headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream', 'X-Service-Key': KEY },
      body: req.body,
    });
    const d = await r.json().catch(() => ({}));
    res.status(r.status).json(d);
  } catch { res.status(502).json({ error: 'Attachment upload is unavailable.' }); }
});

// Delete a message, or one of its attachments (sender or a manager — enforced by Management).
router.delete('/:id', (req, res) => fwd(req, res, 'DELETE', `/${encodeURIComponent(req.params.id)}`));
router.delete('/:id/attachment/:aid', (req, res) => fwd(req, res, 'DELETE', `/${encodeURIComponent(req.params.id)}/attachment/${encodeURIComponent(req.params.aid)}`));

router.get('/:id/attachment/:aid', async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No messaging identity for this account.' });
  try {
    const r = await fetch(asUrl(email, `/${encodeURIComponent(req.params.id)}/attachment/${encodeURIComponent(req.params.aid)}`), { headers: { 'X-Service-Key': KEY } });
    if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(r.status).json(d); }
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).json({ error: 'Attachment is unavailable.' }); }
});

module.exports = router;
