// SSE endpoint that streams deck file changes to the frontend.
//
// GET /api/watch/stream — text/event-stream of "change" events with payload
//   { event: "change|add|unlink", deckId: "de/ihk_4pager" }

const express = require('express');
const router = express.Router();
const { watcher } = require('../lib/watch');

router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Initial comment so the client knows the stream is live.
  res.write(': watching\n\n');

  watcher.attach();
  const onChange = (payload) => {
    res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  watcher.on('change', onChange);

  // Keep-alive ping every 25 s so proxies don't tear down the connection.
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);

  const cleanup = () => {
    clearInterval(ping);
    watcher.off('change', onChange);
    watcher.detach();
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
});

module.exports = router;
