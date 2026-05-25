/* ── Chat + Voice panel ── */
const Chat = (() => {
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

  async function sendEdit() {
    if (!selectedElement || !input.value.trim()) return;

    const instruction = input.value.trim();
    const { deckId, slideIndex } = Viewer.current;
    const mode = currentMode;

    btnSend.classList.add('loading');
    btnSend.disabled = true;
    btnSend.textContent = mode === 'generate' ? 'GENERATING…' : 'APPLYING…';

    try {
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

      addHistory({
        instruction,
        result: data.replacement,
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
