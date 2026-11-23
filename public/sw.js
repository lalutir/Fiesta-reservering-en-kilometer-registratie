// Service worker: network first with a cache fallback for the static app files,
// so the installed app can still open when the phone is offline. It never
// touches /api (always live data) or /admin (admin only, never cached).
// It also shows the reminder notifications the server pushes (see the end of this file).
// Keep PRECACHE equal to the files in public/ (test/pwa.test.ts checks this).

const CACHE = 'car-static-v7';

const PRECACHE = [
  '/',
  '/app.js',
  '/api.js',
  '/dom.js',
  '/calendar.js',
  '/kmcheck.js',
  '/strings.js',
  '/style.css',
  '/manifest.webmanifest',
  '/views/login.js',
  '/views/agenda.js',
  '/views/fuel.js',
  '/views/reserve.js',
  '/views/inbox.js',
  '/views/usage.js',
  '/views/history.js',
  '/views/tickets.js',
  '/views/car.js',
  '/views/account.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/shared/time.js',
  '/shared/format.js',
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

// ---- reminders (Web Push) -------------------------------------------------

/**
 * Every push ends in a visible notification, also when the payload is missing or
 * unreadable: iOS withdraws the subscription of an app whose pushes show nothing.
 */
self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  const text = (value, fallback, max) => (typeof value === 'string' && value.trim() !== '' ? value.slice(0, max) : fallback);
  // The fallbacks are Dutch literals: this worker cannot import public/strings.js. test/dutch.test.ts reads them.
  const title = text(data && data.title, 'Gedeelde auto', 100);
  const options = {
    body: text(data && data.body, 'Open de app om te zien wat er op je wacht.', 300),
    // The start, end and repeat reminders of one reservation share a tag, so a newer one replaces an
    // unread older one instead of piling up. renotify makes the replacement alert again (without it the
    // replacement is silent). It needs a non-empty tag, which the fallback above guarantees.
    tag: text(data && data.tag, 'car', 64),
    renotify: true,
    icon: '/icons/icon-192.png',
    data: { url: text(data && data.url, '/', 300) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/** The address a notification opens: always inside this app, whatever the payload said. */
function targetOf(raw) {
  try {
    const url = new URL(typeof raw === 'string' ? raw : '/', self.location.origin);
    if (url.origin === self.location.origin) return url.href;
  } catch {
    // fall through to the start page
  }
  return new URL('/', self.location.origin).href;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = targetOf(event.notification.data && event.notification.data.url);
  event.waitUntil(openTarget(href));
});

/** Reuse an open window of the app when there is one; otherwise open a new one. */
async function openTarget(href) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const mine = windows.find((client) => {
    try {
      return new URL(client.url).origin === self.location.origin;
    } catch {
      return false;
    }
  });
  if (mine) {
    try {
      const navigated = typeof mine.navigate === 'function' ? await mine.navigate(href) : null;
      await (navigated || mine).focus();
      return;
    } catch {
      // some browsers refuse navigate() or focus(): a new window always works
    }
  }
  await self.clients.openWindow(href);
}
