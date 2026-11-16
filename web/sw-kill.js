// Kill worker for the image cache worker (M10). NOT served: it lives outside web/public on
// purpose. To switch the worker off in visitors' browsers, copy this file over web/public/sw.js,
// set SERVICE_WORKER_ENABLED to false in web/src/lib/serviceWorker.ts and deploy; the procedure
// and what browsers do: docs/frontend/hosting.md, "Switching the worker off".
//
// It answers no request (no fetch listener). On activate it deletes the worker's caches and
// unregisters itself; it claims no page.

const OWN_CACHE_PREFIXES = ['hsr-assets-', 'hsrpvp-assets-'];

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            try {
                const names = await caches.keys();
                const own = names.filter((name) =>
                    OWN_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)),
                );
                await Promise.all(own.map((name) => caches.delete(name)));
            } catch {
                // storage unavailable: nothing to delete
            }
            await self.registration.unregister();
        })(),
    );
});
