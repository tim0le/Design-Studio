/*
 * locator.js — client-side port of the quick-edit locator from routes/edit.js.
 *
 * On serverless there is no /api/edit route to locate-and-apply the AI's
 * replacement text into the slide markdown. This module ports that logic
 * BYTE-FAITHFULLY from routes/edit.js so the apply behavior is identical:
 *
 *   - normalize(s)                          — strip * _ ` ~ and collapse spaces
 *   - fuzzyFind(source, needle)             — normalized substring match -> range
 *   - replaceInSource(source, needle, repl) — exact match, then fuzzy
 *   - replaceByOuterHtml(source, html, repl)— wrap-preserving outerHTML replace
 *
 * Plus the two apply strategies routes/edit.js uses, exposed as helpers:
 *   - applyEdit(slideMarkdown, {elementHtml, elementText}, replacement)
 *       1. outerHTML match -> 2. exact text -> 3. fuzzy text; null if none found
 *       (caller surfaces the same 422-style "Could not locate…" message)
 *   - applyGenerate(slideMarkdown, {elementHtml, elementText}, replacement)
 *       elementHtml-includes match first, else replaceInSource, else append
 *
 * Exposes `window.FGS_Locator` in the browser and `module.exports` in Node
 * (so it can be unit-tested without a DOM).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.FGS_Locator = api;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null)), function () {
  'use strict';

  // The exact 422 message routes/edit.js returns when no locator matches.
  var NOT_FOUND_MESSAGE =
    'Could not locate the selected text in the source markdown. Try a smaller selection — or use Agent mode, which can edit the file directly.';

  // ── ported verbatim from routes/edit.js ──────────────────────────────────

  // Normalize whitespace and strip markdown inline formatting (* _ ` ~) for matching.
  function normalize(s) {
    return s.replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Find a passage in source whose normalized form matches needle's normalized form.
  // Returns {start, end} index range in source, or null if not found.
  function fuzzyFind(source, needle) {
    var target = normalize(needle);
    if (!target) return null;
    // Build a parallel map: stripped chars and their original positions.
    var positions = [];
    var stripped = '';
    for (var i = 0; i < source.length; i++) {
      var c = source[i];
      if (c === '*' || c === '_' || c === '`' || c === '~') continue;
      positions.push(i);
      stripped += c;
    }
    var normalizedStripped = stripped.replace(/\s+/g, ' ');
    // Map from normalizedStripped indices back to stripped indices.
    var strippedPositions = [];
    var prevWasSpace = false;
    for (var j = 0; j < stripped.length; j++) {
      var ch = stripped[j];
      if (/\s/.test(ch)) {
        if (!prevWasSpace && strippedPositions.length > 0) {
          strippedPositions.push(j);
        }
        prevWasSpace = true;
      } else {
        strippedPositions.push(j);
        prevWasSpace = false;
      }
    }
    // Trim leading whitespace tracking for normalizedStripped (it isn't trimmed; only collapsed).
    var idx = normalizedStripped.indexOf(target);
    if (idx < 0) return null;
    // Find original positions
    var strippedStart = strippedPositions[idx];
    var strippedEnd = strippedPositions[idx + target.length - 1] + 1;
    if (strippedStart === undefined || strippedEnd === undefined) return null;
    var origStart = positions[strippedStart];
    var origEnd = positions[strippedEnd - 1] + 1;
    return { start: origStart, end: origEnd };
  }

  function replaceInSource(source, needle, replacement) {
    // 1. Exact match.
    var exactIdx = source.indexOf(needle);
    if (exactIdx >= 0) {
      return source.substring(0, exactIdx) + replacement + source.substring(exactIdx + needle.length);
    }
    // 2. Fuzzy (strip * _ ` ~, collapse whitespace).
    var range = fuzzyFind(source, needle);
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
    var idx = source.indexOf(elementHtml);
    if (idx < 0) return null;

    var openMatch = elementHtml.match(/^<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/);
    var closeMatch = elementHtml.match(/<\/([a-zA-Z][a-zA-Z0-9-]*)>\s*$/);
    // Only do the wrap-preserving replace when the element has a matching pair of
    // open/close tags of the same name. Self-closing / fragment cases fall back.
    if (!openMatch || !closeMatch || openMatch[1].toLowerCase() !== closeMatch[1].toLowerCase()) {
      return source.substring(0, idx) + replacementText + source.substring(idx + elementHtml.length);
    }
    var rebuilt = openMatch[0] + replacementText + closeMatch[0];
    return source.substring(0, idx) + rebuilt + source.substring(idx + elementHtml.length);
  }

  // ── apply strategies (mirror routes/edit.js request body) ─────────────────

  // EDIT mode locator chain (most specific -> least):
  //   1. outerHTML match — exact, preserves tags/attrs
  //   2. exact elementText match
  //   3. fuzzy elementText match (whitespace + markdown emphasis stripped)
  // Returns the updated slide markdown, or null if nothing matched.
  function applyEdit(slideMarkdown, selection, replacement) {
    var elementHtml = selection && selection.elementHtml;
    var elementText = selection && selection.elementText;
    var next = null;
    if (elementHtml) next = replaceByOuterHtml(slideMarkdown, elementHtml, replacement);
    if (next === null) next = replaceInSource(slideMarkdown, elementText, replacement);
    return next; // null => caller surfaces NOT_FOUND_MESSAGE (422 parity)
  }

  // GENERATE mode apply (mirror routes/edit.js generate branch):
  //   elementHtml-includes match first; else replaceInSource; else append.
  // Always returns updated markdown (append fallback never fails).
  function applyGenerate(slideMarkdown, selection, replacement) {
    var elementHtml = selection && selection.elementHtml;
    var elementText = selection && selection.elementText;
    if (elementHtml && slideMarkdown.includes(elementHtml)) {
      return slideMarkdown.replace(elementHtml, replacement);
    }
    var next = replaceInSource(slideMarkdown, elementText, replacement);
    return next !== null ? next : slideMarkdown + '\n\n' + replacement;
  }

  return {
    NOT_FOUND_MESSAGE: NOT_FOUND_MESSAGE,
    normalize: normalize,
    fuzzyFind: fuzzyFind,
    replaceInSource: replaceInSource,
    replaceByOuterHtml: replaceByOuterHtml,
    applyEdit: applyEdit,
    applyGenerate: applyGenerate
  };
});
