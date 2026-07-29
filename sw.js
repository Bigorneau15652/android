// Cache-first app-shell service worker so the app keeps working offline
// once loaded once (no runtime network calls happen otherwise: everything,
// including Pannellum, is bundled locally).
const CACHE = 'photo360-cache-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './js/app.js',
  './js/orientation.js',
  './js/grid.js',
  './js/capture.js',
  './js/stitch.js',
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
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
