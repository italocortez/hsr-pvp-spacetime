import type { CostSet, LobbyPresetViewRow, MyLobbyListRow, MyProfileRow } from '@bindings/types';
import type { CreateLobbyParams } from '@bindings/types/reducers';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InternalError, SenderError, UnknownCallResultError } from 'spacetimedb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setConnectionStatus } from '@/stdb/connectionStatus';
import { LAYER0_QUERIES } from '@/stdb/layer0';
import { MockTable, profileRow } from '@/test/mockConnection';
import { signInConnection } from '@/test/mockSignIn';
import { renderWithConnection } from '@/test/renderWithConnection';
import { ABANDON_CONFIRM_GUARD_MS, NEW_LOBBY_WAIT_MS } from './CreateLobbyDialog';
import { LOBBY_PRESETS_QUERY, PUBLISHED_COST_SETS_QUERY } from './createLobbyQueries';

/*
 * T-S14.4c: "Play Now" and the create dialog through the real App and route tree with the mock connection (Layer 0,
 * the profile, the guest reducer, `create_lobby`, the dialog's two views). No network.
 */

beforeEach(() => {
    setConnectionStatus({ state: 'connected' });
});

const MEMBER = profileRow({ id: 7, isGuest: false });
const GUEST = profileRow({
    id: 11,
    isGuest: true,
    username: 'Guest_0a1b2c3d',
    displayName: 'Guest_0a1b2c3d',
});

const lobbyRow = (over: Partial<MyLobbyListRow> = {}): MyLobbyListRow => ({
    id: 77,
    joinCode: 'AB12CD',
    name: 'Sunday Scrims',
    stage: { tag: 'Waiting' },
    isAway: false,
    ...over,
});

function setup(profile?: MyProfileRow, lobbies: MyLobbyListRow[] = []) {
    const conn = signInConnection();
    const presets = new MockTable<LobbyPresetViewRow>();
    Object.assign(conn.db, { viewLobbyPresets: presets });
    const createLobby = vi.fn<(args: CreateLobbyParams) => Promise<void>>(async () => {
        conn.db.viewMyLobbies.insert(lobbyRow());
    });
    Object.assign(conn.reducers, { createLobby, leaveLobby: vi.fn(async () => {}) });
    if (profile) conn.db.viewMyProfile.seed(profile);
    conn.db.viewMyLobbies.seed(...lobbies);
    conn.reducers.loginAsGuest.mockImplementation(async () => {
        conn.db.viewMyProfile.insert(GUEST);
    });
    const rendered = renderWithConnection('/', conn);
    act(() => {
        conn.apply(LAYER0_QUERIES.profile);
        conn.apply(LAYER0_QUERIES.lobbies);
    });
    return { conn, presets, createLobby, ...rendered };
}

const playNow = () => screen.findByRole('button', { name: 'Play Now' });
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await playNow());
    return screen.findByRole('dialog', { name: 'Create Lobby' }, { timeout: 10_000 });
}

describe('Play Now', () => {
    it('a visitor becomes a guest first, then the dialog opens with the guest rules shown', async () => {
        const user = userEvent.setup();
        const { conn } = setup();
        const d = await openDialog(user);
        expect(conn.reducers.loginAsGuest).toHaveBeenCalledExactlyOnceWith({});
        const type = within(d).getByRole('group', { name: 'Type' });
        expect(within(type).getByRole('button', { name: 'Ranked' })).toHaveAttribute(
            'aria-disabled',
            'true',
        );
        expect(within(type).getByRole('button', { name: 'Ranked' })).toHaveAccessibleDescription(
            'Guests can only create Casual lobbies. Sign in with Discord to play Ranked.',
        );
        // S14.4c-fix M5: the reason is visible words too, not only a tooltip.
        expect(
            within(d).getByText(
                'Guests can only create Casual lobbies. Sign in with Discord to play Ranked.',
                { selector: 'p' },
            ),
        ).toBeVisible();
        const roster = within(d).getByRole('combobox', { name: 'Roster' });
        // S14.4c-fix M6: locked, but focusable (aria-disabled) so its reason is read in order.
        expect(roster).toHaveAttribute('aria-disabled', 'true');
        expect(roster).toBeEnabled();
        expect(roster).toHaveValue('ClosedNoRating');
        expect(roster).toHaveAccessibleDescription('Guests always play Closed No Rating.');
    });

    it('before the profile has answered, Play Now says "Connecting…", never the guest line', async () => {
        const user = userEvent.setup();
        const conn = signInConnection();
        Object.assign(conn.db, { viewLobbyPresets: new MockTable<LobbyPresetViewRow>() });
        Object.assign(conn.reducers, { createLobby: vi.fn(), leaveLobby: vi.fn() });
        conn.db.viewMyProfile.seed(MEMBER);
        renderWithConnection('/', conn);
        await user.click(await playNow());
        expect(await screen.findByText('Connecting…')).toBeInTheDocument();
        expect(screen.queryByText('Creating your guest account…')).toBeNull();
        act(() => {
            conn.apply(LAYER0_QUERIES.profile);
            conn.apply(LAYER0_QUERIES.lobbies);
        });
        expect(
            await screen.findByRole('dialog', { name: 'Create Lobby' }, { timeout: 10_000 }),
        ).toBeInTheDocument();
        expect(conn.reducers.loginAsGuest).not.toHaveBeenCalled();
    });

    it('a member with a lobby is taken to it; no dialog, no guest call', async () => {
        const user = userEvent.setup();
        const { conn, router } = setup(MEMBER, [lobbyRow({ id: 5 })]);
        await user.click(await playNow());
        await waitFor(() => expect(router.state.location.pathname).toBe('/lobby/5'));
        expect(screen.queryByRole('dialog', { name: 'Create Lobby' })).toBeNull();
        expect(conn.reducers.loginAsGuest).not.toHaveBeenCalled();
    });

    it('a lobby in AwaitingResult or an away match does not hold the person: the dialog opens', async () => {
        const user = userEvent.setup();
        setup(MEMBER, [
            lobbyRow({ id: 3, stage: { tag: 'AwaitingResult' } }),
            lobbyRow({ id: 4, stage: { tag: 'Drafting' }, isAway: true }),
        ]);
        expect(await openDialog(user)).toBeInTheDocument();
    });

    it('the dialog subscribes the cost sets and the presets only while open', async () => {
        const user = userEvent.setup();
        const { conn } = setup(MEMBER);
        await playNow();
        expect(conn.liveQueries()).not.toContain(LOBBY_PRESETS_QUERY);
        const d = await openDialog(user);
        await waitFor(() =>
            expect(conn.liveQueries()).toEqual(
                expect.arrayContaining([PUBLISHED_COST_SETS_QUERY, LOBBY_PRESETS_QUERY]),
            ),
        );
        // Nothing changed: the close button closes it without asking.
        await user.click(within(d).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await waitFor(() => expect(conn.liveQueries()).not.toContain(LOBBY_PRESETS_QUERY));
        expect(conn.liveQueries()).not.toContain(PUBLISHED_COST_SETS_QUERY);
    });
});

describe('Create', () => {
    it('sends the form as create_lobby arguments and lands on the new lobby', async () => {
        const user = userEvent.setup();
        const { createLobby, router } = setup(MEMBER);
        const d = await openDialog(user);
        await user.type(within(d).getByRole('textbox', { name: 'Lobby Name' }), '  Sunday Scrims ');
        await user.selectOptions(within(d).getByRole('combobox', { name: 'Team Size' }), '2');
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/lobby/77'));
        expect(createLobby).toHaveBeenCalledOnce();
        expect(createLobby.mock.calls[0]?.[0]).toMatchObject({
            name: 'Sunday Scrims',
            isPublic: true,
            password: '',
            teamSize: 2,
            gameMode: { tag: 'ApocalypticShadow' },
            draftMode: { tag: 'Classic' },
            banMode: { tag: 'Six' },
            characterBudget: 30,
            lightconeBudget: 15,
        });
        expect(createLobby.mock.calls[0]?.[0]).not.toHaveProperty('abandonCurrentMatch');
    });

    it('a password makes it private; a refused character is shown at once and blocks Create', async () => {
        const user = userEvent.setup();
        const { createLobby } = setup(MEMBER);
        const d = await openDialog(user);
        const password = within(d).getByLabelText('Lobby Password');
        expect(password).toHaveAttribute('aria-invalid', 'false');
        await user.type(password, 'abc!');
        expect(password).toHaveAttribute('aria-invalid', 'true');
        expect(password).toHaveAccessibleDescription(
            'Use letters and numbers only (A–⁠Z, a–⁠z, 0–⁠9).',
        );
        expect(within(d).getByText('Private')).toBeInTheDocument();
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        expect(createLobby).not.toHaveBeenCalled();
        expect(password).toHaveFocus();
        await user.type(password, '{Backspace}');
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        await waitFor(() => expect(createLobby).toHaveBeenCalledOnce());
        expect(createLobby.mock.calls[0]?.[0]).toMatchObject({ isPublic: false, password: 'abc' });
    });

    it('a refusal keeps the dialog open with the module sentence in the error slot', async () => {
        const user = userEvent.setup();
        const { createLobby, router } = setup(MEMBER);
        createLobby.mockRejectedValueOnce(
            new SenderError('Lobby creation limit reached: at most 10 lobbies per hour.'),
        );
        const d = await openDialog(user);
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        await waitFor(() =>
            expect(d.querySelector('[data-dialog-error]')).toHaveTextContent(
                'Lobby creation limit reached: at most 10 lobbies per hour.',
            ),
        );
        expect(screen.getByRole('dialog', { name: 'Create Lobby' })).toBeInTheDocument();
        expect(router.state.location.pathname).toBe('/');
        expect(within(d).getByRole('button', { name: 'Create' })).toHaveAttribute(
            'aria-disabled',
            'false',
        );
    });

    // S14.4c-fix S1: the give-up question replaces "Create anyway".
    const pastGuard = () => new Promise((r) => setTimeout(r, ABANDON_CONFIRM_GUARD_MS + 50));

    it('away from a live match: Create asks first, naming the lobby, Keep my match focused; only its confirm sends abandonCurrentMatch', async () => {
        const user = userEvent.setup();
        const { createLobby, router } = setup(MEMBER, [
            lobbyRow({
                id: 4,
                name: 'Old Cup',
                joinCode: 'ZZ99YY',
                stage: { tag: 'Drafting' },
                isAway: true,
            }),
        ]);
        const d = await openDialog(user);
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        const ask = await screen.findByRole('dialog', { name: 'Give up your match?' });
        expect(ask).toHaveAccessibleDescription(
            'You left lobby Old Cup (ZZ99YY) mid-match. Creating this lobby gives that match up: you cannot return to it.',
        );
        expect(within(ask).getByRole('button', { name: 'Keep my match' })).toHaveFocus();
        expect(createLobby).not.toHaveBeenCalled();
        // Create keeps its label and meaning.
        expect(within(d).getByRole('button', { name: 'Create' })).toBeInTheDocument();
        expect(within(d).queryByRole('button', { name: /anyway/ })).toBeNull();

        await user.click(within(ask).getByRole('button', { name: 'Keep my match' }));
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Give up your match?' })).toBeNull(),
        );
        expect(createLobby).not.toHaveBeenCalled();

        await user.click(within(d).getByRole('button', { name: 'Create' }));
        const again = await screen.findByRole('dialog', { name: 'Give up your match?' });
        await pastGuard();
        await user.click(within(again).getByRole('button', { name: 'Give it up and create' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/lobby/77'));
        expect(createLobby).toHaveBeenCalledOnce();
        expect(createLobby.mock.calls[0]?.[0]).toMatchObject({ abandonCurrentMatch: true });
    });

    it('a held Enter or a double click never gives the match up', async () => {
        const user = userEvent.setup();
        const { createLobby } = setup(MEMBER, [
            lobbyRow({ id: 4, joinCode: 'ZZ99YY', stage: { tag: 'Scoring' }, isAway: true }),
        ]);
        const d = await openDialog(user);
        const name = within(d).getByRole('textbox', { name: 'Lobby Name' });
        await user.click(name);
        // A held Enter: the first opens the question, the repeats land on "Keep my match".
        await user.keyboard('{Enter}{Enter}{Enter}{Enter}');
        // A double click on Create: the second click hits the question's confirm within the guard.
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        const ask = await screen.findByRole('dialog', { name: 'Give up your match?' });
        await user.click(within(ask).getByRole('button', { name: 'Give it up and create' }));
        expect(screen.getByRole('dialog', { name: 'Give up your match?' })).toBeInTheDocument();
        for (const call of createLobby.mock.calls) {
            expect(call[0]).not.toHaveProperty('abandonCurrentMatch');
        }
        expect(createLobby).not.toHaveBeenCalled();
    });

    it('the module A68(4) prompt asks the same question; the error slot stays clear', async () => {
        const user = userEvent.setup();
        const { createLobby, router } = setup(MEMBER);
        createLobby.mockRejectedValueOnce(
            new SenderError(
                'You left lobby ZZ99YY mid-match. Joining here means you cannot return to it.',
            ),
        );
        const d = await openDialog(user);
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        const ask = await screen.findByRole('dialog', { name: 'Give up your match?' });
        expect(ask).toHaveAccessibleDescription(
            'You left lobby ZZ99YY mid-match. Creating this lobby gives that match up: you cannot return to it.',
        );
        expect(d.querySelector('[data-dialog-error]')).toBeEmptyDOMElement();
        expect(within(d).getByRole('button', { name: 'Create' })).toBeInTheDocument();
        await pastGuard();
        await user.click(within(ask).getByRole('button', { name: 'Give it up and create' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/lobby/77'));
        expect(createLobby.mock.calls[0]?.[0]).not.toHaveProperty('abandonCurrentMatch');
        expect(createLobby.mock.calls[1]?.[0]).toMatchObject({ abandonCurrentMatch: true });
    });

    it('a lobby taken in another tab while open: the error slot offers the way there', async () => {
        const user = userEvent.setup();
        const { conn, createLobby, router } = setup(MEMBER);
        const d = await openDialog(user);
        await user.type(within(d).getByRole('textbox', { name: 'Lobby Name' }), 'Draft');
        act(() =>
            conn.db.viewMyLobbies.insert(
                lobbyRow({ id: 12, name: 'Other tab', joinCode: 'QQ11WW' }),
            ),
        );
        expect(d.querySelector('[data-dialog-error]')).toHaveTextContent(
            'You are already in lobby Other tab (QQ11WW). Leave it before creating another.',
        );
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        expect(createLobby).not.toHaveBeenCalled();
        await user.click(within(d).getByRole('button', { name: 'Go to your lobby' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/lobby/12'));
    });

    it('a lost answer: the new row arrives, so it goes to the lobby', async () => {
        const user = userEvent.setup();
        const { conn, createLobby, router } = setup(MEMBER);
        createLobby.mockImplementationOnce(async () => {
            setTimeout(() => conn.db.viewMyLobbies.insert(lobbyRow({ id: 31 })), 20);
            throw new UnknownCallResultError();
        });
        const d = await openDialog(user);
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/lobby/31'));
    });

    it.each([
        [
            'a lost answer',
            () => new UnknownCallResultError(),
            'The connection dropped before the server answered, and no new lobby has arrived. Press Play Now to check: it opens the lobby if it was created.',
        ],
        [
            'a server error',
            () => new InternalError('out of energy'),
            'The server hit an error and did not create the lobby. Press Play Now to try again; your settings are kept.',
        ],
    ])(
        '%s with no new row: the dialog closes, the draft is kept, the line is under Play Now',
        async (_, error, line) => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            try {
                const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
                const { createLobby, router } = setup(MEMBER);
                createLobby.mockRejectedValueOnce(error());
                const d = await openDialog(user);
                await user.type(within(d).getByRole('textbox', { name: 'Lobby Name' }), 'Kept');
                await user.click(within(d).getByRole('button', { name: 'Create' }));
                await act(async () => {
                    vi.advanceTimersByTime(NEW_LOBBY_WAIT_MS);
                });
                await waitFor(() =>
                    expect(screen.queryByRole('dialog', { name: 'Create Lobby' })).toBeNull(),
                );
                expect(screen.getByText(line)).toBeInTheDocument();
                expect(router.state.location.pathname).toBe('/');
                const reopened = await openDialog(user);
                expect(within(reopened).getByRole('textbox', { name: 'Lobby Name' })).toHaveValue(
                    'Kept',
                );
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it('while the call is in flight the dialog cannot be dismissed', async () => {
        const user = userEvent.setup();
        const { createLobby, conn } = setup(MEMBER);
        let finish: () => void = () => {};
        createLobby.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = () => {
                        conn.db.viewMyLobbies.insert(lobbyRow());
                        resolve();
                    };
                }),
        );
        const d = await openDialog(user);
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        expect(within(d).getByRole('button', { name: 'Creating…' })).toHaveAttribute(
            'aria-disabled',
            'true',
        );
        expect(within(d).getByRole('button', { name: 'Close' })).toHaveAttribute(
            'aria-disabled',
            'true',
        );
        expect(fireEvent(d, new Event('cancel', { cancelable: true }))).toBe(false);
        await act(async () => finish());
    });
});

describe('closing', () => {
    it('with changes it asks first; Keep editing keeps them, Discard closes, and the next open starts fresh', async () => {
        const user = userEvent.setup();
        setup(MEMBER);
        const d = await openDialog(user);
        await user.type(within(d).getByRole('textbox', { name: 'Lobby Name' }), 'Mine');
        // Escape: the cancel event is refused and the question opens.
        expect(fireEvent(d, new Event('cancel', { cancelable: true }))).toBe(false);
        const ask = await screen.findByRole('dialog', { name: 'Discard this lobby?' });
        await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Discard this lobby?' })).toBeNull(),
        );
        expect(within(d).getByRole('textbox', { name: 'Lobby Name' })).toHaveValue('Mine');

        await user.click(within(d).getByRole('button', { name: 'Close' }));
        const again = await screen.findByRole('dialog', { name: 'Discard this lobby?' });
        await user.click(within(again).getByRole('button', { name: 'Discard' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        const reopened = await openDialog(user);
        expect(within(reopened).getByRole('textbox', { name: 'Lobby Name' })).toHaveValue('');
    });

    it('a close that could not be refused keeps the changes for the next Play Now', async () => {
        const user = userEvent.setup();
        setup(MEMBER);
        const d = await openDialog(user);
        await user.type(within(d).getByRole('textbox', { name: 'Lobby Name' }), 'Kept');
        // Chromium's second Escape in a row: the dialog closes without a cancel the page could refuse.
        act(() => {
            d.removeAttribute('open');
            d.dispatchEvent(new Event('close'));
        });
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Create Lobby' })).toBeNull(),
        );
        const reopened = await openDialog(user);
        expect(within(reopened).getByRole('textbox', { name: 'Lobby Name' })).toHaveValue('Kept');
    });
});

describe('cost sets and presets', () => {
    const SET: CostSet = {
        id: 9,
        name: 'Yuji Open',
        creatorId: 1,
        gameMode: { tag: 'MemoryOfChaos' },
        isPublished: true,
        isDraft: false,
        isLocked: false,
        createdById: 1,
        createdDate: { microsSinceUnixEpoch: 0n } as CostSet['createdDate'],
        lastModifiedById: 1,
        lastModifiedDate: { microsSinceUnixEpoch: 0n } as CostSet['lastModifiedDate'],
    };

    it('a custom cost set fixes the game mode and says why', async () => {
        const user = userEvent.setup();
        const { conn } = setup(MEMBER);
        conn.db.viewPublishedCostSets.seed(SET);
        const d = await openDialog(user);
        act(() => conn.applyAll());
        await user.selectOptions(await within(d).findByRole('combobox', { name: 'Cost Set' }), '9');
        const mode = within(d).getByRole('combobox', { name: 'Game Mode' });
        // S14.4c-fix M6: locked by aria-disabled (focusable); a change is ignored.
        expect(mode).toHaveAttribute('aria-disabled', 'true');
        expect(mode).toHaveValue('MemoryOfChaos');
        expect(mode).toHaveAccessibleDescription(
            'The cost set Yuji Open is for Memory of Chaos only. Pick Default to change the game mode.',
        );
        mode.focus();
        expect(mode).toHaveFocus();
        fireEvent.change(mode, { target: { value: 'ApocalypticShadow' } });
        expect(mode).toHaveValue('MemoryOfChaos');
    });

    it('a kept custom cost set is not called "not available" before the sets arrive (a fast Create)', async () => {
        const user = userEvent.setup();
        const { conn, createLobby } = setup(MEMBER);
        conn.db.viewPublishedCostSets.seed(SET);
        const d = await openDialog(user);
        act(() => conn.applyAll());
        await user.selectOptions(await within(d).findByRole('combobox', { name: 'Cost Set' }), '9');
        // A close that could not be refused: the draft is kept.
        act(() => {
            d.removeAttribute('open');
            d.dispatchEvent(new Event('close'));
        });
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Create Lobby' })).toBeNull(),
        );
        // Unsubscribed: the client cache drops the rows (the mock keeps them unless told).
        act(() => conn.db.viewPublishedCostSets.delete(SET));
        // Reopened: the dialog's subscriptions start again and have not answered yet.
        const reopened = await openDialog(user);
        // Not arrived yet: the kept set shows by its id.
        expect(within(reopened).getByRole('option', { name: 'Cost set 9' })).toBeInTheDocument();
        await user.click(within(reopened).getByRole('button', { name: 'Create' }));
        expect(
            within(reopened).queryByText('This cost set is not available. Pick another one.'),
        ).toBeNull();
        await waitFor(() => expect(createLobby).toHaveBeenCalledOnce());
        expect(createLobby.mock.calls[0]?.[0]).toMatchObject({ costSetId: 9 });
    });

    it('picking a preset copies its values and keeps the name', async () => {
        const user = userEvent.setup();
        const { conn, presets } = setup(MEMBER);
        presets.seed({
            id: 1,
            name: 'Tournament default',
            isSystemPreset: true,
            creatorUserId: 0,
            teamSize: 1,
            draftMode: { tag: 'Classic' },
            banMode: { tag: 'Four' },
            banRestriction: { tag: 'NoRestriction' },
            lineupFormat: { tag: 'Halves' },
            gameMode: { tag: 'MemoryOfChaos' },
            matchType: { tag: 'Casual' },
            standardTurnSeconds: 60,
            reserveBankSeconds: 120,
            confirmWindowSeconds: 60,
            characterBudget: 0,
            lightconeBudget: 0,
            minimumBidRaise: 20,
            rosterDiffAdvantage: 0,
            rosterThreshold: 0,
            underThresholdAdvantage: 0,
            aboveThresholdPenalty: 0,
            deathPenalty: 0,
            isPublic: true,
            isAnonymousPlayers: false,
            isAnonymousSpectators: false,
            hideMmr: false,
            rosterVisibility: { tag: 'OpenRoster' },
            requireOwnership: false,
            costSetId: 0,
            disconnectPolicy: { tag: 'Standard' },
            disconnectForfeitSeconds: undefined,
            allowMirrorPicks: false,
            autoRandomPick: false,
            refereeCanUndo: true,
            refereeCanPause: true,
            refereeCanSetCaptain: true,
            refereeCanKick: false,
            allowPlayerPause: true,
            refereeExclusiveConcede: true,
            maxSpectators: 12,
        });
        const d = await openDialog(user);
        act(() => conn.applyAll());
        await user.type(within(d).getByRole('textbox', { name: 'Lobby Name' }), 'Cup night');
        const preset = within(d).getByRole('combobox', { name: 'Settings Preset' });
        await waitFor(() => expect(within(preset).getAllByRole('option')).toHaveLength(3));
        await user.selectOptions(preset, 'preset:1');
        expect(preset).toHaveValue('preset:1');
        expect(within(d).getByRole('combobox', { name: 'Team Size' })).toHaveValue('1');
        expect(within(d).getByRole('combobox', { name: 'Ban Mode' })).toHaveValue('Four');
        expect(within(d).getByRole('combobox', { name: 'Game Mode' })).toHaveValue('MemoryOfChaos');
        expect(within(d).getByRole('textbox', { name: 'Lobby Name' })).toHaveValue('Cup night');
        await user.selectOptions(preset, 'builtin:auction');
        expect(within(d).getByRole('combobox', { name: 'Draft Mode' })).toHaveValue('Auction');
        expect(within(d).getByRole('combobox', { name: 'Team Size' })).toHaveValue('3');
    });
});

// T-S14.4d: Advanced Settings as a second dialog over Create (L3 option A, the mockup's form).
describe('Advanced Settings (S14.4d)', () => {
    const advancedDialog = () => screen.findByRole('dialog', { name: 'Advanced Settings' });

    it('opens over Create; its values reach create_lobby; the preset select says Custom', async () => {
        const user = userEvent.setup();
        const { createLobby } = setup(MEMBER);
        const d = await openDialog(user);
        const button = within(d).getByRole('button', { name: 'Advanced Settings' });
        expect(button).toHaveAttribute('aria-haspopup', 'dialog');
        expect(within(d).queryByText(/not editable here yet/)).toBeNull();
        await user.click(button);
        const a = await advancedDialog();
        await user.selectOptions(
            within(a).getByRole('combobox', { name: 'Ban Restriction' }),
            'MaxOneSupport',
        );
        const turn = within(a).getByRole('textbox', { name: 'Standard Turn (seconds)' });
        await user.clear(turn);
        await user.type(turn, '45');
        const death = within(a).getByRole('textbox', { name: 'Death Penalty (points)' });
        await user.clear(death);
        await user.type(death, '1,5');
        const spectators = within(a).getByRole('textbox', { name: 'Spectators (at most)' });
        await user.clear(spectators);
        await user.type(spectators, '4');
        await user.click(within(a).getByRole('button', { name: 'Done' }));
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Advanced Settings' })).toBeNull(),
        );
        expect(button).toHaveFocus();
        expect(within(d).getByRole('combobox', { name: 'Settings Preset' })).toHaveValue('custom');
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        await waitFor(() => expect(createLobby).toHaveBeenCalledOnce());
        expect(createLobby.mock.calls[0]?.[0]).toMatchObject({
            banRestriction: { tag: 'MaxOneSupport' },
            standardTurnSeconds: 45,
            deathPenalty: 150,
            maxSpectators: 4,
        });
    });

    it('a setting there that needs a fix: the button counts it; Create opens Advanced Settings and focuses it', async () => {
        const user = userEvent.setup();
        const { createLobby } = setup(MEMBER);
        const d = await openDialog(user);
        await user.click(within(d).getByRole('button', { name: 'Advanced Settings' }));
        const a = await advancedDialog();
        const reserve = within(a).getByRole('textbox', { name: 'Reserve Bank (seconds)' });
        await user.clear(reserve);
        await user.type(reserve, '2000');
        await user.click(within(a).getByRole('button', { name: 'Close Advanced Settings' }));
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Advanced Settings' })).toBeNull(),
        );
        expect(
            within(d).getByRole('button', {
                name: 'Advanced Settings, 1 setting needs a fix',
            }),
        ).toHaveAttribute('data-has-errors');
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        const again = await advancedDialog();
        const field = within(again).getByRole('textbox', { name: 'Reserve Bank (seconds)' });
        await waitFor(() => expect(field).toHaveFocus());
        expect(field).toHaveValue('2000');
        expect(field).toHaveAccessibleDescription('The reserve bank is 0 to 1800 seconds.');
        expect(createLobby).not.toHaveBeenCalled();
    });

    it('a main field that needs a fix takes focus first; Advanced Settings stays closed', async () => {
        const user = userEvent.setup();
        const { createLobby } = setup(MEMBER);
        const d = await openDialog(user);
        await user.click(within(d).getByRole('button', { name: 'Advanced Settings' }));
        const a = await advancedDialog();
        const turn = within(a).getByRole('textbox', { name: 'Standard Turn (seconds)' });
        await user.clear(turn);
        await user.type(turn, '5');
        await user.click(within(a).getByRole('button', { name: 'Close Advanced Settings' }));
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Advanced Settings' })).toBeNull(),
        );
        const password = within(d).getByLabelText('Lobby Password');
        await user.type(password, 'a-b');
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        expect(password).toHaveFocus();
        expect(screen.queryByRole('dialog', { name: 'Advanced Settings' })).toBeNull();
        expect(createLobby).not.toHaveBeenCalled();
    });

    it('an Auction lobby with a raise of 0 is stopped by the form (A224)', async () => {
        const user = userEvent.setup();
        const { createLobby } = setup(MEMBER);
        const d = await openDialog(user);
        await user.selectOptions(
            within(d).getByRole('combobox', { name: 'Draft Mode' }),
            'Auction',
        );
        await user.click(within(d).getByRole('button', { name: 'Advanced Settings' }));
        const a = await advancedDialog();
        const raise = within(a).getByRole('textbox', { name: 'Minimum Bid Raise' });
        await user.clear(raise);
        await user.type(raise, '0');
        await user.click(within(a).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(raise).toHaveFocus());
        expect(raise).toHaveAccessibleDescription(
            'An Auction lobby needs a minimum bid raise above 0.',
        );
        expect(createLobby).not.toHaveBeenCalled();
    });

    it('an edit made only in Advanced Settings counts for the discard question', async () => {
        const user = userEvent.setup();
        setup(MEMBER);
        const d = await openDialog(user);
        await user.click(within(d).getByRole('button', { name: 'Advanced Settings' }));
        const a = await advancedDialog();
        await user.click(
            within(within(a).getByRole('group', { name: 'Hide MMR' })).getByRole('button', {
                name: 'On',
            }),
        );
        await user.click(within(a).getByRole('button', { name: 'Done' }));
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Advanced Settings' })).toBeNull(),
        );
        await user.click(within(d).getByRole('button', { name: 'Close' }));
        expect(
            await screen.findByRole('dialog', { name: 'Discard this lobby?' }),
        ).toBeInTheDocument();
    });
});

// T-S14.4d-fix: review D S1, S2, S4, M3, M4, M5, M9.
describe('Advanced Settings (S14.4d-fix)', () => {
    const advancedDialog = () => screen.findByRole('dialog', { name: 'Advanced Settings' });
    type User = ReturnType<typeof userEvent.setup>;
    const typeInto = async (user: User, a: HTMLElement, name: string, text: string) => {
        const field = within(a).getByRole('textbox', { name });
        await user.clear(field);
        await user.type(field, text);
        return field;
    };
    const pick = async (user: User, a: HTMLElement, group: string, choice: 'On' | 'Off') =>
        user.click(
            within(within(a).getByRole('group', { name: group })).getByRole('button', {
                name: choice,
            }),
        );
    const closeAdvanced = async (user: User, a: HTMLElement) => {
        await user.click(within(a).getByRole('button', { name: 'Done' }));
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Advanced Settings' })).toBeNull(),
        );
    };

    it('S1: it opens with focus on Ban Restriction and no info panel open', async () => {
        const user = userEvent.setup();
        setup(MEMBER);
        const d = await openDialog(user);
        await user.click(within(d).getByRole('button', { name: 'Advanced Settings' }));
        const a = await advancedDialog();
        await waitFor(() =>
            expect(within(a).getByRole('combobox', { name: 'Ban Restriction' })).toHaveFocus(),
        );
        // Past the popover's open delay (200 ms).
        await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
        for (const info of within(a).getAllByRole('button', { name: /^About / }))
            expect(info).toHaveAttribute('aria-expanded', 'false');
        expect(within(a).queryByRole('tooltip')).toBeNull();
    });

    it('M9: every advanced field reaches create_lobby (Classic)', async () => {
        const user = userEvent.setup();
        const { createLobby } = setup(MEMBER);
        const d = await openDialog(user);
        await user.click(within(d).getByRole('button', { name: 'Advanced Settings' }));
        const a = await advancedDialog();
        await user.selectOptions(
            within(a).getByRole('combobox', { name: 'Ban Restriction' }),
            'MaxTwoDps',
        );
        await user.selectOptions(
            within(a).getByRole('combobox', { name: 'Lineup Format' }),
            'Thirds',
        );
        await typeInto(user, a, 'Blue Team Name', '  Sharks ');
        await typeInto(user, a, 'Red Team Name', 'Jets');
        await pick(user, a, 'Mirror Picks', 'On');
        await pick(user, a, 'Random Auto-Pick', 'On');
        await typeInto(user, a, 'Death Penalty (points)', '1,5');
        await typeInto(
            user,
            a,
            'Roster Diff Advantage (points per point of roster-cost difference)',
            '2',
        );
        await typeInto(user, a, 'Roster Threshold (roster cost)', '25.5');
        await typeInto(user, a, 'Under-Threshold Advantage (points)', '0.25');
        await typeInto(user, a, 'Above-Threshold Penalty (points)', '-3');
        await pick(user, a, 'Require Ownership', 'On');
        await typeInto(user, a, 'Standard Turn (seconds)', '45');
        await typeInto(user, a, 'Reserve Bank (seconds)', '90');
        await typeInto(user, a, 'Confirm Window (seconds)', '30');
        await pick(user, a, 'Referee Can Undo', 'Off');
        await pick(user, a, 'Referee Can Pause', 'Off');
        await pick(user, a, 'Referee Can Set Captain', 'Off');
        await pick(user, a, 'Referee Can Kick', 'On');
        await pick(user, a, 'Players Can Pause', 'Off');
        await pick(user, a, 'Referee-Only Concede', 'Off');
        await pick(user, a, 'Anonymous Spectators', 'On');
        await pick(user, a, 'Hide MMR', 'On');
        await typeInto(user, a, 'Spectators (at most)', '4');
        await user.selectOptions(
            within(a).getByRole('combobox', { name: 'Disconnect Policy' }),
            'NoAction',
        );
        await typeInto(user, a, 'Auto-Forfeit (seconds)', '120');
        await closeAdvanced(user, a);
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        await waitFor(() => expect(createLobby).toHaveBeenCalledOnce());
        expect(createLobby.mock.calls[0]?.[0]).toMatchObject({
            banRestriction: { tag: 'MaxTwoDps' },
            lineupFormat: { tag: 'Thirds' },
            teamBlueAlias: 'Sharks',
            teamRedAlias: 'Jets',
            allowMirrorPicks: true,
            autoRandomPick: true,
            deathPenalty: 150,
            rosterDiffAdvantage: 200,
            rosterThreshold: 2550,
            underThresholdAdvantage: 25,
            aboveThresholdPenalty: -300,
            requireOwnership: true,
            standardTurnSeconds: 45,
            reserveBankSeconds: 90,
            confirmWindowSeconds: 30,
            refereeCanUndo: false,
            refereeCanPause: false,
            refereeCanSetCaptain: false,
            refereeCanKick: true,
            allowPlayerPause: false,
            refereeExclusiveConcede: false,
            isAnonymousSpectators: true,
            hideMmr: true,
            maxSpectators: 4,
            disconnectPolicy: { tag: 'NoAction' },
            disconnectForfeitSeconds: 120,
        });
    });

    it('M9, M4, S4: the Auction amounts reach create_lobby as shown; mirror picks and auto-pick are sent false', async () => {
        const user = userEvent.setup();
        const { createLobby } = setup(MEMBER);
        const d = await openDialog(user);
        await user.click(within(d).getByRole('button', { name: 'Advanced Settings' }));
        let a = await advancedDialog();
        await pick(user, a, 'Mirror Picks', 'On');
        await pick(user, a, 'Random Auto-Pick', 'On');
        await closeAdvanced(user, a);
        await user.selectOptions(
            within(d).getByRole('combobox', { name: 'Draft Mode' }),
            'Auction',
        );
        await user.click(within(d).getByRole('button', { name: 'Advanced Settings' }));
        a = await advancedDialog();
        for (const group of ['Mirror Picks', 'Random Auto-Pick'])
            expect(
                within(within(a).getByRole('group', { name: group })).getByRole('button', {
                    pressed: true,
                }),
            ).toHaveTextContent('Off');
        const budget = await typeInto(user, a, 'Character Budget', '$40');
        const cones = await typeInto(user, a, 'Light Cone Budget', '20,5');
        const raise = await typeInto(user, a, 'Minimum Bid Raise', '2.50');
        await user.tab();
        expect(budget).toHaveValue('40');
        expect(cones).toHaveValue('20.5');
        expect(raise).toHaveValue('2.5');
        await closeAdvanced(user, a);
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        await waitFor(() => expect(createLobby).toHaveBeenCalledOnce());
        expect(createLobby.mock.calls[0]?.[0]).toMatchObject({
            draftMode: { tag: 'Auction' },
            characterBudget: 40,
            lightconeBudget: 20.5,
            minimumBidRaise: 2.5,
            allowMirrorPicks: false,
            autoRandomPick: false,
        });
    });

    it('S2: a preset picked after a team name keeps it; typing a team name keeps the preset name', async () => {
        const user = userEvent.setup();
        const { createLobby } = setup(MEMBER);
        const d = await openDialog(user);
        const preset = within(d).getByRole('combobox', { name: 'Settings Preset' });
        await user.click(within(d).getByRole('button', { name: 'Advanced Settings' }));
        let a = await advancedDialog();
        await typeInto(user, a, 'Blue Team Name', 'Sharks');
        await closeAdvanced(user, a);
        expect(preset).toHaveValue('builtin:classic');
        await user.selectOptions(preset, 'builtin:auction');
        expect(preset).toHaveValue('builtin:auction');
        await user.click(within(d).getByRole('button', { name: 'Advanced Settings' }));
        a = await advancedDialog();
        expect(within(a).getByRole('textbox', { name: 'Blue Team Name' })).toHaveValue('Sharks');
        expect(within(a).getByText(/Settings Preset: Default Auction\./)).toBeInTheDocument();
        await closeAdvanced(user, a);
        await user.click(within(d).getByRole('button', { name: 'Create' }));
        await waitFor(() => expect(createLobby).toHaveBeenCalledOnce());
        expect(createLobby.mock.calls[0]?.[0]).toMatchObject({
            draftMode: { tag: 'Auction' },
            teamBlueAlias: 'Sharks',
        });
    });

    it('M5: a typed number text survives the create dialog closing with its draft kept', async () => {
        const user = userEvent.setup();
        setup(MEMBER);
        const d = await openDialog(user);
        await user.click(within(d).getByRole('button', { name: 'Advanced Settings' }));
        const a = await advancedDialog();
        await typeInto(user, a, 'Confirm Window (seconds)', 'abc');
        await user.click(within(a).getByRole('button', { name: 'Close Advanced Settings' }));
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Advanced Settings' })).toBeNull(),
        );
        // A close that could not be refused: the draft is kept.
        act(() => {
            d.removeAttribute('open');
            d.dispatchEvent(new Event('close'));
        });
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: 'Create Lobby' })).toBeNull(),
        );
        const reopened = await openDialog(user);
        await user.click(
            within(reopened).getByRole('button', {
                name: 'Advanced Settings, 1 setting needs a fix',
            }),
        );
        const again = await advancedDialog();
        const field = within(again).getByRole('textbox', { name: 'Confirm Window (seconds)' });
        expect(field).toHaveValue('abc');
        expect(field).toHaveAccessibleDescription('The confirm window is 0 to 300 seconds.');
    });
});
