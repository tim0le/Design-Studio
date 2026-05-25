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

  // Receive messages from iframe (selection + drag)
  window.addEventListener('message', e => {
    if (!e.data || !e.data.type) return;
    if (e.data.type === 'element-selected') {
      window.dispatchEvent(new CustomEvent('fgs:element-selected', { detail: e.data }));
    }
    if (e.data.type === 'drag-position') {
      handleDragPosition(e.data);
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

  async function handleDragPosition(data) {
    if (!currentDeckId) return;
    // Fire-and-forget: save position to markdown, no re-render (iframe already shows the drag result)
    fetch('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deckId: currentDeckId,
        slideIndex: currentSlideIndex,
        elementText: data.elementText,
        elementHtml: data.elementHtml,
        tagName: data.tagName,
        dx: data.dx,
        dy: data.dy
      })
    }).then(r => r.json()).then(result => {
      if (result.success) showToast('✓ Position saved');
      else showToast(result.error || 'Move failed', true);
    }).catch(err => showToast(err.message, true));
  }

  return {
    loadDeck, refreshCurrent, goTo,
    get current() { return { deckId: currentDeckId, slideIndex: currentSlideIndex }; }
  };
})();
