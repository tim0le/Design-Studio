const express = require('express');
const router = express.Router();
const { readDeck, updateSlide } = require('../lib/deck');
const { ensureElementId, deleteElement } = require('../lib/elementSource');

/**
 * POST /api/delete
 * Body: { deckId, slideIndex, elementText, elementHtml, tagName, fgsId? }
 *
 * Removes an element from the slide markdown. If the element has no UUID we
 * first tag it (so we know exactly what range to delete), then drop it.
 *
 * Returns: { success, fgsId }
 */
router.post('/', (req, res) => {
  const { deckId, slideIndex, elementText, elementHtml, tagName, fgsId } = req.body;
  if (!deckId || slideIndex === undefined) {
    return res.status(400).json({ error: 'deckId, slideIndex required' });
  }

  try {
    const { slides } = readDeck(deckId);
    const idx = parseInt(slideIndex, 10);
    if (isNaN(idx) || idx < 0 || idx >= slides.length) {
      return res.status(404).json({ error: 'slide out of range' });
    }
    let slideMarkdown = slides[idx];
    let uuid = fgsId;

    if (!uuid) {
      if (!elementText && !elementHtml) {
        return res.status(400).json({ error: 'need fgsId or elementText/elementHtml to locate element' });
      }
      const r = ensureElementId(slideMarkdown, { tagName, elementText, elementHtml });
      if (!r) return res.status(422).json({ error: 'Could not locate element in source.' });
      slideMarkdown = r.newMarkdown;
      uuid = r.uuid;
    }

    const updated = deleteElement(slideMarkdown, uuid);
    if (updated === null) {
      return res.status(500).json({ error: 'element not found after tagging — internal inconsistency' });
    }
    updateSlide(deckId, idx, updated);
    res.json({ success: true, fgsId: uuid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
