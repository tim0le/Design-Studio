/* ── Chat + Voice panel ── */
const Chat = (() => {
  // Serverless/PWA build flag. In client mode the quick-edit goes to the
  // /api/ai-edit serverless function (returns replacement text only) and the
  // edit is located + applied + persisted client-side via FGS_Locator +
  // DeckStore. On selfhost the legacy /api/edit route does it all server-side.
  const CLIENT = !!window.FGS_CLIENT_RENDER;

  const btnVoice = document.getElementById('btn-voice');
  const btnSend = document.getElementById('btn-send');
  const input = document.getElementById('instruction-input');
  const historyList = document.getElementById('history-list');
  const instructionLabel = document.getElementById('instruction-label');

  let selectedElement = null;
  let recognition = null;
  let isRecording = false;
  let currentMode = 'edit'; // 'edit' | 'generate'
  const history = [];

  // ── Mode toggle ──
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
      updateModeUI();
    });
  });

  function updateModeUI() {
    if (currentMode === 'generate') {
      instructionLabel.textContent = 'Generate visual';
      input.placeholder = 'e.g. Create a bar chart showing adoption growth · Generate an architecture diagram · Replace with a stat block';
      btnSend.textContent = 'GENERATE →';
      btnSend.classList.add('mode-generate');
    } else {
      instructionLabel.textContent = 'Instruction';
      input.placeholder = 'e.g. Make this more concise · Translate to German · Change the tone';
      btnSend.textContent = 'APPLY →';
      btnSend.classList.remove('mode-generate');
    }
  }

  // ── Voice ──
  function initVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { btnVoice.title = 'Voice not supported in this browser'; btnVoice.disabled = true; return; }
    recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = document.documentElement.lang === 'de' ? 'de-DE' : 'en-US';

    recognition.onresult = e => {
      const transcript = e.results[0][0].transcript;
      input.value = (input.value ? input.value + ' ' : '') + transcript;
      checkSendable();
    };
    recognition.onend = () => setRecording(false);
    recognition.onerror = () => setRecording(false);
  }

  function setRecording(on) {
    isRecording = on;
    btnVoice.classList.toggle('recording', on);
    btnVoice.title = on ? 'Stop recording' : 'Voice input';
  }

  btnVoice.addEventListener('click', () => {
    if (!recognition) return;
    if (isRecording) { recognition.stop(); setRecording(false); }
    else { recognition.start(); setRecording(true); }
  });

  // ── Send ──
  function checkSendable() {
    btnSend.disabled = !selectedElement || !input.value.trim();
  }

  input.addEventListener('input', checkSendable);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendEdit();
  });

  btnSend.addEventListener('click', sendEdit);

  // Stream the /api/ai-edit SSE response and resolve with the final replacement
  // text. Frames are {type:'delta',text} ... {type:'done',replacement} or
  // {type:'error',error}. Forwards the stored x-api-key via the fetch monkey-
  // patch in app.js (BackendConfig.headers() injects it on /api/ calls).
  async function streamAiEdit({ mode, slideMarkdown, elementText, instruction, slideIndex }) {
    const res = await fetch('/api/ai-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, slideMarkdown, elementText, instruction, slideIndex })
    });
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let replacement = null;
    const handleFrame = frame => {
      if (!frame.trim()) return;
      // ai-edit emits plain "data: {...}" frames (no event: line).
      const line = frame.split('\n').find(l => l.startsWith('data:'));
      if (!line) return;
      let payload;
      try { payload = JSON.parse(line.slice(5).trim()); } catch (_) { return; }
      if (payload.type === 'done') replacement = payload.replacement;
      else if (payload.type === 'error') throw new Error(payload.error || 'AI edit failed');
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nlnl;
      while ((nlnl = buf.indexOf('\n\n')) >= 0) {
        handleFrame(buf.slice(0, nlnl));
        buf = buf.slice(nlnl + 2);
      }
    }
    if (buf.trim()) handleFrame(buf);
    if (replacement === null) throw new Error('AI edit returned no replacement');
    return replacement;
  }

  // Client-mode quick edit: get replacement from /api/ai-edit, locate + apply it
  // into the slide markdown (ported routes/edit.js strategy), persist, re-render.
  async function sendEditClient({ deckId, slideIndex, instruction, mode }) {
    const { slides } = await DeckStore.readDeck(deckId);
    const slideMarkdown = slides[slideIndex] || '';
    const selection = {
      elementHtml: selectedElement.elementHtml || '',
      elementText: selectedElement.elementText
    };
    const replacement = await streamAiEdit({
      mode, slideMarkdown, elementText: selection.elementText, instruction, slideIndex
    });

    let updated;
    if (mode === 'generate') {
      updated = FGS_Locator.applyGenerate(slideMarkdown, selection, replacement);
    } else {
      updated = FGS_Locator.applyEdit(slideMarkdown, selection, replacement);
      if (updated === null) {
        // Same 422-style message the server surfaced on no-match.
        throw new Error(FGS_Locator.NOT_FOUND_MESSAGE);
      }
    }
    await DeckStore.updateSlide(deckId, slideIndex, updated);
    Viewer.invalidate();
    return replacement;
  }

  async function sendEdit() {
    if (!selectedElement || !input.value.trim()) return;

    const instruction = input.value.trim();
    const { deckId, slideIndex } = Viewer.current;
    const mode = currentMode;

    btnSend.classList.add('loading');
    btnSend.disabled = true;
    btnSend.textContent = mode === 'generate' ? 'GENERATING…' : 'APPLYING…';

    try {
      let replacement;
      if (CLIENT) {
        replacement = await sendEditClient({ deckId, slideIndex, instruction, mode });
      } else {
        const res = await fetch('/api/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deckId,
            slideIndex,
            elementText: selectedElement.elementText,
            elementHtml: selectedElement.elementHtml || '',
            instruction,
            mode
          })
        });

        const data = await res.json();

        if (!res.ok) {
          showToast(data.error || 'Edit failed', true);
          return;
        }
        replacement = data.replacement;
      }

      addHistory({
        instruction,
        result: replacement,
        from: selectedElement.elementText,
        slideIndex,
        mode
      });

      input.value = '';
      selectedElement = null;
      resetSelection();
      checkSendable();

      await Viewer.refreshCurrent();
      showToast(mode === 'generate' ? '✓ Visual generated' : '✓ Applied');

    } catch (e) {
      showToast(e.message, true);
    } finally {
      btnSend.classList.remove('loading');
      updateModeUI(); // reset button text
      checkSendable();
    }
  }

  // ── History ──
  function addHistory({ instruction, result, from, slideIndex, mode }) {
    history.unshift({ instruction, result, from, slideIndex, mode, ts: new Date() });

    const empty = historyList.querySelector('[style]');
    if (empty) empty.remove();

    const item = document.createElement('div');
    item.className = 'history-item';
    const modeLabel = mode === 'generate' ? '⬡ ' : '';
    const preview = result.length > 80 ? result.slice(0, 80).replace(/<[^>]*>/g, '') + '…' : result.replace(/<[^>]*>/g, '');
    item.innerHTML = `
      <div class="history-item-instruction">${modeLabel}"${escHtml(instruction)}"</div>
      <div class="history-item-result">→ ${escHtml(preview)}</div>
      <div class="history-item-meta">Slide ${slideIndex + 1} · ${new Date().toLocaleTimeString()}</div>
    `;
    historyList.prepend(item);
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Selection display ──
  const selectionEmpty = document.getElementById('selection-empty');
  const selectionFilled = document.getElementById('selection-filled');
  const selectionTag = document.getElementById('selection-tag');
  const selectionText = document.getElementById('selection-text');

  function resetSelection() {
    selectionEmpty.classList.remove('hidden');
    selectionFilled.classList.remove('visible');
    selectionTag.textContent = '';
    selectionText.textContent = '';
  }

  window.addEventListener('fgs:element-selected', e => {
    selectedElement = e.detail;
    const tag = e.detail.tagName || e.detail.className?.split(' ')[0] || 'element';
    selectionTag.textContent = tag.toLowerCase();
    selectionText.textContent = e.detail.elementText;
    selectionEmpty.classList.add('hidden');
    selectionFilled.classList.add('visible');
    checkSendable();
  });

  initVoice();
  return { reset: resetSelection };
})();
