import { act, renderHook } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MockConnection } from '@/test/mockConnection';
import { StdbConnectionContext } from './connectionContext';
import { useRouteSubscriptions } from './useRouteSubscriptions';

/*
 * The route-subscription hook (M6 brief item 5, upgrade report R5): one subscription per query,
 * every handle unsubscribed on unmount and on a list change, safe under StrictMode.
 */

const A = 'SELECT * FROM "view_my_lobby"';
const B = 'SELECT * FROM "view_my_lobby_members"';
const C = 'SELECT * FROM view_tournament_teams(42)';

let conn: MockConnection;
beforeEach(() => {
    conn = new MockConnection();
});

function wrapper({ children }: { children: ReactNode }) {
    return <StdbConnectionContext.Provider value={conn}>{children}</StdbConnectionContext.Provider>;
}
function strictWrapper({ children }: { children: ReactNode }) {
    return (
        <StrictMode>
            <StdbConnectionContext.Provider value={conn}>{children}</StdbConnectionContext.Provider>
        </StrictMode>
    );
}

describe('useRouteSubscriptions', () => {
    it('subscribes each query once on mount and is ready when every one has applied', () => {
        const { result } = renderHook(() => useRouteSubscriptions([A, B]), { wrapper });
        expect(conn.liveQueries()).toEqual([A, B]);
        expect(result.current.ready).toBe(false);

        act(() => conn.apply(A));
        expect(result.current.ready).toBe(false);
        act(() => conn.apply(B));
        expect(result.current).toEqual({ ready: true, error: undefined });
    });

    it('unsubscribes every handle on unmount', () => {
        const { unmount } = renderHook(() => useRouteSubscriptions([A, B]), { wrapper });
        unmount();
        expect(conn.live()).toHaveLength(0);
        expect(conn.subscriptions).toHaveLength(2);
    });

    it('a changed list unsubscribes the old set and subscribes the new one', () => {
        const { rerender, result } = renderHook(({ q }) => useRouteSubscriptions(q), {
            wrapper,
            initialProps: { q: [A, B] },
        });
        act(() => conn.applyAll());
        expect(result.current.ready).toBe(true);

        rerender({ q: [A, C] });
        expect(conn.liveQueries()).toEqual([A, C]);
        expect(conn.subscriptions.filter((s) => s.unsubscribed).map((s) => s.query)).toEqual([
            A,
            B,
        ]);
        expect(result.current.ready).toBe(false);
    });

    it('a new array with the same queries does not resubscribe', () => {
        const { rerender } = renderHook(({ q }) => useRouteSubscriptions(q), {
            wrapper,
            initialProps: { q: [A, B] },
        });
        rerender({ q: [A, B] });
        expect(conn.subscriptions).toHaveLength(2);
    });

    it('drops a duplicate query: one subscription per query', () => {
        renderHook(() => useRouteSubscriptions([A, A, B]), { wrapper });
        expect(conn.liveQueries()).toEqual([A, B]);
    });

    it('StrictMode double mount: the first handles are unsubscribed, one live set remains, none after unmount', () => {
        const { unmount } = renderHook(() => useRouteSubscriptions([A, B]), {
            wrapper: strictWrapper,
        });
        expect(conn.liveQueries()).toEqual([A, B]);
        // StrictMode mounted, unmounted and mounted again: two sets created, the first one closed.
        expect(conn.subscriptions).toHaveLength(4);
        expect(conn.subscriptions.slice(0, 2).every((s) => s.unsubscribed)).toBe(true);
        unmount();
        expect(conn.live()).toHaveLength(0);
    });

    it('a late result of an unsubscribed handle does not change the state', () => {
        const { rerender, result } = renderHook(({ q }) => useRouteSubscriptions(q), {
            wrapper,
            initialProps: { q: [A] },
        });
        const old = conn.subscriptions[0];
        rerender({ q: [C] });
        act(() => old?.apply());
        expect(result.current.ready).toBe(false);
    });

    it('reports the first subscription error', () => {
        const { result } = renderHook(() => useRouteSubscriptions([A]), { wrapper });
        act(() => conn.subscriptions[0]?.fail('no such table'));
        expect(result.current.error).toBe(`${A}: no such table`);
    });

    it('a query with a newline in it is kept whole (the list key is JSON, not a joined string)', () => {
        const multiline = 'SELECT * FROM "view_my_lobby"\nWHERE id = 1';
        renderHook(() => useRouteSubscriptions([multiline, B]), { wrapper });
        expect(conn.liveQueries()).toEqual([multiline, B]);
    });

    it('a new list clears the previous error', () => {
        const { rerender, result } = renderHook(({ q }) => useRouteSubscriptions(q), {
            wrapper,
            initialProps: { q: [A] },
        });
        act(() => conn.subscriptions[0]?.fail('no such table'));
        expect(result.current.error).toBeDefined();
        rerender({ q: [B] });
        expect(result.current).toEqual({ ready: false, error: undefined });
        act(() => conn.apply(B));
        expect(result.current).toEqual({ ready: true, error: undefined });
    });

    it('applied twice (a replay) stays ready; an error on a replay makes it not ready', () => {
        const { result } = renderHook(() => useRouteSubscriptions([A, B]), { wrapper });
        act(() => conn.applyAll());
        act(() => conn.applyAll());
        expect(result.current.ready).toBe(true);
        act(() => conn.subscriptions[1]?.fail('replay refused'));
        expect(result.current).toEqual({ ready: false, error: `${B}: replay refused` });
    });

    it('with a delayed unsubscribe end: one unsubscribe per handle, and a late result is ignored', () => {
        conn.delayEnd = true;
        const { rerender, result } = renderHook(({ q }) => useRouteSubscriptions(q), {
            wrapper,
            initialProps: { q: [A] },
        });
        rerender({ q: [B] });
        const old = conn.subscriptions[0];
        expect(old?.unsubscribed).toBe(true);
        expect(old?.ended).toBe(false);
        act(() => old?.apply());
        expect(result.current.ready).toBe(false);
        old?.end();
    });

    it('without a connection it subscribes nothing and stays not ready', () => {
        const { result } = renderHook(() => useRouteSubscriptions([A]));
        expect(result.current.ready).toBe(false);
        expect(conn.subscriptions).toHaveLength(0);
    });
});
