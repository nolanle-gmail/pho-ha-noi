// JWT auth: token signing + Express middleware (verifyToken, requireRole).
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'pho-ha-noi-dev-secret-change-in-prod';
const EXPIRES = '12h';

function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, role: user.role, location_id: user.location_id },
    SECRET,
    { expiresIn: EXPIRES }
  );
}

function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action.' });
    }
    next();
  };
}

// Access levels: owner & admin see everything; manager runs their location;
// support handles inventory operations; employee is view/request only.
const ROLES = {
  ALL: ['owner', 'admin', 'manager', 'support', 'employee'], // any signed-in user
  OPS: ['owner', 'admin', 'manager', 'support'],             // stock operations
  MANAGE: ['owner', 'admin', 'manager'],                     // items, vendors, POs
  ADMIN: ['owner', 'admin'],                                 // users, settings
};

module.exports = { signToken, verifyToken, requireRole, ROLES, SECRET };
