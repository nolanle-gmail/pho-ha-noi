// Cross-module endpoints for the management shell (staff management, etc.).
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations } = require('../lib/auth');
const { auditLog } = require('../lib/audit');

const router = express.Router();
router.use(verifyToken);

// Staff directory. Owner/admin see all locations; managers see their own (view only).
router.get('/staff', requireRole(...ROLES.MANAGE), (req, res) => {
  const scopeAll = seesAllLocations(req.user.role);
  const where = scopeAll ? '' : 'WHERE u.location_id=?';
  const args = scopeAll ? [] : [req.user.location_id];
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.location_id, u.is_active, l.name AS location_name,
           sp.status AS work_status
    FROM users u LEFT JOIN locations l ON u.location_id=l.id
    LEFT JOIN staff_profiles sp ON sp.user_id=u.id
    ${where}
    ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'support' THEN 3 ELSE 4 END, u.name
  `).all(...args);
  res.json(rows);
});

// Staff overview: per-location roster health (count, manager, status breakdown).
router.get('/staff/overview', requireRole(...ROLES.MANAGE), (req, res) => {
  const scopeAll = seesAllLocations(req.user.role);
  const locs = db.prepare(`SELECT id, name FROM locations WHERE is_active=1 ${scopeAll ? '' : 'AND id=?'} ORDER BY name`)
    .all(...(scopeAll ? [] : [req.user.location_id]));
  const displayStatus = (u) => (!u.is_active ? 'inactive' : (u.status || 'active'));
  const rows = locs.map((l) => {
    const staff = db.prepare(`SELECT u.is_active, sp.status FROM users u LEFT JOIN staff_profiles sp ON sp.user_id=u.id WHERE u.location_id=?`).all(l.id);
    const mgr = db.prepare(`SELECT name FROM users WHERE location_id=? AND role IN ('manager','admin') AND is_active=1
      ORDER BY CASE role WHEN 'manager' THEN 0 ELSE 1 END, name LIMIT 1`).get(l.id);
    const count = (s) => staff.filter((u) => displayStatus(u) === s).length;
    return {
      location_id: l.id, location_name: l.name, manager: mgr ? mgr.name : null,
      total: staff.length, active: count('active'), inactive: count('inactive'),
      vacation: count('vacation'), sick: count('sick'),
    };
  });
  res.json(rows);
});

// Resolve the location for a role: owner/admin have none; others require one.
function resolveLocation(role, provided, fallback) {
  if (seesAllLocations(role)) return { location_id: null };
  const loc = (provided !== undefined ? provided : fallback) || null;
  if (!loc) return { error: 'This access level requires a location.' };
  return { location_id: loc };
}

// Create a staff account (owner/admin only).
router.post('/staff', requireRole(...ROLES.ADMIN), (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!ROLES.ALL.includes(role)) return res.status(400).json({ error: 'Invalid access level.' });
  if (role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Only an owner can create owner accounts.' });
  const loc = resolveLocation(role, req.body.location_id, null);
  if (loc.error) return res.status(400).json({ error: loc.error });
  const em = String(email).toLowerCase().trim();
  if (db.prepare(`SELECT id FROM users WHERE email=?`).get(em)) return res.status(409).json({ error: 'That email is already in use.' });
  const r = db.prepare(`INSERT INTO users (name,email,password_hash,role,location_id) VALUES (?,?,?,?,?)`)
    .run(String(name).slice(0, 120), em, bcrypt.hashSync(String(password), 10), role, loc.location_id);
  auditLog(req, 'staff_create', 'user', r.lastInsertRowid, { name, email: em, role });
  res.json({ success: true, id: r.lastInsertRowid });
});

// Update a staff account (owner/admin only).
router.put('/staff/:id', requireRole(...ROLES.ADMIN), (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });
  const fields = [], vals = [];

  if (req.body.name !== undefined) { fields.push('name=?'); vals.push(String(req.body.name).slice(0, 120)); }

  const newRole = req.body.role;
  if (newRole !== undefined) {
    if (!ROLES.ALL.includes(newRole)) return res.status(400).json({ error: 'Invalid access level.' });
    if (newRole === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Only an owner can assign the owner level.' });
    if (u.role === 'owner' && newRole !== 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Only an owner can change an owner account.' });
    fields.push('role=?'); vals.push(newRole);
  }

  // Keep role/location consistent whenever either changes.
  if (newRole !== undefined || req.body.location_id !== undefined) {
    const loc = resolveLocation(newRole !== undefined ? newRole : u.role, req.body.location_id, u.location_id);
    if (loc.error) return res.status(400).json({ error: loc.error });
    fields.push('location_id=?'); vals.push(loc.location_id);
  }

  if (req.body.is_active !== undefined) {
    if (Number(req.params.id) === req.user.id && !req.body.is_active) return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    fields.push('is_active=?'); vals.push(req.body.is_active ? 1 : 0);
  }

  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(u.id);
  db.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).run(...vals);
  auditLog(req, 'staff_update', 'user', u.id, { name: u.name, changes: req.body });
  res.json({ success: true });
});

// Reset a staff member's password (owner/admin only).
router.post('/staff/:id/reset-password', requireRole(...ROLES.ADMIN), (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });
  const p = req.body.new_password;
  if (!p || String(p).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(bcrypt.hashSync(String(p), 10), u.id);
  auditLog(req, 'staff_reset_password', 'user', u.id, { name: u.name });
  res.json({ success: true });
});

// ── Staff profile (full HR record) ───────────────────────────────────────────
const PROFILE_COLS = [
  'preferred_name', 'legal_first_name', 'legal_last_name', 'dob', 'gender',
  'personal_email', 'phone', 'alt_phone', 'address_line1', 'address_line2',
  'city', 'state', 'postal_code', 'country', 'emergency_name', 'emergency_relation',
  'emergency_phone', 'employee_code', 'job_title', 'department', 'employment_type',
  'status', 'hire_date', 'termination_date', 'supervisor_id', 'pay_type', 'payroll_ref',
  'preferred_contact', 'skills', 'notes',
];

// View a full profile (owner/admin/manager).
router.get('/staff/:id/profile', requireRole(...ROLES.MANAGE), (req, res) => {
  const u = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.location_id, u.hourly_rate, u.is_active, u.created_at,
      l.name AS location_name FROM users u LEFT JOIN locations l ON u.location_id=l.id WHERE u.id=?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found.' });
  const profile = db.prepare(`SELECT * FROM staff_profiles WHERE user_id=?`).get(u.id) || {};
  const assigned = db.prepare(`SELECT location_id FROM staff_locations WHERE user_id=?`).all(u.id).map(r => r.location_id);
  const supervisor = profile.supervisor_id ? db.prepare(`SELECT id, name FROM users WHERE id=?`).get(profile.supervisor_id) : null;
  res.json({ ...u, profile, assigned_location_ids: assigned, supervisor });
});

// Update a profile (owner/admin only).
router.put('/staff/:id/profile', requireRole(...ROLES.ADMIN), (req, res) => {
  const u = db.prepare(`SELECT id FROM users WHERE id=?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found.' });
  const b = req.body || {};

  // Pay rate lives on users.
  if (b.hourly_rate !== undefined) db.prepare(`UPDATE users SET hourly_rate=? WHERE id=?`).run(Math.max(0, parseFloat(b.hourly_rate) || 0), u.id);

  // Merge provided fields over the existing profile, then upsert.
  const existing = db.prepare(`SELECT * FROM staff_profiles WHERE user_id=?`).get(u.id) || {};
  const merged = {};
  for (const c of PROFILE_COLS) {
    merged[c] = b[c] !== undefined ? (b[c] === '' ? null : b[c]) : (existing[c] ?? null);
  }
  if (merged.supervisor_id != null && merged.supervisor_id !== '') merged.supervisor_id = parseInt(merged.supervisor_id, 10) || null;

  const placeholders = PROFILE_COLS.map(() => '?').join(',');
  const updates = PROFILE_COLS.map(c => `${c}=excluded.${c}`).join(', ');
  db.prepare(`INSERT INTO staff_profiles (user_id, ${PROFILE_COLS.join(',')}, updated_at)
     VALUES (?, ${placeholders}, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET ${updates}, updated_at=datetime('now')`)
    .run(u.id, ...PROFILE_COLS.map(c => merged[c]));

  // Assigned (additional) locations.
  if (Array.isArray(b.assigned_location_ids)) {
    db.prepare(`DELETE FROM staff_locations WHERE user_id=?`).run(u.id);
    const ins = db.prepare(`INSERT OR IGNORE INTO staff_locations (user_id, location_id) VALUES (?,?)`);
    for (const lid of b.assigned_location_ids) { const n = parseInt(lid, 10); if (n) ins.run(u.id, n); }
  }

  auditLog(req, 'staff_profile_update', 'user', u.id, { fields: Object.keys(b) });
  res.json({ success: true });
});

module.exports = router;
