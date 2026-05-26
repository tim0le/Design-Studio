const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { editSlideWithAgent } = require('../lib/agent');

// In-memory registry of active agent sessions so /cancel can find them.
const activeSessions = new Map();

function writeSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === 'function') {
    res.flush();
  }
}

router.post('/edit', async (req, res) => {
  const { deckId, slideIndex, elementText, elementHtml, instruction, resumeSessionId } = req.body || {};

  if (!deckId || !instruction) {
    return res.status(400).json({ error: 'deckId and instruction are required' });
  }

  let parsedSlideIndex;
  if (slideIndex !== undefined && slideIndex !== null) {
    if (typeof slideIndex !== 'number' && typeof slideIndex !== 'string') {
      return res.status(400).json({ error: 'slideIndex must be a number or numeric string' });
    }
    parsedSlideIndex = Number(slideIndex);
    if (!Number.isInteger(parsedSlideIndex) || parsedSlideIndex < 0) {
      return res.status(400).json({ error: 'slideIndex must be a non-negative integer' });
    }
  }

  // Optional per-request routing overrides. Either header may be absent; when
  // missing or empty we fall back to whatever the SDK / underlying client
  // already picks up from env. We trim because users pasting URLs from a
  // browser frequently include a trailing space or CR.
  const rawBackendUrl = req.headers['x-backend-url'];
  const baseURL = typeof rawBackendUrl === 'string' ? rawBackendUrl.trim() : '';
  if (baseURL) {
    try {
      const parsed = new URL(baseURL);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.host) throw new Error();
    } catch {
      return res.status(400).json({ error: 'X-Backend-URL must be a valid http(s) URL with a host' });
    }
  }

  const rawBackendModel = req.headers['x-backend-model'];
  const model = typeof rawBackendModel === 'string' ? rawBackendModel.trim() : '';
  if (baseURL && !model) {
    return res.status(400).json({ error: 'X-Backend-Model is required when X-Backend-URL is set' });
  }

  // Resolve the API key. Critical: when the user explicitly routes to a local
  // server (baseURL set), do NOT fall back to process.env.ANTHROPIC_API_KEY —
  // forwarding a real Anthropic key to an unknown proxy host would leak it.
  // Only header-supplied keys travel to local backends.
  const headerKey = req.headers['x-api-key'];
  const apiKey = baseURL
    ? (typeof headerKey === 'string' && headerKey.trim() ? headerKey.trim() : '')
    : (headerKey || process.env.ANTHROPIC_API_KEY);

  // When routing to a local server, the proxy itself usually does not require
  // an Anthropic-format key — so a missing apiKey is only fatal if we are
  // talking to Anthropic Cloud. Pass a placeholder downstream when local so
  // the SDK's "no key" guard doesn't trip.
  if (!apiKey && !baseURL) {
    return res.status(503).json({ error: 'No API key — click ⚙ API Key in the toolbar to add yours.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sessionId = crypto.randomUUID();
  const abortController = new AbortController();
  activeSessions.set(sessionId, { controller: abortController, res });

  let clientClosed = false;
  const onClose = () => {
    if (clientClosed) return;
    clientClosed = true;
    abortController.abort();
    activeSessions.delete(sessionId);
  };
  // res.on('close') fires when the underlying connection drops; req.on('close')
  // can fire earlier when the request body finishes parsing, so we listen on res.
  res.on('close', onClose);

  try {
    const iterator = editSlideWithAgent({
      // Some local proxies reject blank Authorization headers — pass a
      // placeholder so the @anthropic-ai/sdk constructs a request with *some*
      // bearer. LiteLLM ignores it; real Anthropic Cloud would reject it,
      // but we only hit this branch when baseURL is also set.
      apiKey: apiKey || (baseURL ? 'local-no-key' : undefined),
      deckId,
      slideIndex: parsedSlideIndex,
      elementText,
      elementHtml,
      instruction,
      resumeSessionId,
      baseURL: baseURL || undefined,
      model: model || undefined,
      signal: abortController.signal,
    });

    for await (const event of iterator) {
      if (clientClosed) break;
      if (!event || typeof event !== 'object' || !event.type) continue;
      const { type, ...payload } = event;
      // Inject our sessionId into the start event so the client can use it to cancel.
      if (type === 'start') {
        payload.sessionId = sessionId;
      }
      writeSseEvent(res, type, payload);
      if (type === 'result') {
        break;
      }
    }
  } catch (err) {
    if (!clientClosed) {
      try {
        writeSseEvent(res, 'error', { message: err && err.message ? err.message : String(err) });
      } catch (_) {
        // Stream may already be torn down; ignore.
      }
    }
  } finally {
    activeSessions.delete(sessionId);
    res.off('close', onClose);
    if (!clientClosed) {
      try {
        res.end();
      } catch (_) {
        // Ignore double-end.
      }
    }
  }
});

router.post('/cancel', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  const entry = activeSessions.get(sessionId);
  if (!entry) {
    return res.status(404).json({ error: 'No active session' });
  }
  entry.controller.abort();
  // Force-close the SSE stream so a downstream that ignores the abort signal
  // can't keep writing events after the client believes the session ended.
  try {
    writeSseEvent(entry.res, 'error', { message: 'Cancelled by user' });
    entry.res.end();
  } catch (_) {
    // Stream may already be torn down; safe to ignore.
  }
  activeSessions.delete(sessionId);
  return res.json({ cancelled: true });
});

module.exports = router;
