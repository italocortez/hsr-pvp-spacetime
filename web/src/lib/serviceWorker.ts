/*
 * Registers the image cache worker (`web/public/sw.js`, M10; docs/frontend/hosting.md). Production
 * builds only, secure contexts only, after the window `load` event, so it never sits in the path
 * of the first paint or the connection. A failure is a warning, never an error for the page.
 */

export const SERVICE_WORKER_URL = '/sw.js';

/**
 * The switch: false removes the worker instead of registering it (with the kill worker copied over
 * `web/public/sw.js`; "Switching the worker off" in docs/frontend/hosting.md).
 */
export const SERVICE_WORKER_ENABLED = true;

/** The worker's caches (`hsr-assets-*`) and the old site's (`hsrpvp-assets-*`). */
export const WORKER_CACHE = /^(?:hsr|hsrpvp)-assets-/;

type Registration = Pick<ServiceWorkerRegistration, 'unregister'> &
    Partial<Pick<ServiceWorkerRegistration, 'active' | 'waiting' | 'installing'>>;

/** True when the registration runs this origin's `/sw.js` (and no other worker). */
export function isOwnWorker(registration: Registration, origin: string): boolean {
    const own = new URL(SERVICE_WORKER_URL, origin).href;
    const worker = registration.active ?? registration.waiting ?? registration.installing;
    return worker?.scriptURL === own;
}

/** Unregisters this origin's `/sw.js` worker(s) and deletes the worker's caches. */
export async function removeServiceWorker(host: {
    origin: string;
    serviceWorker?: Pick<ServiceWorkerContainer, 'getRegistrations'>;
    caches?: Pick<CacheStorage, 'keys' | 'delete'>;
}): Promise<{ workers: number; caches: string[] }> {
    let workers = 0;
    const removed: string[] = [];
    for (const registration of (await host.serviceWorker?.getRegistrations()) ?? []) {
        if (isOwnWorker(registration, host.origin) && (await registration.unregister())) {
            workers += 1;
        }
    }
    if (host.caches) {
        for (const name of await host.caches.keys()) {
            if (WORKER_CACHE.test(name) && (await host.caches.delete(name))) removed.push(name);
        }
    }
    return { workers, caches: removed };
}

/** The parts of `window` this module reads (injectable for tests). */
export type ServiceWorkerHost = Pick<Window, 'isSecureContext' | 'addEventListener'> & {
    navigator: Partial<Pick<Navigator, 'serviceWorker'>>;
    document: Pick<Document, 'readyState'>;
    location: Pick<Location, 'origin'>;
    caches?: Pick<CacheStorage, 'keys' | 'delete'>;
};

export function registerServiceWorker(
    prod: boolean,
    host: ServiceWorkerHost = window,
    enabled: boolean = SERVICE_WORKER_ENABLED,
): void {
    if (!prod || !host.isSecureContext) return;
    const container = host.navigator.serviceWorker;
    if (!container) return;
    const run = () => {
        // A synchronous throw is caught the same way as a rejection.
        Promise.resolve()
            .then(
                (): Promise<unknown> =>
                    enabled
                        ? container.register(SERVICE_WORKER_URL, { scope: '/' })
                        : removeServiceWorker({
                              origin: host.location.origin,
                              serviceWorker: container,
                              caches: host.caches,
                          }),
            )
            .catch((error: unknown) =>
                console.warn(enabled ? '[sw] registration failed' : '[sw] removal failed', error),
            );
    };
    if (host.document.readyState === 'complete') run();
    else host.addEventListener('load', run, { once: true });
}
