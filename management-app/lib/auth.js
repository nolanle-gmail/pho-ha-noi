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
//             exec     Advanced-Admin tier: unlocks the "secret" executive modules
//                      (Integrations, Financials, …) and lets the holder manage the
//                      exec tier itself. Only Owner + Advanced Admin carry it.
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
const CAPS = ['org', 'manage', 'ops', 'reports', 'central', 'delivery', 'exec'];
const SCOPES = ['all', 'location', 'self'];

// Built-in defaults — seed the `roles` table, and a fallback if the DB is empty.
const DEFAULT_ROLE_DEFS = {
  // Executive / all-location administration
  owner:             { label: 'Owner',             scope: 'all',      rank: 100, caps: ['org', 'manage', 'ops', 'reports', 'central', 'exec'] },
  // Advanced Admin — the tier above regular Admin: everything Admin has PLUS the
  // exec cap (secret executive modules + authority over the exec tier). Assign only
  // the few people who should see financials/integrations (e.g. Nha Le); Owner also
  // carries exec. Rank 97 sits above Admin (95) and below President/CEO.
  advanced_admin:    { label: 'Advanced Admin',    scope: 'all',      rank: 97,  caps: ['org', 'manage', 'ops', 'reports', 'central', 'exec'] },
  ceo:               { label: 'CEO',               scope: 'all',      rank: 99,  caps: ['org', 'manage', 'ops', 'reports', 'central'] },
  president:         { label: 'President',         scope: 'all',      rank: 98,  caps: ['org', 'manage', 'ops', 'reports', 'central'] },
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
const ROLES = { ALL: [], ADMIN: [], EXEC: [], MANAGE: [], OPS: [], REPORTS: [], CENTRAL: [], DELIVERY: [], SCHEDULED: [] };
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
  // Per-role "view only" (whole access level is read-only). Best-effort + separate
  // from the main SELECT so a DB that hasn't run the view_only migration yet still
  // loads every role normally (the column simply reads as absent → not view-only).
  try {
    const vo = db.prepare(`SELECT key FROM roles WHERE view_only=1`).all();
    const voSet = new Set(vo.map((r) => r.key));
    for (const k of Object.keys(defs)) defs[k].view_only = voSet.has(k);
  } catch { for (const k of Object.keys(defs)) defs[k].view_only = false; }
  ROLE_DEFS = defs;
  ROLE_KEYS = Object.keys(defs);
  const withCap = (cap) => ROLE_KEYS.filter((k) => defs[k].caps.includes(cap));
  setArr(ROLES.ALL, ROLE_KEYS);
  setArr(ROLES.ADMIN, withCap('org'));
  setArr(ROLES.EXEC, withCap('exec'));
  setArr(ROLES.MANAGE, withCap('manage'));
  setArr(ROLES.OPS, withCap('ops'));
  setArr(ROLES.REPORTS, withCap('reports'));
  setArr(ROLES.CENTRAL, withCap('central'));
  setArr(ROLES.DELIVERY, uniq([...withCap('central'), ...withCap('delivery')]));
  setArr(ROLES.SCHEDULED, ROLE_KEYS.filter((k) => defs[k].scope !== 'all'));
}

// One-time patch: the owner role was seeded before the `exec` cap existed, and
// ensureSeeded's INSERT OR IGNORE never updates an existing row — so give the
// already-seeded owner the exec cap here (idempotent). Advanced Admin is a brand-new
// key, so ensureSeeded inserts it with exec already in its caps.
function ensureOwnerExec() {
  try {
    const r = db.prepare(`SELECT caps FROM roles WHERE key='owner'`).get();
    if (!r) return;
    let caps = []; try { caps = JSON.parse(r.caps || '[]'); } catch { caps = []; }
    if (!caps.includes('exec')) { caps.push('exec'); db.prepare(`UPDATE roles SET caps=? WHERE key='owner'`).run(JSON.stringify(caps)); }
  } catch { /* table not migrated yet in this context */ }
}

ensureSeeded();
ensureOwnerExec();
reloadRoles();

const roleScope = (role) => (ROLE_DEFS[role] ? ROLE_DEFS[role].scope : 'self');
const seesAllLocations = (role) => roleScope(role) === 'all';
// Request-aware "sees every location": the role's own scope OR a per-user grant
// (view_all_locations). Use this at request time in place of
// seesAllLocations(req.user.role) so a specific person can be opened up to all stores.
const userSeesAll = (req) => seesAllLocations(req.user && req.user.role) || !!(req.user && req.user.view_all_locations);
const roleLabel = (role) => (ROLE_DEFS[role] ? ROLE_DEFS[role].label : role);
const roleHasCap = (role, cap) => !!(ROLE_DEFS[role] && ROLE_DEFS[role].caps.includes(cap));
const roleViewOnly = (role) => !!(ROLE_DEFS[role] && ROLE_DEFS[role].view_only);
const roleRank = (role) => (ROLE_DEFS[role] ? (ROLE_DEFS[role].rank || 0) : 0);
// The exec (Advanced-Admin) tier — Owner + Advanced Admin. Used to protect the tier:
// only an exec holder may create/edit/assign an exec-capable role or account.
const isExecRole = (role) => roleHasCap(role, 'exec');
// Public view of the registry for the frontend (labels, scope, caps, builtin).
const publicRoles = () => ROLE_KEYS.map((key) => ({ key, ...ROLE_DEFS[key] }));

function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, role: user.role, location_id: user.location_id },
    SECRET,
    { expiresIn: EXPIRES }
  );
}

// Read-only (view-but-not-modify) principals may still reach these path prefixes
// with a write — sign-in/out, and communication — everything else operational is
// blocked. GET/HEAD/OPTIONS are always allowed.
const READONLY_WRITE_OK = ['/api/auth', '/api/messages', '/api/chat'];
const isWriteMethod = (m) => m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';

// Resolve a signed-in user's live access grants (read fresh from the DB so a change
// takes effect without re-login): whether they're read-only (their own flag OR their
// role being view-only) and whether they may see every location.
function loadGrants(user) {
  const out = { read_only: roleViewOnly(user.role), view_all_locations: false };
  try {
    const g = db.prepare(`SELECT read_only, view_all_locations FROM users WHERE id=?`).get(user.id);
    if (g) { out.read_only = out.read_only || !!g.read_only; out.view_all_locations = !!g.view_all_locations; }
  } catch { /* columns not migrated yet — treat as no override */ }
  return out;
}

function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  let payload;
  try { payload = jwt.verify(token, SECRET); }
  catch { return res.status(401).json({ error: 'Invalid or expired session' }); }
  req.user = payload;
  // Augment with live per-user grants (read-only + see-all-locations).
  const g = loadGrants(payload);
  req.user.read_only = g.read_only;
  req.user.view_all_locations = g.view_all_locations;
  // Enforce read-only: block operational writes, keeping sign-in/out + messaging.
  if (req.user.read_only && isWriteMethod(req.method)) {
    const url = req.originalUrl || req.url || '';
    if (!READONLY_WRITE_OK.some((p) => url.startsWith(p))) {
      return res.status(403).json({ error: 'Your access is view-only — you can see this but not change it.' });
    }
  }
  next();
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
  roleScope, seesAllLocations, userSeesAll, roleLabel, roleHasCap, roleViewOnly, roleRank, isExecRole, publicRoles, reloadRoles,
};
