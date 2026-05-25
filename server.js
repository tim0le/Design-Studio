require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/decks', require('./routes/decks'));
app.use('/api/render', require('./routes/render'));
app.use('/api/edit', require('./routes/edit'));
app.use('/api/export', require('./routes/export'));
app.use('/api/move', require('./routes/move'));
app.use('/api/agent', require('./routes/agent'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n◆ FURGOSON STUDIO running at http://localhost:${PORT}\n`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('  ⚠  ANTHROPIC_API_KEY not set — AI edits will be disabled.');
    console.warn('     Copy .env.template to .env and add your key.\n');
  }
});
