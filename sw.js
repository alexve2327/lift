// sw.js — the service worker. This is the piece that makes the app work in a
// gym basement with no signal.
//
// Strategy: cache-first for our own files, because they only change when you
// deploy. Bump CACHE_VERSION whenever you edit anything, or phones will keep
// serving the old copy from cache indefinitely. That is not a bug in the
// browser, it is the whole point of a cache, and forgetting to bump it is the
// number one reason a PWA "won't update".
//
// Note what is NOT here: any handling of IndexedDB. Your data is not in the
// cache and is never touched by the service worker. Clearing the cache costs
// you a re-download of about 100KB; it does not cost you a single set.

const CACHE_VERSION = 'lift-v4';

const SHELL = [
  './',
  './index.html',
  './app.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/ui.js',
  './js/util.js',
  './js/timer.js',
  './js/chart.js',
  './js/exercise-form.js',
  './js/seed.js',
  './js/views/today.js',
  './js/views/food.js',
  './js/views/library.js',
  './js/views/settings.js',
  './js/views/progress.js',
  './lib/dexie.mjs',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(hit => {
      if (hit) {
        // Refresh the cache in the background so the next launch is current,
        // while this launch stays instant and works offline.
        fetch(request)
          .then(res => {
            if (res.ok) caches.open(CACHE_VERSION).then(c => c.put(request, res));
          })
          .catch(() => { /* offline: the cached copy is the right answer */ });
        return hit;
      }
      return fetch(request).catch(() => caches.match('./index.html'));
    })
  );
});
