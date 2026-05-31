require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Build target: 'selfhost' (default — full Express app) or 'serverless'
// (Vercel static + /api functions). On serverless we skip the routers that
// need a long-lived writable workspace or external CLIs. Default behavior is
// unchanged: with no env var set, everything is mounted as before.
const STUDIO_TARGET = process.env.STUDIO_TARGET || 'selfhost';
const SERVERLESS = STUDIO_TARGET === 'serverless';

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/decks', require('./routes/decks'));
app.use('/api/render', require('./routes/render'));
app.use('/api/edit', require('./routes/edit'));
app.use('/api/move', require('./routes/move'));
app.use('/api/text', require('./routes/text'));
app.use('/api/delete', require('./routes/delete'));
app.use('/api/slides', require('./routes/slides'));

// Self-host-only routers: the Claude Code agent (spawns a subprocess + needs a
// writable workspace), live-reload watch (no FS to watch on serverless), and
// the CLI/LibreOffice-backed exports (Marp CLI + LibreOffice). Skipped when
// STUDIO_TARGET=serverless.
if (!SERVERLESS) {
  app.use('/api/export', require('./routes/export'));
  app.use('/api/agent', require('./routes/agent'));
  app.use('/api/watch', require('./routes/watch'));
} else {
  console.log('  ℹ  STUDIO_TARGET=serverless — agent, watch, and CLI export routes are self-host-only and were not mounted.');
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n◆ FURGOSON STUDIO running at http://localhost:${PORT}  (STUDIO_TARGET=${STUDIO_TARGET})\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('  ⚠  ANTHROPIC_API_KEY not set — AI edits will be disabled.');
    console.warn('     Copy .env.template to .env and add your key.\n');
  }
});
