'use strict';

/**
 * Precise per-slide byte range helpers.
 *
 * The deck markdown looks like:
 *
 *   ---
 *   marp: true
 *   theme: furgoson
 *   ---
 *
 *   <!-- _class: cover -->
 *   # First slide
 *   ...
 *   ---
 *   <!-- _class: top -->
 *   # Second slide
 *
 * Slides are separated by a line containing exactly `---` (CR optional). A
 * leading frontmatter block wrapped in `---` lines is optional. Separators
 * that appear inside an HTML comment block (`<!-- ... -->`) are ignored.
 *
 * The returned `{start, end, content}` offsets are byte offsets into the
 * ORIGINAL string (NOT the normalised one) so callers can use them with
 * `String.prototype.slice` for surgical edits.
 */

/**
 * Find all separator positions in the source. A separator is a line whose
 * content is exactly `---` (with optional trailing CR), that is NOT inside
 * an HTML comment block.
 *
 * Returns an array of {sepStart, sepEnd}:
 *   sepStart: offset of the first `-` of the separator line
 *   sepEnd:   offset just past the trailing newline of the separator line
 *             (== source.length if the separator was the final line with no
 *             trailing newline)
 */
function findSeparators(source) {
  const seps = [];
  const len = source.length;
  let inComment = false;
  let lineStart = 0;
  let i = 0;

  while (i <= len) {
    const c = i < len ? source[i] : '\n';

    // Update comment state by scanning at the current cursor BEFORE we
    // treat the character as a line terminator. We only inspect `<` and `-`
    // characters; everything else is fall-through.
    if (!inComment && i < len && source[i] === '<'
        && source[i + 1] === '!' && source[i + 2] === '-' && source[i + 3] === '-') {
      inComment = true;
      i += 4;
      continue;
    }
    if (inComment && i < len && source[i] === '-'
        && source[i + 1] === '-' && source[i + 2] === '>') {
      inComment = false;
      i += 3;
      continue;
    }

    if (c === '\n') {
      // We're at end-of-line. Inspect the line we just finished.
      // Compute the line content (without the trailing CR, if any).
      let contentEnd = i;
      if (contentEnd > lineStart && source[contentEnd - 1] === '\r') contentEnd--;
      const line = source.slice(lineStart, contentEnd);
      if (!inComment && line === '---') {
        seps.push({ sepStart: lineStart, sepEnd: i < len ? i + 1 : len });
      }
      lineStart = i + 1;
      i++;
      continue;
    }

    i++;
  }

  return seps;
}

/**
 * Compute every slide's byte range in `source`.
 *
 * Algorithm:
 *   1. Find all separator lines (`---` on its own line, outside HTML comments).
 *   2. If the source begins with a separator on the very first line, treat
 *      the first two separators as the frontmatter delimiters: slide 0 starts
 *      just after the second separator's trailing newline.
 *   3. Otherwise, slide 0 starts at offset 0.
 *   4. Each subsequent separator ends the current slide (at its sepStart) and
 *      begins the next (at its sepEnd).
 *   5. The final slide runs to the end of the file.
 *
 * The slide range does NOT include the separator lines themselves; callers
 * can therefore replace `source.slice(start, end)` with new slide content
 * without disturbing the surrounding `---` lines.
 */
function getAllSlideRanges(source) {
  if (typeof source !== 'string') {
    throw new TypeError('source must be a string');
  }
  const seps = findSeparators(source);
  const len = source.length;

  // Detect frontmatter: the file starts with `---` on the very first line.
  // (We treat the source as having frontmatter only when the FIRST separator
  // sits at offset 0 AND there is at least one more separator after it.)
  let cursor = 0;
  let startIdx = 0;
  const hasFrontmatter = seps.length >= 2 && seps[0].sepStart === 0;
  if (hasFrontmatter) {
    cursor = seps[1].sepEnd;
    startIdx = 2;
  }

  const ranges = [];
  let slideStart = cursor;
  for (let i = startIdx; i < seps.length; i++) {
    const sep = seps[i];
    ranges.push({ start: slideStart, end: sep.sepStart, content: source.slice(slideStart, sep.sepStart) });
    slideStart = sep.sepEnd;
  }
  // Final slide extends to EOF.
  ranges.push({ start: slideStart, end: len, content: source.slice(slideStart, len) });

  return ranges;
}

/**
 * Return `{start, end, content}` for the slide at `slideIndex`.
 * Throws if the index is out of range.
 */
function getSlideRange(source, slideIndex) {
  const ranges = getAllSlideRanges(source);
  if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex >= ranges.length) {
    throw new Error(`Slide index ${slideIndex} out of range`);
  }
  return ranges[slideIndex];
}

module.exports = { getSlideRange, getAllSlideRanges };
