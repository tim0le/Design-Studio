// Inline CSS custom properties so HTML→PPTX converters that don't understand
// `var(--name)` (notably LibreOffice's HTML import filter, used by Marp's
// --pptx-editable path) render the correct colors instead of falling back to
// defaults (#000 / #fff).
//
// Strategy:
//   1. Walk every <style>…</style> block, harvesting `--name: value;` pairs.
//      We also scan inline `style="…"` attributes' declarations.
//   2. Recursively resolve nested var()s in the harvested values.
//   3. Replace every `var(--name)` in the entire HTML with its resolved value
//      (or the user-supplied fallback if not declared).
//
// We deliberately keep this dependency-free — no full CSS parser. The Marp
// output is well-formed enough that regex resolution covers every case.

const VAR_REF_RE = /var\(\s*--([\w-]+)\s*(?:,\s*([^)]*))?\)/g;

// Collect `--name: value;` declarations from a chunk of CSS.
function collectVarsFromCss(cssText, vars) {
  // Iterate scoped to declarations — accept either `;` or end-of-block as the
  // terminator. We intentionally don't try to scope by selector; in CSS
  // custom-property cascade, scoping by selector requires a real DOM, and
  // Marp's theme defines them globally on `:root` / `section` anyway.
  const declRe = /--([\w-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/g;
  let m;
  while ((m = declRe.exec(cssText)) !== null) {
    const name = m[1];
    const value = m[2].trim();
    // Last writer wins — matches CSS cascade for redeclared variables.
    vars.set(name, value);
  }
}

// Resolve var() references inside `value` using `vars`, recursively, with a
// guard against circular references.
function resolveValue(value, vars, seen = new Set()) {
  return value.replace(VAR_REF_RE, (full, name, fallback) => {
    if (seen.has(name)) return fallback ? fallback.trim() : full;
    if (!vars.has(name)) return fallback ? resolveValue(fallback.trim(), vars, seen) : full;
    const next = new Set(seen);
    next.add(name);
    return resolveValue(vars.get(name), vars, next);
  });
}

// Resolve every CSS variable in an HTML string. Mutates nothing.
function resolveCssVars(html) {
  if (typeof html !== 'string' || !html) return html;

  const vars = new Map();

  // 1. <style> blocks.
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = styleRe.exec(html)) !== null) {
    collectVarsFromCss(m[1], vars);
  }

  // 2. Inline `style="..."` attribute declarations (rare in Marp output but
  //    cheap to scan; covers themes that emit them).
  const styleAttrRe = /style\s*=\s*"([^"]*)"|style\s*=\s*'([^']*)'/g;
  while ((m = styleAttrRe.exec(html)) !== null) {
    collectVarsFromCss(m[1] || m[2] || '', vars);
  }

  if (vars.size === 0) return html;

  // 3. Pre-resolve each var so we don't recurse on every replacement site.
  const resolved = new Map();
  for (const name of vars.keys()) {
    resolved.set(name, resolveValue(vars.get(name), vars));
  }

  // 4. Substitute throughout the HTML. We treat unknown vars by falling back
  //    to the inline fallback if present (`var(--x, #fff)` -> `#fff`).
  return html.replace(VAR_REF_RE, (full, name, fallback) => {
    if (resolved.has(name)) return resolved.get(name);
    if (fallback) return fallback.trim();
    return full;
  });
}

module.exports = { resolveCssVars };
