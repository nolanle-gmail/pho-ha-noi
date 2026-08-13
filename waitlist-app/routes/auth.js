const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { signToken, verifyToken } = require('../lib/auth');
const { logLogin } = require('../lib/activity');

const router = express.Router();
const MGMT_URL = (process.env.MGMT_URL || 'http://localhost:4001').replace(/\/$/, '');

// Staff sign-in. First try local Front-Desk accounts; then fall back to the
// Management directory so any employee (server, host, manager…) can sign in
// with their Management credentials — the Staff app is one login for everyone.
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const em = String(email).toLowerCase();

  const user = db.prepare(`SELECT * FROM users WHERE email=? AND is_active=1`).get(em);
  if (user && bcrypt.compareSync(password, user.password_hash)) {
    logLogin(req, { user, email: em, success: true });
    return res.json({ token: signToken(user), user: { id: user.id, name: user.name, role: user.role, location_id: user.location_id, src: 'local' } });
  }

  // Fall back to Management (staff are Management employees).
  try {
    const r = await fetch(`${MGMT_URL}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: em, password }) });
    if (r.ok) {
      const d = await r.json();
      const mu = { id: d.user.id, name: d.user.name, role: d.user.role, location_id: d.user.location_id, src: 'mgmt' };
      logLogin(req, { user: mu, email: em, success: true });
      return res.json({ token: signToken(mu), user: mu });
    }
  } catch { /* Management unreachable — fall through to a normal failure */ }

  logLogin(req, { email: em, success: false });
  return res.status(401).json({ error: 'Invalid email or password.' });
});

router.get('/me', verifyToken, (req, res) => {
  if (req.user.src === 'mgmt') return res.json({ id: req.user.id, name: req.user.name, role: req.user.role, location_id: req.user.location_id, src: 'mgmt' });
  res.json(db.prepare(`SELECT id,name,email,role,location_id FROM users WHERE id=?`).get(req.user.id) || {});
});

module.exports = router;
