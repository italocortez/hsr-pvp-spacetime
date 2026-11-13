import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { MockConnection, profileRow } from '@/test/mockConnection';
import { renderWithConnection } from '@/test/renderWithConnection';
import { connectionStatusStore, setConnectionStatus } from './connectionStatus';
import { LAYER0_QUERIES } from './layer0';

/*
 * The connection layer through the real App and route tree (M6 brief items 4, 8 and 9): guarded
 * routes wait for view_my_profile, live role changes, and the failure splashes in place of every
 * route.
 */

let conn: MockConnection;
beforeEach(() => {
    conn = new MockConnection();
});

const h1 = () => screen.queryByRole('heading', { level: 1 });

describe('guarded routes and view_my_profile', () => {
    it('/profile shows nothing under a neutral title until the profile arrives, then renders', async () => {
        document.title = 'Standby — IPC Battlegrounds';
        const { router } = renderWithConnection('/profile', conn);
        await waitFor(() => expect(document.title).toBe('IPC Battlegrounds'));
        expect(h1()).toBeNull();
        expect(router.state.location.pathname).toBe('/profile');

        conn.db.viewMyProfile.seed(profileRow({ isGuest: true }));
        act(() => conn.apply(LAYER0_QUERIES.profile));
        expect(await screen.findByText('Profile')).toBeInTheDocument();
        expect(h1()).toHaveTextContent('Module offline.');
        expect(router.state.location.pathname).toBe('/profile');
    });

    it('/profile for a visitor: the empty result sends them to sign in', async () => {
        const { router } = renderWithConnection('/profile', conn);
        act(() => conn.apply(LAYER0_QUERIES.profile));
        await waitFor(() => expect(router.state.location.href).toBe('/?login=1&next=%2Fprofile'));
    });

    it('a role change from the view moves a member on /admin from no-access to the admin outlet', async () => {
        const member = profileRow({ role: { tag: 'User' } });
        conn.db.viewMyProfile.seed(member);
        renderWithConnection('/admin', conn);
        act(() => conn.apply(LAYER0_QUERIES.profile));
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
            'Access denied.',
        );

        act(() => conn.db.viewMyProfile.update(member, { ...member, role: { tag: 'Admin' } }));
        expect(await screen.findByText('Admin Console')).toBeInTheDocument();
        expect(h1()).toHaveTextContent('Module offline.');
    });

    it('sign-out on /profile: the page content goes in the same render, before the redirect lands', async () => {
        const member = profileRow();
        conn.db.viewMyProfile.seed(member);
        const { router } = renderWithConnection('/profile', conn);
        act(() => conn.apply(LAYER0_QUERIES.profile));
        expect(await screen.findByText('Profile')).toBeInTheDocument();

        // The row goes: auth is a ready visitor; the redirect (async, through invalidate) has not
        // landed yet, and the guarded layout already shows nothing.
        act(() => conn.db.viewMyProfile.delete(member));
        expect(screen.queryByText('Profile')).toBeNull();
        expect(h1()).toBeNull();
        await waitFor(() => expect(router.state.location.href).toBe('/?login=1&next=%2Fprofile'));
    });

    it('a public route renders while still connecting', async () => {
        renderWithConnection('/', conn);
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
            'Module offline.',
        );
    });
});

describe('failure splashes in place of the routes', () => {
    it('failed/offline: the offline splash on any route; Retry goes back to connecting and the route returns', async () => {
        renderWithConnection('/', conn, { ready: true });
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
        expect(document.title).toBe('Connection lost — IPC Battlegrounds');

        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(connectionStatusStore.getSnapshot().status).toEqual({ state: 'connecting' });
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
            'Module offline.',
        );
    });

    it('failed/maintenance: the maintenance splash', async () => {
        renderWithConnection('/lobbies', conn, { ready: true });
        act(() =>
            setConnectionStatus({
                state: 'failed',
                kind: 'maintenance',
                reason: 'Maintenance mode',
                recovery: 'retry',
            }),
        );
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
            'Under maintenance.',
        );
    });

    it('a Layer 0 subscription error shows the offline splash; Retry asks for a new connection', async () => {
        const member = profileRow();
        conn.db.viewMyProfile.seed(member);
        renderWithConnection('/profile', conn);
        act(() => conn.apply(LAYER0_QUERIES.profile));
        expect(await screen.findByText('Profile')).toBeInTheDocument();

        // A replay of view_my_profile fails: the user must not stay signed in on a dead view.
        await act(async () => {
            conn.live()
                .find((s) => s.query === LAYER0_QUERIES.profile)
                ?.fail('view gone');
        });
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
            'Connection lost.',
        );
        expect(connectionStatusStore.getSnapshot().status).toMatchObject({
            state: 'failed',
            reason: 'view gone',
            recovery: 'retry',
        });
        // The connection is closed so that Retry builds a new one (which subscribes again).
        expect(conn.disconnects).toBe(1);

        const generation = connectionStatusStore.getSnapshot().generation;
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(connectionStatusStore.getSnapshot()).toEqual({
            status: { state: 'connecting' },
            generation: generation + 1,
        });
    });

    it('a new connection object after Retry: Layer 0 subscribes again on it and the route returns', async () => {
        const { rerenderWithConnection } = renderWithConnection('/profile', conn);
        act(() => conn.apply(LAYER0_QUERIES.profile));
        await act(async () => conn.live()[0]?.fail('boom'));
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
            'Connection lost.',
        );

        const next = new MockConnection();
        next.db.viewMyProfile.seed(profileRow());
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        rerenderWithConnection(next);
        expect(next.liveQueries()).toEqual([LAYER0_QUERIES.profile, LAYER0_QUERIES.lobbies]);
        expect(conn.live()).toHaveLength(0);
        act(() => next.apply(LAYER0_QUERIES.profile));
        expect(await screen.findByText('Profile')).toBeInTheDocument();
    });

    it('reconnecting blocks nothing', async () => {
        renderWithConnection('/lobbies', conn, { ready: true });
        act(() => setConnectionStatus({ state: 'reconnecting', reason: 'Connection lost' }));
        expect(await screen.findByText('Lobbies')).toBeInTheDocument();
    });
});
