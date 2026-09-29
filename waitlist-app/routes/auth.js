const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { signToken, verifyToken } = require('../lib/auth');
const { logLogin } = require('../lib/activity');
const { normalizePhone, isValidPhone } = require('../lib/phone');

const router = express.Router();
const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');

// Staff sign-in — by phone number. Management is the single source of truth for
// staff accounts, so we authenticate there first and its verdict is authoritative
// when reachable — one password per person works across both apps and can never
// drift. The local Front-Desk accounts are kept only as an offline break-glass: if
// Management is unreachable, a host can still sign in and keep the waiting list running.
router.post('/login', async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'Phone number and password are required.' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'Enter a 10-digit phone number.' });
  const ph = normalizePhone(phone);

  // 1) Management directory (authoritative).
  let mgmtReachable = false;
  try {
    const r = await fetch(`${MGMT_URL}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: ph, password }) });
    mgmtReachable = true;
    if (r.ok) {
      const d = await r.json();
      // Carry the account's email as the cross-app identity for `as=<email>` calls.
      const em = (d.user.email || '').toLowerCase();
      const mu = { id: d.user.id, name: d.user.name, email: em, role: d.user.role, location_id: d.user.location_id, caps: Array.isArray(d.user.caps) ? d.user.caps : [], src: 'mgmt' };
      logLogin(req, { user: mu, email: em, success: true });
      return res.json({ token: signToken(mu), user: mu });
    }
    // Reached Management but it rejected the credentials → authoritative failure
    // (do NOT try local — that is what used to let passwords diverge).
  } catch { mgmtReachable = false; }

  // 2) Break-glass: only when Management is unreachable, allow local accounts (by phone).
  if (!mgmtReachable) {
    const user = db.prepare(`SELECT * FROM users WHERE phone=? AND is_active=1`).get(ph);
    if (user && bcrypt.compareSync(password, user.password_hash)) {
      const em = (user.email || '').toLowerCase();
      logLogin(req, { user, email: em, success: true });
      return res.json({ token: signToken({ ...user, src: 'local' }), user: { id: user.id, name: user.name, role: user.role, location_id: user.location_id, src: 'local' } });
    }
  }

  logLogin(req, { phone: ph, success: false });
  return res.status(401).json({ error: 'Invalid phone number or password.' });
});

// Employee-code kiosk sign-in for the combined Front Desk + Service Flow page (/sflow). Validates
// the code against Management (service key) and, if the staffer is assigned to the kiosk's store,
// mints a Front-Desk JWT pinned to that store. No password — physical tablet + code is the trust
// model. Returns front_desk=true only for host-capable roles.
const KIOSK_KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';
const FD_ROLES = ['owner', 'manager', 'assistant_manager', 'kitchen_manager', 'frontdesk', 'host', 'server', 'cashier'];
router.post('/kiosk', async (req, res) => {
  const code = String((req.body && req.body.code) || '').trim();
  const locId = parseInt(req.body && req.body.location_id, 10);
  const loc = locId && db.prepare(`SELECT id, name FROM locations WHERE id=?`).get(locId);
  if (!loc) return res.status(404).json({ error: 'Unknown location.' });
  let vr;
  try {
    const r = await fetch(`${MGMT_URL}/api/auth/verify-code`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': KIOSK_KEY },
      body: JSON.stringify({ code, location_id: loc.id }),
    });
    vr = await r.json().catch(() => ({}));
  } catch { return res.status(502).json({ error: 'Sign-in is temporarily unavailable.' }); }
  if (!vr || !vr.ok) return res.status(401).json({ error: 'Employee code not found. Please check it, or ask your manager.' });
  if (!vr.authorized) return res.status(403).json({ error: `You’re not assigned to ${(loc.name || '').replace('Pho Ha Noi — ', '')}.` });
  const em = (vr.user.email || '').toLowerCase();
  const mu = { id: vr.user.id, name: vr.user.name, email: em, role: vr.user.role, location_id: loc.id, src: 'mgmt' };
  logLogin(req, { user: mu, email: em, success: true });
  res.json({ token: signToken(mu), user: { id: mu.id, name: mu.name, role: mu.role, location_id: loc.id }, front_desk: FD_ROLES.includes(vr.user.role), location_name: loc.name });
});

router.get('/me', verifyToken, (req, res) => {
  if (req.user.src === 'mgmt') return res.json({ id: req.user.id, name: req.user.name, role: req.user.role, location_id: req.user.location_id, src: 'mgmt' });
  res.json(db.prepare(`SELECT id,name,email,role,location_id FROM users WHERE id=?`).get(req.user.id) || {});
});

module.exports = router;
