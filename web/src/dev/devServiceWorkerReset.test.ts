import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DevResetHost, resetDevServiceWorkers } from './devServiceWorkerReset';

/* T-M10: on the dev server, this origin's /sw.js worker is unregistered and its caches deleted;
 * other workers and caches are left alone. */

const ORIGIN = 'http://localhost:5173';

function fakeHost(names: string[], scripts = [`${ORIGIN}/sw.js`]) {
    const unregisters = scripts.map(() => vi.fn(async () => true));
    const cacheNames = new Set(names);
    const host = {
        location: { origin: ORIGIN },
        navigator: {
            serviceWorker: {
                getRegistrations: vi.fn(async () =>
                    scripts.map((scriptURL, i) => ({
                        active: { scriptURL },
                        unregister: unregisters[i],
                    })),
                ),
            },
        },
        caches: {
            keys: vi.fn(async () => [...cacheNames]),
            delete: vi.fn(async (name: string) => cacheNames.delete(name)),
        },
    } as unknown as DevResetHost;
    return { host, unregisters, cacheNames };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('T-M10 resetDevServiceWorkers (dev only)', () => {
    it('unregisters this origin /sw.js worker and deletes the worker caches, leaving others', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const { host, unregisters, cacheNames } = fakeHost(
            ['hsr-assets-v1', 'hsrpvp-assets-v2', 'other-cache'],
            [`${ORIGIN}/sw.js`, `${ORIGIN}/another-worker.js`],
        );
        const result = await resetDevServiceWorkers(host);
        expect(unregisters[0]).toHaveBeenCalledTimes(1);
        expect(unregisters[1]).not.toHaveBeenCalled();
        expect(result).toEqual({ workers: 1, caches: ['hsr-assets-v1', 'hsrpvp-assets-v2'] });
        expect([...cacheNames]).toEqual(['other-cache']);
        expect(info).toHaveBeenCalledTimes(1);
        expect(String(info.mock.calls[0]?.[0])).toContain('reload once');
    });

    it('a clean origin: nothing removed, nothing logged', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const { host } = fakeHost(['other-cache'], []);
        expect(await resetDevServiceWorkers(host)).toEqual({ workers: 0, caches: [] });
        expect(info).not.toHaveBeenCalled();
    });

    it('no service worker support and no Cache Storage: no throw', async () => {
        await expect(
            resetDevServiceWorkers({ location: { origin: ORIGIN }, navigator: {} }),
        ).resolves.toEqual({ workers: 0, caches: [] });
    });

    it('a failure is a warning, never a throw', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const host = {
            location: { origin: ORIGIN },
            navigator: {
                serviceWorker: { getRegistrations: () => Promise.reject(new Error('denied')) },
            },
        } as unknown as DevResetHost;
        await expect(resetDevServiceWorkers(host)).resolves.toEqual({ workers: 0, caches: [] });
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
