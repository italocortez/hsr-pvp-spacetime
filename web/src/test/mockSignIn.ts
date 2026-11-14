import type { MyLinkRequestRow } from '@bindings/types';
import { Timestamp } from 'spacetimedb';
import { vi } from 'vitest';
import type { CookieJar, StorageLike } from '@/auth/signIn';
import type { ReducersLike } from '@/stdb/types';
import { MockConnection, MockTable } from './mockConnection';

/*
 * T-M5b test doubles: the mock connection of the earlier steps plus the sign-in surface
 * (`reducers` and the keyless `view_my_link_request`), a cookie jar, and a session storage.
 */

export type MockReducers = {
    [K in keyof ReducersLike]: ReturnType<typeof vi.fn<ReducersLike[K]>>;
};

export type SignInMock = MockConnection & {
    reducers: MockReducers;
    db: MockConnection['db'] & { viewMyLinkRequest: MockTable<MyLinkRequestRow> };
};

/** A MockConnection with reducers that resolve (override per test) and the link view. */
export function signInConnection(): SignInMock {
    const conn = new MockConnection() as SignInMock;
    Object.assign(conn.db, { viewMyLinkRequest: new MockTable<MyLinkRequestRow>() });
    conn.reducers = {
        loginAsGuest: vi.fn<ReducersLike['loginAsGuest']>(async () => {}),
        requestLinkCode: vi.fn<ReducersLike['requestLinkCode']>(async () => {}),
        confirmLink: vi.fn<ReducersLike['confirmLink']>(async () => {}),
    };
    return conn;
}

/** A `view_my_link_request` row expiring `inMs` from `nowMs`. */
export function linkRow(
    overrides: Partial<Omit<MyLinkRequestRow, 'expiresAt'>> & {
        inMs?: number;
        nowMs?: number;
    } = {},
): MyLinkRequestRow {
    const { inMs = 60_000, nowMs = Date.now(), ...rest } = overrides;
    return {
        code: undefined,
        awaitingConfirm: false,
        pendingProviderName: undefined,
        ...rest,
        expiresAt: new Timestamp(BigInt(nowMs + inMs) * 1000n),
    };
}

/** A cookie jar in memory that records reads and removals in order. */
export function memoryJar(initial: Record<string, string> = {}) {
    const cookies = new Map(Object.entries(initial));
    const events: string[] = [];
    const jar: CookieJar = {
        read(name) {
            events.push(`read ${name}`);
            return cookies.get(name);
        },
        remove(name) {
            events.push(`remove ${name}`);
            cookies.delete(name);
        },
    };
    return { jar, cookies, events };
}

/** A Storage in memory; `blocked` makes every access throw (a private window with storage off). */
export function memoryStorage(blocked = false): StorageLike & { map: Map<string, string> } {
    const map = new Map<string, string>();
    const guard = () => {
        if (blocked) throw new DOMException('blocked', 'SecurityError');
    };
    return {
        map,
        getItem: (k) => {
            guard();
            return map.get(k) ?? null;
        },
        setItem: (k, v) => {
            guard();
            map.set(k, v);
        },
        removeItem: (k) => {
            guard();
            map.delete(k);
        },
    };
}
