// Staff-app live stream (SSE). One connection carries both this app's waitlist
// events (kiosk check-ins, seatings, notifies) and the Management app's visit
// events (forwarded via the service key), so Front-Desk / Server boards update
// the moment anything changes. EventSource can't set headers → auth via ?token=.
const express = require('express');
const jwt = require('jsonwebtoken');
const { Readable } = require('stream');
const { onWaitlist } = require('../lib/events');

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'pho-ha-noi-waitlist-dev-secret';
const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

router.get('/', async (req, res) => {
  let user; try { user = jwt.verify(req.query.token || '', SECRET); } catch { return res.status(401).end(); }
  const loc = user.location_id || (req.query.location_id ? parseInt(req.query.location_id, 10) : null);

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  if (res.flushHeaders) res.flushHeaders();
  res.write(': connected\n\n');

  // 1) Local waitlist events.
  const unsub = onWaitlist((p) => {
    if (loc && p.location_id != null && String(p.location_id) !== String(loc)) return;
    try { res.write(`data: ${JSON.stringify({ type: 'waitlist', location_id: p.location_id })}\n\n`); } catch { /* closed */ }
  });

  // 2) Forward the Management visit stream (service-key authenticated, server-to-server).
  const controller = new AbortController();
  let node = null;
  (async () => {
    try {
      const up = await fetch(`${MGMT_URL}/api/visits/stream?location_id=${encodeURIComponent(loc || '')}`, { headers: { 'X-Service-Key': KEY }, signal: controller.signal });
      if (up.ok && up.body) { node = Readable.fromWeb(up.body); node.on('data', (c) => { try { res.write(c); } catch { /* closed */ } }); node.on('error', () => { }); }
    } catch { /* Management stream unavailable — local waitlist events still flow */ }
  })();

  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(hb); unsub(); controller.abort(); if (node) node.destroy(); });
});

module.exports = router;
