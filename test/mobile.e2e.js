/* Mobile UX e2e (puppeteer). Serves public/ statically and asserts the
 * responsive layer at iPhone + desktop viewports. Run: node test/mobile.e2e.js */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const PUB = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown',
};

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = path.join(PUB, p);
      if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, () => resolve({ srv, port: srv.address().port }));
  });
}

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('ok - ' + msg);
  else { failures++; console.log('NOT OK - ' + msg); }
}

(async () => {
  const { srv, port } = await serve();
  const base = `http://127.0.0.1:${port}/`;
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  try {
    // ── iPhone 390x844 ──
    const m = await browser.newPage();
    await m.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await m.goto(base, { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 300));

    // (a) no horizontal overflow
    const noOverflow = await m.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert(noOverflow, 'iPhone: no horizontal overflow');

    // (b) bottom tab bar visible
    const tabbarVisible = await m.evaluate(() => {
      const t = document.getElementById('mobile-tabbar');
      return t && getComputedStyle(t).display !== 'none' && t.getBoundingClientRect().width > 0;
    });
    assert(tabbarVisible, 'iPhone: bottom tab bar visible');

    // (c) tab targets >=44px height
    const tabHeights = await m.evaluate(() =>
      Array.from(document.querySelectorAll('.mobile-tab'))
        .map(b => b.getBoundingClientRect().height));
    assert(tabHeights.length === 3 && tabHeights.every(h => h >= 44),
      'iPhone: tab targets >=44px (' + tabHeights.map(h => Math.round(h)).join(',') + ')');

    // (d) input font-size >=16px (focus-zoom proof). Check the agent textarea.
    const inputFs = await m.evaluate(() => {
      const el = document.getElementById('agent-input');
      return parseFloat(getComputedStyle(el).fontSize);
    });
    assert(inputFs >= 16, 'iPhone: composer font-size >=16px (' + inputFs + ')');

    // (e) slide stage spans ~full width
    const stageRatio = await m.evaluate(() => {
      const s = document.querySelector('.slide-stage');
      return s.getBoundingClientRect().width / window.innerWidth;
    });
    assert(stageRatio >= 0.95, 'iPhone: slide stage ~full width (' + stageRatio.toFixed(3) + ')');

    // tab switching: default Slide, then tap each and assert visible panel
    async function tapTab(panel) {
      await m.evaluate(p => {
        document.querySelector('.mobile-tab[data-panel="' + p + '"]').click();
      }, panel);
      await new Promise(r => setTimeout(r, 150));
      return m.evaluate(p => {
        const sel = { 'deck-list': '.deck-list', 'viewer': '.viewer', 'edit-panel': '.edit-panel' }[p];
        const el = document.querySelector(sel);
        return getComputedStyle(el).display !== 'none' && el.offsetParent !== null;
      }, panel);
    }
    const defaultPanel = await m.evaluate(() =>
      document.querySelector('.panels').getAttribute('data-mobile-panel'));
    assert(defaultPanel === 'viewer', 'iPhone: defaults to Slide tab');

    assert(await tapTab('deck-list'), 'iPhone: Decks tab shows deck-list');
    await m.screenshot({ path: '/tmp/int2-mobile-decks.png' });
    assert(await tapTab('edit-panel'), 'iPhone: Edit tab shows edit-panel');
    await m.screenshot({ path: '/tmp/int2-mobile-edit.png' });
    assert(await tapTab('viewer'), 'iPhone: Slide tab shows viewer');
    await m.screenshot({ path: '/tmp/int2-mobile-slide.png' });

    await m.close();

    // ── Desktop 1440x900 ──
    const d = await browser.newPage();
    await d.setViewport({ width: 1440, height: 900 });
    await d.goto(base, { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 300));

    const grid = await d.evaluate(() => {
      const panels = document.querySelector('.panels');
      const cs = getComputedStyle(panels);
      const cols = cs.gridTemplateColumns.split(' ').length;
      const dl = document.querySelector('.deck-list').getBoundingClientRect();
      const vw = document.querySelector('.viewer').getBoundingClientRect();
      const ep = document.querySelector('.edit-panel').getBoundingClientRect();
      const tabbar = getComputedStyle(document.getElementById('mobile-tabbar')).display;
      return {
        display: cs.display, cols,
        sideBySide: dl.right <= vw.left + 1 && vw.right <= ep.left + 1,
        allVisible: dl.width > 0 && vw.width > 0 && ep.width > 0,
        tabbarHidden: tabbar === 'none',
      };
    });
    assert(grid.display === 'grid' && grid.cols === 3, 'Desktop: 3-column grid intact');
    assert(grid.sideBySide && grid.allVisible, 'Desktop: deck-list / viewer / edit-panel side by side');
    assert(grid.tabbarHidden, 'Desktop: tab bar hidden');
    await d.screenshot({ path: '/tmp/int2-desktop.png' });

    await d.close();
  } catch (e) {
    failures++; console.log('NOT OK - exception: ' + (e && e.stack || e));
  } finally {
    await browser.close();
    srv.close();
  }

  console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL PASSED'));
  process.exit(failures ? 1 : 0);
})();
