const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const THEME_PATH = path.resolve(__dirname, '../../furgoson-studio/theme/furgoson.css');

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
section * { cursor:pointer !important; }
</style>
<script>
(function(){
  var drag = null;

  function findTarget(el){
    var tags=['H1','H2','H3','H4'];
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

  document.addEventListener('DOMContentLoaded',function(){
    document.querySelectorAll('section').forEach(function(sec,si){
      sec.dataset.slideIndex=si;

      /* ── hover ── */
      sec.addEventListener('mouseover',function(e){
        if(drag) return;
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
        if(drag && drag.moved){ drag=null; return; }
        var t=findTarget(e.target);
        document.querySelectorAll('.fgs-selected').forEach(function(x){x.classList.remove('fgs-selected');});
        t.classList.add('fgs-selected');
        window.parent.postMessage({
          type:'element-selected',
          slideIndex:si,
          elementText:t.innerText.trim(),
          elementHtml:t.outerHTML,
          tagName:t.tagName.toLowerCase(),
          className:t.className||''
        },'*');
        e.stopPropagation();
      });

      /* ── drag to reposition ── */
      sec.addEventListener('pointerdown',function(e){
        var t=findTarget(e.target);
        if(!t.classList.contains('fgs-selected')) return;
        drag={el:t,si:si,x0:e.clientX,y0:e.clientY,moved:false,tx:0,ty:0};
        t.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
      });

      sec.addEventListener('pointermove',function(e){
        if(!drag) return;
        var dx=e.clientX-drag.x0, dy=e.clientY-drag.y0;
        if(!drag.moved && Math.sqrt(dx*dx+dy*dy)<4) return;
        drag.moved=true; drag.tx=dx; drag.ty=dy;
        drag.el.classList.add('fgs-dragging');
        drag.el.style.transform='translate('+dx+'px,'+dy+'px)';
        e.stopPropagation();
      });

      sec.addEventListener('pointerup',function(e){
        if(!drag) return;
        drag.el.classList.remove('fgs-dragging');
        drag.el.style.transform='';
        if(drag.moved){
          var sc=slideScale(drag.el);
          window.parent.postMessage({
            type:'drag-position',
            slideIndex:drag.si,
            elementText:drag.el.innerText.trim(),
            elementHtml:drag.el.outerHTML,
            tagName:drag.el.tagName.toLowerCase(),
            className:drag.el.className||'',
            dx:Math.round(drag.tx/sc),
            dy:Math.round(drag.ty/sc)
          },'*');
        }
        drag=null;
        e.stopPropagation();
      });
    });
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
    execSync(`marp "${tmpMd}" --theme "${THEME_PATH}" --html --output "${tmpHtml}"`, {
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
  const STUDIO_DIR = path.resolve(__dirname, '../../furgoson-studio');
  const ext = format === 'pptx' ? 'pptx' : 'pdf';
  const outPath = path.join(STUDIO_DIR, 'dist', deckId.replace(/\//g, '_') + '.' + ext);
  const deckPath = path.join(STUDIO_DIR, 'decks', deckId + '.md');
  // PPTX uses --pptx-editable so shapes/text are real PowerPoint objects, not a
  // single rasterized image per slide. PDF uses --pdf as-is. Note: do NOT cache
  // PPTX based on file presence — stale outputs were a long-standing bug.
  const flag = format === 'pptx' ? '--pptx --pptx-editable' : '--pdf';
  execSync(`marp "${deckPath}" --theme "${THEME_PATH}" --html --allow-local-files ${flag} --output "${outPath}"`, {
    timeout: 180000, // editable PPTX uses LibreOffice and can take ~60s per deck
    windowsHide: true,
    env: execEnv()
  });
  return outPath;
}

// Resolve a Marp output flag and file extension for a single-slide export.
// Supported: pdf, pptx, png, jpg, html.
//
// PPTX defaults to editable mode (real shapes, real text). The caller can pass
// `pptx-image` to opt back into Marp's rasterized PPTX if needed for fidelity.
function resolveFormat(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'pdf')  return { flag: '--pdf',   ext: 'pdf'  };
  if (f === 'pptx') return { flag: '--pptx --pptx-editable', ext: 'pptx' };
  if (f === 'pptx-image') return { flag: '--pptx', ext: 'pptx' };
  if (f === 'png')  return { flag: '--png',   ext: 'png'  };
  if (f === 'jpg' || f === 'jpeg') return { flag: '--jpeg', ext: 'jpg' };
  if (f === 'html') return { flag: '--html',  ext: 'html' };
  throw new Error(`Unsupported format: ${format}. Use pdf, pptx, pptx-image, png, jpg, or html.`);
}

// Export a single slide of `deckId` (by `slideIndex`) to `format`. Returns the
// absolute path of the rendered file under furgoson-studio/dist/.
function exportSlide(deckId, slideIndex, format) {
  const { readDeck } = require('./deck');
  const STUDIO_DIR = path.resolve(__dirname, '../../furgoson-studio');
  const DIST_DIR = path.join(STUDIO_DIR, 'dist');
  const { flag, ext } = resolveFormat(format);

  const { frontmatter, slides } = readDeck(deckId);
  const idx = Number(slideIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= slides.length) {
    throw new Error(`Slide index ${slideIndex} out of range (deck has ${slides.length} slides)`);
  }

  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
  const safeId = deckId.replace(/\//g, '_');
  const outPath = path.join(DIST_DIR, `${safeId}_slide${String(idx + 1).padStart(2, '0')}.${ext}`);

  // Write the single-slide doc to a temp .md in the studio root so relative
  // asset paths (assets/foo.png) resolve correctly.
  const tmpMd = path.join(STUDIO_DIR, `.fgs_export_${Date.now()}_${process.pid}.md`);
  try {
    const doc = buildSingleSlideDoc(frontmatter, slides[idx]);
    fs.writeFileSync(tmpMd, doc, 'utf8');
    execSync(
      `marp "${tmpMd}" --theme "${THEME_PATH}" --html --allow-local-files ${flag} --output "${outPath}"`,
      { timeout: 180000, windowsHide: true, cwd: STUDIO_DIR, env: execEnv() }
    );
    return outPath;
  } finally {
    try { fs.unlinkSync(tmpMd); } catch {}
  }
}

module.exports = { renderSlide, exportDeck, exportSlide };
