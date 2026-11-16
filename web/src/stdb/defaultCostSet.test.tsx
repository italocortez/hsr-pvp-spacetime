import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { characterCost, synergy } from '@/test/costFixtures';
import { MockConnection, profileRow } from '@/test/mockConnection';
import { renderWithConnection } from '@/test/renderWithConnection';
import { ConnectionScope } from './ConnectionScope';
import { StdbConnectionContext } from './connectionContext';
import { costQueryList } from './costQueries';
import { LAYER0_QUERIES } from './layer0';
import {
    DEFAULT_COST_QUERIES,
    isDefaultCostSetRequested,
    REFERENCE_QUERIES,
    resetReferenceSetForTests,
    retryReferenceSet,
    useReferenceSet,
} from './referenceSet';

/*
 * T-COSTS: the default cost set joins the session-long reference set (user ruling 2026-11-16
 * item 2): three disjoint queries on cost_set_id = 0, started once by the first route that asks
 * for them, kept for the session, never by `/` or `/profile`; rows always filtered to set 0.
 */

let conn: MockConnection;
beforeEach(() => {
    conn = new MockConnection();
});
afterEach(() => {
    resetReferenceSetForTests();
    vi.restoreAllMocks();
});

function wrapper({ children }: { children: ReactNode }) {
    return (
        <StrictMode>
            <StdbConnectionContext.Provider value={conn}>{children}</StdbConnectionContext.Provider>
        </StrictMode>
    );
}

describe('the default cost set in the reference set', () => {
    it('{ costs: true } adds the three set-0 queries once; StrictMode and a second caller add none', () => {
        const first = renderHook(() => useReferenceSet({ costs: true }), { wrapper });
        renderHook(() => useReferenceSet({ costs: true }), { wrapper });
        renderHook(() => useReferenceSet(), { wrapper });
        expect(conn.liveQueries()).toEqual([...REFERENCE_QUERIES, ...DEFAULT_COST_QUERIES]);
        expect(conn.subscriptions).toHaveLength(8);
        expect(isDefaultCostSetRequested()).toBe(true);
        // Kept for the session.
        first.unmount();
        expect(conn.live()).toHaveLength(8);
    });

    it('the queries are exactly the set-0 filters, disjoint from any custom set', () => {
        expect(DEFAULT_COST_QUERIES).toEqual(costQueryList(0));
        for (const q of costQueryList(3)) expect(DEFAULT_COST_QUERIES).not.toContain(q);
    });

    it('a plain caller does not start the cost queries', () => {
        renderHook(() => useReferenceSet(), { wrapper });
        expect(conn.liveQueries()).toEqual([...REFERENCE_QUERIES]);
        expect(isDefaultCostSetRequested()).toBe(false);
    });

    it('costsReady once the three have applied; rows of another set in the shared cache are left out', async () => {
        const { result } = renderHook(() => useReferenceSet({ costs: true }), { wrapper });
        const own = characterCost('acheron', 7);
        const custom = characterCost('acheron', 9, { set: 5 });
        conn.db.hsrCharacterCost.seed(own, custom);
        conn.db.hsrSynergyCost.seed(
            synergy('anaxa', 'cerydra', 3),
            synergy('a', 'b', 1, { set: 5 }),
        );
        expect(result.current.costsReady).toBe(false);
        await act(async () => conn.applyAll());
        expect(result.current.costsReady).toBe(true);
        expect(result.current.characterCosts).toEqual([own]);
        expect(result.current.synergyCosts).toHaveLength(1);
        expect(
            result.current.defaultCosts.character('acheron', 'ApocalypticShadow', 'Classic'),
        ).toBe(own);
        // A later custom-set insert does not leak into the default set.
        await act(async () =>
            conn.db.hsrCharacterCost.insert(characterCost('pela', 2, { set: 5 })),
        );
        expect(result.current.characterCosts).toEqual([own]);
    });

    it('a failed cost query is the costs error (the base stays fine); retry subscribes that group again', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { result } = renderHook(() => useReferenceSet({ costs: true }), { wrapper });
        await act(async () =>
            conn
                .live()
                .find((s) => s.query === DEFAULT_COST_QUERIES[1])
                ?.fail('boom'),
        );
        expect(result.current.costsError).toBe(`${DEFAULT_COST_QUERIES[1]}: boom`);
        expect(result.current.error).toBeUndefined();
        const before = conn.subscriptions.length;
        act(() => retryReferenceSet());
        expect(result.current.costsError).toBeUndefined();
        // Only the cost group was subscribed again (three new handles), the base untouched.
        expect(conn.subscriptions.length).toBe(before + 3);
        expect([...conn.liveQueries()].sort()).toEqual(
            [...REFERENCE_QUERIES, ...DEFAULT_COST_QUERIES].sort(),
        );
    });

    it('a replaced connection carries the cost queries over', async () => {
        let current = conn;
        const scope = ({ children }: { children: ReactNode }) => (
            <ConnectionScope connection={current}>{children}</ConnectionScope>
        );
        const { rerender } = renderHook(() => useReferenceSet({ costs: true }), {
            wrapper: scope,
        });
        await act(async () => {});
        const next = new MockConnection();
        current = next;
        rerender();
        await act(async () => {});
        expect(conn.live()).toHaveLength(0);
        expect([...next.liveQueries()].sort()).toEqual(
            [
                LAYER0_QUERIES.profile,
                LAYER0_QUERIES.lobbies,
                ...REFERENCE_QUERIES,
                ...DEFAULT_COST_QUERIES,
            ].sort(),
        );
    });

    it('the default cost group is resumed on a new connection when no caller asks for it then', async () => {
        let current = conn;
        let wantsCosts = true;
        const scope = ({ children }: { children: ReactNode }) => (
            <ConnectionScope connection={current}>{children}</ConnectionScope>
        );
        const { rerender } = renderHook(() => useReferenceSet({ costs: wantsCosts }), {
            wrapper: scope,
        });
        await act(async () => {});
        // The costs page is gone; only a plain caller of the reference set remains.
        wantsCosts = false;
        rerender();
        await act(async () => {});
        const next = new MockConnection();
        current = next;
        rerender();
        await act(async () => {});
        expect(next.liveQueries()).toEqual(expect.arrayContaining([...DEFAULT_COST_QUERIES]));
        expect(isDefaultCostSetRequested()).toBe(true);
    });

    it.each(['/', '/profile'])('%s never starts the cost queries', async (path) => {
        renderWithConnection(path, conn);
        conn.db.viewMyProfile.seed(profileRow());
        act(() => conn.applyAll());
        expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
        await waitFor(() =>
            expect(conn.liveQueries()).toEqual([LAYER0_QUERIES.profile, LAYER0_QUERIES.lobbies]),
        );
        expect(isDefaultCostSetRequested()).toBe(false);
    });

    it('/costs starts the base set and the default cost set, once', async () => {
        renderWithConnection('/costs', conn, { ready: true });
        expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
        await waitFor(() =>
            expect([...conn.liveQueries()].sort()).toEqual(
                [
                    LAYER0_QUERIES.profile,
                    LAYER0_QUERIES.lobbies,
                    ...REFERENCE_QUERIES,
                    ...DEFAULT_COST_QUERIES,
                ].sort(),
            ),
        );
    });
});
