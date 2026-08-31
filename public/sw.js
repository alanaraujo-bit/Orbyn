/// <reference lib="webworker" />

/**
 * Service worker for the installed panel.
 *
 * Its job is narrow on purpose. The panel sits behind a password and `proxy.ts`
 * redirects anything unauthenticated to /entrar, so caching a page response is
 * a real hazard: an expired session turns into a cached login redirect served
 * as if it were the dashboard, and the operator sees a stale screen with no way
 * to tell. So nothing that can carry data or an auth decision is ever cached.
 *
 * What is cached is only what is already public and immutable: the build's
 * static assets, the app icons, and one offline placeholder page. Everything
 * else goes to the network every time.
 *
 * Bump CACHE_VERSION to force every installed phone to drop its old cache.
 */

const CACHE_VERSION = 'orbyn-v1';
const OFFLINE_URL = '/offline.html';

/** Prefixes safe to serve from cache: content-hashed or version-controlled. */
const IMMUTABLE_PREFIXES = ['/_next/static/', '/icons/'];

const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      // A missing precache entry must not wedge the install; the worker is
      // still useful without the offline page.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Page loads: always the network, so the operator never reads stale numbers.
  // If the network is gone, show the offline placeholder rather than the
  // browser's own error page.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL).then((cached) => cached ?? Response.error())));
    return;
  }

  if (IMMUTABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            // Only store complete, same-origin successes. An opaque or partial
            // response cached here would be indistinguishable from the real one.
            if (response.ok && response.type === 'basic') {
              const copy = response.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Everything else — RSC payloads, Server Actions, the API — is network only.
});

/** Lets the page ask a waiting worker to take over without a manual reload. */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
