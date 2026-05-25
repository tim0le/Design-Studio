const express = require('express');
const router = express.Router();
const { readDeck, updateSlide } = require('../lib/deck');

// Position changes are saved to markdown only — no Marp re-render (too slow).
// The iframe keeps the drag transform visually until next slide load.
router.post('/', (req, res) => {
  const { deckId, slideIndex, elementText, tagName, dx, dy } = req.body;
  if (!deckId || slideIndex === undefined || !elementText || !tagName) {
    return res.status(400).json({ error: 'deckId, slideIndex, elementText, tagName required' });
  }

  try {
    const { slides } = readDeck(deckId);
    const idx = parseInt(slideIndex, 10);
    let slideMarkdown = slides[idx];

    const posStyle = `position:relative;top:${dy}px;left:${dx}px;`;
    const re = new RegExp(`(<${tagName}(?:\\s[^>]*)?)>`, 'i');
    const firstLine = elementText.split('\n')[0].trim().substring(0, 30);
    const lineIdx = slideMarkdown.split('\n').findIndex(l => l.includes(firstLine));

    if (lineIdx >= 0) {
      const lines = slideMarkdown.split('\n');
      for (let i = lineIdx; i >= Math.max(0, lineIdx - 5); i--) {
        const m = lines[i].match(re);
        if (m) {
          const existingStyle = m[1].match(/style="([^"]*)"/);
          let newTag;
          if (existingStyle) {
            newTag = m[1].replace(/style="[^"]*"/, `style="${existingStyle[1]};${posStyle}"`) + '>';
          } else {
            newTag = m[1] + ` style="${posStyle}">`;
          }
          lines[i] = lines[i].replace(m[0], newTag);
          slideMarkdown = lines.join('\n');
          break;
        }
      }
    }

    updateSlide(deckId, idx, slideMarkdown);
    // Return immediately without re-rendering — position is saved, iframe shows drag result
    res.json({ success: true, saved: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
