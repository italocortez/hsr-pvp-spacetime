import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    fetchMaintenance,
    MAINTENANCE_SKIP_KEY,
    maintenanceSkipped,
    parseMaintenance,
    STATUS_FILE_PATH,
} from './statusFile';

/*
 * The maintenance status file reader (T-M7): only an object with `maintenance: true` means
 * maintenance; every failure fails open. `fetch` is a stub; nothing touches the network.
 */

describe('parseMaintenance', () => {
    it.each([
        ['{ maintenance: true }', { maintenance: true }, true],
        ['{ maintenance: false }', { maintenance: false }, false],
        ['{} (field missing)', {}, false],
        ['{ maintenance: "true" }', { maintenance: 'true' }, false],
        ['{ maintenance: 1 }', { maintenance: 1 }, false],
        ['null', null, false],
        ['[true]', [true], false],
        ['an array with the field', Object.assign([], { maintenance: true }), false],
        ['true alone', true, false],
        ['"maintenance"', 'maintenance', false],
        ['extra fields with true', { maintenance: true, message: 'Back at 18:00', eta: 3 }, true],
        ['extra fields with false', { maintenance: false, message: 'ignored' }, false],
    ])('%s', (_label, body, expected) => {
        expect(parseMaintenance(body)).toBe(expected);
    });
});

/** A fetch stub answering with `status` and a body that `json()` parses (or fails to). */
function answer(status: number, json: () => Promise<unknown>) {
    return vi.fn(async (_input: string, _init: RequestInit) => ({ status, json }));
}

describe('fetchMaintenance', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('200 with maintenance true: true; reads /status.json uncached', async () => {
        const fetchImpl = answer(200, async () => ({ maintenance: true }));
        await expect(fetchMaintenance(fetchImpl)).resolves.toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0]?.[0]).toBe(STATUS_FILE_PATH);
        expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' });
    });

    it('200 with maintenance false: false', async () => {
        await expect(
            fetchMaintenance(answer(200, async () => ({ maintenance: false }))),
        ).resolves.toBe(false);
    });

    it('404 (even with a maintenance body): false', async () => {
        await expect(
            fetchMaintenance(answer(404, async () => ({ maintenance: true }))),
        ).resolves.toBe(false);
    });

    it('a body that is not JSON: false', async () => {
        await expect(
            fetchMaintenance(
                answer(200, async () => {
                    throw new SyntaxError('Unexpected token < in JSON');
                }),
            ),
        ).resolves.toBe(false);
    });

    it('a rejected fetch: false', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        });
        await expect(fetchMaintenance(fetchImpl)).resolves.toBe(false);
    });

    it('no answer within the timeout: false, and the request is aborted', async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        const fetchImpl = vi.fn((_input: string, init: RequestInit) => {
            signal = init.signal ?? undefined;
            return new Promise<never>(() => {});
        });
        const result = fetchMaintenance(fetchImpl, 3000);
        await vi.advanceTimersByTimeAsync(2999);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toBe(false);
        expect(signal?.aborted).toBe(true);
    });
});

describe('fetchMaintenance with a caller signal', () => {
    it('an abort from the caller aborts the request and resolves false', async () => {
        let seen: AbortSignal | undefined;
        const fetchImpl = vi.fn(
            (_input: string, init: RequestInit) =>
                new Promise<never>((_resolve, reject) => {
                    seen = init.signal ?? undefined;
                    seen?.addEventListener('abort', () =>
                        reject(new DOMException('', 'AbortError')),
                    );
                }),
        );
        const caller = new AbortController();
        const result = fetchMaintenance(fetchImpl, 3000, caller.signal);
        caller.abort();
        await expect(result).resolves.toBe(false);
        expect(seen?.aborted).toBe(true);
    });

    it('an already aborted signal: false without waiting', async () => {
        const caller = new AbortController();
        caller.abort();
        const fetchImpl = vi.fn(async (_input: string, init: RequestInit) => {
            if (init.signal?.aborted) throw new DOMException('', 'AbortError');
            return { status: 200, json: async () => ({ maintenance: true }) };
        });
        await expect(fetchMaintenance(fetchImpl, 3000, caller.signal)).resolves.toBe(false);
    });
});

describe('maintenanceSkipped', () => {
    afterEach(() => {
        sessionStorage.clear();
    });

    it('no parameter and no flag: false', () => {
        expect(maintenanceSkipped('')).toBe(false);
        expect(maintenanceSkipped('?maintenance=on')).toBe(false);
    });

    it('?maintenance=skip: true, and the tab keeps the flag without the parameter', () => {
        expect(maintenanceSkipped('?tab=x&maintenance=skip')).toBe(true);
        expect(sessionStorage.getItem(MAINTENANCE_SKIP_KEY)).toBe('1');
        expect(maintenanceSkipped('')).toBe(true);
    });

    it('a blocked storage: the parameter still counts, nothing throws', () => {
        const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError');
        });
        const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError');
        });
        try {
            expect(maintenanceSkipped('?maintenance=skip')).toBe(true);
            expect(maintenanceSkipped('')).toBe(false);
        } finally {
            set.mockRestore();
            get.mockRestore();
        }
    });
});
