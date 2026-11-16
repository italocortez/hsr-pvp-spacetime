import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOwnWorker, registerServiceWorker, type ServiceWorkerHost } from './serviceWorker';

/* T-M10: the worker's registration (production only, secure context only, after `load`) and the
 * page-side switch that removes it instead. */

const ORIGIN = 'https://hsr.example';

type Options = {
    secure?: boolean;
    readyState?: DocumentReadyState;
    withWorkers?: boolean;
    register?: () => Promise<unknown>;
    registrations?: { scriptURL: string; unregister: () => Promise<boolean> }[];
    cacheNames?: string[];
};

function fakeHost({
    secure = true,
    readyState = 'loading',
    withWorkers = true,
    register = async () => ({}),
    registrations = [],
    cacheNames = [],
}: Options = {}) {
    const listeners: { type: string; fn: () => void; options: unknown }[] = [];
    const registerMock = vi.fn(register);
    const names = new Set(cacheNames);
    const host = {
        isSecureContext: secure,
        addEventListener: vi.fn((type: string, fn: () => void, options?: unknown) => {
            listeners.push({ type, fn, options });
        }),
        navigator: withWorkers
            ? {
                  serviceWorker: {
                      register: registerMock,
                      getRegistrations: async () =>
                          registrations.map((r) => ({
                              active: { scriptURL: r.scriptURL },
                              unregister: r.unregister,
                          })),
                  },
              }
            : {},
        document: { readyState },
        location: { origin: ORIGIN },
        caches: {
            keys: async () => [...names],
            delete: async (name: string) => names.delete(name),
        },
    } as unknown as ServiceWorkerHost;
    const fireLoad = () => {
        for (const l of listeners.filter((x) => x.type === 'load')) l.fn();
    };
    return { host, registerMock, listeners, fireLoad, names };
}

/** Lets the promise chain inside registerServiceWorker run. */
const settle = () => new Promise((done) => setTimeout(done, 0));

afterEach(() => {
    vi.restoreAllMocks();
});

describe('T-M10 registerServiceWorker (worker enabled)', () => {
    it('a dev build registers nothing and waits for nothing', async () => {
        const { host, registerMock, listeners } = fakeHost();
        registerServiceWorker(false, host, true);
        await settle();
        expect(registerMock).not.toHaveBeenCalled();
        expect(listeners).toEqual([]);
    });

    it('production: registers /sw.js with scope / only after the window load event', async () => {
        const { host, registerMock, listeners, fireLoad } = fakeHost();
        registerServiceWorker(true, host, true);
        await settle();
        expect(registerMock).not.toHaveBeenCalled();
        expect(listeners).toHaveLength(1);
        expect(listeners[0]?.type).toBe('load');
        expect(listeners[0]?.options).toEqual({ once: true });
        fireLoad();
        await settle();
        expect(registerMock).toHaveBeenCalledTimes(1);
        expect(registerMock).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    });

    it('production after load has already fired: registers at once', async () => {
        const { host, registerMock, listeners } = fakeHost({ readyState: 'complete' });
        registerServiceWorker(true, host, true);
        await settle();
        expect(listeners).toEqual([]);
        expect(registerMock).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    });

    it('an insecure context registers nothing', async () => {
        const { host, registerMock, listeners, fireLoad } = fakeHost({ secure: false });
        registerServiceWorker(true, host, true);
        fireLoad();
        await settle();
        expect(registerMock).not.toHaveBeenCalled();
        expect(listeners).toEqual([]);
    });

    it('a browser without service workers registers nothing', async () => {
        const { host, listeners } = fakeHost({ withWorkers: false });
        expect(() => registerServiceWorker(true, host, true)).not.toThrow();
        expect(listeners).toEqual([]);
    });

    it('a rejected registration is swallowed with one warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const failure = new Error('SecurityError');
        const { host, fireLoad } = fakeHost({ register: () => Promise.reject(failure) });
        registerServiceWorker(true, host, true);
        fireLoad();
        await settle();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('[sw] registration failed', failure);
    });

    it('a registration that throws synchronously is swallowed the same way', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { host, fireLoad } = fakeHost({
            register: () => {
                throw new Error('boom');
            },
        });
        registerServiceWorker(true, host, true);
        expect(() => fireLoad()).not.toThrow();
        await settle();
        expect(warn).toHaveBeenCalledTimes(1);
    });
});

describe('T-M10 registerServiceWorker (worker switched off)', () => {
    it('production: after load, unregisters this origin /sw.js only and deletes both cache families', async () => {
        const own = vi.fn(async () => true);
        const foreign = vi.fn(async () => true);
        const { host, registerMock, fireLoad, names } = fakeHost({
            registrations: [
                { scriptURL: `${ORIGIN}/sw.js`, unregister: own },
                { scriptURL: `${ORIGIN}/other-worker.js`, unregister: foreign },
            ],
            cacheNames: ['hsr-assets-v1', 'hsrpvp-assets-v2', 'unrelated'],
        });
        registerServiceWorker(true, host, false);
        await settle();
        expect(own).not.toHaveBeenCalled();
        fireLoad();
        await settle();
        expect(registerMock).not.toHaveBeenCalled();
        expect(own).toHaveBeenCalledTimes(1);
        expect(foreign).not.toHaveBeenCalled();
        expect([...names]).toEqual(['unrelated']);
    });

    it('a dev build does not remove either (the dev reset does that)', async () => {
        const own = vi.fn(async () => true);
        const { host, fireLoad, names } = fakeHost({
            registrations: [{ scriptURL: `${ORIGIN}/sw.js`, unregister: own }],
            cacheNames: ['hsr-assets-v1'],
        });
        registerServiceWorker(false, host, false);
        fireLoad();
        await settle();
        expect(own).not.toHaveBeenCalled();
        expect([...names]).toEqual(['hsr-assets-v1']);
    });

    it('an insecure context removes nothing and waits for nothing', async () => {
        const own = vi.fn(async () => true);
        const { host, fireLoad, listeners, names } = fakeHost({
            secure: false,
            registrations: [{ scriptURL: `${ORIGIN}/sw.js`, unregister: own }],
            cacheNames: ['hsr-assets-v1'],
        });
        registerServiceWorker(true, host, false);
        fireLoad();
        await settle();
        expect(listeners).toEqual([]);
        expect(own).not.toHaveBeenCalled();
        expect([...names]).toEqual(['hsr-assets-v1']);
    });

    it('a failed removal is swallowed with one warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { host } = fakeHost({
            readyState: 'complete',
            registrations: [
                { scriptURL: `${ORIGIN}/sw.js`, unregister: () => Promise.reject(new Error('x')) },
            ],
        });
        registerServiceWorker(true, host, false);
        await settle();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toBe('[sw] removal failed');
    });
});

describe('T-M10 isOwnWorker', () => {
    const reg = (scriptURL?: string, slot: 'active' | 'waiting' | 'installing' = 'active') => ({
        [slot]: scriptURL === undefined ? null : { scriptURL },
        unregister: async () => true,
    });

    it.each([
        [`${ORIGIN}/sw.js`, true],
        [`${ORIGIN}/sw.js?v=2`, false],
        [`${ORIGIN}/other.js`, false],
        ['https://elsewhere.example/sw.js', false],
    ])('%s is ours: %s', (url, expected) => {
        expect(isOwnWorker(reg(url) as never, ORIGIN)).toBe(expected);
    });

    it('a waiting or installing worker counts; no worker at all does not', () => {
        expect(isOwnWorker(reg(`${ORIGIN}/sw.js`, 'waiting') as never, ORIGIN)).toBe(true);
        expect(isOwnWorker(reg(`${ORIGIN}/sw.js`, 'installing') as never, ORIGIN)).toBe(true);
        expect(isOwnWorker(reg(undefined) as never, ORIGIN)).toBe(false);
    });
});
