const fs = require('fs');
const path = require('path');

const DECKS_DIR = path.resolve(__dirname, '../../furgoson-studio/decks');

function listDecks() {
  const decks = [];
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), prefix + entry.name + '/');
      } else if (entry.name.endsWith('.md')) {
        const id = prefix + entry.name.replace(/\.md$/, '');
        const markdown = fs.readFileSync(path.join(dir, entry.name), 'utf8');
        const parsed = parseDeck(markdown);
        if (!/^---\n[\s\S]*?\bmarp:\s*true\b[\s\S]*?\n---/.test(parsed.frontmatter + '\n')) continue;
        const lang = id.startsWith('de/') ? 'de' : id.startsWith('en/') ? 'en' : 'en';
        const name = formatName(entry.name.replace(/\.md$/, ''), lang);
        decks.push({ id, name, lang, slideCount: parsed.slides.length, path: path.join(dir, entry.name) });
      }
    }
  }
  walk(DECKS_DIR);
  return decks;
}

function getDeckPath(id) {
  return path.join(DECKS_DIR, id + '.md');
}

function readDeck(id) {
  const filePath = getDeckPath(id);
  if (!fs.existsSync(filePath)) throw new Error(`Deck not found: ${id}`);
  const markdown = fs.readFileSync(filePath, 'utf8');
  return { markdown, ...parseDeck(markdown) };
}

function writeDeck(id, markdown) {
  const filePath = getDeckPath(id);
  fs.writeFileSync(filePath, markdown, 'utf8');
}

function createDeck(id, markdown) {
  const filePath = getDeckPath(id);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, markdown, 'utf8');
}

function parseDeck(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const fmMatch = normalized.match(/^---\n[\s\S]*?\n---\n/);
  const frontmatter = fmMatch ? fmMatch[0] : '';
  const body = normalized.slice(frontmatter.length);
  const slideTexts = body.split(/\n---\n/);
  return {
    frontmatter: frontmatter.trim(),
    slides: slideTexts.map(s => s.trim()).filter(Boolean)
  };
}

function assembleDeck(frontmatter, slides) {
  return frontmatter + '\n\n' + slides.join('\n\n---\n\n') + '\n';
}

function updateSlide(id, slideIndex, newSlideMarkdown) {
  const { frontmatter, slides } = readDeck(id);
  if (slideIndex < 0 || slideIndex >= slides.length) throw new Error('Slide index out of range');
  slides[slideIndex] = newSlideMarkdown;
  const updated = assembleDeck(frontmatter, slides);
  writeDeck(id, updated);
  return updated;
}

function formatName(id, lang) {
  const map = {
    'ihk_4pager': lang === 'de' ? 'IHK 4-Pager (DE)' : 'IHK 4-Pager',
    'capabilities': lang === 'en' ? 'Capabilities (EN)' : 'Capabilities',
  };
  return map[id] || id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = { listDecks, readDeck, writeDeck, createDeck, parseDeck, assembleDeck, updateSlide, getDeckPath };
