// Cross-module endpoints for the management shell (staff directory, etc.).
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES } = require('../lib/auth');

const router = express.Router();
router.use(verifyToken);

// Staff directory. Owner/admin see all locations; managers see their own.
router.get('/staff', requireRole(...ROLES.MANAGE), (req, res) => {
  const scopeAll = ['owner', 'admin'].includes(req.user.role);
  const where = scopeAll ? '' : 'WHERE u.location_id=?';
  const args = scopeAll ? [] : [req.user.location_id];
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.is_active, l.name AS location_name
    FROM users u LEFT JOIN locations l ON u.location_id=l.id
    ${where}
    ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'support' THEN 3 ELSE 4 END, u.name
  `).all(...args);
  res.json(rows);
});

module.exports = router;
