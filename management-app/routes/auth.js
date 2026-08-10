const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { signToken, verifyToken, publicRoles } = require('../lib/auth');
const { logLogin } = require('../lib/activity');

const router = express.Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const em = String(email).toLowerCase();
  const user = db.prepare(`SELECT * FROM users WHERE email=? AND is_active=1`).get(em);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    logLogin(req, { email: em, success: false });
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  logLogin(req, { user, email: em, success: true });
  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, location_id: user.location_id },
  });
});

router.get('/me', verifyToken, (req, res) => {
  const u = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.location_id, l.name AS location_name
    FROM users u LEFT JOIN locations l ON u.location_id=l.id WHERE u.id=?
  `).get(req.user.id);
  res.json(u || {});
});

// The access-level registry (labels, scope, capabilities) — drives the UI.
router.get('/roles', verifyToken, (req, res) => res.json(publicRoles()));

// Account settings: change my own password.
router.post('/change-password', verifyToken, (req, res) => {
  const { current_password, new_password } = req.body || {};
  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.user.id);
  if (!u || !bcrypt.compareSync(current_password || '', u.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(bcrypt.hashSync(String(new_password), 10), req.user.id);
  res.json({ success: true });
});

module.exports = router;
