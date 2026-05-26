const express = require('express');
const router = express.Router();
const { readDeck, updateSlide } = require('../lib/deck');
const { ensureElementId, setElementStyle } = require('../lib/elementSource');

/**
 * POST /api/move
 * Body: { deckId, slideIndex, elementText, elementHtml, tagName, fgsId?, dx, dy, x?, y? }
 *
 * Sets position:absolute + left/top on the target element so it can be
 * positioned anywhere on the slide canvas. If the element has no
 * data-fgs-id yet, one is assigned (transforming the source as needed: a
 * markdown `## Heading` becomes `<h2 data-fgs-id="…">Heading</h2>`).
 *
 * Coordinates are in the slide's 1280×720 canvas space, not viewport pixels.
 * The client sends:
 *   - x, y: ABSOLUTE final coordinates of the element's top-left (preferred)
 *   - dx, dy: delta from the element's previous position (fallback)
 *
 * Returns: { success, fgsId, savedSource? }
 */
router.post('/', (req, res) => {
  const { deckId, slideIndex, elementText, elementHtml, tagName, fgsId, dx, dy, x, y } = req.body;
  if (!deckId || slideIndex === undefined) {
    return res.status(400).json({ error: 'deckId, slideIndex required' });
  }
  if (x === undefined && y === undefined && dx === undefined && dy === undefined) {
    return res.status(400).json({ error: 'must send x/y (absolute) or dx/dy (delta)' });
  }

  try {
    const { slides } = readDeck(deckId);
    const idx = parseInt(slideIndex, 10);
    if (isNaN(idx) || idx < 0 || idx >= slides.length) {
      return res.status(404).json({ error: 'slide out of range' });
    }
    let slideMarkdown = slides[idx];
    let uuid = fgsId;

    // If no UUID supplied, derive one (tagging the source if necessary).
    if (!uuid) {
      if (!elementText && !elementHtml) {
        return res.status(400).json({ error: 'need fgsId or elementText/elementHtml to locate element' });
      }
      const r = ensureElementId(slideMarkdown, { tagName, elementText, elementHtml });
      if (!r) return res.status(422).json({ error: 'Could not locate element in source.' });
      slideMarkdown = r.newMarkdown;
      uuid = r.uuid;
    }

    // Compute final position. Prefer absolute coordinates; fall back to deltas
    // applied to the element's current style (if any), defaulting to 0 origin.
    let finalLeft, finalTop;
    if (typeof x === 'number' && typeof y === 'number') {
      finalLeft = Math.round(x);
      finalTop = Math.round(y);
    } else {
      // Find current position from inline style, if any.
      const { findElementById, parseStyleString } = require('../lib/elementSource');
      const found = findElementById(slideMarkdown, uuid);
      const pairs = found ? parseStyleString(found.attrs.style || '') : [];
      const cur = Object.fromEntries(pairs);
      const curLeft = parseInt(cur.left, 10) || 0;
      const curTop = parseInt(cur.top, 10) || 0;
      finalLeft = Math.round(curLeft + (Number(dx) || 0));
      finalTop = Math.round(curTop + (Number(dy) || 0));
    }

    const updated = setElementStyle(slideMarkdown, uuid, {
      position: 'absolute',
      left: `${finalLeft}px`,
      top: `${finalTop}px`
    });
    if (updated === null) {
      return res.status(500).json({ error: 'failed to apply style to tagged element' });
    }

    updateSlide(deckId, idx, updated);
    res.json({ success: true, fgsId: uuid, left: finalLeft, top: finalTop });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
