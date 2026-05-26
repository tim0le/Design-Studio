/**
 * elementSource: stable element identity for direct-manipulation flows.
 *
 * Every "movable/editable" element in a slide can be referenced by a UUID
 * (data-fgs-id) embedded in the source markdown. The DOM in the iframe
 * carries the same UUID. Operations look up elements by UUID rather than
 * fuzzy text matching, which is fragile and order-dependent.
 *
 * Markdown constructs (`## Heading`, standalone paragraphs) are converted
 * to HTML (`<h2 data-fgs-id="…">Heading</h2>`) the FIRST time a user
 * touches them. HTML elements with no UUID get the attribute injected.
 * Subsequent operations reuse the existing UUID — these helpers are all
 * idempotent.
 */

const TAG_ATTR = 'data-fgs-id';

// RFC4122 v4. We don't need cryptographic strength here — collision-resistance
// is enough. Browser side uses crypto.randomUUID() when available.
function generateUuid() {
  // 16 random bytes, set version 4 + variant 10xx
  const bytes = new Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-');
}

// Escape a string for use inside a RegExp.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parse an HTML opening tag's attributes into a plain object.
// Returns { tagName, attrs } or null. Naive but sufficient for the kinds of
// inline HTML Marp slides contain (no nested quoted angle brackets in attrs).
function parseOpenTag(tag) {
  const m = tag.match(/^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)\s*(\/?)>$/);
  if (!m) return null;
  const tagName = m[1].toLowerCase();
  const rawAttrs = m[2] || '';
  const attrs = {};
  const attrRe = /\s+([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let am;
  while ((am = attrRe.exec(rawAttrs)) !== null) {
    const name = am[1];
    const val = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : '';
    attrs[name] = val;
  }
  return { tagName, attrs, selfClosing: m[3] === '/' };
}

// Serialize { tagName, attrs } back into an opening tag string. Attribute order
// is insertion order — we keep existing attrs in their original sequence and
// append new ones at the end (callers that need a specific order should set
// attrs in that order).
function serializeOpenTag(tagName, attrs, selfClosing = false) {
  const pairs = Object.keys(attrs)
    .filter(k => attrs[k] !== undefined && attrs[k] !== null)
    .map(k => `${k}="${String(attrs[k]).replace(/"/g, '&quot;')}"`);
  return `<${tagName}${pairs.length ? ' ' + pairs.join(' ') : ''}${selfClosing ? ' /' : ''}>`;
}

// Find the matching close tag for an opening tag at `openStart` in `source`.
// Handles nested same-name tags via a depth counter. Returns the index of the
// `<` of the matching close tag, or -1 if not found / mismatched.
function findMatchingClose(source, openStart, tagName) {
  const openRe = new RegExp(`<${escapeRegex(tagName)}(?=[\\s/>])`, 'gi');
  const closeRe = new RegExp(`</${escapeRegex(tagName)}\\s*>`, 'gi');
  // Start scanning from just after the opening tag's `<`.
  openRe.lastIndex = openStart + 1;
  closeRe.lastIndex = openStart + 1;
  let depth = 1;
  while (depth > 0) {
    const om = openRe.exec(source);
    const cm = closeRe.exec(source);
    if (!cm) return -1;
    if (om && om.index < cm.index) {
      depth++;
      closeRe.lastIndex = om.index + 1; // ensure next close search continues past
    } else {
      depth--;
      if (depth === 0) return cm.index;
      // continue: next openRe search resumes from its last position
      openRe.lastIndex = cm.index + 1;
    }
  }
  return -1;
}

// Find the element with the given data-fgs-id in `source`. Returns
// { start, end, openEnd, closeStart, tagName, attrs, innerHTML, outerHTML }
// or null. `start` is the index of the opening `<`, `end` is one past the
// closing `>`.
function findElementById(source, uuid) {
  if (!uuid) return null;
  // Match an opening tag containing `data-fgs-id="<uuid>"`. We scan all
  // opening tags and check attrs to avoid false positives across attribute
  // ordering / quote style.
  const openTagRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)\s*(\/?)>/g;
  let m;
  while ((m = openTagRe.exec(source)) !== null) {
    const full = m[0];
    const parsed = parseOpenTag(full);
    if (!parsed) continue;
    if (parsed.attrs[TAG_ATTR] !== uuid) continue;
    const start = m.index;
    const openEnd = start + full.length;
    if (parsed.selfClosing) {
      return {
        start, end: openEnd, openEnd, closeStart: openEnd,
        tagName: parsed.tagName, attrs: parsed.attrs,
        innerHTML: '', outerHTML: full
      };
    }
    const closeStart = findMatchingClose(source, start, parsed.tagName);
    if (closeStart < 0) return null;
    const closeEnd = source.indexOf('>', closeStart) + 1;
    return {
      start, end: closeEnd, openEnd, closeStart,
      tagName: parsed.tagName, attrs: parsed.attrs,
      innerHTML: source.slice(openEnd, closeStart),
      outerHTML: source.slice(start, closeEnd)
    };
  }
  return null;
}

// Strip HTML tags and collapse whitespace — gives a plain-text fingerprint
// suitable for comparing two elements' visible content.
function plainTextFingerprint(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Find an existing HTML element opening tag in source that matches the
// browser's elementHtml. The browser's outerHTML often collapses whitespace
// differently from source, and many slides contain repeated identical
// opening tags (e.g. three `<div class="card">` siblings) — so the locator
// must use BOTH the opening tag AND the inner text to disambiguate.
//
// Strategy:
//   1. Collect every opening tag with matching name + attrs (sans fgs-*
//      classes the browser injected during selection).
//   2. If exactly one, return it.
//   3. If multiple, score by inner-text fingerprint similarity to the
//      browser's elementText (or text stripped from elementHtml). Return the
//      first candidate whose fingerprint matches.
//   4. If no fingerprint match (and the verbatim outerHTML wasn't in source
//      either), refuse rather than guess.
//
// Returns { start, openTag, tagName, attrs } or null.
function findHtmlOpenTag(source, elementHtml, elementText) {
  if (!elementHtml) return null;
  const openMatch = elementHtml.match(/^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)\s*(\/?)>/);
  if (!openMatch) return null;
  const openTag = openMatch[0];
  const parsed = parseOpenTag(openTag);
  if (!parsed) return null;

  // Compute inner-text fingerprint from elementText (already stripped by the
  // browser) or by stripping tags from the inner of elementHtml.
  const lastClose = elementHtml.lastIndexOf('</');
  const innerSlice = lastClose > openTag.length ? elementHtml.slice(openTag.length, lastClose) : '';
  const wantInner = plainTextFingerprint(elementText || innerSlice);

  // Strip fgs-* classes (browser-added during selection) so they don't
  // disqualify a source-side match.
  const browserAttrs = { ...parsed.attrs };
  if (browserAttrs.class) {
    browserAttrs.class = browserAttrs.class
      .split(/\s+/)
      .filter(c => !/^fgs-/.test(c))
      .join(' ');
  }
  const wantClassSorted = (browserAttrs.class || '').split(/\s+/).filter(Boolean).sort().join(' ');

  // Collect all candidate opening tags with matching name + matching class.
  const tagRe = new RegExp(`<${escapeRegex(parsed.tagName)}(?:\\s+[^>]*?)?\\s*/?>`, 'gi');
  const candidates = [];
  let m;
  while ((m = tagRe.exec(source)) !== null) {
    const candidate = parseOpenTag(m[0]);
    if (!candidate) continue;
    if (candidate.attrs[TAG_ATTR]) continue; // already-tagged elements are reused via step 1 of ensureElementId
    const candClassSorted = (candidate.attrs.class || '').split(/\s+/).filter(Boolean).sort().join(' ');
    if (candClassSorted !== wantClassSorted) continue;
    candidates.push({ start: m.index, openTag: m[0], tagName: candidate.tagName, attrs: candidate.attrs });
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Multiple matches — disambiguate by inner-text fingerprint. Walk each
  // candidate, find its closing tag, compare its plain-text to wantInner.
  if (wantInner) {
    for (const c of candidates) {
      const closeStart = findMatchingClose(source, c.start, c.tagName);
      if (closeStart < 0) continue;
      const inner = source.slice(c.start + c.openTag.length, closeStart);
      if (plainTextFingerprint(inner) === wantInner) return c;
    }
  }

  // No fingerprint match — refuse rather than silently pick the wrong one.
  return null;
}

// Markdown heading detection. `## Title` / `### Subtitle` etc. Returns
// { level, text, lineStart, lineEnd } where lineStart..lineEnd covers the
// whole heading line (without trailing newline). Returns null if no match.
function findMarkdownHeading(source, text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  // Lines starting with 1-6 `#` followed by space then the text.
  const lines = source.split('\n');
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      const headingText = hm[2].trim();
      // Match the trimmed text either as a substring of the heading or
      // exactly. We accept substring because the DOM textContent strips
      // markdown emphasis (`*…*`) while the source still contains them.
      const headingPlain = headingText.replace(/[*_`~]/g, '').trim();
      const targetPlain = trimmed.replace(/[*_`~]/g, '').trim();
      if (headingPlain === targetPlain || headingText === trimmed) {
        return {
          level: hm[1].length,
          text: headingText,
          lineStart: pos,
          lineEnd: pos + line.length
        };
      }
    }
    pos += line.length + 1; // +1 for the \n consumed by split
  }
  return null;
}

// Convert a subset of inline markdown to HTML so it renders correctly when
// embedded inside an HTML block (Marp does NOT re-enter markdown mode inside
// `<h2>`/`<p>` etc. when html:true). Handles **strong**, *em*, _em_, `code`.
// Order matters: **…** must be processed before *…* so we don't eat the inner
// asterisks. Best-effort — doesn't handle nesting like ***both***.
function inlineMarkdownToHtml(text) {
  if (!text) return '';
  return String(text)
    // **strong**
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    // *em* — require non-space adjacent to asterisk to avoid grabbing literal *
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
    // _em_ — same restriction
    .replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
    // `code`
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

// Wrap a markdown heading line into `<hN data-fgs-id="…">…</hN>`. Converts
// inline markdown emphasis to HTML first, because Marp does not re-process
// markdown inside HTML block elements when html:true — leaving `*x*` literal
// would cause visible asterisks in the rendered slide.
function wrapMarkdownHeading(source, heading, uuid) {
  const tag = `h${heading.level}`;
  const inner = inlineMarkdownToHtml(heading.text);
  const wrapped = `<${tag} ${TAG_ATTR}="${uuid}">${inner}</${tag}>`;
  return source.slice(0, heading.lineStart) + wrapped + source.slice(heading.lineEnd);
}

// Inject `data-fgs-id="<uuid>"` into an existing opening tag. Preserves all
// other attributes and their order; appends the new attr at the end.
function injectIdAttr(source, openTagInfo, uuid) {
  const { start, openTag, tagName, attrs } = openTagInfo;
  const newAttrs = { ...attrs, [TAG_ATTR]: uuid };
  const newOpenTag = serializeOpenTag(tagName, newAttrs, /\/>$/.test(openTag));
  return source.slice(0, start) + newOpenTag + source.slice(start + openTag.length);
}

/**
 * Ensure the element identified by tagName + elementText + elementHtml has a
 * UUID. Returns { newMarkdown, uuid, alreadyTagged }. Idempotent: if the
 * element already has a UUID, returns the existing UUID and the unchanged
 * markdown.
 *
 * Locator strategy:
 *   1. If elementHtml contains data-fgs-id="…" AND that UUID exists in
 *      source, reuse it.
 *   2. If elementHtml exists verbatim in source and has no UUID, inject one
 *      into its opening tag.
 *   3. If tagName is h1..h6, look for the matching markdown heading and wrap
 *      it.
 *   4. Otherwise — fall back to wrapping the literal elementText in a tag of
 *      the requested name. This is a last resort; callers should prefer to
 *      send elementHtml when possible.
 */
function ensureElementId(slideMarkdown, { tagName, elementText, elementHtml }) {
  // Step 1: UUID already present in elementHtml? Trust it if it exists in
  // source. (This is the steady-state case after the first operation.)
  const existingIdMatch = (elementHtml || '').match(/data-fgs-id="([^"]+)"/);
  if (existingIdMatch) {
    const existing = existingIdMatch[1];
    if (findElementById(slideMarkdown, existing)) {
      return { newMarkdown: slideMarkdown, uuid: existing, alreadyTagged: true };
    }
  }

  // Step 2: HTML element verbatim in source — inject attr.
  const htmlInfo = findHtmlOpenTag(slideMarkdown, elementHtml, elementText);
  if (htmlInfo) {
    // If it already has the attr (somehow not matched above), reuse it.
    if (htmlInfo.attrs[TAG_ATTR]) {
      return { newMarkdown: slideMarkdown, uuid: htmlInfo.attrs[TAG_ATTR], alreadyTagged: true };
    }
    const uuid = generateUuid();
    const newMarkdown = injectIdAttr(slideMarkdown, htmlInfo, uuid);
    return { newMarkdown, uuid, alreadyTagged: false };
  }

  // Step 3: Markdown heading → wrap as HTML.
  if (tagName && /^h[1-6]$/i.test(tagName)) {
    const heading = findMarkdownHeading(slideMarkdown, elementText);
    if (heading) {
      const uuid = generateUuid();
      const newMarkdown = wrapMarkdownHeading(slideMarkdown, heading, uuid);
      return { newMarkdown, uuid, alreadyTagged: false };
    }
  }

  // Step 4: Markdown paragraph (or other) → try to find the line by exact
  // text match and wrap it in <p> or <tagName>.
  if (elementText) {
    const trimmedTarget = elementText.trim();
    const targetPlain = trimmedTarget.replace(/[*_`~]/g, '').trim();
    const lines = slideMarkdown.split('\n');
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const linePlain = line.replace(/[*_`~]/g, '').trim();
      if (line.trim() && (linePlain === targetPlain || line.trim() === trimmedTarget)) {
        // Don't wrap if the line is already inside an HTML block or already
        // a heading (heading case is handled above). Skip if the line itself
        // is purely an opening / closing HTML tag.
        if (/^<\/?[a-zA-Z]/.test(line.trim())) {
          pos += line.length + 1;
          continue;
        }
        if (/^#{1,6}\s+/.test(line)) {
          pos += line.length + 1;
          continue;
        }
        const uuid = generateUuid();
        const tag = (tagName || 'p').toLowerCase();
        const leadingMatch = line.match(/^(\s*)/);
        const leading = leadingMatch ? leadingMatch[1] : '';
        const inner = inlineMarkdownToHtml(line.slice(leading.length));
        const wrapped = `${leading}<${tag} ${TAG_ATTR}="${uuid}">${inner}</${tag}>`;
        const newMarkdown = slideMarkdown.slice(0, pos) + wrapped + slideMarkdown.slice(pos + line.length);
        return { newMarkdown, uuid, alreadyTagged: false };
      }
      pos += line.length + 1;
    }
  }

  // Could not locate the element.
  return null;
}

// Parse an inline style string `position:absolute; left:10px` into an
// ordered list of [key, value] pairs. Preserves order for stable serialization.
function parseStyleString(style) {
  if (!style) return [];
  return style.split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const colon = part.indexOf(':');
      if (colon < 0) return [part.trim(), ''];
      return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
    });
}

function serializeStyleString(pairs) {
  return pairs.map(([k, v]) => `${k}:${v}`).join(';');
}

// Merge styleObj into the existing style string. Keys in styleObj REPLACE
// existing values; new keys are appended. Returns the new style string.
// Empty/null values in styleObj REMOVE the key entirely.
function mergeStyle(existing, styleObj) {
  const pairs = parseStyleString(existing);
  const updateKeys = Object.keys(styleObj);
  // Update in-place for existing keys
  for (let i = 0; i < pairs.length; i++) {
    const k = pairs[i][0];
    if (Object.prototype.hasOwnProperty.call(styleObj, k)) {
      pairs[i][1] = styleObj[k];
    }
  }
  // Append new keys
  for (const k of updateKeys) {
    if (!pairs.some(p => p[0] === k)) {
      pairs.push([k, styleObj[k]]);
    }
  }
  // Drop pairs with empty/null values
  const cleaned = pairs.filter(([, v]) => v !== '' && v !== null && v !== undefined);
  return serializeStyleString(cleaned);
}

/**
 * Replace inline style on the element with this UUID. Replaces individual
 * style properties (e.g. position/left/top) without clobbering others.
 * Returns the updated markdown, or null if the UUID isn't found.
 */
function setElementStyle(slideMarkdown, uuid, styleObj) {
  const found = findElementById(slideMarkdown, uuid);
  if (!found) return null;
  const newStyle = mergeStyle(found.attrs.style || '', styleObj);
  const newAttrs = { ...found.attrs };
  if (newStyle) newAttrs.style = newStyle;
  else delete newAttrs.style;
  const selfClosing = /\/>$/.test(found.outerHTML) && found.innerHTML === '';
  const newOpenTag = serializeOpenTag(found.tagName, newAttrs, selfClosing);
  // Rebuild the element: opening tag + innerHTML + closing tag (or self-closing).
  let rebuilt;
  if (selfClosing) {
    rebuilt = newOpenTag;
  } else {
    rebuilt = newOpenTag + found.innerHTML + `</${found.tagName}>`;
  }
  return slideMarkdown.slice(0, found.start) + rebuilt + slideMarkdown.slice(found.end);
}

/**
 * Replace the innerHTML/text of the element with this UUID. Preserves
 * attributes and the surrounding tag. Returns updated markdown, or null if
 * UUID not found.
 *
 * Note: this replaces innerHTML wholesale, so the caller is responsible for
 * sanitizing if the new content shouldn't be interpreted as HTML. For the
 * contenteditable flow, we pass plain text (the browser's textContent), so
 * HTML special chars need escaping.
 */
function replaceElementText(slideMarkdown, uuid, newText) {
  const found = findElementById(slideMarkdown, uuid);
  if (!found) return null;
  if (/<\//.test(found.outerHTML) === false && found.innerHTML === '') {
    // self-closing element — can't have text
    return slideMarkdown;
  }
  const escaped = String(newText)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const selfClosing = /\/>$/.test(found.outerHTML) && found.innerHTML === '';
  const openTag = serializeOpenTag(found.tagName, found.attrs, selfClosing);
  const rebuilt = openTag + escaped + `</${found.tagName}>`;
  return slideMarkdown.slice(0, found.start) + rebuilt + slideMarkdown.slice(found.end);
}

/**
 * Remove the entire element identified by UUID from the markdown. Cleans up
 * trailing whitespace on the line it occupied (so we don't leave a blank
 * line if the element was the only thing on it). Returns null if not found.
 */
function deleteElement(slideMarkdown, uuid) {
  const found = findElementById(slideMarkdown, uuid);
  if (!found) return null;
  let start = found.start;
  let end = found.end;
  // If the element occupies a whole line (preceded only by whitespace, then
  // EOL or BOF, and followed only by whitespace then EOL), consume the line
  // and its trailing newline so we don't leave a blank line behind.
  let lineStart = start;
  while (lineStart > 0 && slideMarkdown[lineStart - 1] !== '\n') {
    if (!/\s/.test(slideMarkdown[lineStart - 1])) { lineStart = -1; break; }
    lineStart--;
  }
  let lineEnd = end;
  while (lineEnd < slideMarkdown.length && slideMarkdown[lineEnd] !== '\n') {
    if (!/\s/.test(slideMarkdown[lineEnd])) { lineEnd = -1; break; }
    lineEnd++;
  }
  if (lineStart >= 0 && lineEnd >= 0) {
    // Include the trailing newline (if present) to fully remove the line.
    if (lineEnd < slideMarkdown.length && slideMarkdown[lineEnd] === '\n') lineEnd++;
    start = lineStart;
    end = lineEnd;
  }
  return slideMarkdown.slice(0, start) + slideMarkdown.slice(end);
}

module.exports = {
  TAG_ATTR,
  generateUuid,
  findElementById,
  ensureElementId,
  setElementStyle,
  replaceElementText,
  deleteElement,
  // Exposed for tests:
  parseOpenTag,
  serializeOpenTag,
  parseStyleString,
  mergeStyle
};
