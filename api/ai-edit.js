// api/ai-edit.js — Vercel-style Node serverless function for the quick-edit AI
// path of the Furgoson Studio mobile PWA.
//
// Vercel compatibility:
//   - Runtime: Node.js (the default Node serverless runtime). Streams SSE over
//     the Node response object; the Edge runtime is NOT used.
//   - maxDuration: set to ~60s in vercel.json (owned by unit B8). The default
//     Hobby cap is 10s, so configure `maxDuration` (or fluid compute) there.
//   - This is a plain `(req, res)` handler, so it can ALSO be mounted on Express
//     directly: `app.post('/api/ai-edit', require('./api/ai-edit'))`. Express
//     parses `req.body` via body-parser; on Vercel `req.body` is parsed too. A
//     defensive raw-body fallback is included for runtimes that don't pre-parse.
//
// What it does:
//   - POST JSON { mode: 'edit'|'generate', slideMarkdown, elementText,
//     instruction, slideIndex }.
//   - Resolves the API key from `x-api-key` header OR process.env.ANTHROPIC_API_KEY.
//   - Streams the Anthropic response as Server-Sent Events; `?stream=0` returns
//     plain JSON { replacement } instead.
//   - Returns ONLY the replacement text. Does NOT touch the filesystem and does
//     NOT apply the edit — the client owns locating/applying.
//
// Security: the resolved key is never logged.

const { editElementStream, generateVisualStream } = require('../lib/claude');

const NO_KEY_MESSAGE = 'No API key — click ⚙ API Key in the toolbar to add yours.';

// Read and JSON-parse the request body. On Vercel/Express `req.body` is usually
// already populated; fall back to reading the raw stream for bare Node runtimes.
async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      return req.body ? JSON.parse(req.body) : {};
    }
    return req.body;
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

// Detect SSE opt-out: `?stream=0`.
function streamingDisabled(req) {
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('stream') === '0';
  } catch (_) {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (_) {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const { mode = 'edit', slideMarkdown, elementText, instruction } = payload || {};
  const slideIndex = parseInt(payload && payload.slideIndex, 10) || 0;

  // Validate required fields.
  if (!slideMarkdown || !elementText || !instruction) {
    return sendJson(res, 400, { error: 'slideMarkdown, elementText, instruction are required' });
  }

  // Resolve key: client-supplied header first, then host env. Never logged.
  const apiKey = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return sendJson(res, 503, { error: NO_KEY_MESSAGE });
  }

  const runStream = mode === 'generate' ? generateVisualStream : editElementStream;
  const args = { apiKey, slideMarkdown, elementText, instruction, slideIndex };

  // Non-streaming fallback: ?stream=0 → plain JSON { replacement }.
  if (streamingDisabled(req)) {
    try {
      const replacement = await runStream(args);
      return sendJson(res, 200, { replacement });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Streaming path: Server-Sent Events.
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const replacement = await runStream({
      ...args,
      onDelta: (text) => sse({ type: 'delta', text })
    });
    sse({ type: 'done', replacement });
  } catch (e) {
    sse({ type: 'error', error: e.message });
  } finally {
    res.end();
  }
};
