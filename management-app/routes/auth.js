const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { signToken, verifyToken, publicRoles } = require('../lib/auth');
const { logLogin } = require('../lib/activity');
const { normalizePhone, isValidPhone } = require('../lib/phone');

const router = express.Router();

// Login is by phone number: staff may type any format, but it must be exactly 10
// digits once punctuation is stripped, and it's matched against the stored digits.
router.post('/login', (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'Phone number and password are required.' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'Enter a 10-digit phone number.' });
  const ph = normalizePhone(phone);
  const user = db.prepare(`SELECT * FROM users WHERE phone=? AND is_active=1`).get(ph);
  const email = (user && user.email || '').toLowerCase();
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    logLogin(req, { user: user || undefined, email, success: false });
    return res.status(401).json({ error: 'Invalid phone number or password.' });
  }
  logLogin(req, { user, email, success: true });
  const token = signToken(user);
  res.json({
    token,
    // email is returned so the Staff app can carry it as the cross-app identity
    // (its `as=<email>` service calls) even though login is by phone.
    user: { id: user.id, name: user.name, email: user.email, role: user.role, location_id: user.location_id },
  });
});

router.get('/me', verifyToken, (req, res) => {
  const u = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.role, u.location_id, l.name AS location_name
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
