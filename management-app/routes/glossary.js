// Glossary (product_catalog) — the group-wide product dictionary, shared by the Central
// Kitchen and every location. One row per GTIN. Hand-managed here (add / edit / delete)
// and pre-filled from the smart receive flow. Manager/ops level, like the rest of inventory.
const express = require('express');
const db = require('../db/database');
const { verifyToken, requireRole, ROLES } = require('../lib/auth');
const { auditLog } = require('../lib/audit');
const { glossaryList, glossaryUpsert, glossaryDelete, catalogGet } = require('../lib/productLookup');
const { parseScan } = require('../lib/barcode');

const router = express.Router();
router.use(verifyToken);

const key = (raw) => { const p = parseScan(raw); return (p.gtin || p.code || '').toString().trim(); };

// List / search the glossary. ?q=text ?category=… ?active=1
router.get('/', requireRole(ROLES.OPS), (req, res) => {
  res.json(glossaryList({ q: req.query.q || '', category: req.query.category || '', activeOnly: req.query.active === '1', limit: req.query.limit }));
});

// Distinct categories currently used in the glossary (for the filter picker).
router.get('/categories', requireRole(ROLES.OPS), (req, res) => {
  try { res.json(db.prepare(`SELECT DISTINCT category FROM product_catalog WHERE category IS NOT NULL AND category<>'' ORDER BY category`).all().map(r => r.category)); }
  catch { res.json([]); }
});

// One glossary entry by GTIN/barcode (raw scan or plain code both work).
router.get('/:code', requireRole(ROLES.OPS), (req, res) => {
  const row = catalogGet(key(req.params.code));
  if (!row) return res.status(404).json({ error: 'Not in the glossary.' });
  res.json(row);
});

// Create or update a glossary entry (upsert by GTIN).
router.post('/', requireRole(ROLES.OPS), (req, res) => {
  const body = { ...req.body, barcode: key(req.body.barcode || req.body.gtin || req.body.code) };
  const r = glossaryUpsert(body, req.user.id);
  if (r.error) return res.status(400).json({ error: r.error });
  auditLog(req, r.created ? 'glossary_create' : 'glossary_update', 'product_catalog', 0, { barcode: r.barcode, name: body.name });
  res.json({ success: true, barcode: r.barcode, created: r.created });
});

// Delete a glossary entry (does not touch any stock rows).
router.delete('/:code', requireRole(ROLES.OPS), (req, res) => {
  const code = key(req.params.code);
  const existed = catalogGet(code);
  const r = glossaryDelete(code);
  if (!r.ok) return res.status(404).json({ error: 'Not in the glossary.' });
  auditLog(req, 'glossary_delete', 'product_catalog', 0, { barcode: code, name: existed && existed.name });
  res.json({ success: true });
});

module.exports = router;
