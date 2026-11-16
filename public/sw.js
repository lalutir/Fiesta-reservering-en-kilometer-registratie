// Service worker: network first with a cache fallback for the static app files,
// so the installed app can still open when the phone is offline. It never
// touches /api (always live data) or /admin (admin only, never cached).
// Keep PRECACHE equal to the files in public/ (test/pwa.test.ts checks this).

const CACHE = 'car-static-v1';

const PRECACHE = [
  '/',
  '/app.js',
  '/api.js',
  '/dom.js',
  '/strings.js',
  '/style.css',
  '/manifest.webmanifest',
  '/views/login.js',
  '/views/agenda.js',
  '/views/reserve.js',
  '/views/inbox.js',
  '/views/usage.js',
  '/views/history.js',
  '/views/account.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/shared/time.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** @param {string} pathname */
function isExcluded(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/admin' || pathname.startsWith('/admin/');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isExcluded(url.pathname)) return;
  event.respondWith(networkFirst(request, event));
});

async function networkFirst(request, event) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) event.waitUntil(cache.put(request, response.clone()));
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}
