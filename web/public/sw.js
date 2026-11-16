// Image cache worker (M10). Plain JavaScript, served as is from web/public (no build step).
//
// Character and light cone images live on UploadThing. Their addresses are content keys: an
// image at a given address never changes. This worker keeps a copy of every such image the
// visitor has seen, so a later view downloads nothing. It never touches this site's own requests
// (pages, scripts, the status file, the login routes, this file) or any host not listed below.
// Rules, how to switch it off and how to reset the cache by hand: docs/frontend/hosting.md,
// "Service worker (M10)".

// The image hosts, exactly (no wildcard): the UploadThing app of every image address in
// data/seed/characters.json and data/seed/lightcones.json. A unit test fails when a seed address
// is on a host missing here; add the new host when the UploadThing app changes.
const ALLOWED_HOSTS = ['zmvtaeh9bl.ufs.sh'];
// Changed by hand only when the caching rules change (not per build: images never change).
const CACHE_NAME = 'hsr-assets-v1';
// Caches of this worker (and of the old site's worker) that activate may delete.
const OWN_CACHE_PREFIXES = ['hsr-assets-', 'hsrpvp-assets-'];
// At most this many images; the first stored go first.
const MAX_ENTRIES = 400;

/** An image request this worker answers: every condition must hold. */
function isCachedImageRequest(request, url) {
    return (
        request.method === 'GET' &&
        request.destination === 'image' &&
        url.protocol === 'https:' &&
        url.port === '' &&
        url.username === '' &&
        url.password === '' &&
        ALLOWED_HOSTS.includes(url.hostname) &&
        !request.headers.has('range')
    );
}

/** A full, readable, non-empty image answer: never a partial, opaque or error response. */
function isStorable(response) {
    const type = response.headers.get('content-type') || '';
    return (
        response.status === 200 &&
        response.type !== 'opaque' &&
        type.toLowerCase().startsWith('image/') &&
        response.headers.get('content-length') !== '0'
    );
}

// The trim runs after a store only, one at a time. A store that lands while it runs asks for one
// more pass instead of starting a second trim, so two trims never delete from the same list.
let trimming = null;
let trimAgain = false;

function trimCache() {
    if (trimming) {
        trimAgain = true;
        return trimming;
    }
    trimming = (async () => {
        try {
            do {
                trimAgain = false;
                const cache = await caches.open(CACHE_NAME);
                const keys = await cache.keys();
                // keys() lists entries in insertion order: the first stored first.
                for (let i = 0; i < keys.length - MAX_ENTRIES; i++) {
                    await cache.delete(keys[i]);
                }
            } while (trimAgain);
        } catch (error) {
            console.warn('[sw] cache trim failed', error);
        } finally {
            trimming = null;
        }
    })();
    return trimming;
}

/** Stores a copy; a full disk or private browsing is not an error for the page. */
async function store(cache, url, response) {
    try {
        await cache.put(url, response);
    } catch {
        return;
    }
    await trimCache();
}

async function cacheFirst(event, url) {
    let cache = null;
    try {
        cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(url);
        if (hit) return hit;
    } catch {
        cache = null; // storage unavailable: the network still answers
    }
    // Refetched in CORS mode without credentials: an <img> request without crossorigin is
    // no-cors, whose opaque answer cannot be checked and is padded heavily in the storage quota.
    // UploadThing answers with Access-Control-Allow-Origin: *. The page's own headers are not
    // copied, so no preflight is triggered.
    let response;
    try {
        response = await fetch(
            new Request(url, {
                method: 'GET',
                mode: 'cors',
                credentials: 'omit',
                redirect: 'follow',
            }),
        );
    } catch {
        // The worker never breaks an image that would load without it: the page's own request,
        // in its own mode, never stored. If that fails too, the page sees a network error.
        return fetch(event.request);
    }
    if (cache && isStorable(response)) {
        // Not awaited: the page gets its answer while the copy is stored. A waitUntil that throws
        // (InvalidStateError) only costs the copy, never the image.
        try {
            event.waitUntil(store(cache, url, response.clone()));
        } catch {
            // the store may still finish; the page gets its image either way
        }
    }
    return response;
}

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            try {
                const names = await caches.keys();
                const old = names.filter(
                    (name) =>
                        name !== CACHE_NAME &&
                        OWN_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)),
                );
                await Promise.all(old.map((name) => caches.delete(name)));
            } catch {
                // storage unavailable: nothing to clean
            }
            // Safe: the worker never serves the app itself, so no page can run stale code.
            await self.clients.claim();
        })(),
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    // The first check, always: this site's own requests are never intercepted.
    if (url.origin === self.location.origin) return;
    if (!isCachedImageRequest(request, url)) return;
    event.respondWith(cacheFirst(event, url.href));
});
