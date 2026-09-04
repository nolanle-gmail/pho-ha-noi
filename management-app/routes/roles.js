// Access-level registry management — the "Roles" on the Access Levels page.
// Owner/Admin (the org-admin capability) can add, edit and remove roles; the
// changes take effect immediately because lib/auth reloads the live registry.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, CAPS, SCOPES, publicRoles, reloadRoles } = require('../lib/auth');
const { auditLog } = require('../lib/audit');

const router = express.Router();
router.use(verifyToken);

const KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;      // role key (identifier)
const cleanCaps = (v) => (Array.isArray(v) ? [...new Set(v.filter((c) => CAPS.includes(c)))] : []);
const cleanScope = (v) => (SCOPES.includes(v) ? v : null);
const cleanRank = (v, dflt) => (Number.isInteger(v) && v >= 0 && v <= 1000 ? v : dflt);
const usersWith = (key) => db.prepare(`SELECT COUNT(*) c FROM users WHERE role=?`).get(key).c;

// List every role (any signed-in user — labels/scope/caps drive the UI & nav).
router.get('/', (req, res) => res.json(publicRoles()));

// Add a role (org admin).
router.post('/', requireRole(ROLES.ADMIN), (req, res) => {
  const key = String(req.body.key || '').toLowerCase().trim();
  if (!KEY_RE.test(key)) return res.status(400).json({ error: 'Key must be 2–32 chars: a lowercase letter, then letters, digits or underscores.' });
  if (db.prepare(`SELECT 1 FROM roles WHERE key=?`).get(key)) return res.status(409).json({ error: 'A role with that key already exists.' });
  const label = String(req.body.label || '').trim().slice(0, 60);
  if (!label) return res.status(400).json({ error: 'A display name is required.' });
  const scope = cleanScope(req.body.scope);
  if (!scope) return res.status(400).json({ error: 'Access level must be all, location or self.' });
  const caps = cleanCaps(req.body.caps);
  const rank = cleanRank(req.body.rank, 10);
  db.prepare(`INSERT INTO roles (key,label,scope,rank,caps,is_builtin,is_active) VALUES (?,?,?,?,?,0,1)`)
    .run(key, label, scope, rank, JSON.stringify(caps));
  reloadRoles();
  auditLog(req, 'role_create', 'role', key, { label, scope, caps });
  res.json({ success: true, key });
});

// Edit a role (org admin). Owner is protected from being locked out.
router.put('/:key', requireRole(ROLES.ADMIN), (req, res) => {
  const r = db.prepare(`SELECT * FROM roles WHERE key=?`).get(req.params.key);
  if (!r) return res.status(404).json({ error: 'Role not found.' });
  const label = req.body.label !== undefined ? String(req.body.label).trim().slice(0, 60) : r.label;
  if (!label) return res.status(400).json({ error: 'A display name is required.' });
  let scope = req.body.scope !== undefined ? cleanScope(req.body.scope) : r.scope;
  if (!scope) return res.status(400).json({ error: 'Access level must be all, location or self.' });
  let caps = req.body.caps !== undefined ? cleanCaps(req.body.caps) : (JSON.parse(r.caps || '[]'));
  const rank = req.body.rank !== undefined ? cleanRank(req.body.rank, r.rank) : r.rank;
  // Never lock the platform out of its owner: keep Owner all-scope with org admin.
  if (r.key === 'owner') { scope = 'all'; caps = [...new Set([...caps, 'org', 'manage', 'ops', 'reports', 'central'])]; }
  db.prepare(`UPDATE roles SET label=?, scope=?, rank=?, caps=? WHERE key=?`)
    .run(label, scope, rank, JSON.stringify(caps), r.key);
  reloadRoles();
  auditLog(req, 'role_update', 'role', r.key, { label, scope, caps });
  res.json({ success: true });
});

// Remove a role (org admin). Owner/Admin are required; a role still assigned to
// staff can't be removed until those people are reassigned.
router.delete('/:key', requireRole(ROLES.ADMIN), (req, res) => {
  const key = req.params.key;
  if (key === 'owner' || key === 'admin') return res.status(400).json({ error: 'The Owner and Admin roles are required and can’t be removed.' });
  const r = db.prepare(`SELECT * FROM roles WHERE key=?`).get(key);
  if (!r) return res.status(404).json({ error: 'Role not found.' });
  const inUse = usersWith(key);
  if (inUse) return res.status(409).json({ error: `${inUse} staff member${inUse > 1 ? 's' : ''} still ${inUse > 1 ? 'use' : 'uses'} this role — reassign ${inUse > 1 ? 'them' : 'that person'} first.` });
  db.prepare(`DELETE FROM roles WHERE key=?`).run(key);
  reloadRoles();
  auditLog(req, 'role_delete', 'role', key, { label: r.label });
  res.json({ success: true });
});

module.exports = router;
