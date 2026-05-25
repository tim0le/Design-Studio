// Filesystem watcher for the furgoson-studio decks directory. Emits "change"
// events with the deckId of any modified .md file so the frontend can refresh
// the iframe without manual reload.
//
// Used by routes/watch.js to push SSE events to connected clients.

const chokidar = require('chokidar');
const path = require('path');
const { EventEmitter } = require('events');

const DECKS_DIR = path.resolve(__dirname, '../../furgoson-studio/decks');

class DeckWatcher extends EventEmitter {
  constructor() {
    super();
    this.watcher = null;
    this.refCount = 0;
  }

  // Lazy-start: only spin up chokidar when at least one client is listening.
  // This keeps node idle when no studio tab is open.
  attach() {
    this.refCount += 1;
    if (this.watcher) return;
    // Chokidar globbing on Windows is unreliable when path separators differ.
    // Watch the directory itself and filter to .md files in the listener.
    this.watcher = chokidar.watch(DECKS_DIR, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      ignored: (p) => {
        // Allow directories and .md files; ignore everything else.
        if (!p) return false;
        if (p === DECKS_DIR) return false;
        if (/\.md$/i.test(p)) return false;
        try {
          // If the entry is a directory (no extension), let chokidar recurse.
          const ext = path.extname(p);
          if (!ext) return false;
        } catch (_) {}
        return true;
      }
    });
    const emitFor = (event, fullPath) => {
      // Convert absolute path -> deckId like "de/ihk_4pager"
      const rel = path.relative(DECKS_DIR, fullPath).replace(/\\/g, '/').replace(/\.md$/, '');
      if (!rel || rel.startsWith('..')) return;
      this.emit('change', { event, deckId: rel });
    };
    this.watcher.on('change', f => emitFor('change', f));
    this.watcher.on('add',    f => emitFor('add', f));
    this.watcher.on('unlink', f => emitFor('unlink', f));
  }

  detach() {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount === 0 && this.watcher) {
      this.watcher.close().catch(() => {});
      this.watcher = null;
    }
  }
}

// Singleton — one watcher serves all connected clients.
const watcher = new DeckWatcher();

module.exports = { watcher };
