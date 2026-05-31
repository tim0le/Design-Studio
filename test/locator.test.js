/*
 * Node test for public/edit/locator.js.
 *
 * Verifies the client-side quick-edit locator behaves identically to the
 * server's routes/edit.js (replaceByOuterHtml / replaceInSource exact+fuzzy /
 * the edit & generate apply strategies). Fixtures mirror the cases routes/edit.js
 * documents in its comments (outerHTML-first, then exact, then fuzzy with
 * `* _ ` ~` stripped and whitespace collapsed; generate appends on no match).
 *
 * Run: node test/locator.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');

let passed = 0;
function ok(label) { passed++; console.log('ok - ' + label); }

const L = require(path.join(__dirname, '..', 'public', 'edit', 'locator.js'));

// ── replaceByOuterHtml: wrap-preserving inner-text swap ────────────────────
(function outerHtml() {
  const src = 'before\n<h2 class="title">old text</h2>\nafter';
  const out = L.replaceByOuterHtml(src, '<h2 class="title">old text</h2>', 'new text');
  assert.strictEqual(out, 'before\n<h2 class="title">new text</h2>\nafter');
  ok('replaceByOuterHtml preserves tag + attributes, swaps inner text');

  // Not found -> null
  assert.strictEqual(L.replaceByOuterHtml(src, '<p>missing</p>', 'x'), null);
  ok('replaceByOuterHtml returns null when outerHTML absent');

  // Mismatched / fragment tags -> plain substring replace of the whole match
  const frag = 'a <br> b';
  assert.strictEqual(L.replaceByOuterHtml(frag, '<br>', 'X'), 'a X b');
  ok('replaceByOuterHtml falls back to plain replace for non-paired tags');
})();

// ── replaceInSource: exact then fuzzy ──────────────────────────────────────
(function inSource() {
  // Exact
  const src = 'Hello world, this is a slide.';
  assert.strictEqual(
    L.replaceInSource(src, 'Hello world', 'Goodbye'),
    'Goodbye, this is a slide.'
  );
  ok('replaceInSource exact match');

  // Fuzzy: source has markdown emphasis + collapsed whitespace differences.
  // needle (from rendered innerText) has no markdown and single spaces.
  const md = 'The **quick   brown** _fox_ jumps';
  const out = L.replaceInSource(md, 'quick brown fox', 'lazy dog');
  // The matched range spans from the original index of "quick" to the original
  // index just past the last matched char "x" of fox. The emphasis markers that
  // were stripped during matching keep their original positions: the leading
  // `**` (before "quick") sits outside the start, the inner `**`/`_` between
  // brown/fox are inside and get replaced, and the trailing `_` after fox is
  // outside the end. This exact (quirky) output is the byte-faithful behavior
  // of routes/edit.js fuzzyFind — asserted here to lock parity.
  assert.strictEqual(out, 'The **lazy dog_ jumps');
  ok('replaceInSource fuzzy match strips * _ ` ~ and collapses whitespace');

  // No match -> null
  assert.strictEqual(L.replaceInSource(src, 'not present here', 'x'), null);
  ok('replaceInSource returns null on no match');
})();

// ── fuzzyFind range ────────────────────────────────────────────────────────
(function fuzzy() {
  const src = 'a *bold* word';
  const range = L.fuzzyFind(src, 'bold word');
  assert.ok(range && typeof range.start === 'number', 'returns a range');
  assert.strictEqual(src.slice(range.start, range.end), 'bold* word');
  ok('fuzzyFind maps normalized match back to original (markdown) positions');

  assert.strictEqual(L.fuzzyFind(src, ''), null);
  ok('fuzzyFind returns null for empty needle');
})();

// ── applyEdit: outerHTML -> exact -> fuzzy -> null ─────────────────────────
(function applyEdit() {
  const slide = '## <span class="eyebrow">INTRO</span>\n\nThe **big** idea here.';

  // outerHTML path
  let out = L.applyEdit(slide, { elementHtml: '<span class="eyebrow">INTRO</span>', elementText: 'INTRO' }, 'START');
  assert.strictEqual(out, '## <span class="eyebrow">START</span>\n\nThe **big** idea here.');
  ok('applyEdit uses outerHTML first');

  // fuzzy text path (no elementHtml match; emphasis stripped)
  out = L.applyEdit(slide, { elementHtml: '', elementText: 'big' }, 'small');
  assert.strictEqual(out, '## <span class="eyebrow">INTRO</span>\n\nThe **small** idea here.');
  ok('applyEdit falls through to fuzzy text match');

  // no match -> null (caller surfaces NOT_FOUND_MESSAGE)
  assert.strictEqual(L.applyEdit(slide, { elementHtml: '', elementText: 'nonexistent' }, 'x'), null);
  ok('applyEdit returns null when nothing matches');
  assert.ok(/Could not locate/.test(L.NOT_FOUND_MESSAGE));
  ok('NOT_FOUND_MESSAGE matches the server 422 wording');
})();

// ── applyGenerate: elementHtml-include -> replaceInSource -> append ────────
(function applyGenerate() {
  const slide = 'Title\n\n<div class="card">old</div>';

  // elementHtml include
  let out = L.applyGenerate(slide, { elementHtml: '<div class="card">old</div>', elementText: 'old' }, '<div class="chart"></div>');
  assert.strictEqual(out, 'Title\n\n<div class="chart"></div>');
  ok('applyGenerate replaces matched elementHtml');

  // append fallback when neither html nor text matches
  out = L.applyGenerate('Just text', { elementHtml: '<x>', elementText: 'absent' }, 'APPENDED');
  assert.strictEqual(out, 'Just text\n\nAPPENDED');
  ok('applyGenerate appends when no locator matches');
})();

console.log('\n# ' + passed + ' assertions passed');
