// Network-first app-shell service worker: always tries to fetch the latest
// version from the network first (so code updates show up immediately
// without needing to remember to bump a cache-buster), falling back to the
// cached copy only when offline. Previous versions used cache-first, which
// silently kept serving stale JS forever whenever this file's own bytes
// hadn't changed (Chrome only re-checks a service worker when its script
// differs byte-for-byte) - bump CACHE below only if you ever need to force
// a hard reset, it is no longer required for ordinary updates.
const CACHE = 'photo360-cache-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './js/app.js',
  './js/orientation.js',
  './js/grid.js',
  './js/capture.js',
  './js/align.js',
  './js/export.js',
  './js/storage.js',
  './vendor/pannellum/pannellum.js',
  './vendor/pannellum/pannellum.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
