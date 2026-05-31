const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ROOT: STUDIO_ROOT_DIR, THEME_DIR, DIST_DIR, listThemeFiles } = require('./studioRoot');

// Marp's `--theme` flag registers a CSS file under its `@theme <name>` header.
// We register EVERY theme file in the studio's theme dir so decks can reference
// any of them by name in their frontmatter (`theme: furgoson` / `theme: starter`).
function themeFlags() {
  return listThemeFiles().map(p => `--theme "${p}"`).join(' ');
}

// Back-compat: most call sites used to reference THEME_PATH. Keep it pointing
// at the first theme so any external code that still imports it doesn't break.
const _allThemes = listThemeFiles();
const THEME_PATH = _allThemes[0] || path.resolve(THEME_DIR, 'theme.css');

// Editable PPTX export requires LibreOffice's `soffice` binary on PATH. On
// Windows the default installer drops it under Program Files but doesn't
// always refresh open shells, so we discover and prepend it ourselves.
function libreOfficePath() {
  const candidates = [
    process.env.SOFFICE_PATH && path.dirname(process.env.SOFFICE_PATH),
    'C:\\Program Files\\LibreOffice\\program',
    'C:\\Program Files (x86)\\LibreOffice\\program',
    '/usr/bin',
    '/usr/local/bin',
    '/opt/libreoffice/program',
    '/Applications/LibreOffice.app/Contents/MacOS',
  ].filter(Boolean);
  for (const dir of candidates) {
    const bin = path.join(dir, os.platform() === 'win32' ? 'soffice.exe' : 'soffice');
    if (fs.existsSync(bin)) return dir;
  }
  return null;
}

// Returned env should be spread into execSync({ env }) for any export that may
// shell out to soffice (PPTX-editable). Adds the discovered LibreOffice dir to
// the front of PATH if it's not already there.
function execEnv() {
  const env = { ...process.env };
  const loDir = libreOfficePath();
  if (loDir) {
    const sep = os.platform() === 'win32' ? ';' : ':';
    const cur = env.PATH || env.Path || '';
    if (!cur.split(sep).includes(loDir)) {
      env.PATH = loDir + sep + cur;
      env.Path = env.PATH; // Windows is case-sensitive in spawned env
    }
  }
  return env;
}

const SELECTION_SCRIPT = `
<style>
bespoke-marp-osc, #bespoke-progress, .bespoke-progress { display:none !important; }
.fgs-hover { outline: 1px dashed rgba(229,90,62,0.45) !important; outline-offset:2px; }
.fgs-selected { outline: 2px solid #e55a3e !important; outline-offset:3px; background:rgba(229,90,62,0.06) !important; cursor:move !important; }
.fgs-dragging { outline: 2px dashed #e55a3e !important; opacity:0.75 !important; cursor:grabbing !important; }
.fgs-editing { outline: 2px solid #e55a3e !important; outline-offset:3px; background:rgba(229,90,62,0.03) !important; cursor:text !important; min-width:1ch; }
section * { cursor:pointer !important; }
</style>
<script>
(function(){
  var drag = null;
  var editing = null; // currently contenteditable element

  function uuid(){
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
      var r = Math.random()*16|0, v = c==='x' ? r : (r&0x3|0x8);
      return v.toString(16);
    });
  }

  function ensureFgsId(el){
    var id = el.getAttribute('data-fgs-id');
    if (!id) {
      id = uuid();
      el.setAttribute('data-fgs-id', id);
    }
    return id;
  }

  function findTarget(el){
    var tags=['H1','H2','H3','H4','H5','H6','P'];
    var classes=['eyebrow','subtitle','card-label','card','num','text','stat-number','stat-label','waffle-label','name'];
    var n=el;
    while(n && n!==document.body){
      if(tags.indexOf(n.tagName)>-1) return n;
      if(n.classList && classes.some(function(c){return n.classList.contains(c);})) return n;
      n=n.parentElement;
    }
    return el;
  }

  function sectionOf(el){
    var n=el;
    while(n){ if(n.tagName==='SECTION') return n; n=n.parentElement; }
    return null;
  }

  function slideScale(el){
    var sec=sectionOf(el);
    if(!sec) return 1;
    var w=sec.getBoundingClientRect().width;
    return w>0 ? w/1280 : 1;
  }

  // Compute element's position within the slide's 1280×720 coordinate space.
  // Uses the element's bounding box relative to the section, divided by the
  // viewport scale (the section's display width / 1280).
  function slideCoords(el){
    var sec = sectionOf(el);
    if (!sec) return { x:0, y:0 };
    var secRect = sec.getBoundingClientRect();
    var elRect = el.getBoundingClientRect();
    var sc = secRect.width > 0 ? secRect.width/1280 : 1;
    return {
      x: Math.round((elRect.left - secRect.left) / sc),
      y: Math.round((elRect.top - secRect.top) / sc)
    };
  }

  // Parse "translate(Xpx, Ypx)" (or "translate(Xpx)" / "translate3d(...)") from
  // an element's current inline transform. Returns {x, y} in CSS pixels. We
  // accumulate drag offsets on top of this so multiple drags compose
  // correctly without resetting the element's existing offset.
  function currentTranslate(el){
    var t = (el.style && el.style.transform) || '';
    if (!t) return { x:0, y:0 };
    // translate(Xpx, Ypx) — Y is optional, defaults to 0.
    // NB: this whole function is inside a template literal, so every \\ here
    // resolves to a literal \\ in the emitted script, which then resolves to
    // a single \\ inside the regex literal. Single \\ would be dropped.
    var m = t.match(/translate(?:3d)?\\(\\s*(-?[0-9.]+)px\\s*(?:,\\s*(-?[0-9.]+)px)?/);
    if (!m) return { x:0, y:0 };
    return { x: parseFloat(m[1]) || 0, y: parseFloat(m[2] || '0') || 0 };
  }

  function endEditing(commit){
    if (!editing) return;
    var el = editing;
    var originalText = el.dataset.fgsOriginalText || '';
    el.removeAttribute('contenteditable');
    el.classList.remove('fgs-editing');
    var newText = el.innerText;
    delete el.dataset.fgsOriginalText;
    editing = null;
    if (!commit) {
      // Revert visually — but real source is unchanged, so any in-DOM mutation
      // disappears on next iframe reload regardless.
      el.innerText = originalText;
      return;
    }
    if (newText === originalText) return;
    var fgsId = ensureFgsId(el);
    window.parent.postMessage({
      type:'text-edited',
      slideIndex: parseInt(sectionOf(el).dataset.slideIndex, 10),
      fgsId: fgsId,
      newText: newText,
      originalText: originalText,
      elementText: originalText,
      elementHtml: el.outerHTML,
      tagName: el.tagName.toLowerCase()
    }, '*');
  }

  document.addEventListener('DOMContentLoaded',function(){
    document.querySelectorAll('section').forEach(function(sec,si){
      sec.dataset.slideIndex=si;

      /* ── hover ── */
      sec.addEventListener('mouseover',function(e){
        if(drag || editing) return;
        var t=findTarget(e.target);
        document.querySelectorAll('.fgs-hover').forEach(function(x){x.classList.remove('fgs-hover');});
        if(!t.classList.contains('fgs-selected')) t.classList.add('fgs-hover');
        e.stopPropagation();
      });
      sec.addEventListener('mouseout',function(){
        document.querySelectorAll('.fgs-hover').forEach(function(x){x.classList.remove('fgs-hover');});
      });

      /* ── click to select ── */
      sec.addEventListener('click',function(e){
        if (editing && editing.contains(e.target)) return; // don't re-select while editing
        if(drag && drag.moved){ drag=null; return; }
        var t=findTarget(e.target);
        document.querySelectorAll('.fgs-selected').forEach(function(x){x.classList.remove('fgs-selected');});
        t.classList.add('fgs-selected');
        var fgsId = t.getAttribute('data-fgs-id') || null;
        window.parent.postMessage({
          type:'element-selected',
          slideIndex:si,
          fgsId: fgsId,
          elementText:t.innerText.trim(),
          elementHtml:t.outerHTML,
          tagName:t.tagName.toLowerCase(),
          className:t.className||''
        },'*');
        e.stopPropagation();
      });

      /* ── double-click → inline edit ── */
      sec.addEventListener('dblclick', function(e){
        var t = findTarget(e.target);
        if (editing && editing !== t) endEditing(true);
        editing = t;
        t.dataset.fgsOriginalText = t.innerText;
        t.setAttribute('contenteditable', 'true');
        t.classList.remove('fgs-selected','fgs-hover');
        t.classList.add('fgs-editing');
        t.focus();
        // Select all text on enter
        try {
          var range = document.createRange();
          range.selectNodeContents(t);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch(_){}
        e.preventDefault();
        e.stopPropagation();
      });

      /* ── drag to reposition (only when NOT editing) ──
       *
       * Free positioning uses CSS transform translate, NOT position:absolute.
       * The element keeps its slot in the slide's flex/grid flow, so other
       * elements DO NOT reflow when one is moved. Previously we used
       * position:absolute, which removed the dragged element from flow and
       * caused every following element to collapse upward — visually
       * identical to "other content got deleted".
       *
       * Each drag accumulates on top of whatever transform was already in
       * source: pointerdown reads the element's existing translate, then
       * pointermove computes a NEW absolute translate value that equals
       * existing + current drag delta. The script sends only the final
       * tx, ty in slide-coord pixels; the server writes a transform:
       * translate(...) directly with those values.
       */
      sec.addEventListener('pointerdown',function(e){
        if (editing) return;
        var t=findTarget(e.target);
        if(!t.classList.contains('fgs-selected')) return;
        var startTranslate = currentTranslate(t);
        drag={
          el: t, si: si,
          x0: e.clientX, y0: e.clientY,
          moved: false,
          // Existing transform in CSS pixels (viewport units, NOT slide units).
          baseTxPx: startTranslate.x,
          baseTyPx: startTranslate.y,
        };
        try { t.setPointerCapture(e.pointerId); } catch(_){}
        e.preventDefault();
        e.stopPropagation();
      });

      sec.addEventListener('pointermove',function(e){
        if(!drag) return;
        var dx=e.clientX-drag.x0, dy=e.clientY-drag.y0;
        if(!drag.moved && Math.sqrt(dx*dx+dy*dy)<4) return;
        drag.moved=true;
        // Cumulative translate in CSS pixels.
        drag.curTxPx = drag.baseTxPx + dx;
        drag.curTyPx = drag.baseTyPx + dy;
        drag.el.classList.add('fgs-dragging');
        drag.el.style.transform='translate('+drag.curTxPx+'px,'+drag.curTyPx+'px)';
        e.stopPropagation();
      });

      sec.addEventListener('pointerup',function(e){
        if(!drag) return;
        drag.el.classList.remove('fgs-dragging');
        // Keep the visual transform until iframe reload so there's no flicker.
        if(drag.moved){
          var sc = slideScale(drag.el);
          // Convert CSS-pixel translate to slide-coord pixels (1280px-wide canvas).
          var txSlide = Math.round(drag.curTxPx / sc);
          var tySlide = Math.round(drag.curTyPx / sc);
          var fgsId = drag.el.getAttribute('data-fgs-id') || null;
          window.parent.postMessage({
            type:'drag-position',
            slideIndex: drag.si,
            fgsId: fgsId,
            elementText: drag.el.innerText.trim(),
            elementHtml: drag.el.outerHTML,
            tagName: drag.el.tagName.toLowerCase(),
            className: drag.el.className || '',
            // Final cumulative translate in slide coords. Server writes this
            // directly as transform: translate(...) on the element's style.
            tx: txSlide,
            ty: tySlide,
          },'*');
        }
        drag=null;
        e.stopPropagation();
      });
    });

    /* ── keyboard ── */
    document.addEventListener('keydown', function(e){
      // While editing: Enter commits (unless Shift+Enter for newline), Esc cancels
      if (editing) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          editing.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          endEditing(false);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          editing.blur();
        }
        return;
      }
      // Not editing: Delete/Backspace removes the currently-selected element
      if ((e.key === 'Delete' || e.key === 'Backspace')) {
        var sel = document.querySelector('.fgs-selected');
        if (!sel) return;
        e.preventDefault();
        var fgsId = sel.getAttribute('data-fgs-id') || null;
        var section = sectionOf(sel);
        window.parent.postMessage({
          type:'element-delete',
          slideIndex: section ? parseInt(section.dataset.slideIndex, 10) : 0,
          fgsId: fgsId,
          elementText: sel.innerText.trim(),
          elementHtml: sel.outerHTML,
          tagName: sel.tagName.toLowerCase(),
          className: sel.className || ''
        }, '*');
      }
    });

    /* ── blur on editing element commits ── */
    document.addEventListener('blur', function(e){
      if (editing && e.target === editing) endEditing(true);
    }, true);

    /* ── swipe-to-change-slide forwarding (mobile) ──
       The iframe captures touches over the slide, so the parent viewer never
       sees them. Detect a clear horizontal flick and forward it as an
       fgs-swipe message (parent maps dir<0 -> next, dir>0 -> prev). Skipped
       while dragging or inline-editing. */
    var _sw = null;
    document.addEventListener('touchstart', function(e){
      if (drag || editing || e.touches.length !== 1) { _sw = null; return; }
      _sw = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    document.addEventListener('touchend', function(e){
      if (!_sw) return;
      var t = e.changedTouches[0]; if (!t) { _sw = null; return; }
      var dx = t.clientX - _sw.x, dy = t.clientY - _sw.y; _sw = null;
      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      window.parent.postMessage({ type: 'fgs-swipe', dir: dx }, '*');
    }, { passive: true });
  });
})();
</script>
`;

function buildSingleSlideDoc(frontmatter, slideContent) {
  const fm = frontmatter
    .replace(/^---\n/, '')
    .replace(/\n---$/, '')
    .replace(/paginate:\s*\S+/, 'paginate: false');
  return `---\n${fm}\n---\n\n${slideContent}\n`;
}

function renderSlide(frontmatter, slideContent) {
  const tmpMd = path.join(os.tmpdir(), `fgs_slide_${Date.now()}.md`);
  const tmpHtml = tmpMd.replace(/\.md$/, '.html');
  try {
    const doc = buildSingleSlideDoc(frontmatter, slideContent);
    fs.writeFileSync(tmpMd, doc, 'utf8');
    execSync(`marp "${tmpMd}" ${themeFlags()} --html --output "${tmpHtml}"`, {
      timeout: 15000,
      windowsHide: true
    });
    let html = fs.readFileSync(tmpHtml, 'utf8');
    html = html.replace(/<div class="bespoke-marp-osc"[^>]*>[\s\S]*?<\/div>/g, '');
    html = html.replace('</body>', SELECTION_SCRIPT + '\n</body>');
    return html;
  } finally {
    try { fs.unlinkSync(tmpMd); } catch {}
    try { fs.unlinkSync(tmpHtml); } catch {}
  }
}

function exportDeck(deckId, format) {
  const STUDIO_DIR = STUDIO_ROOT_DIR;
  const ext = (format === 'pptx' || format === 'pptx-editable') ? 'pptx' : 'pdf';
  const outPath = path.join(STUDIO_DIR, 'dist', deckId.replace(/\//g, '_') + '.' + ext);
  const deckPath = path.join(STUDIO_DIR, 'decks', deckId + '.md');
  // Defaults:
  //   pptx           → rasterized slides (pixel-perfect Furgoson layout, NOT editable)
  //   pptx-editable  → LibreOffice path with editable text (degraded layout on
  //                    complex CSS-grid/flex slides; suitable for text-heavy decks)
  //   pdf            → vector PDF (preserves layout AND text)
  let flag;
  if (format === 'pptx-editable') flag = '--pptx --pptx-editable';
  else if (format === 'pptx')     flag = '--pptx';
  else                            flag = '--pdf';
  execSync(`marp "${deckPath}" ${themeFlags()} --html --allow-local-files ${flag} --output "${outPath}"`, {
    // Editable variant runs LibreOffice → ~60s/deck. Rasterized is much faster.
    timeout: format === 'pptx-editable' ? 180000 : 60000,
    windowsHide: true,
    env: execEnv()
  });
  return outPath;
}

// Resolve a Marp output flag and file extension for a single-slide export.
// Supported: pdf, pptx (rasterized, exact-fidelity), pptx-editable (editable
// text, fidelity sacrificed), png, jpg, html.
//
// Default `pptx` is RASTER because Marp's --pptx-editable path runs HTML
// through LibreOffice, which can't reproduce the Furgoson theme's CSS grid /
// flex layouts and produces visually scrambled output. Pick `pptx-editable`
// explicitly only when text-editability matters more than visual accuracy.
function resolveFormat(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'pdf')            return { flag: '--pdf',                 ext: 'pdf'  };
  if (f === 'pptx')           return { flag: '--pptx',                ext: 'pptx' };
  if (f === 'pptx-editable')  return { flag: '--pptx --pptx-editable', ext: 'pptx' };
  if (f === 'png')            return { flag: '--png',                 ext: 'png'  };
  if (f === 'jpg' || f === 'jpeg') return { flag: '--jpeg',           ext: 'jpg'  };
  if (f === 'html')           return { flag: '--html',                ext: 'html' };
  throw new Error(`Unsupported format: ${format}. Use pdf, pptx, pptx-editable, png, jpg, or html.`);
}

// Export a single slide of `deckId` (by `slideIndex`) to `format`. Returns the
// absolute path of the rendered file under furgoson-studio/dist/.
function exportSlide(deckId, slideIndex, format) {
  const { readDeck } = require('./deck');
  const STUDIO_DIR = STUDIO_ROOT_DIR;
  // DIST_DIR is already a module-level import; alias for clarity here.
  const DIST = DIST_DIR;
  const { flag, ext } = resolveFormat(format);

  const { frontmatter, slides } = readDeck(deckId);
  const idx = Number(slideIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= slides.length) {
    throw new Error(`Slide index ${slideIndex} out of range (deck has ${slides.length} slides)`);
  }

  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const safeId = deckId.replace(/\//g, '_');
  const outPath = path.join(DIST, `${safeId}_slide${String(idx + 1).padStart(2, '0')}.${ext}`);

  // Write the single-slide doc to a temp .md in the studio root so relative
  // asset paths (assets/foo.png) resolve correctly.
  const tmpMd = path.join(STUDIO_DIR, `.fgs_export_${Date.now()}_${process.pid}.md`);
  try {
    const doc = buildSingleSlideDoc(frontmatter, slides[idx]);
    fs.writeFileSync(tmpMd, doc, 'utf8');
    execSync(
      `marp "${tmpMd}" ${themeFlags()} --html --allow-local-files ${flag} --output "${outPath}"`,
      { timeout: 180000, windowsHide: true, cwd: STUDIO_DIR, env: execEnv() }
    );
    return outPath;
  } finally {
    try { fs.unlinkSync(tmpMd); } catch {}
  }
}

module.exports = { renderSlide, exportDeck, exportSlide };
