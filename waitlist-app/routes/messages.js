// Staff-app messaging is a thin proxy over the Management messaging service
// (the single shared directory + inbox). We forward each call with the service
// key and ?as=<the signed-in staff member's email>, so Management acts on their
// behalf. Front-desk hosts exist in the Management directory too (by email).
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();

// Inline-media streaming via a short-lived ticket (no Authorization header, so an
// <img>/<video> src works and the browser can range-stream). Runs BEFORE auth —
// Management validates the ticket. No ticket → fall through to the authed path.
router.get('/:id/attachment/:aid', (req, res, next) => {
  if (!req.query.tk) return next();
  const url = `${MGMT_URL}/api/messages/${encodeURIComponent(req.params.id)}/attachment/${encodeURIComponent(req.params.aid)}?tk=${encodeURIComponent(req.query.tk)}`;
  return relayFromMgmt(req, res, url);
});

router.use(verifyToken);

const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

const { Readable } = require('stream');
const RELAY_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'cache-control', 'content-disposition'];
// Stream an attachment straight from Management, relaying its caching/range
// headers (immutable cache, ETag, Accept-Ranges) and forwarding the browser's
// Range / If-None-Match. This replaces the old buffer-the-whole-file-then-resend
// proxy, so the Staff app gets the same instant reopen + video streaming without
// this server holding the entire file in memory.
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
router.post('/:id/react', (req, res) => fwd(req, res, 'POST', `/${encodeURIComponent(req.params.id)}/react`, { emoji: req.body && req.body.emoji }));
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

// Mint a streaming ticket for one attachment (authed; Management checks access).
router.get('/:id/attachment/:aid/ticket', (req, res) => fwd(req, res, 'GET', `/${encodeURIComponent(req.params.id)}/attachment/${encodeURIComponent(req.params.aid)}/ticket`));

// Download / inline one attachment's bytes (authed path — images via fetch, file
// downloads). Streams from Management and relays caching + range headers.
router.get('/:id/attachment/:aid', (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No messaging identity for this account.' });
  return relayFromMgmt(req, res, asUrl(email, `/${encodeURIComponent(req.params.id)}/attachment/${encodeURIComponent(req.params.aid)}`));
});

module.exports = router;
