import type { MyLinkRequestRow, MyProfileRow } from '@bindings/types';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { MockConnection, type MockTable, profileRow } from '@/test/mockConnection';
import { linkRow, signInConnection } from '@/test/mockSignIn';
import { StdbConnectionContext } from './connectionContext';
import type { StdbConnectionLike } from './types';
import { useRows } from './useRows';

/* T-M5b: useRows follows the client cache of one table or view (A173). */

function wrapperFor(conn: StdbConnectionLike | null) {
    return ({ children }: { children: ReactNode }) => (
        <StdbConnectionContext.Provider value={conn}>{children}</StdbConnectionContext.Provider>
    );
}

const flush = () => act(async () => {});

describe('useRows', () => {
    it('no connection: an empty list', () => {
        const { result } = renderHook(() => useRows((c) => c.db.viewMyProfile), {
            wrapper: wrapperFor(null),
        });
        expect(result.current).toEqual([]);
    });

    it('reads the rows already cached, then follows insert, update and delete', async () => {
        const conn = new MockConnection();
        const a = profileRow({ id: 1 });
        conn.db.viewMyProfile.seed(a);
        const { result } = renderHook(() => useRows((c) => c.db.viewMyProfile), {
            wrapper: wrapperFor(conn),
        });
        expect(result.current).toEqual([a]);
        const b = profileRow({ id: 2 });
        act(() => conn.db.viewMyProfile.insert(b));
        await flush();
        expect(result.current).toEqual([a, b]);
        const a2 = { ...a, displayName: 'Renamed' };
        act(() => conn.db.viewMyProfile.update(a, a2));
        await flush();
        expect(result.current).toEqual([a2, b]);
        act(() => conn.db.viewMyProfile.delete(b));
        await flush();
        expect(result.current).toEqual([a2]);
    });

    it('a keyless row replaced as insert + delete is never shown as two rows', async () => {
        const conn = signInConnection();
        const view = conn.db.viewMyLinkRequest;
        const before = linkRow({ code: 'A'.repeat(32) });
        view.seed(before);
        const seen: number[] = [];
        const inCallback: number[] = [];
        view.onInsert(() => inCallback.push([...view.iter()].length));
        const { result } = renderHook(
            () => {
                const rows = useRows((c) => c.db.viewMyLinkRequest);
                seen.push(rows.length);
                return rows;
            },
            { wrapper: wrapperFor(conn) },
        );
        const after = linkRow({ awaitingConfirm: true, pendingProviderName: 'kafka' });
        act(() => {
            // The SDK's order for a replaced view row: the new row arrives, then the old one goes.
            view.insert(after);
            view.delete(before);
        });
        await flush();
        expect(inCallback).toEqual([2]); // two rows really are visible inside the callback
        expect(seen.every((n) => n <= 1)).toBe(true);
        expect(result.current).toEqual([after]);
    });

    it('refreshKey re-reads rows that arrived without events (a first result)', () => {
        const conn = new MockConnection();
        const { result, rerender } = renderHook(
            ({ key }: { key: boolean }) => useRows((c) => c.db.viewMyProfile, key),
            { wrapper: wrapperFor(conn), initialProps: { key: false } },
        );
        expect(result.current).toEqual([]);
        const row: MyProfileRow = profileRow();
        conn.db.viewMyProfile.seed(row);
        rerender({ key: true });
        expect(result.current).toEqual([row]);
    });

    it('removes its callbacks on unmount', () => {
        const conn = new MockConnection();
        const { unmount } = renderHook(() => useRows((c) => c.db.viewMyProfile), {
            wrapper: wrapperFor(conn),
        });
        expect(conn.db.viewMyProfile.listenerCount).toBe(3);
        unmount();
        expect(conn.db.viewMyProfile.listenerCount).toBe(0);
    });

    it('a keyless table gets no update callback', () => {
        const conn = signInConnection();
        renderHook(() => useRows((c) => c.db.viewMyLinkRequest), { wrapper: wrapperFor(conn) });
        // MockTable implements onUpdate; the hook registers it only for a table that has one.
        expect(conn.db.viewMyLinkRequest.inserts.size).toBe(1);
        expect(conn.db.viewMyLinkRequest.deletes.size).toBe(1);
    });

    it('an absent table (the selector returns undefined) is an empty list', () => {
        const conn = new MockConnection();
        const { result } = renderHook(
            () =>
                useRows(
                    (c) =>
                        (c.db as { viewMyLinkRequest?: MockTable<MyLinkRequestRow> })
                            .viewMyLinkRequest,
                ),
            { wrapper: wrapperFor(conn) },
        );
        expect(result.current).toEqual([]);
    });
});
