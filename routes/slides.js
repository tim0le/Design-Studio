// Slide-level CRUD: add / duplicate / delete / move (reorder).
// Mounted at /api/slides — paths take deckId in the URL and slideIndex in the
// path or body depending on the operation.
//
// ROUTE ORDER MATTERS: the greedy `:id(*)` glob will swallow extra segments,
// so the more-specific patterns are registered first.

const express = require('express');
const router = express.Router();
const { addSlide, deleteSlide, duplicateSlide, moveSlide } = require('../lib/deck');

// POST /api/slides/:id(*)/:index/duplicate
router.post('/:id(*)/:index/duplicate', (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    if (!Number.isInteger(idx)) return res.status(400).json({ error: 'index must be integer' });
    const result = duplicateSlide(req.params.id, idx);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/slides/:id(*)/:index/move — body { direction: "up" | "down" }
router.post('/:id(*)/:index/move', (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    if (!Number.isInteger(idx)) return res.status(400).json({ error: 'index must be integer' });
    const direction = (req.body && req.body.direction) || '';
    const result = moveSlide(req.params.id, idx, direction);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/slides/:id(*)/:index
router.delete('/:id(*)/:index', (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    if (!Number.isInteger(idx)) return res.status(400).json({ error: 'index must be integer' });
    const result = deleteSlide(req.params.id, idx);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/slides/:id(*) — add slide; body { content?, insertAt? }
// Catch-all, registered last so the more-specific routes above match first.
router.post('/:id(*)', (req, res) => {
  try {
    const { content, insertAt } = req.body || {};
    const result = addSlide(req.params.id, content, insertAt);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
