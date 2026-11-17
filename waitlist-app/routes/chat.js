// Staff-app chat is a thin proxy over the Management chat service, forwarded with
// the service key and ?as=<the signed-in staff member's email> so Management acts
// on their behalf (same pattern as the messaging proxy).
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();

const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

const { Readable } = require('stream');
const RELAY_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'cache-control', 'content-disposition'];
// Stream an attachment straight from Management, relaying its caching/range headers
// and forwarding the browser's Range / If-None-Match — same as the messaging proxy.
async function relayFromMgmt(req, res, url) {
  const headers = { 'X-Service-Key': KEY };
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];
  let r;
  try { r = await fetch(url, { headers }); } catch { return res.status(502).json({ error: 'Attachment is unavailable.' }); }
  if (r.status >= 400) { const d = await r.json().catch(() => ({})); return res.status(r.status).json(d); }
  RELAY_HEADERS.forEach((h) => { const v = r.headers.get(h); if (v) res.setHeader(h, v); });
  res.status(r.status);
  if (r.status === 304 || !r.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(r.body).pipe(res);
}

// Inline-media streaming via a short-lived ticket (no Authorization header). Runs
// BEFORE auth — Management validates the ticket. No ticket → fall through below.
router.get('/groups/:id/messages/:mid/attachment/:aid', (req, res, next) => {
  if (!req.query.tk) return next();
  const url = `${MGMT_URL}/api/chat/groups/${encodeURIComponent(req.params.id)}/messages/${encodeURIComponent(req.params.mid)}/attachment/${encodeURIComponent(req.params.aid)}?tk=${encodeURIComponent(req.query.tk)}`;
  return relayFromMgmt(req, res, url);
});

router.use(verifyToken);

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
router.post('/messages/:id/react', (req, res) => fwd(req, res, 'POST', `/messages/${encodeURIComponent(req.params.id)}/react`, { emoji: req.body && req.body.emoji }));

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
// Mint a streaming ticket for one chat attachment (authed; Management checks access).
router.get('/groups/:id/messages/:mid/attachment/:aid/ticket', (req, res) => fwd(req, res, 'GET', `/groups/${encodeURIComponent(req.params.id)}/messages/${encodeURIComponent(req.params.mid)}/attachment/${encodeURIComponent(req.params.aid)}/ticket`));

// Download / inline one chat attachment's bytes (authed path). Streams from
// Management and relays caching + range headers.
router.get('/groups/:id/messages/:mid/attachment/:aid', (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No chat identity for this account.' });
  return relayFromMgmt(req, res, chatUrl(email, `/groups/${encodeURIComponent(req.params.id)}/messages/${encodeURIComponent(req.params.mid)}/attachment/${encodeURIComponent(req.params.aid)}`));
});
router.post('/groups/:id/members', (req, res) => fwd(req, res, 'POST', `/groups/${encodeURIComponent(req.params.id)}/members`, req.body));
router.delete('/groups/:id/members/:uid', (req, res) => fwd(req, res, 'DELETE', `/groups/${encodeURIComponent(req.params.id)}/members/${encodeURIComponent(req.params.uid)}`));
router.delete('/groups/:id', (req, res) => fwd(req, res, 'DELETE', `/groups/${encodeURIComponent(req.params.id)}`));

module.exports = router;
