import type { MySuspensionRow } from '@bindings/types';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authStore, setAuthSnapshot } from '@/auth/authStore';
import { costQueryList } from '@/stdb/costQueries';
import { CHARACTERS, costSet, LIGHTCONES } from '@/test/costFixtures';
import { MockConnection, MockTable, profileRow } from '@/test/mockConnection';
import { renderWithConnection } from '@/test/renderWithConnection';
import { LAYER0_QUERIES, startLayer0 } from './layer0';
import { setSuspended, suspensionStore } from './suspensionStatus';

/*
 * SUS2: the suspended page. Layer 0 reads `view_my_suspension` (one row while suspended); the root
 * layout shows the suspended page in place of the shell and every route while the row exists, and
 * the app comes back when it goes. Driven by the mock connection, with the suspension table added
 * to it here (the shared double predates the view).
 */

const signOutMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/signOut', () => ({ signOut: signOutMock }));

type Conn = MockConnection & {
    db: MockConnection['db'] & { viewMySuspension: MockTable<MySuspensionRow> };
};

function connWithSuspension(): Conn {
    const conn = new MockConnection();
    Object.assign(conn.db, { viewMySuspension: new MockTable<MySuspensionRow>() });
    return conn as Conn;
}

const SUSPENDED_ROW: MySuspensionRow = { userId: 7 };

let conn: Conn;
beforeEach(() => {
    conn = connWithSuspension();
    signOutMock.mockClear();
});
afterEach(() => {
    setSuspended(false);
});

describe('Layer 0 with view_my_suspension', () => {
    let stop: (() => void) | undefined;
    afterEach(() => {
        stop?.();
        stop = undefined;
        setAuthSnapshot({ ready: true });
    });

    it('waits for both the profile and the suspension result before saying who the viewer is', () => {
        setAuthSnapshot({ ready: false });
        stop = startLayer0(conn);
        conn.db.viewMyProfile.seed(profileRow());
        conn.apply(LAYER0_QUERIES.profile);
        expect(authStore.getSnapshot()).toEqual({ ready: false });
        conn.apply(LAYER0_QUERIES.suspension);
        expect(authStore.getSnapshot().user?.id).toBe(7);
        expect(suspensionStore.getSnapshot()).toBe(false);
    });

    it('a row: suspended, auth not ready; the row removed with the profile back: the user returns', () => {
        setAuthSnapshot({ ready: false });
        stop = startLayer0(conn);
        conn.db.viewMySuspension.seed(SUSPENDED_ROW);
        conn.applyAll();
        expect(suspensionStore.getSnapshot()).toBe(true);
        expect(authStore.getSnapshot()).toEqual({ ready: false });

        // The lift: one transaction deletes the suspension row and brings the profile row back.
        conn.db.viewMyProfile.rows = [profileRow()];
        conn.db.viewMySuspension.delete(SUSPENDED_ROW);
        expect(suspensionStore.getSnapshot()).toBe(false);
        expect(authStore.getSnapshot().user?.id).toBe(7);
    });

    it('a suspension mid-session: suspended, the user withheld', () => {
        stop = startLayer0(conn);
        const row = profileRow();
        conn.db.viewMyProfile.seed(row);
        conn.applyAll();
        expect(authStore.getSnapshot().user).toBeDefined();
        conn.db.viewMyProfile.rows = [];
        conn.db.viewMySuspension.insert(SUSPENDED_ROW);
        expect(suspensionStore.getSnapshot()).toBe(true);
        expect(authStore.getSnapshot()).toEqual({ ready: false });
    });

    it('the cleanup unsubscribes the suspension view and removes its callbacks', () => {
        stop = startLayer0(conn);
        stop();
        stop = undefined;
        expect(conn.live()).toHaveLength(0);
        expect(conn.db.viewMySuspension.listenerCount).toBe(0);
    });
});

describe('the suspended page in place of the app', () => {
    const MEMBER = profileRow({ id: 7 });

    function seedReference() {
        conn.db.hsrCharacter.seed(...CHARACTERS);
        conn.db.hsrLightcone.seed(...LIGHTCONES);
        conn.db.viewPublishedCostSets.seed(costSet(5, 'Chaos League', { mode: 'MemoryOfChaos' }));
    }

    async function openCosts({ suspended }: { suspended: boolean }) {
        conn.db.viewMyProfile.seed(...(suspended ? [] : [MEMBER]));
        if (suspended) conn.db.viewMySuspension.seed(SUSPENDED_ROW);
        seedReference();
        const r = renderWithConnection('/costs?set=5', conn);
        await act(async () => conn.applyAll());
        // The custom set's route subscription starts once the published sets are in.
        await act(async () => conn.applyAll());
        return r;
    }

    it('no row: the app with its shell and the route', async () => {
        await openCosts({ suspended: false });
        await waitFor(() =>
            expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument(),
        );
        expect(screen.queryByRole('heading', { name: 'Account suspended' })).toBeNull();
        expect(conn.liveQueries()).toEqual(expect.arrayContaining(costQueryList(5)));
    });

    it('a row: the suspended page alone, no shell, no route, no route subscription', async () => {
        await openCosts({ suspended: false });
        await waitFor(() =>
            expect(conn.liveQueries()).toEqual(expect.arrayContaining(costQueryList(5))),
        );

        await act(async () => {
            conn.db.viewMyProfile.rows = [];
            conn.db.viewMySuspension.insert(SUSPENDED_ROW);
        });

        const heading = await screen.findByRole('heading', { level: 1 });
        expect(heading).toHaveTextContent('Account suspended');
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
        expect(screen.getAllByRole('main')).toHaveLength(1);
        expect(
            screen.getByText('This account is suspended. You cannot use the site with it.'),
        ).toBeInTheDocument();
        expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
        expect(document.title).toBe('Account suspended — IPC Battlegrounds');
        // Focus on the heading; the one action reachable by keyboard.
        expect(heading).toHaveFocus();
        await userEvent.tab();
        expect(screen.getByRole('button', { name: 'Sign out' })).toHaveFocus();
        // The route's own subscription ended with the route; Layer 0 stays.
        const live = conn.liveQueries();
        expect(live).not.toEqual(expect.arrayContaining([costQueryList(5)[0]]));
        expect(live).toEqual(
            expect.arrayContaining([
                LAYER0_QUERIES.profile,
                LAYER0_QUERIES.lobbies,
                LAYER0_QUERIES.suspension,
            ]),
        );
    });

    it('a row from the first result: the suspended page, never the route', async () => {
        await openCosts({ suspended: true });
        expect(
            await screen.findByRole('heading', { level: 1, name: 'Account suspended' }),
        ).toBeInTheDocument();
        expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    });

    it('the row removed (lifted): the app comes back without a reload', async () => {
        await openCosts({ suspended: true });
        await screen.findByRole('heading', { level: 1, name: 'Account suspended' });

        await act(async () => {
            conn.db.viewMyProfile.rows = [MEMBER];
            conn.db.viewMySuspension.delete(SUSPENDED_ROW);
        });

        await waitFor(() =>
            expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument(),
        );
        expect(screen.queryByRole('heading', { name: 'Account suspended' })).toBeNull();
        expect(signOutMock).not.toHaveBeenCalled();
    });

    it('"Sign out" calls the existing sign-out', async () => {
        await openCosts({ suspended: true });
        await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
        expect(signOutMock).toHaveBeenCalledTimes(1);
    });

    it('shows no reason, no date and no staff name', async () => {
        await openCosts({ suspended: true });
        const main = await screen.findByRole('main');
        const text = main.textContent ?? '';
        expect(text).not.toMatch(/reason|until|since|by staff|admin|moderator/i);
        expect(text).not.toMatch(/\d{4}-\d{2}|\d{1,2}\/\d{1,2}|\d{1,2}:\d{2}/);
        expect(text).not.toMatch(
            /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|\b(19|20)\d{2}\b/,
        );
    });
});
