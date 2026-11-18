import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SenderError } from 'spacetimedb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StdbConnectionContext } from '@/stdb/connectionContext';
import { resetConnectionStatus, setConnectionStatus } from '@/stdb/connectionStatus';
import { type SignInMock, signInConnection } from '@/test/mockSignIn';
import { type AuthSnapshot, setAuthSnapshot } from './authStore';
import { useEnsureSignedIn, waitForAuth } from './useEnsureSignedIn';

/*
 * T-S14.4b: guest on demand. A visitor becomes a guest (login_as_guest, then the profile view shows the guest); a
 * guest or a member passes through with no call; refusals, no connection and a silent profile come back as results.
 */

const VISITOR: AuthSnapshot = { ready: true };
const GUEST: AuthSnapshot = {
    ready: true,
    user: { id: 7, role: { tag: 'User' }, isGuest: true, displayName: 'Guest_0a1b2c3d' },
};
const MEMBER: AuthSnapshot = {
    ready: true,
    user: { id: 8, role: { tag: 'User' }, isGuest: false, displayName: 'kafka' },
};

let conn: SignInMock;

beforeEach(() => {
    conn = signInConnection();
    setConnectionStatus({ state: 'connected' });
});
afterEach(() => {
    vi.useRealTimers();
    resetConnectionStatus();
    setAuthSnapshot({ ready: true });
});

function setup(waitMs?: number) {
    const wrapper = ({ children }: { children?: ReactNode }) => (
        <StdbConnectionContext.Provider value={conn}>{children}</StdbConnectionContext.Provider>
    );
    return renderHook(() => useEnsureSignedIn(waitMs), { wrapper }).result;
}

describe('useEnsureSignedIn', () => {
    it('a visitor: login_as_guest once, then ready when the profile view shows the guest', async () => {
        setAuthSnapshot(VISITOR);
        conn.reducers.loginAsGuest.mockImplementation(async () => {
            setAuthSnapshot(GUEST);
        });
        const result = setup();
        let out: unknown;
        await act(async () => {
            out = await result.current();
        });
        expect(conn.reducers.loginAsGuest).toHaveBeenCalledExactlyOnceWith({});
        expect(out).toEqual({ kind: 'ready', created: true, isGuest: true });
    });

    it('the profile may arrive after the call resolves', async () => {
        setAuthSnapshot(VISITOR);
        const result = setup();
        let promise: Promise<unknown> = Promise.resolve();
        act(() => {
            promise = result.current();
        });
        await act(async () => {
            await Promise.resolve();
            setAuthSnapshot(GUEST);
        });
        await expect(promise).resolves.toEqual({ kind: 'ready', created: true, isGuest: true });
    });

    it.each([
        ['a guest', GUEST, true],
        ['a member', MEMBER, false],
    ])('%s passes through with no call', async (_label, auth, isGuest) => {
        setAuthSnapshot(auth);
        const result = setup();
        await expect(result.current()).resolves.toEqual({ kind: 'ready', created: false, isGuest });
        expect(conn.reducers.loginAsGuest).not.toHaveBeenCalled();
    });

    it('not ready yet: it waits for the profile view first', async () => {
        setAuthSnapshot({ ready: false });
        const result = setup();
        const promise = result.current();
        act(() => setAuthSnapshot(MEMBER));
        await expect(promise).resolves.toEqual({ kind: 'ready', created: false, isGuest: false });
        expect(conn.reducers.loginAsGuest).not.toHaveBeenCalled();
    });

    it('a refusal comes back with the module’s sentence', async () => {
        setAuthSnapshot(VISITOR);
        conn.reducers.loginAsGuest.mockRejectedValueOnce(
            new SenderError('New guest accounts are temporarily disabled.'),
        );
        const result = setup();
        await expect(result.current()).resolves.toEqual({
            kind: 'refused',
            text: 'New guest accounts are temporarily disabled.',
        });
    });

    it('no open connection: failed, nothing sent', async () => {
        setAuthSnapshot(VISITOR);
        setConnectionStatus({ state: 'reconnecting', reason: 'x' });
        const result = setup();
        await expect(result.current()).resolves.toEqual({
            kind: 'failed',
            reason: 'notConnected',
        });
        expect(conn.reducers.loginAsGuest).not.toHaveBeenCalled();
    });

    it('another rejection: the result is unknown', async () => {
        setAuthSnapshot(VISITOR);
        const dropped = new Error('dropped');
        dropped.name = 'UnknownCallResultError';
        conn.reducers.loginAsGuest.mockRejectedValueOnce(dropped);
        const result = setup();
        await expect(result.current()).resolves.toEqual({ kind: 'failed', reason: 'unknown' });
    });

    it('the profile view stays silent: timeout', async () => {
        setAuthSnapshot(VISITOR);
        const result = setup(50);
        await expect(result.current()).resolves.toEqual({ kind: 'failed', reason: 'timeout' });
    });

    it('two calls at once share one login_as_guest', async () => {
        setAuthSnapshot(VISITOR);
        conn.reducers.loginAsGuest.mockImplementation(async () => {
            setAuthSnapshot(GUEST);
        });
        const result = setup();
        let both: unknown[] = [];
        await act(async () => {
            both = await Promise.all([result.current(), result.current()]);
        });
        expect(conn.reducers.loginAsGuest).toHaveBeenCalledTimes(1);
        expect(both[0]).toBe(both[1]);
    });
});

describe('waitForAuth', () => {
    it('the current snapshot when it passes, else the first that does, else null after the wait', async () => {
        setAuthSnapshot(MEMBER);
        await expect(waitForAuth((a) => a.ready, 10)).resolves.toBe(MEMBER);
        setAuthSnapshot({ ready: false });
        const later = waitForAuth((a) => a.user !== undefined, 1000);
        setAuthSnapshot(GUEST);
        await expect(later).resolves.toBe(GUEST);
        await expect(waitForAuth((a) => a.user?.isGuest === false, 20)).resolves.toBeNull();
    });
});
