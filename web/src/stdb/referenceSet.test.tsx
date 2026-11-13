import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockConnection, profileRow } from '@/test/mockConnection';
import { renderWithConnection } from '@/test/renderWithConnection';
import { ConnectionScope } from './ConnectionScope';
import { StdbConnectionContext } from './connectionContext';
import { LAYER0_QUERIES } from './layer0';
import {
    isReferenceSetRequested,
    REFERENCE_QUERIES,
    resetReferenceSetForTests,
    useReferenceSet,
} from './referenceSet';

/*
 * The session-long reference set (M6 brief item 6): started once by the first caller, never by
 * `/` or `/profile`, kept across unmounts; maps memoized on the row arrays.
 */

let conn: MockConnection;
beforeEach(() => {
    conn = new MockConnection();
});
afterEach(() => {
    resetReferenceSetForTests();
});

function strictWrapper({ children }: { children: ReactNode }) {
    return (
        <StrictMode>
            <StdbConnectionContext.Provider value={conn}>{children}</StdbConnectionContext.Provider>
        </StrictMode>
    );
}

const character = {
    name: 'kafka',
    displayName: 'Kafka',
    aliases: [],
    rarity: 5,
    path: { tag: 'Nihility' },
    element: { tag: 'Lightning' },
    role: { tag: 'Dps' },
    imageUrl: '',
    versionReleased: 1.2,
    treatAsVersion: 1.2,
    posX: 0,
    posY: 0,
    width: 0,
    createdById: 0,
    createdDate: { microsSinceUnixEpoch: 0n },
    lastModifiedById: 0,
    lastModifiedDate: { microsSinceUnixEpoch: 0n },
} as unknown as Parameters<MockConnection['db']['hsrCharacter']['insert']>[0];

describe('reference set', () => {
    it('the first caller starts five subscriptions; a second caller and StrictMode add none', () => {
        const first = renderHook(() => useReferenceSet(), { wrapper: strictWrapper });
        renderHook(() => useReferenceSet(), { wrapper: strictWrapper });
        expect(conn.liveQueries()).toEqual([...REFERENCE_QUERIES]);
        expect(conn.subscriptions).toHaveLength(5);
        expect(isReferenceSetRequested()).toBe(true);

        // Kept for the session: unmounting every caller unsubscribes nothing.
        first.unmount();
        expect(conn.live()).toHaveLength(5);
    });

    it('covers the five public reference sources and no cost table yet', () => {
        expect(REFERENCE_QUERIES).toEqual([
            'SELECT * FROM "hsr_character"',
            'SELECT * FROM "hsr_lightcone"',
            'SELECT * FROM "archetype"',
            'SELECT * FROM "hsr_character_archetype"',
            'SELECT * FROM "view_published_cost_sets"',
        ]);
    });

    it('is ready once all five have applied; rows and maps follow the cache', async () => {
        const { result } = renderHook(() => useReferenceSet(), { wrapper: strictWrapper });
        conn.db.hsrCharacter.seed(character);
        await act(async () => conn.applyAll());
        expect(result.current.ready).toBe(true);
        expect(result.current.characters).toEqual([character]);
        expect(result.current.characterByName.get('kafka')).toBe(character);
    });

    it('memoizes the maps on the row arrays: a change elsewhere keeps the same map', async () => {
        const { result } = renderHook(() => useReferenceSet(), { wrapper: strictWrapper });
        conn.db.hsrCharacter.seed(character);
        await act(async () => conn.applyAll());
        const map = result.current.characterByName;
        await act(async () =>
            conn.db.archetype.insert({
                id: 1,
                name: 'DoT',
                createdById: 0,
                createdDate: { microsSinceUnixEpoch: 0n },
                lastModifiedById: 0,
                lastModifiedDate: { microsSinceUnixEpoch: 0n },
            } as unknown as Parameters<MockConnection['db']['archetype']['insert']>[0]),
        );
        expect(result.current.archetypes).toHaveLength(1);
        expect(result.current.characterByName).toBe(map);
    });

    it('a replaced connection: old listeners gone, Layer 0 and the set restarted, rows kept until applied', async () => {
        let current = conn;
        const scope = ({ children }: { children: ReactNode }) => (
            <StrictMode>
                <ConnectionScope connection={current}>{children}</ConnectionScope>
            </StrictMode>
        );
        const { result, rerender } = renderHook(() => useReferenceSet(), { wrapper: scope });
        conn.db.hsrCharacter.seed(character);
        await act(async () => conn.applyAll());
        expect(result.current.characters).toEqual([character]);

        const next = new MockConnection();
        current = next;
        rerender();
        await act(async () => {});
        // The old connection: nothing left listening or subscribed.
        for (const table of Object.values(conn.db)) expect(table.listenerCount).toBe(0);
        expect(conn.live()).toHaveLength(0);
        // The new one: Layer 0 and the reference set, once each (order does not matter).
        expect([...next.liveQueries()].sort()).toEqual(
            [LAYER0_QUERIES.profile, LAYER0_QUERIES.lobbies, ...REFERENCE_QUERIES].sort(),
        );
        // No empty flash: the last rows stay until the new subscriptions apply.
        expect(result.current.characters).toEqual([character]);
        expect(result.current.ready).toBe(true);

        const renamed = { ...character, displayName: 'Kafka (new)' };
        next.db.hsrCharacter.seed(renamed);
        await act(async () => next.applyAll());
        expect(result.current.characters).toEqual([renamed]);
    });

    it('a subscription error is exposed as error, not a silent not-ready', async () => {
        const { result } = renderHook(() => useReferenceSet(), { wrapper: strictWrapper });
        await act(async () => conn.live()[1]?.fail('no such table'));
        expect(result.current.ready).toBe(false);
        expect(result.current.error).toBe(`${REFERENCE_QUERIES[1]}: no such table`);
    });

    it.each(['/', '/profile'])(
        '%s with a signed-in member never starts it: only the two Layer 0 subscriptions exist',
        async (path) => {
            renderWithConnection(path, conn);
            conn.db.viewMyProfile.seed(profileRow());
            act(() => conn.applyAll());
            expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
            await waitFor(() =>
                expect(conn.liveQueries()).toEqual([
                    LAYER0_QUERIES.profile,
                    LAYER0_QUERIES.lobbies,
                ]),
            );
            expect(isReferenceSetRequested()).toBe(false);
        },
    );
});
