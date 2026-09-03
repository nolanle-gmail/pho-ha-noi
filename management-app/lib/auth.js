// JWT auth + the access-level model.
//
// Each role (access level) has:
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
// The registry lives in the `roles` DB table (seeded from DEFAULT_ROLE_DEFS below)
// so Owner/Admin can add, edit and remove roles at runtime from the Access Levels
// page. Route permission groups (ROLES.MANAGE, .OPS, …) and the frontend navigation
// both derive from it. The ROLES.* groups are STABLE array instances mutated in
// place on reloadRoles(), so route guards (requireRole(ROLES.X)) and inline
// ROLES.X.includes(...) checks always reflect the current registry.
const jwt = require('jsonwebtoken');
const db = require('../db/database');

const SECRET = process.env.JWT_SECRET || 'pho-ha-noi-dev-secret-change-in-prod';
const EXPIRES = '12h';

// Known capabilities and scopes (the editable vocabulary for a role).
const CAPS = ['org', 'manage', 'ops', 'reports', 'central', 'delivery'];
const SCOPES = ['all', 'location', 'self'];

// Built-in defaults — seed the `roles` table, and a fallback if the DB is empty.
const DEFAULT_ROLE_DEFS = {
  // Executive / all-location administration
  owner:             { label: 'Owner',             scope: 'all',      rank: 100, caps: ['org', 'manage', 'ops', 'reports', 'central'] },
  admin:             { label: 'Admin',             scope: 'all',      rank: 95,  caps: ['org', 'manage', 'ops', 'reports', 'central'] },
  // HR — full administrative access, mirroring Admin. (Owner/Admin are slated to
  // keep a few powers to themselves later — archive, delete, activity log & audit —
  // which HR would then not have; those checks are marked ORG_ADMIN_ONLY.)
  hr:                { label: 'HR',                scope: 'all',      rank: 90,  caps: ['org', 'manage', 'ops', 'reports', 'central'] },
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

// The live registry, populated from the DB by reloadRoles().
let ROLE_DEFS = {};
let ROLE_KEYS = [];

// Permission groups — STABLE instances, repopulated in place on reload so any
// held reference (route guards, inline checks) stays live.
const ROLES = { ALL: [], ADMIN: [], MANAGE: [], OPS: [], REPORTS: [], CENTRAL: [], DELIVERY: [], SCHEDULED: [] };
const setArr = (arr, vals) => { arr.length = 0; for (const v of vals) arr.push(v); };
const uniq = (a) => [...new Set(a)];

// Insert any missing built-in roles (adds new code-defined roles without
// clobbering rows an admin has edited). Best-effort — the table may not exist yet.
function ensureSeeded() {
  try {
    const ins = db.prepare(`INSERT OR IGNORE INTO roles (key,label,scope,rank,caps,is_builtin,is_active) VALUES (?,?,?,?,?,1,1)`);
    for (const [key, d] of Object.entries(DEFAULT_ROLE_DEFS)) ins.run(key, d.label, d.scope, d.rank, JSON.stringify(d.caps));
  } catch { /* table not migrated yet in this context */ }
}

// Rebuild ROLE_DEFS + the ROLES.* groups from the DB (fallback: code defaults).
function reloadRoles() {
  let rows = [];
  try { rows = db.prepare(`SELECT key,label,scope,rank,caps,is_builtin FROM roles WHERE is_active=1`).all(); } catch { rows = []; }
  const defs = {};
  if (rows.length) {
    for (const r of rows) {
      let caps = [];
      try { caps = JSON.parse(r.caps || '[]'); } catch { caps = []; }
      defs[r.key] = { label: r.label, scope: r.scope, rank: r.rank, caps: caps.filter((c) => CAPS.includes(c)), builtin: !!r.is_builtin };
    }
  } else {
    for (const [key, d] of Object.entries(DEFAULT_ROLE_DEFS)) defs[key] = { ...d, builtin: true };
  }
  ROLE_DEFS = defs;
  ROLE_KEYS = Object.keys(defs);
  const withCap = (cap) => ROLE_KEYS.filter((k) => defs[k].caps.includes(cap));
  setArr(ROLES.ALL, ROLE_KEYS);
  setArr(ROLES.ADMIN, withCap('org'));
  setArr(ROLES.MANAGE, withCap('manage'));
  setArr(ROLES.OPS, withCap('ops'));
  setArr(ROLES.REPORTS, withCap('reports'));
  setArr(ROLES.CENTRAL, withCap('central'));
  setArr(ROLES.DELIVERY, uniq([...withCap('central'), ...withCap('delivery')]));
  setArr(ROLES.SCHEDULED, ROLE_KEYS.filter((k) => defs[k].scope !== 'all'));
}

ensureSeeded();
reloadRoles();

const roleScope = (role) => (ROLE_DEFS[role] ? ROLE_DEFS[role].scope : 'self');
const seesAllLocations = (role) => roleScope(role) === 'all';
const roleLabel = (role) => (ROLE_DEFS[role] ? ROLE_DEFS[role].label : role);
const roleHasCap = (role, cap) => !!(ROLE_DEFS[role] && ROLE_DEFS[role].caps.includes(cap));
// Public view of the registry for the frontend (labels, scope, caps, builtin).
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

// Accepts explicit role names — requireRole('owner','admin') — OR a single live
// group array — requireRole(ROLES.MANAGE) — which is read at request time so it
// tracks runtime edits to the registry.
function requireRole(...roles) {
  const live = roles.length === 1 && Array.isArray(roles[0]);
  const list = live ? roles[0] : roles;
  return (req, res, next) => {
    if (!req.user || !list.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action.' });
    }
    next();
  };
}

module.exports = {
  signToken, verifyToken, requireRole, SECRET,
  ROLES, ROLE_DEFS, CAPS, SCOPES, DEFAULT_ROLE_DEFS,
  roleScope, seesAllLocations, roleLabel, roleHasCap, publicRoles, reloadRoles,
};
