import { act, renderHook } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StdbConnectionContext } from '@/stdb/connectionContext';
import { costQueryList } from '@/stdb/costQueries';
import { DEFAULT_COST_QUERIES } from '@/stdb/referenceSet';
import { characterCost } from '@/test/costFixtures';
import { MockConnection } from '@/test/mockConnection';
import { useCustomCostSet } from './useCostSet';

/*
 * T-COSTS: a picked custom set is a route subscription on its own id (user ruling item 2):
 * subscribed on pick, unsubscribed when the pick changes and when the page leaves, never
 * overlapping the default set's queries, rows filtered to the set.
 */

let conn: MockConnection;
beforeEach(() => {
    conn = new MockConnection();
});
afterEach(() => {});

function wrapper({ children }: { children: ReactNode }) {
    return (
        <StrictMode>
            <StdbConnectionContext.Provider value={conn}>{children}</StdbConnectionContext.Provider>
        </StrictMode>
    );
}

describe('the custom cost set subscription', () => {
    it('the default set (0) or no set subscribes nothing and is ready', () => {
        const { result, rerender } = renderHook(({ id }) => useCustomCostSet(id), {
            wrapper,
            initialProps: { id: 0 as number | undefined },
        });
        expect(conn.liveQueries()).toEqual([]);
        expect(result.current.ready).toBe(true);
        rerender({ id: undefined });
        expect(conn.liveQueries()).toEqual([]);
    });

    it('a pick subscribes the three queries of that id, with no overlap with set 0', () => {
        renderHook(() => useCustomCostSet(5), { wrapper });
        expect(conn.liveQueries()).toEqual(costQueryList(5));
        for (const q of conn.liveQueries()) expect(DEFAULT_COST_QUERIES).not.toContain(q);
    });

    it('a new pick unsubscribes the old set before the new one is live; leaving unsubscribes all', () => {
        const { rerender, unmount } = renderHook(({ id }) => useCustomCostSet(id), {
            wrapper,
            initialProps: { id: 5 },
        });
        const first = conn.live();
        rerender({ id: 6 });
        expect(first.every((s) => s.unsubscribed)).toBe(true);
        expect(conn.liveQueries()).toEqual(costQueryList(6));
        unmount();
        expect(conn.live()).toEqual([]);
    });

    it('ready after the first results; rows of other sets in the shared cache are left out', async () => {
        const { result } = renderHook(() => useCustomCostSet(5), { wrapper });
        expect(result.current.ready).toBe(false);
        conn.db.hsrCharacterCost.seed(
            characterCost('acheron', 7),
            characterCost('acheron', 9, { set: 5 }),
        );
        await act(async () => conn.applyAll());
        expect(result.current.ready).toBe(true);
        expect(
            result.current.lookup.character('acheron', 'ApocalypticShadow', 'Classic')?.costs.e0,
        ).toBe(9);
    });

    it('an error is reported; retry replaces the failed subscription', async () => {
        const { result } = renderHook(() => useCustomCostSet(5), { wrapper });
        await act(async () => conn.live()[0]?.fail('gone'));
        expect(result.current.error).toBe(`${costQueryList(5)[0]}: gone`);
        await act(async () => result.current.retry());
        expect(result.current.error).toBeUndefined();
        expect(conn.liveQueries()).toEqual(costQueryList(5));
    });
});
