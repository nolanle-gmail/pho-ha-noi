// Staff-app barcode scanning — a thin proxy over Management's invscan service, sent with
// the service key and ?as=<signed-in staff email> so Management scopes everything to the
// staffer's own store.
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);

const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

async function fwd(req, res, method, path, body) {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No staff identity for this account.' });
  const sep = path.includes('?') ? '&' : '?';
  const url = `${MGMT_URL}/api/invscan${path}${sep}as=${encodeURIComponent(email)}`;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch {
    res.status(502).json({ error: 'Scanning is temporarily unavailable.' });
  }
}

router.get('/items/list', (req, res) => fwd(req, res, 'GET', '/items/list'));
router.get('/vendors/list', (req, res) => fwd(req, res, 'GET', '/vendors/list'));
router.get('/lookup/:code', (req, res) => fwd(req, res, 'GET', `/lookup/${encodeURIComponent(req.params.code)}`));
router.post('/scan', (req, res) => fwd(req, res, 'POST', '/scan', req.body || {}));
router.post('/link', (req, res) => fwd(req, res, 'POST', '/link', req.body || {}));
router.post('/create', (req, res) => fwd(req, res, 'POST', '/create', req.body || {}));
router.get('/:code', (req, res) => fwd(req, res, 'GET', `/${encodeURIComponent(req.params.code)}`));

module.exports = router;
