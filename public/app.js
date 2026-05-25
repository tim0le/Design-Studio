/* ── API Key management (global) ── */
const ApiKey = (() => {
  const KEY = 'fgs_api_key';
  let _key = localStorage.getItem(KEY) || '';

  function get() { return _key; }
  function set(k) { _key = k.trim(); if (_key) localStorage.setItem(KEY, _key); else localStorage.removeItem(KEY); }
  function headers() { return _key ? { 'X-API-Key': _key } : {}; }
  function isSet() { return !!_key; }
  return { get, set, headers, isSet };
})();

// Monkey-patch fetch to auto-inject API key header
const _origFetch = window.fetch.bind(window);
window.fetch = (url, opts = {}) => {
  if (typeof url === 'string' && url.startsWith('/api/') && ApiKey.isSet()) {
    opts.headers = Object.assign({}, opts.headers || {}, ApiKey.headers());
  }
  return _origFetch(url, opts);
};

/* ── App: orchestrator ── */
(async () => {
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
      const res = await fetch('/api/decks');
      decks = await res.json();
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
    btnExportPptx.disabled = false;
    const btnSlideExport = document.getElementById('btn-slide-export');
    if (btnSlideExport) btnSlideExport.disabled = false;
    Chat.reset();
    if (typeof Agent !== 'undefined' && Agent.reset) Agent.reset();
    await Viewer.loadDeck(id);
  }

  // ── Export ──
  async function exportDeck(format) {
    if (!currentDeckId) return;
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
      a.download = currentDeckId.replace(/\//g, '_') + '.' + format;
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
  btnExportPptx.addEventListener('click', () => exportDeck('pptx'));

  // ── Single-slide export ──
  async function exportCurrentSlide(format) {
    if (!currentDeckId) return;
    const { slideIndex } = Viewer.current;
    if (slideIndex === undefined || slideIndex === null) {
      showToast('No slide selected', true);
      return;
    }
    showToast(`Exporting slide ${slideIndex + 1} as ${format.toUpperCase()}…`);
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
      a.download = `${safeId}_slide${pad}.${format === 'jpeg' ? 'jpg' : format}`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`✓ Slide ${slideIndex + 1} ${format.toUpperCase()} downloaded`);
    } catch (e) {
      showToast(e.message, true);
    }
  }

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

  // ── Settings / API Key ──
  function updateSettingsBtn() {
    btnSettings.classList.toggle('has-key', ApiKey.isSet());
    btnSettings.title = ApiKey.isSet() ? '⚙ API Key set — click to change' : '⚙ Set API key to enable AI edits';
  }
  updateSettingsBtn();

  btnSettings.addEventListener('click', () => {
    apiKeyInput.value = ApiKey.get();
    apiKeyStatus.textContent = ApiKey.isSet() ? '✓ Key saved' : '';
    apiKeyStatus.className = 'api-key-status' + (ApiKey.isSet() ? ' ok' : '');
    settingsDialog.style.display = 'flex';
    setTimeout(() => apiKeyInput.focus(), 50);
  });

  settingsCancel.addEventListener('click', () => { settingsDialog.style.display = 'none'; });

  settingsSave.addEventListener('click', () => {
    const k = apiKeyInput.value.trim();
    if (k && !k.startsWith('sk-ant-')) {
      apiKeyStatus.textContent = 'Key should start with sk-ant-';
      apiKeyStatus.className = 'api-key-status err';
      return;
    }
    ApiKey.set(k);
    apiKeyStatus.textContent = k ? '✓ Key saved' : 'Key removed';
    apiKeyStatus.className = 'api-key-status ok';
    updateSettingsBtn();
    setTimeout(() => { settingsDialog.style.display = 'none'; }, 600);
  });

  apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') settingsSave.click(); });
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

  uploadConfirm.addEventListener('click', async () => {
    if (!pendingUpload) return;
    uploadConfirm.disabled = true;
    uploadConfirm.textContent = 'Uploading…';
    try {
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
