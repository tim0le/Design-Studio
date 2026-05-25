const express = require('express');
const router = express.Router();
const { exportDeck } = require('../lib/marp');
const path = require('path');

router.post('/', (req, res) => {
  const { deckId, format } = req.body;
  if (!deckId || !format) return res.status(400).json({ error: 'deckId and format required' });
  if (!['pdf', 'pptx'].includes(format)) return res.status(400).json({ error: 'format must be pdf or pptx' });

  try {
    const outPath = exportDeck(deckId, format);
    const filename = path.basename(outPath);
    res.download(outPath, filename, err => {
      if (err && !res.headersSent) res.status(500).json({ error: err.message });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
