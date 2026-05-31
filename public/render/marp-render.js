/* ── Client-side Marp renderer ──
 *
 * Renders a single Furgoson slide entirely in the browser using the bundled
 * @marp-team/marp-core (see public/vendor/marp-core.bundle.js, global
 * `MarpCore`). No `marp` CLI, no Chromium, no server round-trip.
 *
 * Load order in the page:
 *   <script src="/vendor/marp-core.bundle.js"></script>
 *   <script src="/render/marp-render.js"></script>
 *
 * Public API (attached to window.MarpRender):
 *   await ready()                                   -> resolves once themes are registered
 *   await renderSlideDoc(frontmatter, slideMd)      -> { html, css }
 *   await renderToIframeSrcdoc(frontmatter, slideMd)-> full HTML document string
 *
 * Both render functions are async because theme CSS is fetched on first use.
 */
window.MarpRender = (function () {
  'use strict';

  // Theme CSS files served as static assets. The Furgoson theme is the
  // default; `starter` is also registered so decks referencing `theme: starter`
  // still render. Each file carries a `/* @theme <name> */` header that must
  // match the deck frontmatter `theme:` value.
  var THEME_URLS = [
    { name: 'furgoson', url: '/render/themes/furgoson.css', isDefault: true },
    { name: 'starter', url: '/render/themes/starter.css', isDefault: false }
  ];

  var _readyPromise = null;

  // Lazily fetch + register all theme CSS into a fresh Marp instance's
  // themeSet. Resolves with nothing; throws if marp-core isn't loaded or a
  // theme can't be fetched.
  function _loadThemes() {
    if (typeof window.MarpCore === 'undefined' || typeof window.MarpCore.Marp !== 'function') {
      return Promise.reject(new Error(
        'MarpCore not loaded — include /vendor/marp-core.bundle.js before marp-render.js'
      ));
    }
    return Promise.all(THEME_URLS.map(function (t) {
      return fetch(t.url).then(function (res) {
        if (!res.ok) throw new Error('Failed to fetch theme ' + t.name + ': HTTP ' + res.status);
        return res.text().then(function (css) {
          return { css: css, isDefault: t.isDefault };
        });
      });
    }));
  }

  // Resolves to an array of { css, isDefault }, caching the successful promise.
  // On failure the cache is cleared so a later call can retry (otherwise a
  // single transient fetch error would wedge rendering forever).
  function ready() {
    if (!_readyPromise) {
      _readyPromise = _loadThemes();
      _readyPromise.catch(function () { _readyPromise = null; });
    }
    return _readyPromise;
  }

  // Build a fresh Marp instance with all themes registered. A new instance per
  // render keeps state isolated (marp-core accumulates per-render state).
  function _makeMarp(themes) {
    var marp = new window.MarpCore.Marp({ html: true });
    themes.forEach(function (t) {
      var added = marp.themeSet.add(t.css);
      if (t.isDefault) marp.themeSet.default = added;
    });
    return marp;
  }

  // Mirror of buildSingleSlideDoc() in lib/marp.js: strip the leading/trailing
  // `---` fences from the frontmatter block, force `paginate: false`, then
  // reassemble a one-slide Marp document.
  function buildSingleSlideDoc(frontmatter, slideContent) {
    var fm = String(frontmatter == null ? '' : frontmatter)
      .replace(/^---\n/, '')
      .replace(/\n---$/, '')
      .replace(/paginate:\s*\S+/, 'paginate: false');
    return '---\n' + fm + '\n---\n\n' + String(slideContent == null ? '' : slideContent) + '\n';
  }

  // Render a single slide. Returns { html, css }.
  function renderSlideDoc(frontmatter, slideContent) {
    return ready().then(function (themes) {
      var marp = _makeMarp(themes);
      var doc = buildSingleSlideDoc(frontmatter, slideContent);
      var out = marp.render(doc);
      return { html: out.html, css: out.css };
    });
  }

  // Render to a complete HTML document string suitable for an iframe `srcdoc`.
  // Selection behaviors are deliberately NOT injected here — unit B2 owns
  // public/render/selection.js. We leave a marked injection point before
  // </body> so B2 (or a caller) can splice its script in.
  function renderToIframeSrcdoc(frontmatter, slideContent) {
    return renderSlideDoc(frontmatter, slideContent).then(function (out) {
      return (
        '<!DOCTYPE html>\n' +
        '<html>\n<head>\n' +
        '<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        '<style>\n' + out.css + '\n</style>\n' +
        '</head>\n<body>\n' +
        out.html + '\n' +
        '<!-- FGS_SELECTION_INJECT -->\n' +
        '</body>\n</html>'
      );
    });
  }

  return {
    ready: ready,
    buildSingleSlideDoc: buildSingleSlideDoc,
    renderSlideDoc: renderSlideDoc,
    renderToIframeSrcdoc: renderToIframeSrcdoc
  };
})();
