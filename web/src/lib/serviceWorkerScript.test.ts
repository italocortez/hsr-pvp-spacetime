import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_WORKER_ENABLED } from './serviceWorker';

/*
 * T-M10: the image cache worker, `web/public/sw.js`, and the kill worker, `web/sw-kill.js`, the
 * real files. Each source runs in a fake worker scope (self, caches, fetch, Request, console) and
 * the tests drive real install, activate and fetch events through its own listeners. No network:
 * fetch is a fake. The fake Cache API consumes the body it stores, as the real one does.
 *
 * The suites follow the state on disk: while `web/public/sw.js` is the caching worker the caching
 * suites run; while it is the kill worker (switched off, docs/frontend/hosting.md) the kill suite
 * runs against it too. One agreement test always runs: the page-side switch matches the file.
 */

// jsdom gives this file a non-file import.meta.url, so the web folder is found from the cwd
// (as in entryChunk.test.ts).
const WEB = [join(process.cwd(), 'web'), process.cwd()].find((d) =>
    existsSync(join(d, 'public', 'sw.js')),
) as string;
const ROOT = dirname(WEB);
const SOURCE = readFileSync(join(WEB, 'public', 'sw.js'), 'utf8');
const KILL_SOURCE = readFileSync(join(WEB, 'sw-kill.js'), 'utf8');

/**
 * Drops `//` and block comments, keeping string and template literal contents. Not a parser:
 * regex literals and nested template expressions are not understood. The same rule is duplicated
 * in scripts/ci/check-patterns.mjs gate 11 (web/src may not import scripts/, gate 10).
 */
function stripComments(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i] as string;
        const n = src[i + 1];
        if (c === '/' && n === '/') {
            while (i < src.length && src[i] !== '\n') i++;
        } else if (c === '/' && n === '*') {
            const end = src.indexOf('*/', i + 2);
            i = end < 0 ? src.length : end + 2;
            out += ' ';
        } else if (c === "'" || c === '"' || c === '`') {
            out += c;
            i++;
            while (i < src.length && src[i] !== c) {
                if (src[i] === '\\') out += src[i++] ?? '';
                out += src[i++] ?? '';
            }
            out += src[i++] ?? '';
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

/** Gate 11's two shapes: the caching worker, the kill worker, or neither. */
function workerShape(src: string): 'caching' | 'kill' | 'neither' {
    const code = stripComments(src);
    const responds = code.includes('respondWith(');
    const fetchListener = /addEventListener\(\s*['"]fetch['"]/.test(code);
    const unregisters = code.includes('registration.unregister()');
    if (responds && !unregisters) return 'caching';
    if (!responds && !fetchListener && unregisters) return 'kill';
    return 'neither';
}

const SHAPE = workerShape(SOURCE);
const IS_CACHING = SHAPE === 'caching';

const ORIGIN = 'https://hsr.example';
const HOST = 'zmvtaeh9bl.ufs.sh';
const IMAGE = `https://${HOST}/f/SLmv6eLWwLJmy0SD4Bx0IkdESXzc2H3gZ1spCA9DTWBmMito`;
const CURRENT = 'hsr-assets-v1';

/** Header bag with case-insensitive names (the worker reads `get` and `has`). */
class FakeHeaders {
    private readonly map = new Map<string, string>();
    constructor(readonly init: Record<string, string> = {}) {
        for (const [k, v] of Object.entries(init)) this.map.set(k.toLowerCase(), v);
    }
    get(name: string) {
        return this.map.get(name.toLowerCase()) ?? null;
    }
    has(name: string) {
        return this.map.has(name.toLowerCase());
    }
}

/** A response whose body can be read once; a clone has its own body. */
class FakeResponse {
    readonly headers: FakeHeaders;
    bodyUsed = false;
    constructor(
        readonly status: number,
        headers: Record<string, string> = {},
        readonly type: string = 'cors',
        private readonly body = 'image-bytes',
    ) {
        this.headers = new FakeHeaders(headers);
    }
    get ok() {
        return this.status >= 200 && this.status < 300;
    }
    async text() {
        if (this.bodyUsed) throw new TypeError('body already used');
        this.bodyUsed = true;
        return this.body;
    }
    clone() {
        if (this.bodyUsed) throw new TypeError('cannot clone a used body');
        return new FakeResponse(this.status, this.headers.init, this.type, this.body);
    }
}

const image = (status = 200, type = 'image/webp', extra: Record<string, string> = {}) =>
    new FakeResponse(status, { 'Content-Type': type, ...extra });
const opaque = () => new FakeResponse(0, {}, 'opaque', '');

/** What `new Request(url, init)` received in the worker. */
class FakeRequest {
    constructor(
        readonly url: string,
        readonly init: Record<string, unknown>,
    ) {}
}

type CacheKey = string | { url: string };
const keyOf = (key: CacheKey) => (typeof key === 'string' ? key : key.url);

type Listener = (event: unknown) => void;
type RequestInit = {
    method?: string;
    headers?: Record<string, string>;
    destination?: string;
    /** The event's waitUntil throws InvalidStateError. */
    waitUntilThrows?: boolean;
};

function loadWorker(source = SOURCE) {
    const listeners = new Map<string, Listener>();
    const stores = new Map<string, Map<string, FakeResponse>>();
    const calls = {
        keys: 0,
        keysInFlight: 0,
        maxKeysInFlight: 0,
        putsDuringKeys: 0,
        putKeys: [] as unknown[],
        putsStarted: 0,
        putsDone: 0,
        putFails: false,
        /** When set, every put waits for it. */
        putGate: undefined as Promise<void> | undefined,
        openFails: false,
        cachesKeysFails: false,
        deleted: [] as string[],
        /** Called each time keys() starts, after its snapshot (lets a test store during a trim). */
        onKeys: () => {},
        slowKeys: false,
        /** When set, every caches.delete waits for it. */
        deleteGate: undefined as Promise<void> | undefined,
        /** Cache deletions and unregister calls, in order. */
        ops: [] as string[],
    };
    const fetchMock = vi.fn<(request: unknown) => Promise<FakeResponse>>(async () => image());
    const log = { log: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };

    const cacheFor = (name: string) => {
        let entries = stores.get(name);
        if (!entries) {
            entries = new Map();
            stores.set(name, entries);
        }
        const map = entries;
        return {
            match: async (key: CacheKey) => map.get(keyOf(key))?.clone(),
            put: async (key: CacheKey, response: FakeResponse) => {
                calls.putsStarted += 1;
                calls.putKeys.push(key);
                if (calls.putGate) await calls.putGate;
                if (calls.putFails) throw new Error('QuotaExceededError');
                if (calls.keysInFlight > 0) calls.putsDuringKeys += 1;
                // As the Cache API: the body is read (consumed), the entry replaced and appended.
                const body = await response.text();
                map.delete(keyOf(key));
                map.set(
                    keyOf(key),
                    new FakeResponse(response.status, response.headers.init, response.type, body),
                );
                calls.putsDone += 1;
            },
            keys: async () => {
                calls.keys += 1;
                calls.keysInFlight += 1;
                calls.maxKeysInFlight = Math.max(calls.maxKeysInFlight, calls.keysInFlight);
                const snapshot = [...map.keys()].map((url) => ({ url }));
                calls.onKeys();
                // A real keys() takes a while: the overlap test lets other events run first.
                if (calls.slowKeys) await new Promise((done) => setTimeout(done, 0));
                calls.keysInFlight -= 1;
                return snapshot;
            },
            delete: async (key: CacheKey) => {
                calls.deleted.push(keyOf(key));
                return map.delete(keyOf(key));
            },
        };
    };
    const caches = {
        open: async (name: string) => {
            if (calls.openFails) throw new DOMException('denied', 'SecurityError');
            return cacheFor(name);
        },
        keys: async () => {
            if (calls.cachesKeysFails) throw new DOMException('denied', 'SecurityError');
            return [...stores.keys()];
        },
        delete: async (name: string) => {
            if (calls.deleteGate) await calls.deleteGate;
            calls.ops.push(`delete ${name}`);
            return stores.delete(name);
        },
    };
    const self = {
        location: { origin: ORIGIN },
        addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
        skipWaiting: vi.fn(async () => {}),
        clients: { claim: vi.fn(async () => {}) },
        registration: {
            unregister: vi.fn(async () => {
                calls.ops.push('unregister');
                return true;
            }),
        },
    };
    const constants = new Function(
        'self',
        'caches',
        'fetch',
        'Request',
        'console',
        `${source}\nreturn typeof ALLOWED_HOSTS === 'undefined' ? {} : { ALLOWED_HOSTS, CACHE_NAME, MAX_ENTRIES };`,
    )(self, caches, fetchMock, FakeRequest, log) as {
        ALLOWED_HOSTS?: string[];
        CACHE_NAME?: string;
        MAX_ENTRIES?: number;
    };

    /** Dispatches a fetch event; the answer and the waitUntil work are returned separately. */
    function dispatch(url: string, init: RequestInit = {}) {
        let responded: Promise<unknown> | undefined;
        const waits: Promise<unknown>[] = [];
        const request = {
            url,
            method: init.method ?? 'GET',
            mode: 'no-cors',
            destination: init.destination ?? 'image',
            headers: new FakeHeaders(init.headers),
        };
        const event = {
            request,
            respondWith: (p: Promise<unknown>) => {
                responded = Promise.resolve(p);
            },
            waitUntil: (p: Promise<unknown>) => {
                if (init.waitUntilThrows) {
                    throw new DOMException('the event is no longer active', 'InvalidStateError');
                }
                waits.push(p);
            },
        };
        listeners.get('fetch')?.(event);
        if (!responded) return undefined;
        const answer = responded.then(
            (response) => ({ response: response as FakeResponse, error: undefined }),
            (error: unknown) => ({ response: undefined, error }),
        );
        const settled = async () => {
            for (let i = 0; i < waits.length; i++) await waits[i];
        };
        return { request, answer, settled };
    }

    /** Dispatches a fetch event; settles every waitUntil before it returns. */
    async function request(url: string, init: RequestInit = {}) {
        const sent = dispatch(url, init);
        if (!sent) return { intercepted: false as const };
        const outcome = await sent.answer;
        await sent.settled();
        return { intercepted: true as const, request: sent.request, ...outcome };
    }

    async function lifecycle(type: 'install' | 'activate') {
        const waits: Promise<unknown>[] = [];
        listeners.get(type)?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
        await Promise.all(waits);
    }

    const entries = (name = CURRENT) => [...(stores.get(name)?.keys() ?? [])];

    return {
        dispatch,
        request,
        lifecycle,
        listeners,
        fetchMock,
        calls,
        stores,
        entries,
        self,
        log,
        cacheFor,
        constants,
    };
}

let worker: ReturnType<typeof loadWorker>;
beforeEach(() => {
    worker = loadWorker();
});

describe('T-M10 the switch and web/public/sw.js agree (always runs)', () => {
    it('web/public/sw.js is one of the two shapes', () => {
        expect(SHAPE).not.toBe('neither');
    });

    it('SERVICE_WORKER_ENABLED is true exactly when web/public/sw.js is the caching worker', () => {
        let problem = '';
        if (SHAPE === 'kill' && SERVICE_WORKER_ENABLED) {
            problem =
                'web/public/sw.js is the kill worker but SERVICE_WORKER_ENABLED is true: set it to false in web/src/lib/serviceWorker.ts (step 2 of "Switching the worker off")';
        } else if (SHAPE === 'caching' && !SERVICE_WORKER_ENABLED) {
            problem =
                'SERVICE_WORKER_ENABLED is false but web/public/sw.js is the caching worker: copy web/sw-kill.js over web/public/sw.js (step 1 of "Switching the worker off")';
        }
        expect(problem).toBe('');
    });

    it('the shape rule ignores comments (a marker only in a comment does not count)', () => {
        expect(
            workerShape(
                '// self.registration.unregister()\nself.addEventListener("install", () => {});',
            ),
        ).toBe('neither');
        expect(
            workerShape(
                "self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request))); /* registration.unregister() */",
            ),
        ).toBe('caching');
        expect(workerShape("const s = '// not a comment'; self.registration.unregister();")).toBe(
            'kill',
        );
    });
});

describe.runIf(IS_CACHING)('T-M10 sw.js: what the worker never intercepts', () => {
    it.each(['/', '/assets/index-abc123.js', '/status.json', '/api/auth/discord/start', '/sw.js'])(
        'same origin %s goes to the network untouched',
        async (path) => {
            expect(await worker.request(`${ORIGIN}${path}`)).toEqual({ intercepted: false });
            expect(await worker.request(`${ORIGIN}${path}`, { method: 'POST' })).toEqual({
                intercepted: false,
            });
        },
    );

    it.each([
        'https://maincloud.spacetimedb.com/v1/identity/websocket-token',
        'https://discord.com/oauth2/authorize',
        'https://cdn.discordapp.com/avatars/1/a.png',
        'https://ufs.sh/f/key',
        'https://other-tenant.ufs.sh/f/key',
        'https://evil-ufs.sh/f/key',
        'https://ufs.sh.evil.example/f/key',
        `https://${HOST}.evil.example/f/key`,
        `https://x.${HOST}/f/key`,
        `http://${HOST}/f/key`,
        `https://${HOST}:8443/f/key`,
        `https://user:pass@${HOST}/f/key`,
        `https://user@${HOST}/f/key`,
        `https://:pw@${HOST}/f/key`,
    ])('a host or address not on the allow-list (%s) is not intercepted', async (url) => {
        expect(await worker.request(url)).toEqual({ intercepted: false });
    });

    it.each(['POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'])(
        '%s to the image host is not intercepted',
        async (method) => {
            expect(await worker.request(IMAGE, { method })).toEqual({ intercepted: false });
        },
    );

    it.each(['', 'script', 'style', 'video', 'audio', 'document', 'font'])(
        'a request with destination "%s" (not an image) is not intercepted',
        async (destination) => {
            expect(await worker.request(IMAGE, { destination })).toEqual({ intercepted: false });
        },
    );

    it('a byte-range request is not intercepted', async () => {
        expect(await worker.request(IMAGE, { headers: { Range: 'bytes=0-99' } })).toEqual({
            intercepted: false,
        });
    });

    it('the fetch never reached the network or the cache for any of those', async () => {
        await worker.request(`${ORIGIN}/status.json`);
        await worker.request('https://discord.com/x');
        await worker.request(IMAGE, { destination: '' });
        expect(worker.fetchMock).not.toHaveBeenCalled();
        expect(worker.stores.size).toBe(0);
    });

    it('the same-origin return is the first check of the fetch listener', () => {
        const listener = SOURCE.slice(SOURCE.indexOf("addEventListener('fetch'"));
        const first = listener.indexOf('if (');
        expect(listener.slice(first)).toMatch(
            /^if \(url\.origin === self\.location\.origin\) return;/,
        );
    });
});

describe.runIf(IS_CACHING)('T-M10 sw.js: the allow-list covers every seed image', () => {
    const seedUrls = ['characters.json', 'lightcones.json'].flatMap((file) =>
        (
            JSON.parse(readFileSync(join(ROOT, 'data', 'seed', file), 'utf8')) as {
                image_url?: unknown;
            }[]
        )
            .map((row) => row.image_url)
            .filter((u): u is string => typeof u === 'string' && u !== ''),
    );

    it('the seed files hold image addresses (the test reads real data)', () => {
        expect(seedUrls.length).toBeGreaterThan(200);
    });

    it('the allow-list is a short list of exact hosts', () => {
        const hosts = worker.constants.ALLOWED_HOSTS ?? [];
        expect(hosts.length).toBeGreaterThan(0);
        for (const host of hosts) expect(host).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    });

    it('every seed image address is https on an allowed host, and the worker intercepts it', async () => {
        const hosts = worker.constants.ALLOWED_HOSTS ?? [];
        const outside = seedUrls.filter((u) => {
            const url = new URL(u);
            return url.protocol !== 'https:' || url.port !== '' || !hosts.includes(url.hostname);
        });
        expect(outside).toEqual([]);
        for (const u of seedUrls) {
            const sent = worker.dispatch(u);
            expect(sent, u).toBeDefined();
            await sent?.answer;
            await sent?.settled();
        }
    });
});

describe.runIf(IS_CACHING)('T-M10 sw.js: cache-first for allowed images', () => {
    it('a first request refetches in CORS mode without credentials and stores the image', async () => {
        const result = await worker.request(IMAGE);
        expect(result.intercepted).toBe(true);
        expect(result.intercepted && result.response?.status).toBe(200);
        expect(worker.fetchMock).toHaveBeenCalledTimes(1);
        const sent = worker.fetchMock.mock.calls[0]?.[0] as FakeRequest;
        expect(sent).toBeInstanceOf(FakeRequest);
        expect(sent.url).toBe(IMAGE);
        expect(sent.init).toEqual({
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
            redirect: 'follow',
        });
        expect(worker.entries()).toEqual([IMAGE]);
    });

    it('the stored copy is a clone: the page can still read the body it was given', async () => {
        const result = await worker.request(IMAGE);
        expect(result.intercepted && result.response?.bodyUsed).toBe(false);
        await expect(result.intercepted && result.response?.text()).resolves.toBe('image-bytes');
        expect(worker.calls.putsDone).toBe(1);
    });

    it('the cache key is the address string, query string included', async () => {
        await worker.request(`${IMAGE}?v=1`);
        await worker.request(`${IMAGE}?v=2`);
        expect(worker.calls.putKeys).toEqual([`${IMAGE}?v=1`, `${IMAGE}?v=2`]);
        expect(worker.entries()).toEqual([`${IMAGE}?v=1`, `${IMAGE}?v=2`]);
    });

    it('the answer is not delayed by the store (it resolves while put is still pending)', async () => {
        let release = () => {};
        worker.calls.putGate = new Promise((done) => {
            release = done;
        });
        const sent = worker.dispatch(IMAGE);
        const outcome = await sent?.answer;
        expect(outcome?.response?.status).toBe(200);
        expect(worker.calls.putsStarted).toBe(1);
        expect(worker.calls.putsDone).toBe(0);
        release();
        await sent?.settled();
        expect(worker.calls.putsDone).toBe(1);
    });

    it('a second request is served from the cache with no network call and no keys() read', async () => {
        await worker.request(IMAGE);
        worker.fetchMock.mockClear();
        const keysBefore = worker.calls.keys;
        const result = await worker.request(IMAGE);
        expect(result.intercepted && result.response?.status).toBe(200);
        await expect(result.intercepted && result.response?.text()).resolves.toBe('image-bytes');
        expect(worker.fetchMock).not.toHaveBeenCalled();
        expect(worker.calls.keys).toBe(keysBefore);
    });

    it.each([
        ['a partial 206', () => image(206)],
        ['an opaque answer', opaque],
        ['a 404', () => new FakeResponse(404, { 'Content-Type': 'text/html' })],
        ['a 404 with an image type', () => image(404)],
        [
            'a 200 that is not an image',
            () => new FakeResponse(200, { 'Content-Type': 'text/html' }),
        ],
        ['a 200 with no content type', () => new FakeResponse(200)],
        [
            'a 200 image with Content-Length: 0',
            () => image(200, 'image/webp', { 'Content-Length': '0' }),
        ],
    ])('%s is returned to the page but not stored', async (_label, make) => {
        const answer = make();
        worker.fetchMock.mockResolvedValueOnce(answer);
        const result = await worker.request(IMAGE);
        expect(result.intercepted && result.response).toBe(answer);
        expect(worker.entries()).toEqual([]);
    });

    it('an image type is matched without case (IMAGE/PNG is stored)', async () => {
        worker.fetchMock.mockResolvedValueOnce(image(200, 'IMAGE/PNG'));
        await worker.request(IMAGE);
        expect(worker.entries()).toEqual([IMAGE]);
    });

    it('the CORS refetch failing falls back to the page own request, not stored', async () => {
        const fallback = opaque();
        worker.fetchMock
            .mockRejectedValueOnce(new TypeError('CORS failure'))
            .mockResolvedValueOnce(fallback);
        const result = await worker.request(IMAGE);
        expect(result.intercepted && result.response).toBe(fallback);
        expect(worker.fetchMock).toHaveBeenCalledTimes(2);
        expect(worker.fetchMock.mock.calls[1]?.[0]).toBe(result.intercepted && result.request);
        expect(worker.entries()).toEqual([]);
        expect(worker.calls.putsStarted).toBe(0);
    });

    it('a 200 image from the fallback is not stored either', async () => {
        worker.fetchMock.mockRejectedValueOnce(new TypeError('CORS failure'));
        worker.fetchMock.mockResolvedValueOnce(image());
        const result = await worker.request(IMAGE);
        expect(result.intercepted && result.response?.status).toBe(200);
        expect(worker.entries()).toEqual([]);
    });

    it('both the refetch and the fallback failing: the request rejects (a normal network error)', async () => {
        const failure = new TypeError('Failed to fetch');
        worker.fetchMock
            .mockRejectedValueOnce(new TypeError('CORS failure'))
            .mockRejectedValueOnce(failure);
        const result = await worker.request(IMAGE);
        expect(result.intercepted).toBe(true);
        expect(result.intercepted && result.error).toBe(failure);
        expect(result.intercepted && result.response).toBeUndefined();
        expect(worker.entries()).toEqual([]);
    });

    it('a cached image wins before any network, even while the network is down', async () => {
        await worker.request(IMAGE);
        worker.fetchMock.mockClear();
        worker.fetchMock.mockRejectedValue(new TypeError('offline'));
        const result = await worker.request(IMAGE);
        expect(result.intercepted && result.response?.status).toBe(200);
        expect(worker.fetchMock).not.toHaveBeenCalled();
    });

    it('cache.put rejecting (quota) still returns the image, silently', async () => {
        worker.calls.putFails = true;
        const answer = image();
        worker.fetchMock.mockResolvedValueOnce(answer);
        const result = await worker.request(IMAGE);
        expect(result.intercepted && result.response).toBe(answer);
        expect(result.intercepted && result.error).toBeUndefined();
        expect(worker.entries()).toEqual([]);
        expect(worker.calls.keys).toBe(0);
    });

    it('a waitUntil that throws InvalidStateError never breaks the image', async () => {
        const answer = image();
        worker.fetchMock.mockResolvedValueOnce(answer);
        const result = await worker.request(IMAGE, { waitUntilThrows: true });
        expect(result.intercepted && result.response).toBe(answer);
        expect(result.intercepted && result.error).toBeUndefined();
    });

    it('caches.open throwing (private browsing) still returns the image from the network', async () => {
        worker.calls.openFails = true;
        const answer = image();
        worker.fetchMock.mockResolvedValueOnce(answer);
        const result = await worker.request(IMAGE);
        expect(result.intercepted && result.response).toBe(answer);
        expect(worker.calls.putsStarted).toBe(0);
    });

    it('the cache is named hsr-assets-v1', async () => {
        await worker.request(IMAGE);
        expect([...worker.stores.keys()]).toEqual([CURRENT]);
        expect(worker.constants.CACHE_NAME).toBe(CURRENT);
    });

    it('nothing is logged on the normal path', async () => {
        await worker.lifecycle('install');
        await worker.lifecycle('activate');
        await worker.request(IMAGE);
        await worker.request(IMAGE);
        await worker.request(`${ORIGIN}/status.json`);
        expect(worker.log.log).not.toHaveBeenCalled();
        expect(worker.log.info).not.toHaveBeenCalled();
        expect(worker.log.warn).not.toHaveBeenCalled();
    });
});

describe.runIf(IS_CACHING)('T-M10 sw.js: the 400-entry cap', () => {
    const url = (i: number) => `https://${HOST}/f/key-${i}`;

    it('the cap is 400', () => {
        expect(worker.constants.MAX_ENTRIES).toBe(400);
    });

    it('401 stores leave 400 entries; the first stored is gone', async () => {
        for (let i = 0; i < 401; i++) await worker.request(url(i));
        const kept = worker.entries();
        expect(kept).toHaveLength(400);
        expect(kept).not.toContain(url(0));
        expect(kept[0]).toBe(url(1));
        expect(kept[399]).toBe(url(400));
        expect(worker.calls.deleted).toEqual([url(0)]);
    });

    it('keys() is read once per store, never on a hit', async () => {
        await worker.request(url(1));
        await worker.request(url(2));
        expect(worker.calls.keys).toBe(2);
        for (let i = 0; i < 5; i++) await worker.request(url(1));
        expect(worker.calls.keys).toBe(2);
    });

    it('a store during a trim is counted by one more pass; trims never overlap', async () => {
        const cache = worker.cacheFor(CURRENT);
        for (let i = 0; i < 400; i++) await cache.put(url(i), image());
        worker.calls.putKeys = [];
        // The second image lands after the first trim took its list of keys.
        let releaseSecond = () => {};
        const secondArrives = new Promise<FakeResponse>((done) => {
            releaseSecond = () => done(image());
        });
        worker.fetchMock.mockImplementationOnce(async () => image());
        worker.fetchMock.mockImplementationOnce(() => secondArrives);
        const a = worker.request(url(1000));
        const b = worker.request(url(1001));
        worker.calls.onKeys = releaseSecond;
        worker.calls.slowKeys = true;
        await Promise.all([a, b]);
        expect(worker.calls.putsDuringKeys).toBe(1);
        expect(worker.calls.maxKeysInFlight).toBe(1);
        expect(worker.calls.keys).toBe(2);
        const kept = worker.entries();
        expect(kept).toHaveLength(400);
        expect(kept).toContain(url(1000));
        expect(kept).toContain(url(1001));
        expect(kept).not.toContain(url(0));
        expect(kept).not.toContain(url(1));
        expect(kept).toContain(url(2));
        expect(worker.calls.deleted).toEqual([url(0), url(1)]);
    });
});

describe.runIf(IS_CACHING)('T-M10 sw.js: install and activate', () => {
    it('install calls skipWaiting', async () => {
        await worker.lifecycle('install');
        expect(worker.self.skipWaiting).toHaveBeenCalledTimes(1);
    });

    it('activate deletes the old-named caches, keeps the current and foreign ones, then claims', async () => {
        for (const name of [
            'hsr-assets-v0',
            'hsr-assets-abc12345',
            'hsrpvp-assets-v2',
            CURRENT,
            'workbox-precache-v2',
            'my-hsr-assets-v0',
            'other',
        ]) {
            worker.cacheFor(name);
        }
        await worker.lifecycle('activate');
        expect([...worker.stores.keys()].sort()).toEqual(
            [CURRENT, 'my-hsr-assets-v0', 'other', 'workbox-precache-v2'].sort(),
        );
        expect(worker.self.clients.claim).toHaveBeenCalledTimes(1);
        expect(worker.self.registration.unregister).not.toHaveBeenCalled();
    });

    it('caches.keys() rejecting in activate still claims the pages', async () => {
        worker.calls.cachesKeysFails = true;
        await worker.lifecycle('activate');
        expect(worker.self.clients.claim).toHaveBeenCalledTimes(1);
    });
});

describe('T-M10 sw-kill.js stays out of web/public', () => {
    it('is not under web/public (never served by accident)', () => {
        expect(existsSync(join(WEB, 'public', 'sw-kill.js'))).toBe(false);
    });
});

/** The kill worker's file, and web/public/sw.js too while it is the kill worker. */
const KILL_SOURCES: [string, string][] = [
    ['web/sw-kill.js', KILL_SOURCE],
    ...(SHAPE === 'kill' ? ([['web/public/sw.js', SOURCE]] as [string, string][]) : []),
];

describe.each(KILL_SOURCES)('T-M10 %s: the kill worker', (_file, source) => {
    let kill: ReturnType<typeof loadWorker>;
    beforeEach(() => {
        kill = loadWorker(source);
    });

    it('activate deletes the caches before it unregisters, all inside waitUntil', async () => {
        kill.cacheFor(CURRENT);
        kill.cacheFor('hsrpvp-assets-v2');
        let release = () => {};
        kill.calls.deleteGate = new Promise((done) => {
            release = done;
        });
        const waits: Promise<unknown>[] = [];
        kill.listeners.get('activate')?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
        expect(waits).toHaveLength(1);
        let settled = false;
        void waits[0]?.then(() => {
            settled = true;
        });
        for (let i = 0; i < 10; i++) await Promise.resolve();
        // The deletes are held: the waitUntil promise is still open and nothing is unregistered.
        expect(settled).toBe(false);
        expect(kill.self.registration.unregister).not.toHaveBeenCalled();
        release();
        await waits[0];
        expect(kill.calls.ops).toEqual([
            `delete ${CURRENT}`,
            'delete hsrpvp-assets-v2',
            'unregister',
        ]);
    });

    it('has no fetch listener: it answers no request', async () => {
        expect(kill.listeners.has('fetch')).toBe(false);
        expect([...kill.listeners.keys()].sort()).toEqual(['activate', 'install']);
    });

    it('install calls skipWaiting', async () => {
        await kill.lifecycle('install');
        expect(kill.self.skipWaiting).toHaveBeenCalledTimes(1);
    });

    it('activate deletes both cache families, leaves other caches, unregisters, claims nothing', async () => {
        for (const name of [
            CURRENT,
            'hsr-assets-v0',
            'hsrpvp-assets-v2',
            'other',
            'my-hsr-assets-v1',
        ]) {
            kill.cacheFor(name);
        }
        await kill.lifecycle('activate');
        expect([...kill.stores.keys()].sort()).toEqual(['my-hsr-assets-v1', 'other']);
        expect(kill.self.registration.unregister).toHaveBeenCalledTimes(1);
        expect(kill.self.clients.claim).not.toHaveBeenCalled();
    });

    it('caches.keys() rejecting in activate still unregisters', async () => {
        kill.calls.cachesKeysFails = true;
        await kill.lifecycle('activate');
        expect(kill.self.registration.unregister).toHaveBeenCalledTimes(1);
    });
});
