const express = require('express');
const router = express.Router();
const { listDecks, readDeck, writeDeck, createDeck } = require('../lib/deck');

router.post('/upload', (req, res) => {
  try {
    const { name, content, lang } = req.body;
    if (!name || !content) return res.status(400).json({ error: 'name and content required' });
    const sanitized = name.replace(/\.md$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    if (!sanitized) return res.status(400).json({ error: 'invalid deck name' });
    const validLang = ['de', 'en'].includes(lang) ? lang : 'en';
    const deckId = `${validLang}/${sanitized}`;
    createDeck(deckId, content);
    const decks = listDecks();
    const deck = decks.find(d => d.id === deckId) || { id: deckId, name: sanitized, lang: validLang };
    res.json({ success: true, deckId, deck });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', (req, res) => {
  try {
    res.json(listDecks());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
