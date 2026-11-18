import type { LobbyMemberViewRow, MyLobbyListRow } from '@bindings/types';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SenderError } from 'spacetimedb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setConnectionStatus } from '@/stdb/connectionStatus';
import { LAYER0_QUERIES } from '@/stdb/layer0';
import { MockTable, profileRow } from '@/test/mockConnection';
import { signInConnection } from '@/test/mockSignIn';
import { renderWithConnection } from '@/test/renderWithConnection';
import { MY_LOBBY_MEMBERS_QUERY } from './LobbyPlaceholder';

/*
 * T-S14.4c: the lobby placeholder at `/lobby/$lobbyId` through the real route tree with the mock connection: the
 * lobby's name, join code (copied), host, and "Leave lobby" (one `leave_lobby` call, then `/`); a lobby that is not
 * the viewer's says so. No network.
 */

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
beforeEach(() => {
    setConnectionStatus({ state: 'connected' });
});
afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
});

const LOBBY: MyLobbyListRow = {
    id: 5,
    joinCode: 'AB12CD',
    name: 'Sunday Scrims',
    stage: { tag: 'Waiting' },
    isAway: false,
};

function member(over: Partial<LobbyMemberViewRow> = {}): LobbyMemberViewRow {
    return {
        memberKey: 1n,
        lobbyId: 5,
        joinSeq: 1,
        userId: 7,
        label: 'Kafka',
        lobbySlot: { tag: 'Spectator' },
        presence: { tag: 'Online' },
        isHost: true,
        isReferee: true,
        isCaptain: false,
        isConfirmed: false,
        avatarCharacterName: undefined,
        displayedAchievementId: undefined,
        mmrByMode: undefined,
        accountRating: undefined,
        accountCount: undefined,
        disconnectActionAt: undefined,
        ...over,
    } as LobbyMemberViewRow;
}

function setup(path: string, lobbies: MyLobbyListRow[] = [LOBBY]) {
    const conn = signInConnection();
    const members = new MockTable<LobbyMemberViewRow>();
    Object.assign(conn.db, { viewMyLobbyMembers: members });
    const leaveLobby = vi.fn<(args: { lobbyId: number }) => Promise<void>>(async () => {
        for (const row of [...conn.db.viewMyLobbies.rows]) conn.db.viewMyLobbies.delete(row);
    });
    Object.assign(conn.reducers, { leaveLobby, createLobby: vi.fn() });
    conn.db.viewMyProfile.seed(profileRow({ id: 7 }));
    conn.db.viewMyLobbies.seed(...lobbies);
    members.seed(member());
    const rendered = renderWithConnection(path, conn);
    act(() => {
        conn.apply(LAYER0_QUERIES.profile);
        conn.apply(LAYER0_QUERIES.lobbies);
    });
    return { conn, leaveLobby, ...rendered };
}

describe('/lobby/$lobbyId placeholder', () => {
    it('shows the name, the join code, the host, and subscribes the members view', async () => {
        const { conn } = setup('/lobby/5');
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Sunday Scrims');
        expect(screen.getByText('AB12CD')).toBeInTheDocument();
        await waitFor(() => expect(conn.liveQueries()).toContain(MY_LOBBY_MEMBERS_QUERY));
        act(() => conn.apply(MY_LOBBY_MEMBERS_QUERY));
        expect(await screen.findByText('Kafka (you)')).toBeInTheDocument();
        await waitFor(() =>
            expect(document.title).toBe('Sunday Scrims — Lobby — IPC Battlegrounds'),
        );
    });

    it('an unnamed lobby is called by its code', async () => {
        setup('/lobby/5', [{ ...LOBBY, name: '' }]);
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Lobby AB12CD');
    });

    it('copies the join code and says so', async () => {
        // After userEvent.setup(), which puts its own clipboard stub in place.
        const user = userEvent.setup();
        const writeText = vi.fn(() => Promise.resolve());
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        setup('/lobby/5');
        await user.click(await screen.findByRole('button', { name: 'Copy the join code' }));
        expect(writeText).toHaveBeenCalledWith('AB12CD');
        expect(
            await screen.findByText('Copied the join code AB12CD to the clipboard'),
        ).toBeInTheDocument();
        // S14.4c-fix M15: the button's name after copying is the short word alone.
        expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
    });

    it('a waiting lobby says no page takes the code yet; a live match says neither "waiting room" nor "create another"', async () => {
        const { unmount } = setup('/lobby/5');
        expect(await screen.findByText('Lobby // Waiting room')).toBeInTheDocument();
        expect(screen.getByText(/no page takes the code yet/)).toBeInTheDocument();
        unmount();
        setup('/lobby/5', [{ ...LOBBY, stage: { tag: 'Drafting' } }]);
        expect(await screen.findByText('Lobby // Match in progress')).toBeInTheDocument();
        expect(screen.queryByText(/Waiting room/)).toBeNull();
        expect(screen.getByText(/if you leave, you are away from it/)).toBeInTheDocument();
    });

    it('while leaving, Leave keeps focus (aria-disabled, not disabled) and ignores a second press', async () => {
        const user = userEvent.setup();
        const { leaveLobby } = setup('/lobby/5');
        let finish: () => void = () => {};
        leaveLobby.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = () => resolve();
                }),
        );
        await user.click(await screen.findByRole('button', { name: 'Leave lobby' }));
        const busy = screen.getByRole('button', { name: 'Leaving…' });
        expect(busy).toHaveAttribute('aria-disabled', 'true');
        expect(busy).toBeEnabled();
        expect(busy).toHaveFocus();
        await user.click(busy);
        expect(leaveLobby).toHaveBeenCalledOnce();
        await act(async () => finish());
    });

    it('Leave lobby calls leave_lobby once and returns to /', async () => {
        const user = userEvent.setup();
        const { leaveLobby, router } = setup('/lobby/5');
        await user.click(await screen.findByRole('button', { name: 'Leave lobby' }));
        expect(leaveLobby).toHaveBeenCalledExactlyOnceWith({ lobbyId: 5 });
        await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    });

    it('a refused Leave stays with the module sentence', async () => {
        const user = userEvent.setup();
        const { leaveLobby, router } = setup('/lobby/5');
        leaveLobby.mockRejectedValueOnce(new SenderError('You are not a member of this lobby.'));
        await user.click(await screen.findByRole('button', { name: 'Leave lobby' }));
        expect(await screen.findByText('You are not a member of this lobby.')).toBeInTheDocument();
        expect(router.state.location.pathname).toBe('/lobby/5');
        expect(screen.getByRole('button', { name: 'Leave lobby' })).toBeEnabled();
        // S14.4c-fix M14: focus stays on the button after the refusal.
        expect(screen.getByRole('button', { name: 'Leave lobby' })).toHaveFocus();
        expect(screen.getByRole('button', { name: 'Leave lobby' })).not.toHaveAttribute(
            'aria-disabled',
        );
    });

    it('a lobby that is not the viewer’s says so, with a link home', async () => {
        setup('/lobby/9');
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
            'Lobby unavailable.',
        );
        expect(
            screen.getByText('This lobby is not one of yours, or it no longer exists.'),
        ).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Return to Base/ })).toHaveAttribute('href', '/');
    });
});
