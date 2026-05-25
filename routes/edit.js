const express = require('express');
const router = express.Router();
const { readDeck, updateSlide } = require('../lib/deck');
const { editElement, generateVisual } = require('../lib/claude');
const { renderSlide } = require('../lib/marp');

// Normalize whitespace and strip markdown inline formatting (* _ ` ~) for matching.
function normalize(s) {
  return s.replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
}

// Find a passage in source whose normalized form matches needle's normalized form.
// Returns {start, end} index range in source, or null if not found.
function fuzzyFind(source, needle) {
  const target = normalize(needle);
  if (!target) return null;
  // Build a parallel map: stripped chars and their original positions.
  const positions = [];
  let stripped = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '*' || c === '_' || c === '`' || c === '~') continue;
    positions.push(i);
    stripped += c;
  }
  const normalizedStripped = stripped.replace(/\s+/g, ' ');
  // Map from normalizedStripped indices back to stripped indices.
  const strippedPositions = [];
  let prevWasSpace = false;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (/\s/.test(c)) {
      if (!prevWasSpace && strippedPositions.length > 0) {
        strippedPositions.push(i);
      }
      prevWasSpace = true;
    } else {
      strippedPositions.push(i);
      prevWasSpace = false;
    }
  }
  // Trim leading whitespace tracking for normalizedStripped (it isn't trimmed; only collapsed).
  const idx = normalizedStripped.indexOf(target);
  if (idx < 0) return null;
  // Find original positions
  const strippedStart = strippedPositions[idx];
  const strippedEnd = strippedPositions[idx + target.length - 1] + 1;
  if (strippedStart === undefined || strippedEnd === undefined) return null;
  const origStart = positions[strippedStart];
  const origEnd = positions[strippedEnd - 1] + 1;
  return { start: origStart, end: origEnd };
}

function replaceInSource(source, needle, replacement) {
  // 1. Exact match.
  const exactIdx = source.indexOf(needle);
  if (exactIdx >= 0) {
    return source.substring(0, exactIdx) + replacement + source.substring(exactIdx + needle.length);
  }
  // 2. Fuzzy (strip * _ ` ~, collapse whitespace).
  const range = fuzzyFind(source, needle);
  if (range) {
    return source.substring(0, range.start) + replacement + source.substring(range.end);
  }
  return null;
}

// Swap the inner text of an HTML element while preserving its outer tags and
// attributes. Given the iframe's outerHTML like `<h2 class="x">old text</h2>`
// and a replacement string, produce `<h2 class="x">replacement</h2>`. Used as
// the first-choice locator for edits because outerHTML is byte-exact and
// usually unique within a slide, unlike the stripped textContent.
function replaceByOuterHtml(source, elementHtml, replacementText) {
  const idx = source.indexOf(elementHtml);
  if (idx < 0) return null;

  const openMatch = elementHtml.match(/^<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/);
  const closeMatch = elementHtml.match(/<\/([a-zA-Z][a-zA-Z0-9-]*)>\s*$/);
  // Only do the wrap-preserving replace when the element has a matching pair of
  // open/close tags of the same name. Self-closing / fragment cases fall back.
  if (!openMatch || !closeMatch || openMatch[1].toLowerCase() !== closeMatch[1].toLowerCase()) {
    return source.substring(0, idx) + replacementText + source.substring(idx + elementHtml.length);
  }
  const rebuilt = openMatch[0] + replacementText + closeMatch[0];
  return source.substring(0, idx) + rebuilt + source.substring(idx + elementHtml.length);
}

router.post('/', async (req, res) => {
  const { deckId, slideIndex, elementText, elementHtml, instruction, mode = 'edit' } = req.body;

  if (!deckId || slideIndex === undefined || !elementText || !instruction) {
    return res.status(400).json({ error: 'deckId, slideIndex, elementText, instruction are required' });
  }

  const apiKey = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'No API key — click ⚙ API Key in the toolbar to add yours.' });
  }

  try {
    const { frontmatter, slides } = readDeck(deckId);
    const idx = parseInt(slideIndex, 10);
    const slideMarkdown = slides[idx];

    let replacement, updatedSlide;

    if (mode === 'generate') {
      replacement = await generateVisual({ apiKey, slideMarkdown, elementText, instruction, slideIndex: idx });
      // Try elementHtml match first (works for HTML blocks rendered identically).
      if (elementHtml && slideMarkdown.includes(elementHtml)) {
        updatedSlide = slideMarkdown.replace(elementHtml, replacement);
      } else {
        const next = replaceInSource(slideMarkdown, elementText, replacement);
        updatedSlide = next !== null ? next : slideMarkdown + '\n\n' + replacement;
      }
    } else {
      replacement = await editElement({ apiKey, deckId, slideIndex: idx, slideMarkdown, elementText, instruction });
      // Locator strategy (most specific → least):
      //   1. outerHTML match — exact, preserves tags/attrs
      //   2. exact elementText match
      //   3. fuzzy elementText match (whitespace + markdown emphasis stripped)
      let next = null;
      if (elementHtml) next = replaceByOuterHtml(slideMarkdown, elementHtml, replacement);
      if (next === null) next = replaceInSource(slideMarkdown, elementText, replacement);
      if (next === null) {
        return res.status(422).json({
          error: 'Could not locate the selected text in the source markdown. Try a smaller selection — or use Agent mode, which can edit the file directly.',
          replacement,
          elementTextPreview: elementText.substring(0, 100)
        });
      }
      updatedSlide = next;
    }

    const updatedDeckMarkdown = updateSlide(deckId, idx, updatedSlide);
    const renderedHtml = renderSlide(frontmatter, updatedSlide);

    res.json({
      success: true,
      replacement,
      mode,
      updatedSlideMarkdown: updatedSlide,
      updatedDeckMarkdown,
      renderedHtml
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
