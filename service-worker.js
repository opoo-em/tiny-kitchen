// Tiny Kitchen — service worker
// Strategy: cache app shell on install, network-first for recipes.json,
// cache-first fallback for everything else when offline.
//
// Bump CACHE_VERSION whenever the app shell changes — clients update on next load.

const CACHE_VERSION = 'tiny-kitchen-v1.1';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'data/recipes.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
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
  const isData = url.pathname.endsWith('recipes.json');

  if (isData) {
    // Network-first for data — so fresh content shows when online, falls back to cache offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
  } else {
    // Cache-first for app shell.
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        // Cache any same-origin GET we successfully fetched
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      }))
    );
  }
});
