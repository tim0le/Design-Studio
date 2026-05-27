/* ── Viewer: slide rendering + selection + drag ── */
const Viewer = (() => {
  let currentDeckId = null;
  let currentSlideIndex = 0;
  let totalSlides = 0;

  const iframe = document.getElementById('slide-iframe');
  const loading = document.getElementById('slide-loading');
  const navPage = document.getElementById('nav-page');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');
  const placeholder = document.getElementById('slide-placeholder');

  function showLoading(on) {
    loading.classList.toggle('visible', on);
  }

  function updateNav() {
    navPage.textContent = totalSlides ? `${currentSlideIndex + 1} / ${totalSlides}` : '—';
    btnPrev.disabled = currentSlideIndex <= 0;
    btnNext.disabled = currentSlideIndex >= totalSlides - 1;
  }

  async function loadSlide(deckId, slideIndex) {
    showLoading(true);
    const url = `/api/render/${encodeURIComponent(deckId)}/slide/${slideIndex}`;
    iframe.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
    iframe.src = url + '?t=' + Date.now();
    iframe.onload = () => showLoading(false);
    iframe.onerror = () => { showLoading(false); showToast('Failed to render slide', true); };
  }

  async function loadDeck(deckId, startIndex = 0) {
    currentDeckId = deckId;
    currentSlideIndex = startIndex;
    const res = await fetch(`/api/decks/${encodeURIComponent(deckId)}/source`);
    const data = await res.json();
    totalSlides = data.slides ? data.slides.length : 0;
    updateNav();
    await loadSlide(deckId, currentSlideIndex);
  }

  async function goTo(index) {
    if (!currentDeckId || index < 0 || index >= totalSlides) return;
    currentSlideIndex = index;
    updateNav();
    await loadSlide(currentDeckId, currentSlideIndex);
  }

  async function refreshCurrent() {
    if (!currentDeckId) return;
    await loadSlide(currentDeckId, currentSlideIndex);
  }

  btnPrev.addEventListener('click', () => goTo(currentSlideIndex - 1));
  btnNext.addEventListener('click', () => goTo(currentSlideIndex + 1));

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') goTo(currentSlideIndex - 1);
    if (e.key === 'ArrowRight') goTo(currentSlideIndex + 1);
  });

  // Receive messages from iframe (selection + drag + edit + delete)
  window.addEventListener('message', e => {
    if (!e.data || !e.data.type) return;
    if (e.data.type === 'element-selected') {
      window.dispatchEvent(new CustomEvent('fgs:element-selected', { detail: e.data }));
    }
    if (e.data.type === 'drag-position') {
      handleDragPosition(e.data);
    }
    if (e.data.type === 'text-edited') {
      handleTextEdited(e.data);
    }
    if (e.data.type === 'element-delete') {
      handleElementDelete(e.data);
    }
  });

  // Reload current slide when an agent session finishes editing the deck
  window.addEventListener('fgs:agent-complete', () => {
    refreshCurrent();
  });

  // Live reload: SSE subscription to filesystem changes under decks/. Refresh
  // the iframe whenever the *current* deck's .md is rewritten — by the agent,
  // the source drawer, or an external editor.
  let watchSource = null;
  function openWatchStream() {
    if (watchSource) return;
    try {
      watchSource = new EventSource('/api/watch/stream');
      watchSource.addEventListener('change', e => {
        try {
          const data = JSON.parse(e.data);
          if (data.deckId === currentDeckId) refreshCurrent();
        } catch (_) {}
      });
      watchSource.onerror = () => {
        if (watchSource) { watchSource.close(); watchSource = null; }
        setTimeout(openWatchStream, 3000);
      };
    } catch (_) {}
  }
  openWatchStream();

  // Direct-manipulation handlers (drag / inline edit / delete) all share the
  // same shape: POST the change to the server, on success ALWAYS reload the
  // iframe so the user sees the persisted state. We do NOT rely on the chokidar
  // file watcher's SSE — its debounce + connection lifecycle are unreliable for
  // tight interactive feedback (and were causing the "element jumps back" bug:
  // the script clears the drag transform on pointerup, but the iframe still
  // shows the pre-move render until the watcher fires, so the element snaps
  // back to its original source position visually).
  async function postAndRefresh(url, body, opts = {}) {
    if (!currentDeckId) return;
    const { successToast, errorPrefix } = opts;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.success) {
        showToast(result.error || `${errorPrefix || 'Request'} failed`, true);
        // Force-refresh so any visual state (transform/contenteditable text)
        // is wiped — keeping the failed visual implies the change persisted.
        refreshCurrent();
        return null;
      }
      if (successToast) showToast(successToast);
      // Always refresh — the only authoritative state is the source file +
      // a fresh Marp render. Doing this here is O(1) HTTP roundtrip; the
      // watcher SSE is a nice-to-have for external edits, not interactive ops.
      refreshCurrent();
      return result;
    } catch (err) {
      showToast(err.message, true);
      refreshCurrent();
      return null;
    }
  }

  async function handleDragPosition(data) {
    return postAndRefresh('/api/move', {
      deckId: currentDeckId,
      slideIndex: currentSlideIndex,
      fgsId: data.fgsId,
      elementText: data.elementText,
      elementHtml: data.elementHtml,
      tagName: data.tagName,
      // Current script sends final cumulative translate as {tx, ty}.
      tx: data.tx, ty: data.ty,
      // Back-compat with older injected scripts that may still be in cache.
      dx: data.dx, dy: data.dy,
      x: data.x, y: data.y,
    }, { errorPrefix: 'Move' });
  }

  async function handleTextEdited(data) {
    const result = await postAndRefresh('/api/text', {
      deckId: currentDeckId,
      slideIndex: currentSlideIndex,
      fgsId: data.fgsId,
      elementText: data.elementText,
      elementHtml: data.elementHtml,
      tagName: data.tagName,
      newText: data.newText,
    }, { errorPrefix: 'Edit' });
    if (result && result.deleted) showToast('✓ Element removed (empty edit)');
  }

  async function handleElementDelete(data) {
    return postAndRefresh('/api/delete', {
      deckId: currentDeckId,
      slideIndex: currentSlideIndex,
      fgsId: data.fgsId,
      elementText: data.elementText,
      elementHtml: data.elementHtml,
      tagName: data.tagName,
    }, { successToast: '✓ Element removed', errorPrefix: 'Delete' });
  }

  return {
    loadDeck, refreshCurrent, goTo,
    get current() { return { deckId: currentDeckId, slideIndex: currentSlideIndex }; }
  };
})();
