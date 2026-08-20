const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { signToken, verifyToken } = require('../lib/auth');
const { logLogin } = require('../lib/activity');

const router = express.Router();
const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');

// Staff sign-in. Management is the single source of truth for staff accounts, so
// we authenticate there first and its verdict is authoritative when reachable —
// one password per person works across both apps and can never drift. The local
// Front-Desk accounts are kept only as an offline break-glass: if Management is
// unreachable, a host can still sign in and keep the waiting list running.
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const em = String(email).toLowerCase();

  // 1) Management directory (authoritative).
  let mgmtReachable = false;
  try {
    const r = await fetch(`${MGMT_URL}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: em, password }) });
    mgmtReachable = true;
    if (r.ok) {
      const d = await r.json();
      const mu = { id: d.user.id, name: d.user.name, email: em, role: d.user.role, location_id: d.user.location_id, src: 'mgmt' };
      logLogin(req, { user: mu, email: em, success: true });
      return res.json({ token: signToken(mu), user: mu });
    }
    // Reached Management but it rejected the credentials → authoritative failure
    // (do NOT try local — that is what used to let passwords diverge).
  } catch { mgmtReachable = false; }

  // 2) Break-glass: only when Management is unreachable, allow local accounts.
  if (!mgmtReachable) {
    const user = db.prepare(`SELECT * FROM users WHERE email=? AND is_active=1`).get(em);
    if (user && bcrypt.compareSync(password, user.password_hash)) {
      logLogin(req, { user, email: em, success: true });
      return res.json({ token: signToken({ ...user, src: 'local' }), user: { id: user.id, name: user.name, role: user.role, location_id: user.location_id, src: 'local' } });
    }
  }

  logLogin(req, { email: em, success: false });
  return res.status(401).json({ error: 'Invalid email or password.' });
});

router.get('/me', verifyToken, (req, res) => {
  if (req.user.src === 'mgmt') return res.json({ id: req.user.id, name: req.user.name, role: req.user.role, location_id: req.user.location_id, src: 'mgmt' });
  res.json(db.prepare(`SELECT id,name,email,role,location_id FROM users WHERE id=?`).get(req.user.id) || {});
});

module.exports = router;
