import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MockConnection } from '@/test/mockConnection';
import { signInConnection } from '@/test/mockSignIn';
import { StdbConnectionContext } from './connectionContext';
import { resetConnectionStatus, setConnectionStatus } from './connectionStatus';
import type { StdbConnectionLike } from './types';
import { NotConnectedError, useReducerCall } from './useReducerCall';

/* T-M5b: useReducerCall rejects at once without an open connection; no queue (A173). */

afterEach(() => resetConnectionStatus());

function render(conn: StdbConnectionLike | null) {
    const wrapper = ({ children }: { children: ReactNode }) => (
        <StdbConnectionContext.Provider value={conn}>{children}</StdbConnectionContext.Provider>
    );
    return renderHook(
        () => useReducerCall((r, args: { confirmToken: string }) => r.confirmLink(args)),
        { wrapper },
    );
}

describe('useReducerCall', () => {
    it('no connection: rejects with NotConnectedError', async () => {
        setConnectionStatus({ state: 'connected' });
        const { result } = render(null);
        await expect(result.current({ confirmToken: 't' })).rejects.toBeInstanceOf(
            NotConnectedError,
        );
    });

    it('a connection without reducers: rejects with NotConnectedError', async () => {
        setConnectionStatus({ state: 'connected' });
        const { result } = render(new MockConnection());
        await expect(result.current({ confirmToken: 't' })).rejects.toBeInstanceOf(
            NotConnectedError,
        );
    });

    it.each([
        ['connecting', { state: 'connecting' as const }],
        ['reconnecting', { state: 'reconnecting' as const, reason: 'x' }],
    ])(
        'a connection that is %s: rejects at once and never calls the reducer later',
        async (_l, status) => {
            setConnectionStatus(status);
            const conn = signInConnection();
            const { result } = render(conn);
            await expect(result.current({ confirmToken: 't' })).rejects.toBeInstanceOf(
                NotConnectedError,
            );
            act(() => setConnectionStatus({ state: 'connected' }));
            await act(async () => {});
            expect(conn.reducers.confirmLink).not.toHaveBeenCalled();
        },
    );

    it('connected: calls the reducer with the arguments and returns its promise', async () => {
        setConnectionStatus({ state: 'connected' });
        const conn = signInConnection();
        const { result } = render(conn);
        await expect(result.current({ confirmToken: 'tok' })).resolves.toBeUndefined();
        expect(conn.reducers.confirmLink).toHaveBeenCalledWith({ confirmToken: 'tok' });
    });

    it('a module refusal rejects with its text', async () => {
        setConnectionStatus({ state: 'connected' });
        const conn = signInConnection();
        conn.reducers.confirmLink.mockRejectedValueOnce(
            new Error('This sign-in could not be confirmed.'),
        );
        const { result } = render(conn);
        await expect(result.current({ confirmToken: 'tok' })).rejects.toThrow(
            'This sign-in could not be confirmed.',
        );
    });

    it('the returned function is stable while the connection is the same', () => {
        setConnectionStatus({ state: 'connected' });
        const { result, rerender } = render(signInConnection());
        const first = result.current;
        rerender();
        expect(result.current).toBe(first);
    });
});
