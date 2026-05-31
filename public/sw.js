/*
 * Furgoson Studio service worker.
 *
 * Strategy:
 *   - App shell (HTML/CSS/JS/manifest/icons): cache-first, so the installed
 *     PWA opens instantly and works offline.
 *   - /api/* requests: network-first (never serve a stale deck/edit response);
 *     these are not cached.
 *   - Everything else (cross-origin fonts, etc.): pass through to the network.
 */
const CACHE = 'furgoson-shell-v1';

// The static app shell. Paths are root-relative to match express.static('public').
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/viewer.js',
  '/chat.js',
  '/agent.js',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Tolerate individual misses so install never fails on one 404.
      Promise.all(
        SHELL.map((url) =>
          cache.add(url).catch(() => {
            /* ignore a single failed precache entry */
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; let the browser deal with POST/PUT/etc. directly.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Don't touch cross-origin requests (e.g. Google Fonts) — pass through.
  if (url.origin !== self.location.origin) return;

  // API: network-first, no caching.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  // Shell / static: cache-first, then fill the cache on first network hit.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Cache successful, same-origin, basic responses for next time.
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
