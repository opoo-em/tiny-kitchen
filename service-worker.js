// Tiny Kitchen — service worker (v2)
// Cache app shell on install; network-first for the local data bundle;
// cache-first for shell. GitHub API calls (remote data mode) are NOT handled
// here — the app caches that data itself in localStorage, so it works offline
// without the SW ever seeing a token.
//
// Bump CACHE_VERSION whenever the app shell changes — clients update on next load.

const CACHE_VERSION = 'tiny-kitchen-v3.0';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'parser.js',
  'manifest.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
// Optional: present in the private/dev copy, absent in the public shell.
// Cached best-effort so a 404 can't block install.
const OPTIONAL = ['data/tiny.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      await cache.addAll(SHELL);
      await Promise.all(
        OPTIONAL.map((path) =>
          fetch(path).then((res) => (res.ok ? cache.put(path, res) : null)).catch(() => null)
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never intercept cross-origin requests (GitHub API etc.).
  if (url.origin !== self.location.origin) return;

  const isData = url.pathname.endsWith('tiny.json');

  if (isData) {
    // Network-first for data — fresh when online, cache when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
  } else {
    // Cache-first for app shell.
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
            }
            return res;
          })
      )
    );
  }
});
