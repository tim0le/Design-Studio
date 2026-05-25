const express = require('express');
const router = express.Router();
const { exportDeck, exportSlide } = require('../lib/marp');
const path = require('path');

const DECK_FORMATS = ['pdf', 'pptx', 'pptx-editable'];
const SLIDE_FORMATS = ['pdf', 'pptx', 'pptx-editable', 'png', 'jpg', 'jpeg', 'html'];

router.post('/', (req, res) => {
  const { deckId, format } = req.body;
  if (!deckId || !format) return res.status(400).json({ error: 'deckId and format required' });
  if (!DECK_FORMATS.includes(format)) return res.status(400).json({ error: `format must be one of: ${DECK_FORMATS.join(', ')}` });

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

// Export a single slide as pdf/pptx/png/jpg/html.
router.post('/slide', (req, res) => {
  const { deckId, slideIndex, format } = req.body;
  if (!deckId || slideIndex === undefined || slideIndex === null || !format) {
    return res.status(400).json({ error: 'deckId, slideIndex, format required' });
  }
  if (!SLIDE_FORMATS.includes(String(format).toLowerCase())) {
    return res.status(400).json({ error: `format must be one of: ${SLIDE_FORMATS.join(', ')}` });
  }

  try {
    const outPath = exportSlide(deckId, slideIndex, format);
    const filename = path.basename(outPath);
    res.download(outPath, filename, err => {
      if (err && !res.headersSent) res.status(500).json({ error: err.message });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
