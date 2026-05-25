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

  const apiKey = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
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
      apiKey,
      deckId,
      slideIndex: parsedSlideIndex,
      elementText,
      elementHtml,
      instruction,
      resumeSessionId,
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
