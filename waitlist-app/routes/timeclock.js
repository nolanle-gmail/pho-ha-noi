// Staff-app "My Hours" — a thin proxy to Management's self timesheet, acting as
// the signed-in staff member (service key + ?as=email), like the messages proxy.
const express = require('express');
const { verifyToken } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);

const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';

router.get('/my-hours', async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No timesheet identity for this account.' });
  const kind = ['daily', 'weekly', 'biweekly', 'monthly'].includes(req.query.kind) ? req.query.kind : 'weekly';
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.anchor || '') ? req.query.anchor : '';
  const url = `${MGMT_URL}/api/timeclock/my-hours?as=${encodeURIComponent(email)}&kind=${kind}${anchor ? `&anchor=${anchor}` : ''}`;
  try {
    const r = await fetch(url, { headers: { 'X-Service-Key': KEY } });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch {
    res.status(502).json({ error: 'Hours are temporarily unavailable.' });
  }
});

// Today's own clock status (clocked in / out / on break / scheduled-not-in / no shift) for the
// app's home banner — proxied to Management acting as the signed-in staff member.
router.get('/my-today', async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No timesheet identity for this account.' });
  try {
    const r = await fetch(`${MGMT_URL}/api/timeclock/my-today?as=${encodeURIComponent(email)}`, { headers: { 'X-Service-Key': KEY } });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch {
    res.status(502).json({ error: 'Status is temporarily unavailable.' });
  }
});

// End-of-day sign-off: confirm a day's hours, or report an issue (which messages the manager).
// Both forward to Management acting as the signed-in staff member.
for (const action of ['confirm', 'dispute']) {
  router.post(`/my-hours/${action}`, async (req, res) => {
    const email = (req.user.email || '').toLowerCase();
    if (!email) return res.status(400).json({ error: 'No timesheet identity for this account.' });
    const url = `${MGMT_URL}/api/timeclock/my-hours/${action}?as=${encodeURIComponent(email)}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY },
        body: JSON.stringify({ date: req.body && req.body.date, note: req.body && req.body.note }),
      });
      res.status(r.status).json(await r.json().catch(() => ({})));
    } catch {
      res.status(502).json({ error: 'Hours are temporarily unavailable.' });
    }
  });
}

// One-time Worked-Hours Acknowledgment — status + sign, proxied as the staffer.
router.get('/my-hours/ack', async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No timesheet identity for this account.' });
  try {
    const r = await fetch(`${MGMT_URL}/api/timeclock/my-hours/ack?as=${encodeURIComponent(email)}`, { headers: { 'X-Service-Key': KEY } });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch { res.status(502).json({ error: 'The acknowledgment is temporarily unavailable.' }); }
});

router.post('/my-hours/ack', async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No timesheet identity for this account.' });
  try {
    const r = await fetch(`${MGMT_URL}/api/timeclock/my-hours/ack?as=${encodeURIComponent(email)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': KEY,
        // Preserve the staffer's real device for the signed record's audit trail.
        'User-Agent': req.headers['user-agent'] || '',
        'X-Forwarded-For': (req.headers['x-forwarded-for'] || req.ip || '').toString(),
      },
      body: JSON.stringify({ full_name: req.body && req.body.full_name, agree: req.body && req.body.agree, lang: req.body && req.body.lang }),
    });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch { res.status(502).json({ error: 'Could not record your signature right now — please try again.' }); }
});

// Stream the staffer's own signed PDF back through the proxy.
router.get('/my-hours/ack/document', async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'No timesheet identity for this account.' });
  try {
    const r = await fetch(`${MGMT_URL}/api/timeclock/my-hours/ack/document?as=${encodeURIComponent(email)}`, { headers: { 'X-Service-Key': KEY } });
    if (!r.ok) return res.status(r.status).json(await r.json().catch(() => ({ error: 'No signed acknowledgment on file.' })));
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/pdf');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Content-Disposition', r.headers.get('content-disposition') || 'inline; filename="acknowledgment.pdf"');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.end(buf);
  } catch { res.status(502).json({ error: 'Your signed form is temporarily unavailable.' }); }
});

module.exports = router;
