// Staff-app Service Flow — a thin proxy over the Management Service Flow service, sent
// with the service key and ?as=<signed-in staff email> so Management scopes the board to
// the staffer's store and records their Served / Done taps.
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
  const url = `${MGMT_URL}/api/sf${path}${sep}as=${encodeURIComponent(email)}`;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch {
    res.status(502).json({ error: 'Service Flow is temporarily unavailable.' });
  }
}

router.get('/board', (req, res) => fwd(req, res, 'GET', '/board' + (req.query.location_id ? `?location_id=${encodeURIComponent(req.query.location_id)}` : '')));
router.post('/:guid/served', (req, res) => fwd(req, res, 'POST', `/${encodeURIComponent(req.params.guid)}/served`, req.body || {}));
router.post('/:guid/done', (req, res) => fwd(req, res, 'POST', `/${encodeURIComponent(req.params.guid)}/done`, {}));
router.post('/seated-left/:vid', (req, res) => fwd(req, res, 'POST', `/seated-left/${encodeURIComponent(req.params.vid)}`, {}));

module.exports = router;
