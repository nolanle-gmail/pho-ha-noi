// Staff-app floor alerts — a thin proxy over the Management alerts service, sent
// with the service key and ?as=<signed-in staff email> so Management acts on their
// behalf (send if a manager, acknowledge if a recipient).
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
  const url = `${MGMT_URL}/api/alerts${path}${sep}as=${encodeURIComponent(email)}`;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch {
    res.status(502).json({ error: 'Alerts are temporarily unavailable.' });
  }
}

router.get('/staff', (req, res) => fwd(req, res, 'GET', '/staff' + (req.query.location_id ? `?location_id=${encodeURIComponent(req.query.location_id)}` : '')));
router.get('/active', (req, res) => fwd(req, res, 'GET', '/active'));
router.get('/sent', (req, res) => fwd(req, res, 'GET', '/sent'));
router.get('/:id/acks', (req, res) => fwd(req, res, 'GET', `/${encodeURIComponent(req.params.id)}/acks`));
router.post('/', (req, res) => fwd(req, res, 'POST', '/', req.body));
router.post('/:id/ack', (req, res) => fwd(req, res, 'POST', `/${encodeURIComponent(req.params.id)}/ack`, {}));
router.post('/:id/close', (req, res) => fwd(req, res, 'POST', `/${encodeURIComponent(req.params.id)}/close`, {}));

module.exports = router;
