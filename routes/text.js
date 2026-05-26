const express = require('express');
const router = express.Router();
const { readDeck, updateSlide } = require('../lib/deck');
const { ensureElementId, replaceElementText, deleteElement } = require('../lib/elementSource');

/**
 * POST /api/text
 * Body: { deckId, slideIndex, elementText, elementHtml, tagName, fgsId?, newText }
 *
 * Direct text replacement (no LLM). Used by the inline contenteditable flow:
 * user double-clicks an element, types new text, blurs → server persists.
 *
 * Empty newText is treated as a delete signal (the user cleared the element).
 *
 * Returns: { success, fgsId, deleted?: true }
 */
router.post('/', (req, res) => {
  const { deckId, slideIndex, elementText, elementHtml, tagName, fgsId } = req.body;
  const newText = req.body.newText;
  if (!deckId || slideIndex === undefined) {
    return res.status(400).json({ error: 'deckId, slideIndex required' });
  }
  if (newText === undefined || newText === null) {
    return res.status(400).json({ error: 'newText required' });
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

    // Empty edit → delete (per spec: convert empty text to delete, no confirm)
    const trimmed = String(newText).trim();
    if (trimmed === '') {
      const deleted = deleteElement(slideMarkdown, uuid);
      if (deleted === null) return res.status(500).json({ error: 'failed to delete empty element' });
      updateSlide(deckId, idx, deleted);
      return res.json({ success: true, fgsId: uuid, deleted: true });
    }

    const updated = replaceElementText(slideMarkdown, uuid, newText);
    if (updated === null) {
      return res.status(500).json({ error: 'failed to replace element text' });
    }
    updateSlide(deckId, idx, updated);
    res.json({ success: true, fgsId: uuid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
