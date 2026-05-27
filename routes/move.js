const express = require('express');
const router = express.Router();
const { readDeck, updateSlide } = require('../lib/deck');
const { ensureElementId, setElementStyle } = require('../lib/elementSource');

/**
 * POST /api/move
 * Body: { deckId, slideIndex, elementText, elementHtml, tagName, fgsId?, tx, ty }
 *
 * Applies a CSS `transform: translate(tx px, ty px)` to the element so it
 * visually moves without leaving its layout slot — other elements stay in
 * place. tx/ty are in slide-coord pixels (1280×720 canvas).
 *
 * The client already accumulates drag deltas on top of the element's existing
 * transform, so tx/ty are the final absolute translate values, not deltas.
 *
 * If the element has no data-fgs-id yet, one is assigned (transforming the
 * source as needed: a markdown `## Heading` becomes `<h2 data-fgs-id="…">…`).
 *
 * Returns: { success, fgsId, tx, ty }
 *
 * Legacy: accepts {x, y} (interpreted as transform values) and {dx, dy}
 * (applied as deltas on top of the existing transform) for backwards-compat
 * with older clients.
 */
router.post('/', (req, res) => {
  const { deckId, slideIndex, elementText, elementHtml, tagName, fgsId, tx, ty, x, y, dx, dy } = req.body;
  if (!deckId || slideIndex === undefined) {
    return res.status(400).json({ error: 'deckId, slideIndex required' });
  }
  if (tx === undefined && ty === undefined && x === undefined && y === undefined && dx === undefined && dy === undefined) {
    return res.status(400).json({ error: 'must send tx/ty (translate values) or dx/dy (delta)' });
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

    // Compute the final translate values. Priority:
    //   1. {tx, ty} from current client — final cumulative translate
    //   2. {x, y} from legacy client — same semantics as tx, ty
    //   3. {dx, dy} — delta on top of existing transform parsed from source
    let finalTx, finalTy;
    if (typeof tx === 'number' && typeof ty === 'number') {
      finalTx = Math.round(tx);
      finalTy = Math.round(ty);
    } else if (typeof x === 'number' && typeof y === 'number') {
      finalTx = Math.round(x);
      finalTy = Math.round(y);
    } else {
      const { findElementById, parseStyleString } = require('../lib/elementSource');
      const found = findElementById(slideMarkdown, uuid);
      const pairs = found ? parseStyleString(found.attrs.style || '') : [];
      const cur = Object.fromEntries(pairs);
      let curTx = 0, curTy = 0;
      if (cur.transform) {
        const m = String(cur.transform).match(/translate(?:3d)?\(\s*(-?[0-9.]+)px\s*(?:,\s*(-?[0-9.]+)px)?/);
        if (m) { curTx = parseFloat(m[1]) || 0; curTy = parseFloat(m[2] || '0') || 0; }
      }
      finalTx = Math.round(curTx + (Number(dx) || 0));
      finalTy = Math.round(curTy + (Number(dy) || 0));
    }

    // Strip any legacy `position/left/top` that previous versions wrote, so we
    // don't leave decks half-using each scheme. Setting a key to '' deletes it
    // via mergeStyle. Then write the new transform.
    const updated = setElementStyle(slideMarkdown, uuid, {
      position: '',
      left: '',
      top: '',
      transform: `translate(${finalTx}px, ${finalTy}px)`,
    });
    if (updated === null) {
      return res.status(500).json({ error: 'failed to apply style to tagged element' });
    }

    updateSlide(deckId, idx, updated);
    res.json({ success: true, fgsId: uuid, tx: finalTx, ty: finalTy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
