// Validate a staff EMPLOYEE CODE for the Waitlist front-desk board. Employee codes live here in the
// Management DB, so the Waitlist app calls this server-to-server (service key) before it lets a code
// run a board action (Notify / Seat / Left). Returns whether the code is an active, host-capable
// staffer at that board's location — the guard that keeps a random passer-by from tapping an action.
const express = require('express');
const db = require('../db/database');

const router = express.Router();
const KEY = process.env.FLOORPLAN_SERVICE_KEY || 'dev-floorplan-key';
router.use((req, res, next) => {
  const k = req.headers['x-service-key'];
  if (k && k === KEY) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
});

// Roles allowed to operate the front-desk board (host/floor staff + leadership).
const BOARD_ROLES = ['owner', 'admin', 'ceo', 'president', 'hr', 'general_manager', 'manager', 'assistant_manager', 'kitchen_manager', 'shift_lead', 'kitchen_lead', 'frontdesk', 'host', 'server', 'cashier'];
// These see every location, so their code works at any board.
const ALL_LOC = ['owner', 'admin', 'ceo', 'president', 'hr', 'general_manager'];

router.post('/validate', (req, res) => {
  const code = String((req.body && req.body.employee_code) || '').trim();
  const locId = parseInt(req.body && req.body.location_id, 10);
  if (!code || !locId) return res.json({ ok: false, reason: 'bad_request' });
  const u = db.prepare(`SELECT id, name, role, location_id FROM users WHERE employee_code=? AND is_active=1`).get(code);
  if (!u) return res.json({ ok: false, reason: 'notfound' });
  if (!BOARD_ROLES.includes(u.role)) return res.json({ ok: false, reason: 'role' });
  // The code must belong to someone who works at this location (home store, a covered store, or an
  // all-location role) — a Berkeley host's code shouldn't drive the San Jose board.
  const here = ALL_LOC.includes(u.role) || String(u.location_id) === String(locId)
    || !!db.prepare(`SELECT 1 FROM staff_locations WHERE user_id=? AND location_id=?`).get(u.id, locId);
  if (!here) return res.json({ ok: false, reason: 'location' });
  res.json({ ok: true, name: u.name, role: u.role });
});

module.exports = router;
