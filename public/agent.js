/* ── Agent chat panel: streams Claude Code sessions to a transcript ── */
const Agent = (() => {
  // ── DOM ──
  const transcriptEl = document.getElementById('agent-transcript');
  const emptyEl      = document.getElementById('agent-empty');
  const input        = document.getElementById('agent-input');
  const btnSend      = document.getElementById('agent-btn-send');
  const btnCancel    = document.getElementById('agent-btn-cancel');
  const btnVoice     = document.getElementById('agent-btn-voice');

  const editPanel    = document.getElementById('edit-mode-panel');
  const agentPanel   = document.getElementById('agent-mode-panel');
  const panelTitle   = document.querySelector('.edit-panel-title');

  // ── State ──
  let selectedElement = null;     // mirrored from fgs:element-selected
  let currentSessionId = null;    // server-issued sessionId for cancel
  let inflight = false;           // streaming a session right now
  let abortCtrl = null;           // for fetch abort
  let lastAssistantBubble = null; // for concatenating sequential assistant_text
  const toolCards = new Map();    // toolUseId -> { card, body }
  let recognition = null;
  let isRecording = false;

  // ── Mode toggle: hide/show edit vs agent panel ──
  function setMode(mode) {
    document.querySelectorAll('.mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    if (mode === 'agent') {
      editPanel.style.display = 'none';
      agentPanel.style.display = 'flex';
      if (panelTitle) panelTitle.textContent = 'Agent';
      // Refresh send button state on switch
      checkSendable();
    } else {
      editPanel.style.display = 'flex';
      agentPanel.style.display = 'none';
      if (panelTitle) panelTitle.textContent = 'Edit';
    }
  }

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // ── Selection mirror ──
  window.addEventListener('fgs:element-selected', e => {
    selectedElement = e.detail;
    checkSendable();
  });

  // ── Send guard ──
  function checkSendable() {
    btnSend.disabled = inflight || !selectedElement || !input.value.trim();
  }

  input.addEventListener('input', checkSendable);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
  });
  btnSend.addEventListener('click', send);
  btnCancel.addEventListener('click', cancel);

  // ── Voice (mirror chat.js behavior) ──
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

  // ── SSE frame parser: "event: foo\ndata: {...}" → {type, payload} ──
  function parseSSE(frame) {
    const lines = frame.split('\n');
    let type = 'message';
    let dataStr = '';
    for (const line of lines) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        dataStr += (dataStr ? '\n' : '') + line.slice(5).trimStart();
      }
    }
    let payload = null;
    if (dataStr) {
      try { payload = JSON.parse(dataStr); }
      catch { payload = { raw: dataStr }; }
    }
    return { type, payload };
  }

  // ── Send: POST + stream ──
  async function send() {
    if (inflight) return;
    if (!selectedElement || !input.value.trim()) return;
    if (!Viewer || !Viewer.current.deckId) return;

    const instruction = input.value.trim();
    const { deckId, slideIndex } = Viewer.current;

    // UI: lock composer, reset stream state
    inflight = true;
    btnSend.disabled = true;
    btnSend.classList.add('loading');
    btnSend.textContent = 'SENDING…';
    btnCancel.style.display = 'inline-flex';
    lastAssistantBubble = null;
    toolCards.clear();
    if (emptyEl) emptyEl.style.display = 'none';

    // User message bubble
    appendUser(instruction);
    input.value = '';

    abortCtrl = new AbortController();

    try {
      const res = await fetch('/api/agent/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deckId,
          slideIndex,
          elementText: selectedElement.elementText,
          elementHtml: selectedElement.elementHtml || '',
          instruction
        }),
        signal: abortCtrl.signal
      });

      if (!res.ok || !res.body) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
        appendError(msg);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nlnl;
        while ((nlnl = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, nlnl);
          buf = buf.slice(nlnl + 2);
          if (!frame.trim()) continue;
          const ev = parseSSE(frame);
          handleEvent(ev);
        }
      }
      // Flush any trailing frame
      if (buf.trim()) {
        const ev = parseSSE(buf);
        handleEvent(ev);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        appendStatus('session cancelled', 'cancel');
      } else {
        appendError(err.message || String(err));
      }
    } finally {
      inflight = false;
      currentSessionId = null;
      abortCtrl = null;
      btnSend.classList.remove('loading');
      btnSend.textContent = 'SEND →';
      btnCancel.style.display = 'none';
      checkSendable();
    }
  }

  async function cancel() {
    if (!inflight) return;
    const sid = currentSessionId;
    btnCancel.disabled = true;
    btnCancel.textContent = '⏹ Cancelling…';
    try {
      if (sid) {
        // Fire-and-forget — server-side cancel
        fetch('/api/agent/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid })
        }).catch(() => {});
      }
      if (abortCtrl) abortCtrl.abort();
    } finally {
      btnCancel.disabled = false;
      btnCancel.textContent = '⏹ Cancel';
    }
  }

  // ── Event dispatch ──
  function handleEvent({ type, payload }) {
    const data = payload || {};
    switch (type) {
      case 'start':
        currentSessionId = data.sessionId || null;
        appendStatus(`session started${data.sessionId ? ' · ' + shortId(data.sessionId) : ''}`, 'start');
        break;
      case 'assistant_text':
        appendAssistant(data.text || '');
        break;
      case 'tool_use':
        appendToolUse(data.id, data.name, data.input);
        // Once a tool runs, a new assistant message will need a fresh bubble
        lastAssistantBubble = null;
        break;
      case 'tool_result':
        appendToolResult(data.toolUseId, data.content, !!data.isError);
        break;
      case 'usage':
        appendUsage(data);
        break;
      case 'result':
        appendStatus('✓ done', 'done');
        // Tell the viewer to reload the iframe
        window.dispatchEvent(new CustomEvent('fgs:agent-complete', { detail: data }));
        break;
      case 'error':
        appendError(data.message || 'Unknown error');
        break;
      default:
        // Ignore unknown event types
        break;
    }
    scrollToEnd();
  }

  // ── DOM builders ──
  function appendUser(text) {
    const el = document.createElement('div');
    el.className = 'msg msg-user';
    el.appendChild(textNode(text));
    transcriptEl.appendChild(el);
    lastAssistantBubble = null;
    forceScrollToEnd();
  }

  function appendAssistant(text) {
    if (!text) return;
    if (lastAssistantBubble) {
      lastAssistantBubble.appendChild(textNode(text));
      return;
    }
    const el = document.createElement('div');
    el.className = 'msg msg-claude';
    el.appendChild(textNode(text));
    transcriptEl.appendChild(el);
    lastAssistantBubble = el;
  }

  function appendToolUse(id, name, inputObj) {
    const card = document.createElement('div');
    card.className = 'tool-card';

    const head = document.createElement('div');
    head.className = 'tool-head';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tool-name';
    nameSpan.textContent = name || 'tool';
    head.appendChild(nameSpan);

    const summarySpan = document.createElement('span');
    summarySpan.className = 'tool-summary';
    summarySpan.textContent = summarizeToolInput(name, inputObj);
    head.appendChild(summarySpan);

    const toggle = document.createElement('button');
    toggle.className = 'tool-toggle';
    toggle.type = 'button';
    toggle.textContent = '▸';
    toggle.title = 'Show tool input';
    head.appendChild(toggle);

    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'tool-body';
    body.style.display = 'none';

    const pre = document.createElement('pre');
    pre.className = 'tool-input';
    pre.textContent = safeJsonStringify(inputObj);
    body.appendChild(pre);

    card.appendChild(body);

    toggle.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      toggle.textContent = open ? '▸' : '▾';
    });

    transcriptEl.appendChild(card);
    if (id) toolCards.set(id, { card, body });
  }

  function appendToolResult(toolUseId, content, isError) {
    const entry = toolUseId && toolCards.get(toolUseId);
    const target = entry ? entry.card : transcriptEl;

    const result = document.createElement('div');
    result.className = 'tool-result' + (isError ? ' tool-result-error' : '');

    const label = document.createElement('span');
    label.className = 'tool-result-label';
    label.textContent = isError ? '✗ error' : '↳ result';
    result.appendChild(label);

    const pre = document.createElement('pre');
    pre.className = 'tool-result-content';
    pre.textContent = stringifyContent(content);
    result.appendChild(pre);

    if (entry) entry.card.appendChild(result);
    else transcriptEl.appendChild(result);
  }

  function appendUsage(u) {
    const el = document.createElement('div');
    el.className = 'msg msg-usage';
    const parts = [];
    if (u.inputTokens != null) parts.push(`${u.inputTokens} in`);
    if (u.outputTokens != null) parts.push(`${u.outputTokens} out`);
    if (u.cacheReadTokens != null) parts.push(`${u.cacheReadTokens} cached`);
    el.textContent = parts.join(' / ');
    transcriptEl.appendChild(el);
  }

  function appendStatus(text, kind) {
    const el = document.createElement('div');
    el.className = 'agent-pill agent-pill-' + (kind || 'info');
    el.textContent = text;
    transcriptEl.appendChild(el);
    lastAssistantBubble = null;
  }

  function appendError(message) {
    const el = document.createElement('div');
    el.className = 'agent-error';
    el.textContent = '⚠ ' + message;
    transcriptEl.appendChild(el);
    lastAssistantBubble = null;
    scrollToEnd();
  }

  // ── Helpers ──
  function textNode(s) {
    return document.createTextNode(s);
  }

  // Scroll-anchoring: only auto-stick to the bottom when the user is already
  // near it. If they've scrolled up to read earlier output, streaming updates
  // won't yank them back down.
  const STICK_THRESHOLD = 48; // px from bottom that still counts as "at bottom"
  function nearBottom() {
    const slack = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
    return slack <= STICK_THRESHOLD;
  }
  function scrollToEnd() {
    if (nearBottom()) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  // Force scroll regardless of position — used when the user sends a message
  // (they expect to see their own input and the incoming response).
  function forceScrollToEnd() {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function shortId(s) {
    return String(s).slice(0, 8);
  }

  function safeJsonStringify(v) {
    try { return JSON.stringify(v, null, 2); }
    catch { return String(v); }
  }

  function stringifyContent(c) {
    if (c == null) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map(item => {
        if (item && typeof item === 'object' && typeof item.text === 'string') return item.text;
        return safeJsonStringify(item);
      }).join('\n');
    }
    if (typeof c === 'object') return safeJsonStringify(c);
    return String(c);
  }

  // Produce a one-line summary like "Read decks/de/ihk_4pager.md" from tool name + input.
  function summarizeToolInput(name, input) {
    if (!input || typeof input !== 'object') return '';
    const truncate = (s, n) => {
      const str = String(s);
      return str.length > n ? str.slice(0, n) + '…' : str;
    };
    switch (String(name)) {
      case 'Read':       return truncate(input.file_path || '', 80);
      case 'Write':      return truncate(input.file_path || '', 80);
      case 'Edit': {
        const path = input.file_path || '';
        const repl = input.old_string ? `replace "${truncate(input.old_string, 30)}"` : 'replace';
        return truncate(`${path} (${repl})`, 80);
      }
      case 'Bash':       return truncate(input.command || input.description || '', 80);
      case 'Glob':       return truncate(input.pattern || '', 80);
      case 'Grep':       return truncate(input.pattern || '', 80);
      default: {
        // Try common path-ish keys, otherwise show first scalar value.
        for (const k of ['path', 'file', 'file_path', 'url', 'query', 'pattern', 'command']) {
          if (typeof input[k] === 'string') return truncate(input[k], 80);
        }
        for (const k of Object.keys(input)) {
          const v = input[k];
          if (typeof v === 'string' || typeof v === 'number') return truncate(`${k}=${v}`, 80);
        }
        return '';
      }
    }
  }

  // ── Public reset (called by app.js when deck changes) ──
  function reset() {
    // Cancel in-flight session if any
    if (inflight && abortCtrl) {
      try { abortCtrl.abort(); } catch (_) {}
    }
    inflight = false;
    currentSessionId = null;
    abortCtrl = null;
    lastAssistantBubble = null;
    toolCards.clear();
    input.value = '';
    btnSend.classList.remove('loading');
    btnSend.textContent = 'SEND →';
    btnCancel.style.display = 'none';
    // Clear transcript, restore empty state
    transcriptEl.innerHTML = '';
    if (emptyEl) {
      emptyEl.style.display = '';
      transcriptEl.appendChild(emptyEl);
    }
    checkSendable();
  }

  initVoice();
  checkSendable();

  // ── Keyboard-aware composer (mobile) ──
  // iOS Safari shrinks window.visualViewport when the soft keyboard opens but
  // does NOT reflow fixed/bottom UI, so the composer can hide behind the
  // keyboard. We expose the keyboard height as the CSS var --fgs-kb on <html>;
  // the mobile @media block lifts the composer (and hides the tab bar) by that
  // amount. Gated to a coarse pointer + the mobile breakpoint so desktop and
  // trackpad browsers are untouched. Shared by both composers in the edit panel.
  (function initKeyboardAwareComposer() {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const isMobile = () => window.matchMedia('(max-width: 899px)').matches;

    function update() {
      // Keyboard height ≈ how much the visual viewport is shorter than the
      // layout viewport from the bottom. Clamp to >=0 and ignore tiny values
      // (toolbar jitter) so we don't shift on every scroll.
      const kb = isMobile()
        ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
        : 0;
      root.style.setProperty('--fgs-kb', (kb > 80 ? kb : 0) + 'px');
      // When the keyboard opens while the agent transcript is in view, keep the
      // latest output visible above it.
      if (kb > 80 && nearBottom()) forceScrollToEnd();
    }

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    // Reset when focus leaves any composer (keyboard dismissed).
    document.addEventListener('focusout', () => setTimeout(update, 50));
    update();
  })();

  return { reset, setMode };
})();
