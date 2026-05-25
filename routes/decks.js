const express = require('express');
const router = express.Router();
const { listDecks, readDeck, writeDeck, createDeck } = require('../lib/deck');
const { convertToDeckSource } = require('../lib/importers');

router.post('/upload', (req, res) => {
  try {
    const { name, content, contentBase64, mime, lang, kind } = req.body;
    if (!name || (!content && !contentBase64)) {
      return res.status(400).json({ error: 'name and content (or contentBase64) required' });
    }

    const { deckId, markdown, format } = convertToDeckSource({
      name, content, contentBase64, mime, lang, kind
    });

    createDeck(deckId, markdown);
    const decks = listDecks();
    const validLang = ['de', 'en'].includes(lang) ? lang : 'en';
    const deck = decks.find(d => d.id === deckId)
      || { id: deckId, name: deckId.split('/').pop(), lang: validLang };
    res.json({ success: true, deckId, deck, format });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/', (req, res) => {
  try {
    res.json(listDecks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Per-slide source endpoints (registered BEFORE the deck-level /source
// routes so the greedy `:id(*)` glob doesn't swallow the `/slide/:index`
// segments). ──

// Read the source of a single slide.
router.get('/:id(*)/slide/:index/source', (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    const { slides } = readDeck(req.params.id);
    if (!Number.isInteger(idx) || idx < 0 || idx >= slides.length) {
      return res.status(404).json({ error: 'Slide not found' });
    }
    res.json({ deckId: req.params.id, slideIndex: idx, markdown: slides[idx] });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Write a single slide's source. Uses Unit 4's slideRange helpers via
// lib/deck.writeSlideRange so the surgical edit preserves frontmatter and
// neighbour slides' byte-exact content (CRLF, blank lines, etc.).
router.put('/:id(*)/slide/:index/source', (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    const { markdown } = req.body || {};
    if (typeof markdown !== 'string') {
      return res.status(400).json({ error: 'markdown (string) is required' });
    }
    const { writeSlideRange } = require('../lib/deck');
    writeSlideRange(req.params.id, idx, markdown);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Whole-deck source endpoints ──
router.get('/:id(*)/source', (req, res) => {
  try {
    const { markdown, frontmatter, slides } = readDeck(req.params.id);
    res.json({ markdown, frontmatter, slides: slides.map((s, i) => ({ index: i, markdown: s })) });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

router.put('/:id(*)/source', (req, res) => {
  try {
    const { markdown } = req.body;
    if (!markdown) return res.status(400).json({ error: 'markdown required' });
    writeDeck(req.params.id, markdown);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
