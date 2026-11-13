import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authStore, setAuthSnapshot } from '@/auth/authStore';
import { MockConnection, profileRow } from '@/test/mockConnection';
import { connectionStatusStore, resetConnectionStatus } from './connectionStatus';
import { LAYER0_QUERIES, profileToAuth, startLayer0, useMyLobbies } from './layer0';

/*
 * Layer 0 (docs/frontend/subscriptions.md Decision 6) and the auth mapping from view_my_profile
 * (M6 brief item 4), driven by the mock connection.
 */

let conn: MockConnection;
let stop: (() => void) | undefined;

beforeEach(() => {
    conn = new MockConnection();
    setAuthSnapshot({ ready: false });
});
afterEach(() => {
    stop?.();
    stop = undefined;
    setAuthSnapshot({ ready: true });
    resetConnectionStatus();
});

const auth = () => authStore.getSnapshot();

describe('profileToAuth', () => {
    it('no row is a ready visitor', () => {
        expect(profileToAuth([])).toEqual({ ready: true });
    });

    it('a row is a ready user with the numeric id, role and guest flag of the row', () => {
        const row = profileRow({ id: 42, role: { tag: 'Moderator' }, isGuest: true });
        expect(profileToAuth([row])).toEqual({
            ready: true,
            user: { id: 42, role: { tag: 'Moderator' }, isGuest: true },
        });
        expect(typeof profileToAuth([row]).user?.id).toBe('number');
    });
});

describe('startLayer0', () => {
    it('subscribes view_my_profile and view_my_lobbies, one subscription each, nothing else', () => {
        stop = startLayer0(conn);
        expect(conn.liveQueries()).toEqual([LAYER0_QUERIES.profile, LAYER0_QUERIES.lobbies]);
        expect(LAYER0_QUERIES.profile).toBe('SELECT * FROM "view_my_profile"');
        expect(LAYER0_QUERIES.lobbies).toBe('SELECT * FROM "view_my_lobbies"');
    });

    it('stays not ready before the first result, even if a row event arrives early', () => {
        stop = startLayer0(conn);
        conn.db.viewMyProfile.insert(profileRow());
        expect(auth()).toEqual({ ready: false });
    });

    it('applied with no row: a ready visitor', () => {
        stop = startLayer0(conn);
        conn.apply(LAYER0_QUERIES.profile);
        expect(auth()).toEqual({ ready: true });
    });

    it('applied with a row: a ready user', () => {
        stop = startLayer0(conn);
        conn.db.viewMyProfile.seed(profileRow({ id: 9, role: { tag: 'Admin' } }));
        conn.apply(LAYER0_QUERIES.profile);
        expect(auth()).toEqual({
            ready: true,
            user: { id: 9, role: { tag: 'Admin' }, isGuest: false },
        });
    });

    it('follows the row afterwards: sign-in insert, role update, deletion', () => {
        stop = startLayer0(conn);
        conn.apply(LAYER0_QUERIES.profile);
        expect(auth().user).toBeUndefined();

        const guest = profileRow({ id: 3, isGuest: true });
        conn.db.viewMyProfile.insert(guest);
        expect(auth()).toEqual({
            ready: true,
            user: { id: 3, role: { tag: 'User' }, isGuest: true },
        });

        const promoted = { ...guest, isGuest: false, role: { tag: 'Moderator' as const } };
        conn.db.viewMyProfile.update(guest, promoted);
        expect(auth().user).toEqual({ id: 3, role: { tag: 'Moderator' }, isGuest: false });

        conn.db.viewMyProfile.delete(promoted);
        expect(auth()).toEqual({ ready: true });
    });

    it('keeps the same snapshot object when a row change does not touch id, role or guest flag', () => {
        stop = startLayer0(conn);
        const row = profileRow();
        conn.db.viewMyProfile.seed(row);
        conn.apply(LAYER0_QUERIES.profile);
        const before = auth();
        conn.db.viewMyProfile.update(row, { ...row, displayName: 'Renamed' });
        expect(auth()).toBe(before);
    });

    it('a second applied (a replay after a reconnect) keeps the mapping and subscribes nothing new', () => {
        stop = startLayer0(conn);
        const row = profileRow({ id: 4 });
        conn.db.viewMyProfile.seed(row);
        conn.apply(LAYER0_QUERIES.profile);
        const before = auth();
        conn.apply(LAYER0_QUERIES.profile);
        expect(auth()).toBe(before);
        // The replay brings a changed row: the store follows.
        conn.db.viewMyProfile.rows = [{ ...row, role: { tag: 'Admin' } }];
        conn.apply(LAYER0_QUERIES.profile);
        expect(auth().user?.role).toEqual({ tag: 'Admin' });
        expect(conn.subscriptions).toHaveLength(2);
    });

    it.each([
        ['view_my_profile', LAYER0_QUERIES.profile],
        ['view_my_lobbies', LAYER0_QUERIES.lobbies],
    ])(
        'a %s subscription error is a connection failure: failed, auth not ready, connection closed',
        async (_view, query) => {
            stop = startLayer0(conn);
            conn.db.viewMyProfile.seed(profileRow());
            conn.apply(LAYER0_QUERIES.profile);
            expect(auth().user).toBeDefined();

            conn.live()
                .find((s) => s.query === query)
                ?.fail('no such view');
            expect(connectionStatusStore.getSnapshot().status).toEqual({
                state: 'failed',
                kind: 'offline',
                reason: 'no such view',
                recovery: 'retry',
            });
            expect(auth()).toEqual({ ready: false });
            // Closed after the SDK's callback returns, so the provider builds anew on Retry.
            expect(conn.disconnects).toBe(0);
            await Promise.resolve();
            expect(conn.disconnects).toBe(1);
        },
    );

    it('a failed replay of view_my_profile, then the delete of its row: auth stays not ready', () => {
        stop = startLayer0(conn);
        const row = profileRow();
        conn.db.viewMyProfile.seed(row);
        conn.applyAll();
        conn.live()[0]?.fail('view gone', () => conn.db.viewMyProfile.delete(row));
        expect(auth()).toEqual({ ready: false });
    });

    it('two Layer 0 errors in one frame: the first reason stays, one close', async () => {
        stop = startLayer0(conn);
        conn.live()[0]?.fail('first');
        conn.live()[0]?.fail('second');
        expect(connectionStatusStore.getSnapshot().status).toMatchObject({ reason: 'first' });
        await Promise.resolve();
        expect(conn.disconnects).toBe(1);
    });

    it('a cleanup between the error and its microtask: the connection is not closed', async () => {
        stop = startLayer0(conn);
        conn.live()[0]?.fail('boom');
        stop();
        stop = undefined;
        await Promise.resolve();
        expect(conn.disconnects).toBe(0);
    });

    it('an error that arrives after the cleanup is ignored', async () => {
        stop = startLayer0(conn);
        const handle = conn.subscriptions[0];
        stop();
        stop = undefined;
        handle?.fail('late');
        await Promise.resolve();
        expect(connectionStatusStore.getSnapshot().status).toEqual({ state: 'connecting' });
        expect(conn.disconnects).toBe(0);
    });

    it('with a delayed unsubscribe end, a late result after the cleanup does not touch auth', () => {
        conn.delayEnd = true;
        stop = startLayer0(conn);
        stop();
        stop = undefined;
        expect(conn.subscriptions.every((s) => s.unsubscribed && !s.ended)).toBe(true);
        setAuthSnapshot({ ready: false });
        conn.db.viewMyProfile.seed(profileRow());
        conn.subscriptions[0]?.apply();
        expect(auth()).toEqual({ ready: false });
    });

    it('the cleanup unsubscribes both handles and removes every row callback', () => {
        stop = startLayer0(conn);
        conn.apply(LAYER0_QUERIES.profile);
        stop();
        stop = undefined;
        expect(conn.live()).toHaveLength(0);
        expect(conn.db.viewMyProfile.listenerCount).toBe(0);
        expect(conn.db.viewMyLobbies.listenerCount).toBe(0);
        // A late row event no longer reaches the auth store.
        conn.db.viewMyProfile.insert(profileRow());
        expect(auth()).toEqual({ ready: true });
    });
});

describe('useMyLobbies', () => {
    const lobby = {
        id: 5,
        joinCode: 'ABCD',
        name: 'Scrim',
        stage: { tag: 'Waiting' },
        isAway: false,
    } as const;

    it('is empty until applied, then holds the view rows and follows changes; cleared on stop', () => {
        const { result } = renderHook(() => useMyLobbies());
        expect(result.current).toEqual([]);

        stop = startLayer0(conn);
        conn.db.viewMyLobbies.seed(lobby);
        act(() => conn.apply(LAYER0_QUERIES.lobbies));
        expect(result.current).toEqual([lobby]);

        const away = { ...lobby, isAway: true };
        act(() => conn.db.viewMyLobbies.update(lobby, away));
        expect(result.current).toEqual([away]);

        act(() => {
            stop?.();
            stop = undefined;
        });
        expect(result.current).toEqual([]);
    });
});
