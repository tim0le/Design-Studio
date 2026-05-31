/*
 * Node test for public/store/deckStore.js.
 *
 * Covers:
 *   - PURE functions (parse/assemble round-trip, add/delete/move) without IDB
 *   - parity of ported semantics with lib/deck.js for the same operations
 *   - the async IndexedDB API via fake-indexeddb (seed, CRUD, persistence)
 *
 * Run: node test/deckStore.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function ok(label) { passed++; console.log('ok - ' + label); }

const ROOT = path.join(__dirname, '..');
const SEED_PATH = path.join(ROOT, 'public', 'seed-decks', 'en', 'welcome.md');

// ── 1. Pure functions (no IndexedDB) ──────────────────────────────────────
(function pure() {
  const DS = require(path.join(ROOT, 'public', 'store', 'deckStore.js'));
  const libDeck = require(path.join(ROOT, 'lib', 'deck.js'));

  // parseDeck round-trips with assembleDeck on a real seed deck.
  const seedMd = fs.readFileSync(SEED_PATH, 'utf8');
  const parsed = DS.parseDeck(seedMd);
  assert.strictEqual(parsed.slides.length, 3, 'seed deck has 3 slides');
  ok('parseDeck on real seed deck yields 3 slides');

  // Parity with lib/deck.js parseDeck on the same input.
  const libParsed = libDeck.parseDeck(seedMd);
  assert.deepStrictEqual(parsed, libParsed, 'parseDeck matches lib/deck.js');
  ok('parseDeck matches lib/deck.js exactly');

  // Round-trip: parse(assemble(parse(x))) === parse(x)
  const reassembled = DS.assembleDeck(parsed.frontmatter, parsed.slides);
  assert.strictEqual(reassembled, libDeck.assembleDeck(parsed.frontmatter, parsed.slides), 'assembleDeck matches lib');
  const reparsed = DS.parseDeck(reassembled);
  assert.deepStrictEqual(reparsed, parsed, 'parseDeck round-trips through assembleDeck');
  ok('parseDeck round-trips with assembleDeck');

  // addSlide increases count and inserts at the requested position.
  {
    const slides = parsed.slides.slice();
    const r = DS.applyAddSlide(parsed.frontmatter, slides, 'NEW CONTENT', 1);
    assert.strictEqual(r.slideCount, parsed.slides.length + 1, 'addSlide increases count');
    assert.strictEqual(r.insertedAt, 1, 'addSlide inserts at position 1');
    assert.strictEqual(slides[1], 'NEW CONTENT', 'inserted content at index 1');
    ok('addSlide increases count and inserts at position');
  }

  // addSlide with no content uses DEFAULT_NEW_SLIDE (matches lib constant).
  assert.strictEqual(DS.DEFAULT_NEW_SLIDE, getLibDefault(libDeck), 'DEFAULT_NEW_SLIDE matches lib');
  {
    const slides = parsed.slides.slice();
    DS.applyAddSlide(parsed.frontmatter, slides, null);
    assert.strictEqual(slides[slides.length - 1], DS.DEFAULT_NEW_SLIDE.trim(), 'appends default slide trimmed');
    ok('addSlide uses DEFAULT_NEW_SLIDE when content empty');
  }

  // deleteSlide throws on last slide.
  {
    const single = ['only slide'];
    assert.throws(() => DS.applyDeleteSlide(parsed.frontmatter, single, 0), /Cannot delete the last slide/);
    ok('deleteSlide throws on last slide');
  }

  // deleteSlide out-of-range throws.
  assert.throws(() => DS.applyDeleteSlide(parsed.frontmatter, parsed.slides.slice(), 99), /out of range/);
  ok('deleteSlide throws out of range');

  // moveSlide up/down swaps.
  {
    const slides = ['A', 'B', 'C'];
    const down = DS.applyMoveSlide('fm', slides, 0, 'down');
    assert.strictEqual(down.movedTo, 1);
    assert.deepStrictEqual(slides, ['B', 'A', 'C'], 'move down swaps 0<->1');
    const up = DS.applyMoveSlide('fm', slides, 2, 'up');
    assert.strictEqual(up.movedTo, 1);
    assert.deepStrictEqual(slides, ['B', 'C', 'A'], 'move up swaps 2<->1');
    ok('moveSlide up/down swaps');
  }

  // moveSlide noop at boundary.
  {
    const slides = ['A', 'B'];
    const r = DS.applyMoveSlide('fm', slides, 0, 'up');
    assert.strictEqual(r.noop, true, 'move up at top is noop');
    assert.deepStrictEqual(slides, ['A', 'B'], 'noop leaves slides unchanged');
    ok('moveSlide noop at boundary');
  }

  // moveSlide rejects bad direction.
  assert.throws(() => DS.applyMoveSlide('fm', ['A', 'B'], 0, 'sideways'), /direction must be/);
  ok('moveSlide rejects invalid direction');

  // duplicateSlide inserts a copy after the index.
  {
    const slides = ['A', 'B'];
    const r = DS.applyDuplicateSlide('fm', slides, 0);
    assert.strictEqual(r.insertedAt, 1);
    assert.deepStrictEqual(slides, ['A', 'A', 'B'], 'duplicate copies after index');
    ok('duplicateSlide inserts copy after index');
  }

  // deriveMeta mirrors lib/deck.js listDecks derivation + marp guard.
  {
    const meta = DS.deriveMeta('en/welcome', seedMd);
    assert.strictEqual(meta.lang, 'en');
    assert.strictEqual(meta.kind, 'deck');
    assert.strictEqual(meta.slideCount, 3);
    assert.strictEqual(meta.name, 'Welcome');
    const onePager = DS.deriveMeta('de/one_pager/foo', '---\nmarp: true\n---\n\n# x\n');
    assert.strictEqual(onePager.lang, 'de');
    assert.strictEqual(onePager.kind, 'one_pager');
    const noMarp = DS.deriveMeta('en/x', '---\ntheme: y\n---\n\n# x\n');
    assert.strictEqual(noMarp, null, 'non-marp deck excluded');
    ok('deriveMeta mirrors lib listDecks (lang/kind/marp guard)');
  }
})();

// Extract DEFAULT_NEW_SLIDE from lib/deck.js source for a string-level compare.
function getLibDefault(libDeck) {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'deck.js'), 'utf8');
  const m = src.match(/const DEFAULT_NEW_SLIDE = (`[\s\S]*?`);/);
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

// ── 2. Async IndexedDB API via fake-indexeddb ─────────────────────────────
(async function asyncApi() {
  let fakeOk = true;
  try {
    require.resolve('fake-indexeddb/auto');
  } catch (e) {
    fakeOk = false;
  }
  if (!fakeOk) {
    console.log('# fake-indexeddb not installed — async IDB paths validated in-browser only');
    done();
    return;
  }

  require('fake-indexeddb/auto');

  // Stub fetch so seeding falls back to the minimal deck (no network in Node).
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });

  // Fresh require after globals are set.
  const DS = require(path.join(ROOT, 'public', 'store', 'deckStore.js'));

  // listDecks seeds on first run (fallback deck since fetch fails).
  let decks = await DS.listDecks();
  assert.ok(decks.length >= 1, 'first listDecks seeds at least one deck');
  ok('listDecks seeds on first run');

  // createDeck + readDeck.
  const md = '---\nmarp: true\ntheme: furgoson\n---\n\n# One\n\n---\n\n# Two\n';
  const created = await DS.createDeck('en/test', md);
  assert.strictEqual(created.slides.length, 2, 'created deck has 2 slides');
  const read = await DS.readDeck('en/test');
  assert.strictEqual(read.markdown, md, 'readDeck returns stored markdown');
  ok('createDeck + readDeck');

  // createDeck refuses duplicates.
  await assert.rejects(() => DS.createDeck('en/test', md), /already exists/);
  ok('createDeck refuses duplicate id');

  // addSlide persists.
  const add = await DS.addSlide('en/test', '# Three', 2);
  assert.strictEqual(add.slideCount, 3);
  const afterAdd = await DS.readDeck('en/test');
  assert.strictEqual(afterAdd.slides.length, 3, 'addSlide persisted');
  ok('addSlide read-modify-write persists');

  // deleteSlide persists; refuses last.
  await DS.deleteSlide('en/test', 0);
  let after = await DS.readDeck('en/test');
  assert.strictEqual(after.slides.length, 2);
  await DS.deleteSlide('en/test', 0);
  after = await DS.readDeck('en/test');
  assert.strictEqual(after.slides.length, 1);
  await assert.rejects(() => DS.deleteSlide('en/test', 0), /Cannot delete the last slide/);
  ok('deleteSlide persists and refuses last slide');

  // moveSlide persists.
  await DS.importMarkdown('en/move', '---\nmarp: true\n---\n\n# A\n\n---\n\n# B\n');
  await DS.moveSlide('en/move', 0, 'down');
  const moved = await DS.readDeck('en/move');
  assert.deepStrictEqual([moved.slides[0], moved.slides[1]], ['# B', '# A'], 'moveSlide down persisted');
  ok('moveSlide persists across read-modify-write');

  // export/import round-trip.
  const exported = await DS.exportMarkdown('en/move');
  assert.strictEqual(typeof exported, 'string');
  await DS.importMarkdown('en/imported', exported);
  const imported = await DS.readDeck('en/imported');
  assert.strictEqual(imported.markdown, exported, 'import stores exported markdown');
  ok('exportMarkdown + importMarkdown round-trip');

  // deleteDeck removes it.
  await DS.deleteDeck('en/imported');
  await assert.rejects(() => DS.readDeck('en/imported'), /Deck not found/);
  ok('deleteDeck removes deck');

  done();
})().catch(err => { console.error(err); process.exit(1); });

function done() {
  console.log('\n# ' + passed + ' assertions passed');
}
