// Staff-app chat is a thin proxy over the Management chat service, forwarded with
// the service key and ?as=<the signed-in staff member's email> so Management acts
// on their behalf (same pattern as the messaging proxy).
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);

const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

async function fwd(req, res, method, path, body) {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No chat identity for this account.' });
  const sep = path.includes('?') ? '&' : '?';
  const url = `${MGMT_URL}/api/chat${path}${sep}as=${encodeURIComponent(email)}`;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch { res.status(502).json({ error: 'Chat is temporarily unavailable.' }); }
}

router.get('/groups', (req, res) => fwd(req, res, 'GET', '/groups' + (req.query.scope === 'all' ? '?scope=all' : '')));
router.get('/unread-count', (req, res) => fwd(req, res, 'GET', '/unread-count'));
router.post('/groups', (req, res) => fwd(req, res, 'POST', '/groups', req.body));
router.get('/groups/:id', (req, res) => fwd(req, res, 'GET', `/groups/${encodeURIComponent(req.params.id)}`));
router.get('/groups/:id/messages', (req, res) => fwd(req, res, 'GET', `/groups/${encodeURIComponent(req.params.id)}/messages`));
router.post('/groups/:id/messages', (req, res) => fwd(req, res, 'POST', `/groups/${encodeURIComponent(req.params.id)}/messages`, req.body));

// Chat message attachments (pictures & videos). List is JSON; upload/download stream bytes.
const MAX_VID = parseInt(process.env.MESSAGE_VID_MAX || '', 10) || 25 * 1024 * 1024;
const chatUrl = (email, path) => `${MGMT_URL}/api/chat${path}${path.includes('?') ? '&' : '?'}as=${encodeURIComponent(email)}`;
router.get('/groups/:id/messages/:mid/attachments', (req, res) => fwd(req, res, 'GET', `/groups/${encodeURIComponent(req.params.id)}/messages/${encodeURIComponent(req.params.mid)}/attachments`));
router.post('/groups/:id/messages/:mid/attachment', express.raw({ type: () => true, limit: MAX_VID }), async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No chat identity for this account.' });
  try {
    const qs = req.query.filename ? `?filename=${encodeURIComponent(req.query.filename)}` : '';
    const r = await fetch(chatUrl(email, `/groups/${encodeURIComponent(req.params.id)}/messages/${encodeURIComponent(req.params.mid)}/attachment${qs}`), {
      method: 'POST', headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream', 'X-Service-Key': KEY }, body: req.body,
    });
    const d = await r.json().catch(() => ({}));
    res.status(r.status).json(d);
  } catch { res.status(502).json({ error: 'Attachment upload is unavailable.' }); }
});
router.get('/groups/:id/messages/:mid/attachment/:aid', async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No chat identity for this account.' });
  try {
    const r = await fetch(chatUrl(email, `/groups/${encodeURIComponent(req.params.id)}/messages/${encodeURIComponent(req.params.mid)}/attachment/${encodeURIComponent(req.params.aid)}`), { headers: { 'X-Service-Key': KEY } });
    if (!r.ok) { const d = await r.json().catch(() => ({})); return res.status(r.status).json(d); }
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).json({ error: 'Attachment is unavailable.' }); }
});
router.post('/groups/:id/members', (req, res) => fwd(req, res, 'POST', `/groups/${encodeURIComponent(req.params.id)}/members`, req.body));
router.delete('/groups/:id/members/:uid', (req, res) => fwd(req, res, 'DELETE', `/groups/${encodeURIComponent(req.params.id)}/members/${encodeURIComponent(req.params.uid)}`));
router.delete('/groups/:id', (req, res) => fwd(req, res, 'DELETE', `/groups/${encodeURIComponent(req.params.id)}`));

module.exports = router;
