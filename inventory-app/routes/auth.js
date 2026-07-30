const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { signToken, verifyToken } = require('../lib/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const user = db.prepare(`SELECT * FROM users WHERE email=? AND is_active=1`).get(String(email).toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, location_id: user.location_id },
  });
});

router.get('/me', verifyToken, (req, res) => {
  const u = db.prepare(`SELECT id, name, email, role, location_id FROM users WHERE id=?`).get(req.user.id);
  res.json(u || {});
});

module.exports = router;
