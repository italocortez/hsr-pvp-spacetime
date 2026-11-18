import type { MySuspensionRow } from '@bindings/types';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authStore, setAuthSnapshot } from '@/auth/authStore';
import { SUSPENDED_TEXT } from '@/pages/suspended/SuspendedPage';
import { costQueryList } from '@/stdb/costQueries';
import { CHARACTERS, costSet, LIGHTCONES } from '@/test/costFixtures';
import { MockConnection, MockTable, profileRow } from '@/test/mockConnection';
import { renderWithConnection } from '@/test/renderWithConnection';
import { connectionStatusStore, setConnectionStatus } from './connectionStatus';
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
        // Every route subscription ended with the route (the three custom-set queries); Layer 0 stays.
        const live = conn.liveQueries();
        for (const query of costQueryList(5)) expect(live).not.toContain(query);
        expect(live).toEqual(
            expect.arrayContaining([
                LAYER0_QUERIES.profile,
                LAYER0_QUERIES.lobbies,
                LAYER0_QUERIES.suspension,
            ]),
        );
    });

    // Until Layer 0's first result the not-ready app shows (the shell and, on a public route, the
    // page as for a visitor; never the account's data, never a redirect); this pins the end state.
    it('a row in the first result: the suspended page replaces the not-ready app', async () => {
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

    it('shows only its fixed words (no reason, date, staff name, chip or sector) and no link', async () => {
        await openCosts({ suspended: true });
        await screen.findByRole('heading', { level: 1, name: 'Account suspended' });
        const main = screen.getByRole('main');
        // Every visible text piece, in order: anything added to the screen (a date, a reason, the
        // old HUD chip or sector line) makes this list longer.
        const pieces: string[] = [];
        const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.textContent?.trim();
            if (text) pieces.push(text);
        }
        expect(pieces).toEqual([
            'IPC Battlegrounds',
            'Status // Suspended',
            'Account',
            'suspended',
            SUSPENDED_TEXT.body,
            SUSPENDED_TEXT.signOut,
            'IPC // Battlegrounds',
            'v0.9',
        ]);
        // S2: the brand mark is not a link here; "Sign out" is the one control.
        expect(within(main).queryAllByRole('link')).toHaveLength(0);
        expect(within(main).getAllByRole('button')).toHaveLength(1);
    });
});

describe('the suspended page on a guarded route, over failures and across connections', () => {
    const MEMBER = profileRow({ id: 7 });
    const SIGN_IN_BUTTON = { name: 'Sign in with Discord' } as const;

    const suspendedHeading = () =>
        screen.findByRole('heading', { level: 1, name: 'Account suspended' });

    /** `/profile` with the suspension row in Layer 0's first result. */
    async function openProfileSuspended() {
        conn.db.viewMySuspension.seed(SUSPENDED_ROW);
        const r = renderWithConnection('/profile', conn);
        await act(async () => conn.applyAll());
        await suspendedHeading();
        return r;
    }

    it('/profile: the address stays, no sign-in panel under the screen; the lift returns /profile', async () => {
        const { router } = await openProfileSuspended();
        // Give a sign-in redirect every chance to happen: it must not.
        await act(async () => new Promise((r) => setTimeout(r, 50)));
        expect(router.state.location.href).toBe('/profile');
        expect(screen.queryByRole('button', SIGN_IN_BUTTON)).toBeNull();
        expect(authStore.getSnapshot()).toEqual({ ready: false });

        await act(async () => {
            conn.db.viewMyProfile.rows = [MEMBER];
            conn.db.viewMySuspension.delete(SUSPENDED_ROW);
        });
        expect(await screen.findByText('Profile')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Account suspended' })).toBeNull();
        expect(router.state.location.href).toBe('/profile');
    });

    it('"Sign out" on /profile goes to the home page /, not a reload of /profile', async () => {
        await openProfileSuspended();
        await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
        expect(signOutMock).toHaveBeenCalledTimes(1);
        expect(signOutMock).toHaveBeenCalledWith({ to: '/' });

        // The real sign-out with those options loads `/` and does not reload in place.
        const actual = await vi.importActual<typeof import('@/auth/signOut')>('@/auth/signOut');
        const assign = vi.fn();
        const reload = vi.fn();
        const [options] = signOutMock.mock.calls[0] as [{ to: string }];
        actual.signOut({ ...options, tokenStorageKey: 'test-token', assign, reload });
        expect(assign).toHaveBeenCalledWith('/');
        expect(reload).not.toHaveBeenCalled();
    });

    it('a failed connection while suspended: the offline splash shows over the suspended screen', async () => {
        await openProfileSuspended();
        act(() =>
            setConnectionStatus({
                state: 'failed',
                kind: 'offline',
                reason: 'WebSocket error',
                recovery: 'retry',
            }),
        );
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
            'Connection lost.',
        );
        expect(screen.queryByRole('heading', { name: 'Account suspended' })).toBeNull();
        expect(screen.getAllByRole('main')).toHaveLength(1);
    });

    it('a stale flag stays until the next connection answers, and its first result replaces it', async () => {
        const { router, rerenderWithConnection } = await openProfileSuspended();
        // A Layer 0 error that drops no rows: the offline splash; the flag keeps its last value.
        await act(async () => {
            conn.live()
                .find((s) => s.query === LAYER0_QUERIES.lobbies)
                ?.fail('boom');
        });
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
            'Connection lost.',
        );
        expect(suspensionStore.getSnapshot()).toBe(true);

        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        const next = connWithSuspension();
        next.db.viewMyProfile.seed(MEMBER);
        rerenderWithConnection(next);
        // Before the new connection's first result: still the suspended screen.
        expect(await suspendedHeading()).toBeInTheDocument();
        expect(next.liveQueries()).toEqual(
            expect.arrayContaining([LAYER0_QUERIES.profile, LAYER0_QUERIES.suspension]),
        );

        // The first result has no suspension row: the app comes back on the same address.
        await act(async () => next.applyAll());
        expect(await screen.findByText('Profile')).toBeInTheDocument();
        expect(suspensionStore.getSnapshot()).toBe(false);
        expect(screen.queryByRole('heading', { name: 'Account suspended' })).toBeNull();
        expect(router.state.location.href).toBe('/profile');
    });

    it('a failing view_my_suspension is a connection failure: offline splash, auth not ready, no redirect, connection closed', async () => {
        conn.db.viewMyProfile.seed(MEMBER);
        const { router } = renderWithConnection('/profile', conn);
        // The profile answers; the suspension view fails (as against a module without the view).
        await act(async () => conn.apply(LAYER0_QUERIES.profile));
        await act(async () => {
            conn.live()
                .find((s) => s.query === LAYER0_QUERIES.suspension)
                ?.fail('no such view');
        });
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
            'Connection lost.',
        );
        expect(connectionStatusStore.getSnapshot().status).toMatchObject({
            state: 'failed',
            reason: 'no such view',
        });
        expect(authStore.getSnapshot()).toEqual({ ready: false });
        expect(suspensionStore.getSnapshot()).toBe(false);
        expect(screen.queryByText('Profile')).toBeNull();
        await act(async () => new Promise((r) => setTimeout(r, 50)));
        expect(router.state.location.href).toBe('/profile');
        expect(conn.disconnects).toBe(1);
    });
});
