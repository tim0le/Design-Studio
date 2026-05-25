const express = require('express');
const router = express.Router();
const { readDeck } = require('../lib/deck');
const { renderSlide } = require('../lib/marp');

router.get('/:id(*)/slide/:index', (req, res) => {
  try {
    const { frontmatter, slides } = readDeck(req.params.id);
    const index = parseInt(req.params.index, 10);
    if (isNaN(index) || index < 0 || index >= slides.length) {
      return res.status(404).json({ error: 'Slide not found' });
    }
    const html = renderSlide(frontmatter, slides[index]);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
