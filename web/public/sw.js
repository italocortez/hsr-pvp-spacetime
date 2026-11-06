// public/sw.js — Phase 16 Plan 04 (FOUND-07)
// Asset-CDN cache-first Service Worker. ONLY intercepts the hostnames in ALLOWED_HOSTS.
// NEVER intercepts app-origin requests — that would break RSC streams, API routes, and WS upgrades.
// See 16-RESEARCH.md §Pattern 5 for full rationale; D-17, D-18, D-19 for policy.

const VERSION = 2; // Phase 16 UAT Test 3: CORS-mode fetch + drop imgur allowlist
const ASSET_CACHE = `hsrpvp-assets-v${VERSION}`;
// D-17: UploadThing only. i.imgur.com deferred — no CORS support would force
// opaque responses with ~7MB padding per entry (prohibitive for large galleries).
// Re-add once a strategy is chosen (proxy / accept padding / trusted pre-upload).
const ALLOWED_HOSTS = ['ufs.sh'];

self.addEventListener('install', (event) => {
  console.log('[SW] install v' + VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] activate v' + VERSION);
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== ASSET_CACHE).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // D-18: Never intercept app origin — ORDER MATTERS, this is the FIRST check.
  if (url.origin === self.location.origin) return;

  // D-17: Only intercept allowlisted asset CDNs.
  const hostAllowed = ALLOWED_HOSTS.some(
    (h) => url.hostname === h || url.hostname.endsWith('.' + h)
  );
  if (!hostAllowed) return;

  console.log('[SW] intercept', url.hostname, url.pathname);
  event.respondWith(
    caches.open(ASSET_CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      // Re-issue in CORS mode. <img> requests default to no-cors, which produces
      // opaque responses — response.ok === false (always), response.type === 'opaque',
      // and browsers pessimistically pad the storage quota by ~7MB per entry.
      // ufs.sh returns access-control-allow-origin: * with an accurate content-length,
      // so CORS-mode fetches give us real responses: response.ok works, real bytes
      // charged to quota (Phase 16 UAT Test 3 finding).
      // Headers from the original <img> request are dropped on purpose — preserving
      // custom headers can trigger CORS preflight (OPTIONS), which the CDN may not
      // support for image routes. Plain GETs don't need any headers.
      const corsRequest = new Request(event.request.url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
      });
      let response;
      try {
        response = await fetch(corsRequest);
      } catch (err) {
        // Network / CSP connect-src / CORS failure. Log context so the opaque
        // 'NetworkError when attempting to fetch resource' doesn't disappear
        // into a rejected respondWith promise (Phase 16 UAT Test 3 diagnosis).
        console.warn(
          '[SW] fetch failed for', event.request.url,
          '— mode=', corsRequest.mode,
          'referrer=', event.request.referrer,
          'err=', err
        );
        throw err;
      }
      if (response.ok && event.request.method === 'GET') {
        // WR-03: extend SW lifetime for the cache write WITHOUT delaying the response.
        // A rejected cache.put (quota exceeded, Safari private mode) is swallowed with a
        // warning rather than escaping as an unhandled promise rejection.
        event.waitUntil(
          cache.put(event.request, response.clone())
            .catch((err) => console.warn('[SW] cache.put failed', err))
        );
      }
      return response;
    })
  );
});
