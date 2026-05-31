/*
 * deckStore.js — client-side deck storage for the Furgoson Studio PWA.
 *
 * On serverless/static hosting the server filesystem is read-only, so decks
 * live in the browser (IndexedDB). This module ports the PURE parsing/assembly
 * logic from lib/deck.js verbatim (so it behaves identically) and layers an
 * async IndexedDB-backed CRUD API on top.
 *
 * Pure functions (parseDeck/assembleDeck/updateSlide/addSlide/deleteSlide/
 * duplicateSlide/moveSlide/formatName/deriveMeta) operate on plain
 * strings/objects and never touch IndexedDB, so they are testable in Node.
 * The IndexedDB code is guarded behind a runtime check for `indexedDB`.
 *
 * Exposes `window.DeckStore` in the browser and `module.exports` in Node.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DeckStore = api;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null)), function () {
  'use strict';

  // ────────────────────────────────────────────────────────────────────────
  // PURE: parsing / assembly (ported verbatim from lib/deck.js)
  // ────────────────────────────────────────────────────────────────────────

  // Mirrors lib/deck.js DEFAULT_NEW_SLIDE exactly.
  const DEFAULT_NEW_SLIDE = '<!-- _class: top -->\n\n<header>\n  <span>FURGOSON</span>\n</header>\n\n<div class="eyebrow">NEW SLIDE</div>\n\n## Slide title\n\n<p class="subtitle">Replace this with your content.</p>\n';

  function parseDeck(markdown) {
    const normalized = markdown.replace(/\r\n/g, '\n');
    const fmMatch = normalized.match(/^---\n[\s\S]*?\n---\n/);
    const frontmatter = fmMatch ? fmMatch[0] : '';
    const body = normalized.slice(frontmatter.length);
    const slideTexts = body.split(/\n---\n/);
    return {
      frontmatter: frontmatter.trim(),
      slides: slideTexts.map(s => s.trim()).filter(Boolean)
    };
  }

  function assembleDeck(frontmatter, slides) {
    return frontmatter + '\n\n' + slides.join('\n\n---\n\n') + '\n';
  }

  function formatName(id, lang) {
    const map = {
      'ihk_4pager': lang === 'de' ? 'IHK 4-Pager (DE)' : 'IHK 4-Pager',
      'capabilities': lang === 'en' ? 'Capabilities (EN)' : 'Capabilities',
    };
    return map[id] || id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // Whether a parsed deck's frontmatter declares `marp: true` (the deck guard
  // from lib/deck.js listDecks). Pure — operates on the frontmatter string.
  function hasMarpFlag(frontmatter) {
    return /^---\n[\s\S]*?\bmarp:\s*true\b[\s\S]*?\n---/.test(frontmatter + '\n');
  }

  // Derive list metadata for a deck id + markdown, mirroring lib/deck.js
  // listDecks(). The id is the full path-like id (e.g. "de/foo/bar"); the
  // "basename" is the last path segment used for the display name.
  function deriveMeta(id, markdown) {
    const parsed = parseDeck(markdown);
    if (!hasMarpFlag(parsed.frontmatter)) return null;
    const lang = id.startsWith('de/') ? 'de' : id.startsWith('en/') ? 'en' : 'en';
    const basename = id.indexOf('/') === -1 ? id : id.slice(id.lastIndexOf('/') + 1);
    const name = formatName(basename, lang);
    const kind = id.includes('/one_pager/') ? 'one_pager' : 'deck';
    return { id, name, lang, kind, slideCount: parsed.slides.length };
  }

  // ── Slide-level CRUD on in-memory { frontmatter, slides } (pure) ──
  // These return new markdown / mutate the passed slides array, mirroring the
  // read-modify-write bodies of lib/deck.js but without IO. The async wrappers
  // below do the read/write around them.

  function applyUpdateSlide(frontmatter, slides, slideIndex, newSlideMarkdown) {
    if (slideIndex < 0 || slideIndex >= slides.length) throw new Error('Slide index out of range');
    slides[slideIndex] = newSlideMarkdown;
    return assembleDeck(frontmatter, slides);
  }

  function applyAddSlide(frontmatter, slides, content, insertAt) {
    const next = content || DEFAULT_NEW_SLIDE;
    let position;
    if (insertAt === undefined || insertAt === null || insertAt < 0) {
      position = slides.length;
    } else {
      position = Math.min(insertAt, slides.length);
    }
    slides.splice(position, 0, next.trim());
    return { markdown: assembleDeck(frontmatter, slides), insertedAt: position, slideCount: slides.length };
  }

  function applyDeleteSlide(frontmatter, slides, index) {
    if (index < 0 || index >= slides.length) throw new Error('Slide index out of range');
    if (slides.length === 1) throw new Error('Cannot delete the last slide in a deck');
    slides.splice(index, 1);
    return { markdown: assembleDeck(frontmatter, slides), slideCount: slides.length };
  }

  function applyDuplicateSlide(frontmatter, slides, index) {
    if (index < 0 || index >= slides.length) throw new Error('Slide index out of range');
    slides.splice(index + 1, 0, slides[index]);
    return { markdown: assembleDeck(frontmatter, slides), insertedAt: index + 1, slideCount: slides.length };
  }

  function applyMoveSlide(frontmatter, slides, index, direction) {
    if (index < 0 || index >= slides.length) throw new Error('Slide index out of range');
    const delta = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    if (!delta) throw new Error('direction must be "up" or "down"');
    const target = index + delta;
    if (target < 0 || target >= slides.length) {
      return { markdown: assembleDeck(frontmatter, slides), movedTo: index, slideCount: slides.length, noop: true };
    }
    const tmp = slides[index];
    slides[index] = slides[target];
    slides[target] = tmp;
    return { markdown: assembleDeck(frontmatter, slides), movedTo: target, slideCount: slides.length };
  }

  // ────────────────────────────────────────────────────────────────────────
  // IndexedDB persistence (guarded — only runs in a browser-like env)
  // ────────────────────────────────────────────────────────────────────────

  const DB_NAME = 'furgoson-studio';
  const DB_VERSION = 1;
  const STORE = 'decks';
  const SEED_BASE = 'seed-decks';

  function hasIDB() {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  }

  let _dbPromise = null;

  function openDB() {
    if (!hasIDB()) return Promise.reject(new Error('IndexedDB is not available in this environment'));
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          // keyPath 'id'; value = { id, markdown, name, lang, kind }
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function tx(mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      let settled = false;
      // Run fn synchronously so the IDB request is issued before the
      // transaction auto-commits at the end of this microtask. fn must issue
      // its request(s) synchronously (it may attach .then handlers that
      // resolve after); it reports its value via the setResult callback.
      try {
        fn(store, r => { result = r; });
      } catch (err) {
        settled = true;
        reject(err);
        return;
      }
      t.oncomplete = () => { if (!settled) resolve(result); };
      t.onerror = () => { if (!settled) { settled = true; reject(t.error); } };
      t.onabort = () => { if (!settled) { settled = true; reject(t.error || new Error('Transaction aborted')); } };
    }));
  }

  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Build a stored record from id + markdown (recomputes metadata each write).
  function buildRecord(id, markdown) {
    const meta = deriveMeta(id, markdown);
    const parsed = parseDeck(markdown);
    const lang = id.startsWith('de/') ? 'de' : id.startsWith('en/') ? 'en' : 'en';
    const basename = id.indexOf('/') === -1 ? id : id.slice(id.lastIndexOf('/') + 1);
    return {
      id,
      markdown,
      name: meta ? meta.name : formatName(basename, lang),
      lang: meta ? meta.lang : lang,
      kind: meta ? meta.kind : (id.includes('/one_pager/') ? 'one_pager' : 'deck')
    };
  }

  // ── Seeding ──────────────────────────────────────────────────────────────

  async function fetchSeedManifest() {
    try {
      const res = await fetch(SEED_BASE + '/index.json', { cache: 'no-cache' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // Minimal valid deck used when no example seed decks are available.
  const FALLBACK_SEED_ID = 'en/welcome';
  const FALLBACK_SEED_MD = [
    '---',
    'marp: true',
    'theme: furgoson',
    'paginate: false',
    'size: 16:9',
    'html: true',
    '---',
    '',
    '<!-- _class: cover -->',
    '',
    '# Welcome to the Studio',
    '',
    'Your decks now live in the browser. Edits persist on this device.',
    '',
    '---',
    '',
    '<div class="eyebrow">GETTING STARTED</div>',
    '',
    '## Create and edit',
    '',
    '- Tap a slide to select an element',
    '- Use the Edit panel to ask for changes',
    '- Import or export decks as Markdown',
    '',
    '---',
    '',
    '<div class="eyebrow">NEXT</div>',
    '',
    '## Make it yours',
    '',
    'Add slides, duplicate, reorder, and export when ready.',
    ''
  ].join('\n');

  // Seed the DB on first run (empty store). Tries the committed seed manifest;
  // falls back to a single minimal deck so the app is never empty.
  async function seedIfEmpty() {
    const existing = await tx('readonly', (store, set) => {
      reqToPromise(store.count()).then(set);
    });
    if (existing > 0) return { seeded: 0 };

    const manifest = await fetchSeedManifest();
    const records = [];
    if (manifest && Array.isArray(manifest.decks) && manifest.decks.length) {
      for (const d of manifest.decks) {
        try {
          const res = await fetch(SEED_BASE + '/' + d.path, { cache: 'no-cache' });
          if (!res.ok) continue;
          const md = await res.text();
          records.push(buildRecord(d.id, md));
        } catch (e) { /* skip unreadable seed */ }
      }
    }
    if (!records.length) {
      records.push(buildRecord(FALLBACK_SEED_ID, FALLBACK_SEED_MD));
    }

    await tx('readwrite', (store) => {
      for (const rec of records) store.put(rec);
    });
    return { seeded: records.length };
  }

  // ── Async public API ──────────────────────────────────────────────────────

  async function listDecks() {
    await seedIfEmpty();
    const records = await tx('readonly', (store, set) => {
      reqToPromise(store.getAll()).then(set);
    });
    return records
      .map(rec => deriveMeta(rec.id, rec.markdown))
      .filter(Boolean)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async function getRecord(id) {
    return tx('readonly', (store, set) => {
      reqToPromise(store.get(id)).then(set);
    });
  }

  async function readDeck(id) {
    const rec = await getRecord(id);
    if (!rec) throw new Error('Deck not found: ' + id);
    return { id, markdown: rec.markdown, ...parseDeck(rec.markdown) };
  }

  async function writeDeck(id, markdown) {
    await tx('readwrite', (store) => {
      store.put(buildRecord(id, markdown));
    });
    return markdown;
  }

  async function createDeck(id, markdown) {
    const existing = await getRecord(id);
    if (existing) throw new Error('Deck already exists: ' + id);
    await tx('readwrite', (store) => {
      store.put(buildRecord(id, markdown));
    });
    return { id, markdown, ...parseDeck(markdown) };
  }

  async function deleteDeck(id) {
    await tx('readwrite', (store) => {
      store.delete(id);
    });
    return { id, deleted: true };
  }

  // ── Slide CRUD wrappers (read-modify-write) ────────────────────────────────

  async function updateSlide(id, slideIndex, newSlideMarkdown) {
    const { frontmatter, slides } = await readDeck(id);
    const updated = applyUpdateSlide(frontmatter, slides, slideIndex, newSlideMarkdown);
    await writeDeck(id, updated);
    return updated;
  }

  async function addSlide(id, content, insertAt) {
    const { frontmatter, slides } = await readDeck(id);
    const r = applyAddSlide(frontmatter, slides, content, insertAt);
    await writeDeck(id, r.markdown);
    return { insertedAt: r.insertedAt, slideCount: r.slideCount };
  }

  async function deleteSlide(id, index) {
    const { frontmatter, slides } = await readDeck(id);
    const r = applyDeleteSlide(frontmatter, slides, index);
    await writeDeck(id, r.markdown);
    return { slideCount: r.slideCount };
  }

  async function duplicateSlide(id, index) {
    const { frontmatter, slides } = await readDeck(id);
    const r = applyDuplicateSlide(frontmatter, slides, index);
    await writeDeck(id, r.markdown);
    return { insertedAt: r.insertedAt, slideCount: r.slideCount };
  }

  async function moveSlide(id, index, direction) {
    const { frontmatter, slides } = await readDeck(id);
    const r = applyMoveSlide(frontmatter, slides, index, direction);
    // Mirror lib/deck.js: a boundary noop leaves the stored deck byte-for-byte
    // untouched. Re-writing here would normalize separators/whitespace via
    // assembleDeck even though nothing moved.
    if (!r.noop) await writeDeck(id, r.markdown);
    return { movedTo: r.movedTo, slideCount: r.slideCount, noop: !!r.noop };
  }

  // ── Import / export ─────────────────────────────────────────────────────

  // Import markdown into a deck id, creating or overwriting it.
  async function importMarkdown(id, mdText) {
    await writeDeck(id, mdText);
    return { id, markdown: mdText, ...parseDeck(mdText) };
  }

  // Export a deck's raw markdown (for download).
  async function exportMarkdown(id) {
    const rec = await getRecord(id);
    if (!rec) throw new Error('Deck not found: ' + id);
    return rec.markdown;
  }

  return {
    // pure parsing / assembly
    parseDeck,
    assembleDeck,
    formatName,
    hasMarpFlag,
    deriveMeta,
    DEFAULT_NEW_SLIDE,
    // pure slide ops (testable without IndexedDB)
    applyUpdateSlide,
    applyAddSlide,
    applyDeleteSlide,
    applyDuplicateSlide,
    applyMoveSlide,
    // async persistence API
    listDecks,
    readDeck,
    writeDeck,
    createDeck,
    deleteDeck,
    seedIfEmpty,
    // async slide CRUD wrappers
    updateSlide,
    addSlide,
    deleteSlide,
    duplicateSlide,
    moveSlide,
    // import / export
    importMarkdown,
    exportMarkdown,
    // internals (useful for tests / advanced use)
    hasIDB
  };
});
