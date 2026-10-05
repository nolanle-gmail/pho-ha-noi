// Full-screen Floor Board (/Floorplan/<slug>) — a no-login, always-on TV display that shows ONE
// store's live floor in big, colour-coded tables so staff can read the room from across the
// dining room. It's READ-ONLY: it draws the exact same floor + live Service Flow as the Management
// Floor Plan tab (shared buildFloorplan), but can't seat, move or free a table — a wall screen
// shouldn't mutate anything. Pinned to a store by its URL slug, like the clock / cleanup kiosks.
const express = require('express');
const db = require('../db/database');
const { normSlug } = require('../lib/slug');
const { buildFloorplan } = require('./floorplan');

const router = express.Router();

// Light per-IP abuse guard (a TV polls on a timer; allow generous headroom).
const rate = new Map();
router.use((req, res, next) => {
  const ip = req.ip || 'x', now = Date.now(), e = rate.get(ip);
  if (!e || now - e.t > 60000) { rate.set(ip, { n: 1, t: now }); return next(); }
  if (e.n >= 240) return res.status(429).json({ ok: false, error: 'Too many requests — please wait a moment.' });
  e.n++; next();
});

const locBySlug = (slug) => db.prepare(`SELECT id, name, slug FROM locations WHERE is_active=1`).all()
  .find(l => normSlug(l.slug || '') === normSlug(slug) || normSlug(l.name) === normSlug(slug)) || null;

// The picker (bare /Floorplan): every active location that has a floor plan set up.
router.get('/locations', (req, res) => {
  const rows = db.prepare(`SELECT l.id, l.name, l.slug, COUNT(t.id) AS tables
      FROM locations l LEFT JOIN restaurant_tables t ON t.location_id=l.id AND t.is_active=1
      WHERE l.is_active=1 GROUP BY l.id HAVING tables > 0 ORDER BY l.name`).all();
  res.json({ ok: true, locations: rows.map(r => ({ id: r.id, name: r.name, slug: r.slug || '', tables: r.tables })) });
});

// The board: the full live floor for one store (pinned by slug). Read-only — no reconcile writes.
router.get('/board', (req, res) => {
  const loc = locBySlug(req.query.slug);
  if (!loc) return res.status(404).json({ ok: false, error: 'Unknown Floor Board link.' });
  const data = buildFloorplan(loc.id, { reconcile: false });
  if (!data) return res.status(404).json({ ok: false, error: 'Location not found.' });
  res.json({ ok: true, ...data });
});

module.exports = router;
