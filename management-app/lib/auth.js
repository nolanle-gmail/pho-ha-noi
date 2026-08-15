// JWT auth + the access-level model.
//
// Access levels are defined once in ROLE_DEFS below. Each role has:
//   • scope — 'all' (every location), 'location' (their own store), or
//             'self' (only their own schedule/tasks/messages)
//   • caps  — the capabilities that unlock modules:
//             org      account & access-level administration
//             manage   operational management (staff, schedules, menu, locations)
//             ops      inventory operations (stock, orders, transfers, receiving)
//             reports  view reports & analytics
//             central  the Central Kitchen production/supply hub
//             delivery delivery manifests / fulfillment (drivers)
//
// Route permission groups (ROLES.MANAGE, .OPS, …) and the frontend navigation
// are both derived from this one table, so adding a role here wires it up
// everywhere. Job titles (Server, Line Cook, …) are separate access levels that
// all share the 'self' scope — same permissions, different position.
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'pho-ha-noi-dev-secret-change-in-prod';
const EXPIRES = '12h';

const ROLE_DEFS = {
  // Executive / all-location administration
  owner:             { label: 'Owner',             scope: 'all',      rank: 100, caps: ['org', 'manage', 'ops', 'reports', 'central'] },
  admin:             { label: 'Admin',             scope: 'all',      rank: 95,  caps: ['org', 'manage', 'ops', 'reports', 'central'] },
  general_manager:   { label: 'General Manager',   scope: 'all',      rank: 85,  caps: ['manage', 'ops', 'reports', 'central'] },
  regional_manager:  { label: 'Regional Manager',  scope: 'all',      rank: 80,  caps: ['manage', 'ops', 'reports'] },
  // Single-location management
  manager:           { label: 'Manager',           scope: 'location', rank: 70,  caps: ['manage', 'ops', 'reports'] },
  assistant_manager: { label: 'Assistant Manager', scope: 'location', rank: 65,  caps: ['manage', 'ops', 'reports'] },
  kitchen_manager:   { label: 'Kitchen Manager',   scope: 'location', rank: 63,  caps: ['manage', 'ops', 'reports'] },
  // Analytics / finance — read-only reporting across all locations
  analyst:           { label: 'Analyst',           scope: 'all',      rank: 55,  caps: ['reports'] },
  accountant:        { label: 'Accountant',        scope: 'all',      rank: 53,  caps: ['reports'] },
  // Inventory operations (own location)
  support:           { label: 'Inventory Support', scope: 'location', rank: 45,  caps: ['ops'] },
  // Delivery
  driver:            { label: 'Driver',            scope: 'location', rank: 40,  caps: ['delivery'] },
  // Front / back of house positions — own schedule, tasks & messages only
  server:            { label: 'Server',            scope: 'self',     rank: 30,  caps: [] },
  host:              { label: 'Host / Front Desk', scope: 'self',     rank: 30,  caps: [] },
  frontdesk:         { label: 'Front Desk',        scope: 'self',     rank: 30,  caps: [] },
  cashier:           { label: 'Cashier',           scope: 'self',     rank: 29,  caps: [] },
  bartender:         { label: 'Bartender',         scope: 'self',     rank: 29,  caps: [] },
  barista:           { label: 'Barista',           scope: 'self',     rank: 28,  caps: [] },
  busser:            { label: 'Busser',            scope: 'self',     rank: 27,  caps: [] },
  chef:              { label: 'Chef',              scope: 'self',     rank: 32,  caps: [] },
  line_cook:         { label: 'Line Cook',         scope: 'self',     rank: 28,  caps: [] },
  prep_cook:         { label: 'Prep Cook',         scope: 'self',     rank: 27,  caps: [] },
  dishwasher:        { label: 'Dishwasher',        scope: 'self',     rank: 25,  caps: [] },
  employee:          { label: 'Staff (General)',   scope: 'self',     rank: 20,  caps: [] },
};

const ROLE_KEYS = Object.keys(ROLE_DEFS);
const withCap = (cap) => ROLE_KEYS.filter((k) => ROLE_DEFS[k].caps.includes(cap));
const uniq = (a) => [...new Set(a)];

// Access levels: groups derived from the capability table above.
const ROLES = {
  ALL: ROLE_KEYS,                                            // any signed-in user / valid role
  ADMIN: withCap('org'),                                     // account & access-level admin
  MANAGE: withCap('manage'),                                 // staff, schedules, menu, locations
  OPS: withCap('ops'),                                       // inventory operations
  REPORTS: withCap('reports'),                               // reports & analytics
  CENTRAL: withCap('central'),                               // Central Kitchen hub
  DELIVERY: uniq([...withCap('central'), ...withCap('delivery')]), // manifests / fulfillment
  SCHEDULED: ROLE_KEYS.filter((k) => ROLE_DEFS[k].scope !== 'all'), // people who get a shift schedule
};

const roleScope = (role) => (ROLE_DEFS[role] ? ROLE_DEFS[role].scope : 'self');
const seesAllLocations = (role) => roleScope(role) === 'all';
const roleLabel = (role) => (ROLE_DEFS[role] ? ROLE_DEFS[role].label : role);
// Public view of the registry for the frontend (labels, scope, caps).
const publicRoles = () => ROLE_KEYS.map((key) => ({ key, ...ROLE_DEFS[key] }));

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

module.exports = {
  signToken, verifyToken, requireRole, SECRET,
  ROLES, ROLE_DEFS, roleScope, seesAllLocations, roleLabel, publicRoles,
};
