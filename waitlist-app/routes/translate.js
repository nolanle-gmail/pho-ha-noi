// On-demand translation for message / chat bubbles (EN / ES / VI).
const express = require('express');
const { verifyToken } = require('../lib/auth');
const { translate } = require('../lib/translate');

const router = express.Router();
router.use(verifyToken);

router.get('/', async (req, res) => {
  try { res.json(await translate(req.query.q, req.query.from, req.query.to)); }
  catch (e) {
    if (/Unsupported/.test(e.message)) return res.status(400).json({ error: e.message });
    res.status(502).json({ error: 'Translation is unavailable right now. Please try again.' });
  }
});

module.exports = router;
