// Cross-module endpoints for the management shell (staff management, etc.).
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES, seesAllLocations } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const { normalizePhone, isValidPhone } = require('../lib/phone');

const router = express.Router();
router.use(verifyToken);

// Staff directory. Owner/admin see all locations; managers see their own (view only).
router.get('/staff', requireRole(ROLES.MANAGE), (req, res) => {
  const scopeAll = seesAllLocations(req.user.role);
  const where = scopeAll ? '' : 'WHERE u.location_id=?';
  const args = scopeAll ? [] : [req.user.location_id];
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.employee_code, u.role, u.location_id, u.is_active, l.name AS location_name,
           sp.status AS work_status, sp.job_title
    FROM users u LEFT JOIN locations l ON u.location_id=l.id
    LEFT JOIN staff_profiles sp ON sp.user_id=u.id
    ${where}
    ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'hr' THEN 2 WHEN 'manager' THEN 3 WHEN 'support' THEN 4 ELSE 5 END, u.name
  `).all(...args);
  res.json(rows);
});

// Staff overview: per-location roster health (count, manager, status breakdown).
router.get('/staff/overview', requireRole(ROLES.MANAGE), (req, res) => {
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

// Who may edit a given staff member. Owner/admin: anyone. A manager: their own
// store's staff (all-location managers: any store), but never an owner/admin
// account. Changing access level or home location stays owner/admin-only.
function canEditStaff(req, target) {
  if (ROLES.ADMIN.includes(req.user.role)) return true;
  if (!ROLES.MANAGE.includes(req.user.role)) return false;
  if (ROLES.ADMIN.includes(target.role)) return false;
  if (seesAllLocations(req.user.role)) return true;
  return String(target.location_id) === String(req.user.location_id);
}
const isAdminEditor = (req) => ROLES.ADMIN.includes(req.user.role);

// Resolve the location for a role: owner/admin have none; others require one.
function resolveLocation(role, provided, fallback) {
  if (seesAllLocations(role)) return { location_id: null };
  const loc = (provided !== undefined ? provided : fallback) || null;
  if (!loc) return { error: 'This role requires a location.' };
  return { location_id: loc };
}

// Create a staff account (owner/admin only).
router.post('/staff', requireRole(ROLES.ADMIN), (req, res) => {
  const { name, email, password, role, phone } = req.body || {};
  // Phone is the login credential and is required; email is optional (kept for the
  // internal directory/messaging identity — a placeholder is generated if omitted).
  if (!name || !password) return res.status(400).json({ error: 'Name and password are required.' });
  if (!phone) return res.status(400).json({ error: 'Phone number is required.' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'Enter a 10-digit phone number.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!ROLES.ALL.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Only an owner can create owner accounts.' });
  const loc = resolveLocation(role, req.body.location_id, null);
  if (loc.error) return res.status(400).json({ error: loc.error });
  const ph = normalizePhone(phone);
  if (db.prepare(`SELECT id FROM users WHERE phone=?`).get(ph)) return res.status(409).json({ error: 'That phone number is already in use.' });
  const em = email ? String(email).toLowerCase().trim() : `p${ph}@staff.phohanoi.local`;
  if (db.prepare(`SELECT id FROM users WHERE email=?`).get(em)) return res.status(409).json({ error: 'That email is already in use.' });
  const r = db.prepare(`INSERT INTO users (name,email,phone,password_hash,role,location_id) VALUES (?,?,?,?,?,?)`)
    .run(String(name).slice(0, 120), em, ph, bcrypt.hashSync(String(password), 10), role, loc.location_id);
  auditLog(req, 'staff_create', 'user', r.lastInsertRowid, { name, email: em, phone: ph, role });
  res.json({ success: true, id: r.lastInsertRowid });
});

// Update a staff account. Owner/admin: any staff, all fields. Managers: their own
// store's staff — name and active status only (access level & location are
// owner/admin-only).
router.put('/staff/:id', requireRole(ROLES.MANAGE), (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });
  if (!canEditStaff(req, u)) return res.status(403).json({ error: 'You can only edit staff at your own location.' });
  if (!isAdminEditor(req) && (req.body.role !== undefined || req.body.location_id !== undefined)) {
    return res.status(403).json({ error: 'Only an owner or admin can change role or location.' });
  }
  const fields = [], vals = [];

  if (req.body.name !== undefined) { fields.push('name=?'); vals.push(String(req.body.name).slice(0, 120)); }

  // Phone is the login credential — validate, normalize and keep it unique.
  if (req.body.phone !== undefined) {
    if (!isValidPhone(req.body.phone)) return res.status(400).json({ error: 'Enter a 10-digit phone number.' });
    const ph = normalizePhone(req.body.phone);
    const clash = db.prepare(`SELECT id FROM users WHERE phone=? AND id<>?`).get(ph, u.id);
    if (clash) return res.status(409).json({ error: 'That phone number is already in use.' });
    fields.push('phone=?'); vals.push(ph);
  }

  const newRole = req.body.role;
  if (newRole !== undefined) {
    if (!ROLES.ALL.includes(newRole)) return res.status(400).json({ error: 'Invalid role.' });
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

// Reset a staff member's password (owner/admin, or a manager for their own staff).
router.post('/staff/:id/reset-password', requireRole(ROLES.MANAGE), (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found' });
  if (!canEditStaff(req, u)) return res.status(403).json({ error: 'You can only manage staff at your own location.' });
  const p = req.body.new_password;
  if (!p || String(p).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(bcrypt.hashSync(String(p), 10), u.id);
  auditLog(req, 'staff_reset_password', 'user', u.id, { name: u.name });
  res.json({ success: true });
});

// ── Staff profile (full HR record) ───────────────────────────────────────────
const SIX_DIGITS = /^\d{6}$/;
// Derive an employee code from a date of birth (YYYY-MM-DD) as MMDDYY.
// e.g. 2010-01-01 → "010110".
function codeFromDob(dob) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dob || '').trim());
  return m ? m[2] + m[3] + m[1].slice(2) : '';
}
// Is this 6-digit employee code already taken by someone else?
function employeeCodeClash(code, exceptUserId) {
  return !!(db.prepare(`SELECT id FROM users WHERE employee_code=? AND id<>?`).get(code, exceptUserId)
    || db.prepare(`SELECT user_id FROM staff_profiles WHERE employee_code=? AND user_id<>?`).get(code, exceptUserId));
}

// Transform a 9-digit personal ID into its stored form:
//   first 5 digits: d<9 → d+1, 9 → 'B';  last 4 digits: d≠0 → d−1, 0 → 'A'.
// e.g. 012495930 → 1235B482A.
function transformPersonalId(digits) {
  const s = String(digits);
  if (!/^\d{9}$/.test(s)) return null;
  let out = '';
  for (let i = 0; i < 5; i++) { const d = +s[i]; out += d === 9 ? 'B' : String(d + 1); }
  for (let i = 5; i < 9; i++) { const d = +s[i]; out += d === 0 ? 'A' : String(d - 1); }
  return out;
}

const PROFILE_COLS = [
  'preferred_name', 'legal_first_name', 'legal_last_name', 'dob', 'gender', 'personal_id',
  'personal_email', 'phone', 'alt_phone', 'address_line1', 'address_line2',
  'city', 'state', 'postal_code', 'country', 'emergency_name', 'emergency_relation',
  'emergency_phone', 'employee_code', 'job_title', 'department', 'employment_type',
  'status', 'hire_date', 'termination_date', 'supervisor_id', 'pay_type', 'payroll_ref',
  'preferred_contact', 'skills', 'notes',
];

// View a full profile (owner/admin/manager).
router.get('/staff/:id/profile', requireRole(ROLES.MANAGE), (req, res) => {
  const u = db.prepare(`SELECT u.id, u.name, u.email, u.phone, u.role, u.location_id, u.hourly_rate, u.is_active, u.created_at,
      l.name AS location_name FROM users u LEFT JOIN locations l ON u.location_id=l.id WHERE u.id=?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found.' });
  const profile = db.prepare(`SELECT * FROM staff_profiles WHERE user_id=?`).get(u.id) || {};
  const assigned = db.prepare(`SELECT location_id FROM staff_locations WHERE user_id=?`).all(u.id).map(r => r.location_id);
  const supervisor = profile.supervisor_id ? db.prepare(`SELECT id, name FROM users WHERE id=?`).get(profile.supervisor_id) : null;
  res.json({ ...u, profile, assigned_location_ids: assigned, supervisor });
});

// Update a profile (owner/admin, or a manager for their own staff).
router.put('/staff/:id/profile', requireRole(ROLES.MANAGE), (req, res) => {
  const u = db.prepare(`SELECT id, role, location_id FROM users WHERE id=?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Staff member not found.' });
  if (!canEditStaff(req, u)) return res.status(403).json({ error: 'You can only edit staff at your own location.' });
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

  // Employee code. A manually entered code must be exactly 6 digits; a blank code
  // is derived from the date of birth (MMDDYY). Only touched when the request
  // actually changes it (so legacy non-6-digit codes survive an unrelated edit),
  // or when it's blank and none is set yet. Kept unique and synced to users so the
  // time-clock (which logs in by code) matches.
  let codeToSync;
  if (b.employee_code !== undefined) {
    const requested = String(b.employee_code || '').trim();
    const current = String(existing.employee_code || '');
    if (requested !== current || (!requested && !current)) {
      let code = requested || codeFromDob(b.dob !== undefined ? b.dob : existing.dob);
      if (code) {
        if (!SIX_DIGITS.test(code)) return res.status(400).json({ error: 'Employee code must be exactly 6 digits.' });
        if (employeeCodeClash(code, u.id)) return res.status(409).json({ error: `Employee code ${code} is already in use.` });
        merged.employee_code = code;
        codeToSync = code;
      } else if (requested !== current) {
        return res.status(400).json({ error: 'Enter a 6-digit employee code, or add a date of birth to generate one.' });
      }
    }
  }

  // Personal ID: entered as 9 digits, stored in its transformed form. Only
  // (re)transform when the value actually changes, so the already-transformed
  // stored value survives an unrelated edit (never double-encoded).
  if (b.personal_id !== undefined) {
    const requested = String(b.personal_id || '').trim();
    const current = String(existing.personal_id || '');
    if (requested !== current) {
      if (!requested) merged.personal_id = null;
      else if (/^\d{9}$/.test(requested)) merged.personal_id = transformPersonalId(requested);
      else return res.status(400).json({ error: 'Personal ID must be exactly 9 digits.' });
    }
  }

  const placeholders = PROFILE_COLS.map(() => '?').join(',');
  const updates = PROFILE_COLS.map(c => `${c}=excluded.${c}`).join(', ');
  db.prepare(`INSERT INTO staff_profiles (user_id, ${PROFILE_COLS.join(',')}, updated_at)
     VALUES (?, ${placeholders}, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET ${updates}, updated_at=datetime('now')`)
    .run(u.id, ...PROFILE_COLS.map(c => merged[c]));

  // Keep users.employee_code (used by the time-clock login) in sync.
  if (codeToSync !== undefined) db.prepare(`UPDATE users SET employee_code=? WHERE id=?`).run(codeToSync, u.id);

  // Assigned (additional) locations.
  if (Array.isArray(b.assigned_location_ids)) {
    db.prepare(`DELETE FROM staff_locations WHERE user_id=?`).run(u.id);
    const ins = db.prepare(`INSERT OR IGNORE INTO staff_locations (user_id, location_id) VALUES (?,?)`);
    for (const lid of b.assigned_location_ids) { const n = parseInt(lid, 10); if (n) ins.run(u.id, n); }
  }

  auditLog(req, 'staff_profile_update', 'user', u.id, { fields: Object.keys(b) });
  res.json({ success: true });
});

// ── Staff document holder (contracts, certificates, licenses, scans…) ────────
// Files are stored as bytes with an optional note. Same access as editing the
// person's profile: owner/admin any staff, a manager their own store's staff.
const DOC_MAX = parseInt(process.env.STAFF_DOC_MAX || '', 10) || 25 * 1024 * 1024;
const OK_DOC = /^(image\/(jpeg|png|webp|heic|heif|gif|tiff|bmp)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml|spreadsheetml|presentationml)\.[a-z]+|application\/vnd\.ms-(excel|powerpoint)|text\/(plain|csv))$/i;

// Resolve the staff member and confirm the caller may manage their documents.
function docAccess(req, res) {
  const u = db.prepare(`SELECT id, role, location_id, name FROM users WHERE id=?`).get(req.params.id);
  if (!u) { res.status(404).json({ error: 'Staff member not found.' }); return null; }
  if (!canEditStaff(req, u)) { res.status(403).json({ error: 'You can only manage documents for staff at your own location.' }); return null; }
  return u;
}

// List a staff member's documents (metadata only).
router.get('/staff/:id/documents', requireRole(ROLES.MANAGE), (req, res) => {
  const u = docAccess(req, res); if (!u) return;
  const docs = db.prepare(`SELECT d.id, d.filename, d.mime, d.byte_size, d.note, d.created_at, up.name AS uploaded_by_name
    FROM staff_documents d LEFT JOIN users up ON up.id=d.uploaded_by WHERE d.user_id=? ORDER BY d.id DESC`).all(u.id);
  res.json({ documents: docs });
});

// Upload a document (raw bytes; ?filename= & ?note= in the query).
router.post('/staff/:id/documents', express.raw({ type: () => true, limit: DOC_MAX }), (req, res) => {
  const u = docAccess(req, res); if (!u) return;
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!OK_DOC.test(mime)) return res.status(415).json({ error: 'Unsupported file type. Upload an image, PDF, Word/Excel/PowerPoint, or text file.' });
  const bytes = req.body;
  if (!Buffer.isBuffer(bytes) || !bytes.length) return res.status(400).json({ error: 'No file received.' });
  if (bytes.length > DOC_MAX) return res.status(413).json({ error: `File too large (max ${Math.round(DOC_MAX / 1048576)} MB).` });
  const filename = String(req.query.filename || '').slice(0, 200) || null;
  const note = String(req.query.note || '').slice(0, 500) || null;
  const info = db.prepare(`INSERT INTO staff_documents (user_id, filename, mime, byte_size, note, bytes, uploaded_by) VALUES (?,?,?,?,?,?,?)`)
    .run(u.id, filename, mime, bytes.length, note, bytes, req.user.id);
  auditLog(req, 'staff_document_add', 'user', u.id, { document_id: Number(info.lastInsertRowid), filename, note });
  res.json({ success: true, id: Number(info.lastInsertRowid) });
});

// Update a document's note.
router.put('/staff/:id/documents/:docId', requireRole(ROLES.MANAGE), (req, res) => {
  const u = docAccess(req, res); if (!u) return;
  const doc = db.prepare(`SELECT id FROM staff_documents WHERE id=? AND user_id=?`).get(req.params.docId, u.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  db.prepare(`UPDATE staff_documents SET note=? WHERE id=?`).run(String(req.body && req.body.note || '').slice(0, 500) || null, doc.id);
  res.json({ success: true });
});

// Stream a document's bytes (download / inline view).
router.get('/staff/:id/documents/:docId', requireRole(ROLES.MANAGE), (req, res) => {
  const u = docAccess(req, res); if (!u) return;
  const doc = db.prepare(`SELECT filename, mime, bytes FROM staff_documents WHERE id=? AND user_id=?`).get(req.params.docId, u.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const buf = Buffer.from(doc.bytes);
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Content-Disposition', `inline; filename="${(doc.filename || 'document').replace(/[^\w.\-]+/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(buf);
});

// Remove a document.
router.delete('/staff/:id/documents/:docId', requireRole(ROLES.MANAGE), (req, res) => {
  const u = docAccess(req, res); if (!u) return;
  const info = db.prepare(`DELETE FROM staff_documents WHERE id=? AND user_id=?`).run(req.params.docId, u.id);
  if (!info.changes) return res.status(404).json({ error: 'Document not found.' });
  auditLog(req, 'staff_document_delete', 'user', u.id, { document_id: Number(req.params.docId) });
  res.json({ success: true });
});

// ── Activity log (access trail: logins, writes, denied attempts) ─────────────
router.get('/activity', requireRole(ROLES.ADMIN), (req, res) => {
  const conds = [], args = [];
  if (req.query.event === 'logins') conds.push(`path='/api/auth/login'`);
  else if (req.query.event === 'denied') conds.push('status IN (401,403)');
  if (req.query.user) { conds.push('user_id=?'); args.push(req.query.user); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 300);
  const rows = db.prepare(`SELECT id, user_id, user_name, user_role, method, path, status, ip, detail, created_at
    FROM activity_log ${where} ORDER BY id DESC LIMIT ${limit}`).all(...args);
  res.json(rows.map(r => { let d = null; try { d = r.detail ? JSON.parse(r.detail) : null; } catch { d = null; } return { ...r, detail: d }; }));
});

module.exports = router;
