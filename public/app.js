/* ── Backend config (global) ──
 *
 * Stores where agent requests are routed. Shape:
 *   { provider: 'anthropic' | 'local',
 *     apiKey:   string,                      // sk-ant-… for anthropic; optional auth for local
 *     baseURL:  string,                      // only used when provider==='local'
 *     model:    string }                     // only used when provider==='local'
 *
 * Persisted as a single JSON blob under localStorage['fgs_backend'].
 *
 * Legacy migration: the previous build stored only the Anthropic key under
 * localStorage['fgs_api_key']. If we find it on first load and no new blob
 * exists, we promote it into the new shape and remove the old key so we never
 * read it again.
 *
 * `ApiKey` is kept as a thin back-compat alias so other modules (chat.js,
 * agent.js) that still call ApiKey.get()/isSet() continue to work without an
 * intrusive rename.
 */
const BackendConfig = (() => {
  const KEY = 'fgs_backend';
  const LEGACY_KEY = 'fgs_api_key';
  const DEFAULT = { provider: 'anthropic', apiKey: '', baseURL: '', model: '' };

  let _state = DEFAULT;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      _state = Object.assign({}, DEFAULT, parsed);
    } else {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        _state = Object.assign({}, DEFAULT, { apiKey: legacy });
        localStorage.setItem(KEY, JSON.stringify(_state));
        localStorage.removeItem(LEGACY_KEY);
      }
    }
  } catch (_) {
    // Corrupt JSON — fall back to defaults rather than crashing the app.
    _state = DEFAULT;
  }

  function get() { return Object.assign({}, _state); }
  function provider() { return _state.provider; }
  function apiKey() { return _state.apiKey; }
  function baseURL() { return _state.baseURL; }
  function model() { return _state.model; }

  function set(next) {
    _state = Object.assign({}, DEFAULT, next || {});
    _state.provider = _state.provider === 'local' ? 'local' : 'anthropic';
    _state.apiKey = (_state.apiKey || '').trim();
    _state.baseURL = (_state.baseURL || '').trim();
    _state.model = (_state.model || '').trim();
    localStorage.setItem(KEY, JSON.stringify(_state));
  }

  // "Configured" means: provider==='anthropic' with an API key, OR
  // provider==='local' with at least a base URL. Used to toggle the toolbar
  // button's green dot — purely cosmetic.
  function isConfigured() {
    if (_state.provider === 'local') return !!_state.baseURL;
    return !!_state.apiKey;
  }

  function headers() {
    const h = {};
    if (_state.apiKey) h['X-API-Key'] = _state.apiKey;
    if (_state.provider === 'local') {
      if (_state.baseURL) h['X-Backend-URL'] = _state.baseURL;
      if (_state.model) h['X-Backend-Model'] = _state.model;
    }
    return h;
  }

  return { get, set, provider, apiKey, baseURL, model, isConfigured, headers };
})();

// Back-compat shim — older modules in this app reference `ApiKey`.
const ApiKey = {
  get: () => BackendConfig.apiKey(),
  set: (k) => BackendConfig.set(Object.assign(BackendConfig.get(), { apiKey: k })),
  headers: () => BackendConfig.headers(),
  isSet: () => BackendConfig.isConfigured(),
};

// Monkey-patch fetch to auto-inject backend routing headers on /api/ calls.
// Backend overrides (X-Backend-URL / X-Backend-Model) are only meaningful for
// /api/agent/* but they're cheap to send everywhere and the other routes
// ignore unknown headers.
const _origFetch = window.fetch.bind(window);
window.fetch = (url, opts = {}) => {
  if (typeof url === 'string' && url.startsWith('/api/')) {
    const injected = BackendConfig.headers();
    if (Object.keys(injected).length) {
      opts.headers = Object.assign({}, opts.headers || {}, injected);
    }
  }
  return _origFetch(url, opts);
};

/* ── App: orchestrator ── */
(async () => {
  // Serverless/PWA build flag. In client mode, deck list / CRUD / upload /
  // source-save / export route through the client modules (DeckStore,
  // ClientExport) instead of the Express /api routes. Selfhost is unchanged.
  const CLIENT = !!window.FGS_CLIENT_RENDER;

  const deckItemsEl = document.getElementById('deck-items');
  const topbarName = document.getElementById('topbar-deck-name');
  const btnExportPdf = document.getElementById('btn-export-pdf');
  const btnExportPptx = document.getElementById('btn-export-pptx');
  const btnSettings = document.getElementById('btn-settings');
  const settingsDialog = document.getElementById('settings-dialog');
  const apiKeyInput = document.getElementById('api-key-input');
  const apiKeyStatus = document.getElementById('api-key-status');
  const settingsCancel = document.getElementById('settings-cancel');
  const settingsSave = document.getElementById('settings-save');
  const btnUpload = document.getElementById('btn-upload');
  const fileUpload = document.getElementById('file-upload');
  const uploadDialog = document.getElementById('upload-dialog');
  const uploadDialogFile = document.getElementById('upload-dialog-file');
  const uploadLang = document.getElementById('upload-lang');
  const uploadCancel = document.getElementById('upload-cancel');
  const uploadConfirm = document.getElementById('upload-confirm');

  let currentDeckId = null;
  let decks = [];
  let pendingUpload = null; // { name, content }

  // ── Load deck list ──
  async function loadDecks() {
    try {
      // DeckStore.listDecks() returns the same {id,name,lang,kind,slideCount}
      // shape as GET /api/decks (it ports lib/deck.js listDecks()).
      decks = CLIENT ? await DeckStore.listDecks() : await (await fetch('/api/decks')).json();
      renderDeckList(decks);
    } catch (e) {
      deckItemsEl.innerHTML = `<div style="padding:14px 10px;font-size:11px;color:var(--muted);">Could not load decks.<br>${e.message}</div>`;
    }
  }

  function renderDeckList(decks) {
    deckItemsEl.innerHTML = '';
    if (!decks.length) {
      deckItemsEl.innerHTML = `<div style="padding:14px 10px;font-size:11px;color:var(--muted);">No decks found.</div>`;
      return;
    }
    decks.forEach(deck => {
      const item = document.createElement('div');
      item.className = 'deck-item';
      item.dataset.id = deck.id;
      const kindLabel = deck.kind === 'one_pager' ? 'One-pager' : `${deck.slideCount} slide${deck.slideCount !== 1 ? 's' : ''}`;
      item.innerHTML = `
        <div class="deck-item-icon">${deck.lang.toUpperCase()}</div>
        <div class="deck-item-info">
          <div class="deck-item-name">${escHtml(deck.name)}</div>
          <div class="deck-item-meta">${kindLabel}</div>
        </div>
      `;
      item.addEventListener('click', () => selectDeck(deck.id, deck.name));
      deckItemsEl.appendChild(item);
    });
    // Re-mark active
    if (currentDeckId) {
      document.querySelectorAll('.deck-item').forEach(el =>
        el.classList.toggle('active', el.dataset.id === currentDeckId));
    }
  }

  async function selectDeck(id, name) {
    currentDeckId = id;
    document.querySelectorAll('.deck-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
    topbarName.textContent = name;
    btnExportPdf.disabled = false;
    // PPTX is self-host only; in client mode the button is hidden at init, so
    // don't re-enable it here.
    if (!CLIENT) btnExportPptx.disabled = false;
    const btnSlideExport = document.getElementById('btn-slide-export');
    if (btnSlideExport) btnSlideExport.disabled = false;
    const btnSlideSrc = document.getElementById('btn-slide-source');
    if (btnSlideSrc) btnSlideSrc.disabled = false;
    document.querySelectorAll('.slide-crud .nav-btn-icon').forEach(b => { b.disabled = false; });
    Chat.reset();
    if (typeof Agent !== 'undefined' && Agent.reset) Agent.reset();
    await Viewer.loadDeck(id);
  }

  // ── Client export helpers ──
  // Render every slide of a deck into a detached, off-screen same-origin iframe
  // (srcdoc) so ClientExport can rasterize them. The iframes are sized to the
  // native 1280x720 canvas and removed after the export resolves.
  async function renderDeckToOffscreenIframes(deckId) {
    const { frontmatter, slides } = await DeckStore.readDeck(deckId);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:720px;overflow:hidden;';
    document.body.appendChild(host);
    const frames = [];
    for (let i = 0; i < slides.length; i++) {
      const doc = await MarpRender.renderToIframeSrcdoc(frontmatter, slides[i]);
      const f = document.createElement('iframe');
      f.style.cssText = 'width:1280px;height:720px;border:0;';
      f.sandbox = 'allow-same-origin';
      host.appendChild(f);
      await new Promise(resolve => { f.onload = resolve; f.srcdoc = doc; });
      frames.push(f);
    }
    return { host, frames };
  }

  // Client-side deck export. PDF only (PPTX is self-host); the PPTX button is
  // hidden in client mode so format is always 'pdf' here.
  async function exportDeckClient(format) {
    if (format !== 'pdf') { showToast('PPTX export is self-host only', true); return; }
    btnExportPdf.disabled = true;
    btnExportPdf.textContent = '…';
    let rendered = null;
    try {
      rendered = await renderDeckToOffscreenIframes(currentDeckId);
      await ClientExport.exportPDF(rendered.frames, currentDeckId.replace(/\//g, '_') + '.pdf');
      showToast('✓ PDF downloaded');
    } catch (e) {
      showToast(e.message, true);
    } finally {
      if (rendered && rendered.host) rendered.host.remove();
      btnExportPdf.disabled = false;
      btnExportPdf.textContent = '↓ PDF';
    }
  }

  // ── Export ──
  async function exportDeck(format) {
    if (!currentDeckId) return;
    if (CLIENT) return exportDeckClient(format);
    const btn = format === 'pdf' ? btnExportPdf : btnExportPptx;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deckId: currentDeckId, format })
      });
      if (!res.ok) {
        const d = await res.json();
        showToast(d.error || 'Export failed', true);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Both pptx and pptx-editable produce .pptx files.
      const fileExt = format === 'pptx-editable' ? 'pptx' : format;
      a.download = currentDeckId.replace(/\//g, '_') + '.' + fileExt;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`✓ ${format.toUpperCase()} downloaded`);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = format === 'pdf' ? '↓ PDF' : '↓ PPTX';
    }
  }

  btnExportPdf.addEventListener('click', () => exportDeck('pdf'));

  // Deck-level PPTX dropdown — choose between rasterized (default, exact) and
  // editable (LibreOffice, may scramble complex layouts).
  const deckExportPopup = document.getElementById('deck-export-popup');
  btnExportPptx.addEventListener('click', e => {
    if (!deckExportPopup) { exportDeck('pptx'); return; }
    e.stopPropagation();
    const open = deckExportPopup.style.display !== 'none';
    deckExportPopup.style.display = open ? 'none' : 'flex';
  });
  if (deckExportPopup) {
    deckExportPopup.querySelectorAll('[data-deck-format]').forEach(b => {
      b.addEventListener('click', () => {
        deckExportPopup.style.display = 'none';
        exportDeck(b.dataset.deckFormat);
      });
    });
    document.addEventListener('click', e => {
      if (!deckExportPopup.contains(e.target) && e.target !== btnExportPptx) {
        deckExportPopup.style.display = 'none';
      }
    });
  }

  // Client-side single-slide export off the live slide iframe (same-origin
  // srcdoc). PNG/JPG/PDF via ClientExport; HTML downloads the rendered doc;
  // PPTX variants are self-host only.
  async function exportCurrentSlideClient(format, slideIndex) {
    const iframe = document.getElementById('slide-iframe');
    const safeId = currentDeckId.replace(/\//g, '_');
    const pad = String(slideIndex + 1).padStart(2, '0');
    const base = `${safeId}_slide${pad}`;
    try {
      if (format === 'pptx' || format === 'pptx-editable') {
        showToast('PPTX export is self-host only', true);
        return;
      }
      if (format === 'html') {
        const doc = iframe.contentDocument && iframe.contentDocument.documentElement
          ? '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML
          : iframe.srcdoc;
        const blob = new Blob([doc], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = base + '.html'; a.click();
        URL.revokeObjectURL(url);
      } else if (format === 'png') {
        await ClientExport.exportPNG(iframe, base + '.png');
      } else if (format === 'jpg' || format === 'jpeg') {
        await ClientExport.exportJPG(iframe, base + '.jpg');
      } else if (format === 'pdf') {
        await ClientExport.exportPDF(iframe, base + '.pdf');
      } else {
        showToast('Unsupported format: ' + format, true);
        return;
      }
      showToast(`✓ Slide ${slideIndex + 1} ${format.toUpperCase()} downloaded`);
    } catch (e) {
      showToast(e.message, true);
    }
  }

  // ── Single-slide export ──
  async function exportCurrentSlide(format) {
    if (!currentDeckId) return;
    const { slideIndex } = Viewer.current;
    if (slideIndex === undefined || slideIndex === null) {
      showToast('No slide selected', true);
      return;
    }
    if (CLIENT) return exportCurrentSlideClient(format, slideIndex);
    const slowFormat = format === 'pptx-editable';
    showToast(
      slowFormat
        ? `Exporting editable PPTX for slide ${slideIndex + 1}… (~60s via LibreOffice)`
        : `Exporting slide ${slideIndex + 1} as ${format.toUpperCase()}…`
    );
    try {
      const res = await fetch('/api/export/slide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deckId: currentDeckId, slideIndex, format })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showToast(d.error || 'Slide export failed', true);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeId = currentDeckId.replace(/\//g, '_');
      const pad = String(slideIndex + 1).padStart(2, '0');
      const ext = format === 'pptx-editable' ? 'pptx' : format === 'jpeg' ? 'jpg' : format;
      a.download = `${safeId}_slide${pad}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`✓ Slide ${slideIndex + 1} ${format.toUpperCase()} downloaded`);
    } catch (e) {
      showToast(e.message, true);
    }
  }

  // ── Raw slide-source drawer ──
  const btnSlideSource = document.getElementById('btn-slide-source');
  const sourceDialog = document.getElementById('source-dialog');
  const sourceTextarea = document.getElementById('source-textarea');
  const sourceCancel = document.getElementById('source-cancel');
  const sourceSave = document.getElementById('source-save');
  const sourceDialogTitle = document.getElementById('source-dialog-title');
  const sourceHint = document.getElementById('source-hint');

  async function openSourceDrawer() {
    if (!currentDeckId) return;
    const { slideIndex } = Viewer.current;
    if (slideIndex === undefined || slideIndex === null) {
      showToast('No slide selected', true);
      return;
    }
    sourceDialogTitle.textContent = `Slide ${slideIndex + 1} source — ${currentDeckId}`;
    sourceHint.textContent = 'Loading…';
    sourceTextarea.value = '';
    sourceDialog.style.display = 'flex';

    try {
      if (CLIENT) {
        const { slides } = await DeckStore.readDeck(currentDeckId);
        sourceTextarea.value = slides[slideIndex] || '';
      } else {
        const res = await fetch(`/api/decks/${encodeURIComponent(currentDeckId)}/slide/${slideIndex}/source`);
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Could not load slide', true); sourceDialog.style.display = 'none'; return; }
        sourceTextarea.value = data.markdown || '';
      }
      sourceHint.textContent = 'Edit the raw Marp markdown. The iframe refreshes automatically on save.';
      setTimeout(() => sourceTextarea.focus(), 50);
    } catch (e) {
      showToast(e.message, true);
      sourceDialog.style.display = 'none';
    }
  }

  async function saveSourceDrawer() {
    if (!currentDeckId) return;
    const { slideIndex } = Viewer.current;
    if (slideIndex === undefined || slideIndex === null) return;
    sourceSave.disabled = true;
    const origLabel = sourceSave.textContent;
    sourceSave.textContent = 'Saving…';
    try {
      if (CLIENT) {
        await DeckStore.updateSlide(currentDeckId, slideIndex, sourceTextarea.value);
        Viewer.invalidate();
        sourceDialog.style.display = 'none';
        showToast(`✓ Slide ${slideIndex + 1} source saved`);
        await Viewer.refreshCurrent();
      } else {
        const res = await fetch(`/api/decks/${encodeURIComponent(currentDeckId)}/slide/${slideIndex}/source`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown: sourceTextarea.value })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Save failed', true); return; }
        sourceDialog.style.display = 'none';
        showToast(`✓ Slide ${slideIndex + 1} source saved`);
        // The file watcher will refresh the iframe.
      }
    } catch (e) {
      showToast(e.message, true);
    } finally {
      sourceSave.disabled = false;
      sourceSave.textContent = origLabel;
    }
  }

  if (btnSlideSource && sourceDialog) {
    btnSlideSource.addEventListener('click', openSourceDrawer);
    sourceCancel.addEventListener('click', () => { sourceDialog.style.display = 'none'; });
    sourceSave.addEventListener('click', saveSourceDrawer);
    sourceDialog.addEventListener('click', e => {
      if (e.target === sourceDialog) sourceDialog.style.display = 'none';
    });
    // Cmd/Ctrl+S inside the drawer saves
    sourceTextarea.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveSourceDrawer();
      }
    });
  }

  // ── Slide CRUD ──
  // `doOp(slideIndex)` returns `{ ok, data, error }`. On selfhost it wraps a
  // fetch to /api/slides; in client mode it calls DeckStore. The shared tail
  // reloads the list + navigates to the server/store-reported target index.
  async function slideOp(label, doOp, opts = {}) {
    if (!currentDeckId) return;
    const { slideIndex } = Viewer.current;
    if (slideIndex === undefined || slideIndex === null) {
      showToast('No slide selected', true);
      return;
    }
    try {
      const { ok, data, error } = await doOp(slideIndex);
      if (!ok) { showToast(error || `${label} failed`, true); return; }
      if (CLIENT) Viewer.invalidate();
      // Reload the deck list to update slide counts; then navigate to the new
      // target index reported by the server/store (insertedAt / movedTo /
      // index-1 for delete) so the iframe shows the result.
      await loadDecks();
      const target = opts.targetFromResponse ? opts.targetFromResponse(data || {}, slideIndex) : slideIndex;
      await Viewer.loadDeck(currentDeckId, target);
      showToast(`✓ ${label}`);
    } catch (e) {
      showToast(e.message, true);
    }
  }

  // Wrap a fetch Response into the { ok, data, error } shape slideOp expects.
  async function asOp(res) {
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data, error: data && data.error };
  }
  // Wrap a DeckStore promise (resolves to plain data, rejects on error).
  async function storeOp(promise) {
    try { return { ok: true, data: await promise }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  const slideCrudHandlers = {
    'btn-slide-add': () => slideOp('Slide added', i => CLIENT
      ? storeOp(DeckStore.addSlide(currentDeckId, null, i + 1))
      : asOp(fetch(`/api/slides/${encodeURIComponent(currentDeckId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ insertAt: i + 1 })
      })), { targetFromResponse: d => d.insertedAt }),

    'btn-slide-duplicate': () => slideOp('Slide duplicated', i => CLIENT
      ? storeOp(DeckStore.duplicateSlide(currentDeckId, i))
      : asOp(fetch(`/api/slides/${encodeURIComponent(currentDeckId)}/${i}/duplicate`, {
        method: 'POST'
      })), { targetFromResponse: d => d.insertedAt }),

    'btn-slide-up': () => slideOp('Slide moved up', i => CLIENT
      ? storeOp(DeckStore.moveSlide(currentDeckId, i, 'up'))
      : asOp(fetch(`/api/slides/${encodeURIComponent(currentDeckId)}/${i}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'up' })
      })), { targetFromResponse: d => d.movedTo }),

    'btn-slide-down': () => slideOp('Slide moved down', i => CLIENT
      ? storeOp(DeckStore.moveSlide(currentDeckId, i, 'down'))
      : asOp(fetch(`/api/slides/${encodeURIComponent(currentDeckId)}/${i}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'down' })
      })), { targetFromResponse: d => d.movedTo }),

    'btn-slide-delete': () => {
      if (!confirm('Delete this slide? This cannot be undone.')) return;
      return slideOp('Slide deleted', i => CLIENT
        ? storeOp(DeckStore.deleteSlide(currentDeckId, i))
        : asOp(fetch(`/api/slides/${encodeURIComponent(currentDeckId)}/${i}`, {
          method: 'DELETE'
        })), { targetFromResponse: (d, i) => Math.max(0, i - 1) });
    },
  };

  Object.entries(slideCrudHandlers).forEach(([id, handler]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  });

  const btnSlideExport = document.getElementById('btn-slide-export');
  const slideExportPopup = document.getElementById('slide-export-popup');
  if (btnSlideExport && slideExportPopup) {
    btnSlideExport.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = slideExportPopup.style.display !== 'none';
      slideExportPopup.style.display = isOpen ? 'none' : 'flex';
    });
    slideExportPopup.querySelectorAll('.slide-export-option').forEach(btn => {
      btn.addEventListener('click', () => {
        slideExportPopup.style.display = 'none';
        exportCurrentSlide(btn.dataset.format);
      });
    });
    // Close on outside click
    document.addEventListener('click', e => {
      if (!slideExportPopup.contains(e.target) && e.target !== btnSlideExport) {
        slideExportPopup.style.display = 'none';
      }
    });
  }

  // ── Settings / Backend ──
  const backendAnthropicRadio = document.getElementById('backend-anthropic');
  const backendLocalRadio = document.getElementById('backend-local');
  const backendSectionAnthropic = document.getElementById('backend-section-anthropic');
  const backendSectionLocal = document.getElementById('backend-section-local');
  const backendUrlInput = document.getElementById('backend-url-input');
  const backendModelInput = document.getElementById('backend-model-input');
  const backendKeyInput = document.getElementById('backend-key-input');

  function updateSettingsBtn() {
    const configured = BackendConfig.isConfigured();
    btnSettings.classList.toggle('has-key', configured);
    const provider = BackendConfig.provider();
    if (configured) {
      btnSettings.title = provider === 'local'
        ? `⚙ Routing to local server (${BackendConfig.baseURL()}) — click to change`
        : '⚙ Anthropic key set — click to change';
    } else {
      btnSettings.title = '⚙ Configure agent backend';
    }
  }
  updateSettingsBtn();

  function syncBackendSections() {
    const isLocal = backendLocalRadio.checked;
    backendSectionLocal.style.display = isLocal ? 'flex' : 'none';
    backendSectionLocal.style.flexDirection = 'column';
    backendSectionAnthropic.style.display = isLocal ? 'none' : 'flex';
    backendSectionAnthropic.style.flexDirection = 'column';
  }

  backendAnthropicRadio.addEventListener('change', syncBackendSections);
  backendLocalRadio.addEventListener('change', syncBackendSections);

  btnSettings.addEventListener('click', () => {
    const cfg = BackendConfig.get();
    if (cfg.provider === 'local') {
      backendLocalRadio.checked = true;
      // Show the local key field's existing value here, not the (separate)
      // Anthropic field — keeps the two scoped per-provider.
      backendKeyInput.value = cfg.apiKey;
      apiKeyInput.value = '';
    } else {
      backendAnthropicRadio.checked = true;
      apiKeyInput.value = cfg.apiKey;
      backendKeyInput.value = '';
    }
    backendUrlInput.value = cfg.baseURL;
    backendModelInput.value = cfg.model;
    apiKeyStatus.textContent = BackendConfig.isConfigured() ? '✓ Saved' : '';
    apiKeyStatus.className = 'api-key-status' + (BackendConfig.isConfigured() ? ' ok' : '');
    syncBackendSections();
    settingsDialog.style.display = 'flex';
    setTimeout(() => {
      (cfg.provider === 'local' ? backendUrlInput : apiKeyInput).focus();
    }, 50);
  });

  settingsCancel.addEventListener('click', () => { settingsDialog.style.display = 'none'; });

  function setStatus(text, kind) {
    apiKeyStatus.textContent = text;
    apiKeyStatus.className = 'api-key-status' + (kind ? ' ' + kind : '');
  }

  settingsSave.addEventListener('click', () => {
    const provider = backendLocalRadio.checked ? 'local' : 'anthropic';
    if (provider === 'local') {
      const baseURL = backendUrlInput.value.trim();
      const model = backendModelInput.value.trim();
      const apiKey = backendKeyInput.value.trim();
      if (!baseURL) { setStatus('Base URL is required for local server', 'err'); return; }
      if (!/^https?:\/\//i.test(baseURL)) {
        setStatus('Base URL must start with http:// or https://', 'err');
        return;
      }
      if (!model) { setStatus('Model name is required', 'err'); return; }
      BackendConfig.set({ provider, apiKey, baseURL, model });
    } else {
      const apiKey = apiKeyInput.value.trim();
      if (apiKey && !apiKey.startsWith('sk-ant-')) {
        setStatus('Key should start with sk-ant-', 'err');
        return;
      }
      // Preserve any previously-saved local config so toggling back doesn't lose
      // the URL/model the user typed in.
      const prev = BackendConfig.get();
      BackendConfig.set({ provider, apiKey, baseURL: prev.baseURL, model: prev.model });
    }
    setStatus('✓ Saved', 'ok');
    updateSettingsBtn();
    setTimeout(() => { settingsDialog.style.display = 'none'; }, 600);
  });

  // Enter inside any input submits the form.
  [apiKeyInput, backendUrlInput, backendModelInput, backendKeyInput].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') settingsSave.click(); });
  });
  settingsDialog.addEventListener('click', e => { if (e.target === settingsDialog) settingsDialog.style.display = 'none'; });

  // ── Upload (multi-format) ──
  const uploadKind = document.getElementById('upload-kind');
  const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

  btnUpload.addEventListener('click', () => fileUpload.click());

  fileUpload.addEventListener('change', () => {
    const file = fileUpload.files[0];
    if (!file) return;
    const reader = new FileReader();
    const isImage = IMAGE_EXT.test(file.name);

    reader.onload = e => {
      if (isImage) {
        // result is a data URL like "data:image/png;base64,iVBOR…"
        const result = e.target.result;
        const b64 = String(result).replace(/^data:[^,]+,/, '');
        pendingUpload = {
          name: file.name,
          contentBase64: b64,
          mime: file.type || 'application/octet-stream'
        };
      } else {
        pendingUpload = { name: file.name, content: e.target.result };
      }
      uploadDialogFile.textContent = file.name;
      if (file.name.match(/\b(de|deutsch|german)\b/i)) uploadLang.value = 'de';
      else uploadLang.value = 'en';
      // Default kind: one-pager for single images or non-md formats
      if (uploadKind) {
        uploadKind.value = isImage || /\.(html?|txt)$/i.test(file.name) ? 'one_pager' : 'deck';
      }
      uploadDialog.style.display = 'flex';
    };

    if (isImage) reader.readAsDataURL(file);
    else reader.readAsText(file);
    fileUpload.value = ''; // reset so same file can be re-uploaded
  });

  uploadCancel.addEventListener('click', () => {
    uploadDialog.style.display = 'none';
    pendingUpload = null;
  });

  // Client-mode upload: import Markdown/text decks straight into DeckStore.
  // Other formats (images, HTML) need the server's conversion pipeline and are
  // self-host only. Builds a deck id "<lang>/<slug>" and ensures `marp: true`
  // frontmatter exists so DeckStore.listDecks() will surface it.
  async function uploadClient() {
    if (pendingUpload.contentBase64 || !/\.(md|txt)$/i.test(pendingUpload.name)) {
      showToast('Only .md/.txt import is available in this build. Image/HTML conversion is self-host only.', true);
      return;
    }
    const lang = uploadLang.value;
    const slug = pendingUpload.name
      .replace(/\.(md|txt)$/i, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'deck';
    let md = String(pendingUpload.content || '');
    // Ensure a Marp frontmatter block so deriveMeta() lists the deck.
    if (!DeckStore.hasMarpFlag(DeckStore.parseDeck(md).frontmatter)) {
      md = '---\nmarp: true\ntheme: furgoson\npaginate: false\nsize: 16:9\nhtml: true\n---\n\n' + md;
    }
    const id = `${lang}/${slug}`;
    const existing = await DeckStore.readDeck(id).catch(() => null);
    if (existing) await DeckStore.writeDeck(id, md);
    else await DeckStore.createDeck(id, md);
    uploadDialog.style.display = 'none';
    pendingUpload = null;
    await loadDecks();
    const meta = DeckStore.deriveMeta(id, md);
    const name = (meta && meta.name) || id;
    showToast(`✓ ${uploadKind && uploadKind.value === 'one_pager' ? 'One-pager' : 'Deck'} "${name}" uploaded`);
    selectDeck(id, name);
  }

  uploadConfirm.addEventListener('click', async () => {
    if (!pendingUpload) return;
    uploadConfirm.disabled = true;
    uploadConfirm.textContent = 'Uploading…';
    try {
      if (CLIENT) { await uploadClient(); return; }
      const payload = {
        name: pendingUpload.name,
        lang: uploadLang.value,
        kind: uploadKind ? uploadKind.value : 'deck'
      };
      if (pendingUpload.contentBase64) {
        payload.contentBase64 = pendingUpload.contentBase64;
        payload.mime = pendingUpload.mime;
      } else {
        payload.content = pendingUpload.content;
      }

      const res = await fetch('/api/decks/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Upload failed', true); return; }
      uploadDialog.style.display = 'none';
      pendingUpload = null;
      await loadDecks();
      showToast(`✓ ${payload.kind === 'one_pager' ? 'One-pager' : 'Deck'} "${data.deck.name}" uploaded`);
      if (data.deck) selectDeck(data.deckId, data.deck.name || data.deckId);
    } catch (e) {
      showToast(e.message, true);
    } finally {
      uploadConfirm.disabled = false;
      uploadConfirm.textContent = 'Upload';
    }
  });

  // Close dialog on backdrop click
  uploadDialog.addEventListener('click', e => {
    if (e.target === uploadDialog) { uploadDialog.style.display = 'none'; pendingUpload = null; }
  });

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Client-mode UI gating ──
  // PPTX + PPTX-editable need the Marp CLI + LibreOffice and exist only on
  // self-host. Hide the deck-level PPTX button and the PPTX options in both the
  // deck and slide export popups so they can't be triggered in client mode.
  if (CLIENT) {
    if (btnExportPptx) btnExportPptx.style.display = 'none';
    document
      .querySelectorAll('[data-deck-format^="pptx"], .slide-export-option[data-format^="pptx"]')
      .forEach(el => { el.style.display = 'none'; });
  }

  await loadDecks();
})();

// ── Toast (global) ──
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('visible');
  setTimeout(() => t.classList.remove('visible'), 3000);
}
