// Single source of truth for "where do the decks + theme + assets live".
//
// Resolution priority:
//   1. $FURGOSON_DECK_REPO  — explicit env override (use for non-standard layouts
//      and CI testing)
//   2. ../furgoson-studio    — production layout next to the studio-app repo
//   3. ./examples/starter-studio — built-in starter so a fresh clone of just
//      this app boots with something to render
//
// Helpers also surface the conventional paths (`decks/`, `theme/`, `assets/`,
// `dist/`) so call sites don't have to assemble them.

const fs = require('fs');
const path = require('path');

function resolveStudioRoot() {
  const env = process.env.FURGOSON_DECK_REPO;
  if (env && fs.existsSync(path.resolve(env, 'decks'))) return path.resolve(env);
  const sibling = path.resolve(__dirname, '../../furgoson-studio');
  if (fs.existsSync(path.join(sibling, 'decks'))) return sibling;
  return path.resolve(__dirname, '../examples/starter-studio');
}

const ROOT = resolveStudioRoot();
const DECKS_DIR = path.join(ROOT, 'decks');
const THEME_DIR = path.join(ROOT, 'theme');
const ASSETS_DIR = path.join(ROOT, 'assets');
const DIST_DIR = path.join(ROOT, 'dist');

// List every `<name>.css` in the theme dir so Marp can register all of them.
// Returns absolute paths. Empty array if the dir doesn't exist.
function listThemeFiles() {
  if (!fs.existsSync(THEME_DIR)) return [];
  return fs.readdirSync(THEME_DIR)
    .filter(f => f.endsWith('.css'))
    .map(f => path.join(THEME_DIR, f));
}

module.exports = {
  ROOT,
  DECKS_DIR,
  THEME_DIR,
  ASSETS_DIR,
  DIST_DIR,
  listThemeFiles,
};
