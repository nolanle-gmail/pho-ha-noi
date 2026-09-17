// Management view of the Front Desk waitlist (which lives in the Waitlist app's own
// DB). Reads it server-to-server over the shared service key. Location IDs are aligned
// across both apps. Scoped by role: all-location roles see all; others their own store.
const express = require('express');
const { verifyToken, requireRole, ROLES, seesAllLocations } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);
router.use(requireRole(ROLES.MANAGE));

const WL_URL = (process.env.WAITLIST_URL || 'https://pho-ha-noi-waitlist.fly.dev').replace(/\/+$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

async function wl(path) {
  const r = await fetch(`${WL_URL}/api/wl-feed${path}`, { headers: { 'X-Service-Key': KEY } });
  if (!r.ok) { const e = new Error(`waitlist app returned ${r.status}`); e.status = 502; throw e; }
  return r.json();
}
// A manager is pinned to their own location; all-location roles may pass ?location_id.
const scopedLoc = (req) => seesAllLocations(req.user.role) ? (parseInt(req.query.location_id, 10) || null) : req.user.location_id;

router.get('/active', async (req, res) => {
  try { const loc = scopedLoc(req); res.json(await wl('/active' + (loc ? `?location_id=${loc}` : ''))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/history', async (req, res) => {
  try {
    const loc = scopedLoc(req); const qs = new URLSearchParams();
    if (loc) qs.set('location_id', loc);
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) qs.set('from', req.query.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) qs.set('to', req.query.to);
    if (['waiting', 'seated', 'left'].includes(req.query.status)) qs.set('status', req.query.status);
    res.json(await wl('/history' + (qs.toString() ? '?' + qs.toString() : '')));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/notifications/:id', async (req, res) => {
  try { res.json(await wl('/notifications/' + encodeURIComponent(req.params.id))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

module.exports = router;
