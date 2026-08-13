const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'pho-ha-noi-waitlist-dev-secret';

function signToken(user) {
  return jwt.sign({ id: user.id, name: user.name, role: user.role, location_id: user.location_id, src: user.src || 'local' }, SECRET, { expiresIn: '12h' });
}
function verifyToken(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Authentication required' });
  try { req.user = jwt.verify(t, SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired session' }); }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'Permission denied.' });
    next();
  };
}
module.exports = { signToken, verifyToken, requireRole };
