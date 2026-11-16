import { removeServiceWorker } from '@/lib/serviceWorker';

/*
 * Dev only (imported behind `import.meta.env.DEV` in main.tsx; check:patterns gate 3 keeps it out
 * of the production build by its marker below). The dev server never registers the image cache
 * worker (M10); this removes a worker of this origin's `/sw.js` (other workers are left alone) and
 * the worker's caches, so a worker left by an earlier experiment cannot serve cached images during
 * development. The page that runs this is still controlled by the stale worker until it unloads:
 * one reload after the first dev load fixes it.
 */

/** Gate 3's marker: the text appears in this module only. */
export const DEV_SW_RESET_MARKER = 'hsr-dev-sw-reset';

/** The parts of `window` this module reads (injectable for tests). */
export type DevResetHost = {
    location: Pick<Location, 'origin'>;
    navigator: Partial<Pick<Navigator, 'serviceWorker'>>;
    caches?: Pick<CacheStorage, 'keys' | 'delete'>;
};

/** Unregisters this origin's `/sw.js` worker and deletes the worker's caches. Never throws. */
export async function resetDevServiceWorkers(
    host: DevResetHost = window,
): Promise<{ workers: number; caches: string[] }> {
    let result = { workers: 0, caches: [] as string[] };
    try {
        result = await removeServiceWorker({
            origin: host.location.origin,
            serviceWorker: host.navigator.serviceWorker,
            caches: host.caches,
        });
    } catch (error) {
        console.warn(`[${DEV_SW_RESET_MARKER}] could not reset the service worker`, error);
    }
    if (result.workers > 0 || result.caches.length > 0) {
        console.info(
            `[${DEV_SW_RESET_MARKER}] removed ${result.workers} service worker(s) and the caches: ${result.caches.join(', ') || 'none'}; reload once if this page was controlled by it`,
        );
    }
    return result;
}
