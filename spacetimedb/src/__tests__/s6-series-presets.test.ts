// T-S6 / T-S8e: in-memory tests for the lobby free set, presets and the tournament series settings (A67: no lobby series) (backlog #6, #7, #8, #9; BACKEND-BUGS F2;
// DECISIONS A27, A28, A33, A33a, A38). Reuses the S4 builders; in-memory datastore on the TestClock, no maincloud.
// Admin / TournamentHost calls run as the owner identity (TestAuth.internal()), which init links to SYSTEM (Admin).
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    captainOf,
    expectReject,
    guest,
    lobbyRow,
    member,
    newHarness,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
} from './s4-fixtures';
import { finishGame as closeCurrentGame } from './s7-fixtures';

const BEST_OF = 'bestOf must be 1 or 3.';

const PRESET_ARGS = {
    teamSize: 2,
    draftMode: { tag: 'Classic' },
    banMode: { tag: 'None' },
    gameMode: { tag: 'MemoryOfChaos' },
    matchType: { tag: 'Casual' },
    standardTurnSeconds: 30,
    reserveBankSeconds: 60,
    characterBudget: 100,
    lightconeBudget: 50,
    minimumBidRaise: 1,
    rosterDiffAdvantage: 0,
    rosterThreshold: 0,
    underThresholdAdvantage: 0,
    aboveThresholdPenalty: 0,
    deathPenalty: 0,
    isPublic: true,
    isAnonymousPlayers: false,
    isAnonymousSpectators: false,
    rosterVisibility: { tag: 'OpenRoster' },
    requireOwnership: false,
    costSetId: 0,
    disconnectPolicy: { tag: 'Standard' },
    disconnectForfeitSeconds: 60,
    allowMirrorPicks: false,
    autoRandomPick: false,
    refereeCanUndo: true,
    refereeCanPause: true,
    refereeCanSetCaptain: true,
    refereeCanKick: true,
    allowPlayerPause: true,
    refereeExclusiveConcede: true,
};

const TOURNAMENT_ARGS = {
    name: 'Cup',
    description: '',
    format: 'SingleElimination',
    teamSize: 1,
    defaultGameMode: 'MemoryOfChaos',
    maxParticipants: 8,
    rosterVisibility: 'OpenRoster',
    isAnonymousDefault: false,
    disconnectPolicy: 'Standard',
    costSetId: 0,
    defaultBestOf: 3,
    groupSize: 4,
    has3rdPlaceMatch: false,
    countTowardsMmr: false,
    winnerAdvantage: 0,
    requireOwnership: false,
    requireVerified: false,
    requireRoster: false,
    minimumMmr: 0,
    requireApproval: false,
    waitlistEnabled: false,
    scheduledStartAt: '',
    registrationDeadline: '',
    maxAccountsPerPlayer: 1,
    // T-S8b: the A36 argument set (grandFinalBestOf carries the final's length, A28)
    grandFinalBestOf: 3,
    groupAdvanceCount: 2,
    groupAssignmentMode: 'Auto',
    checkInEnabled: false,
    requireResultValidation: false,
    allowMirrorPicks: false,
    lineupFormat: 'Halves',
};

/** update_lobby_settings arguments mirroring the create defaults, with overrides. */
const settingsArgs = (lobbyId: number, over: Record<string, unknown> = {}) => {
    const { joinCode: _j, presetId: _p, ...rest } = DEFAULT_LOBBY_ARGS;
    return { lobbyId, ...rest, refereeExclusiveConcede: true, ...over } as any;
};

const createTournament = (test: Harness, over: Record<string, unknown> = {}) =>
    tx(test, 'internal', (ctx) => M.create_tournament(ctx, { ...TOURNAMENT_ARGS, ...over } as any));
const tournaments = (test: Harness) => [...test.db.Tournament.iter()];
const updateTournamentArgs = (t: any, over: Record<string, unknown> = {}) => ({
    tournamentId: t.id,
    name: t.name,
    description: t.description,
    rosterVisibility: 'OpenRoster',
    isAnonymousDefault: false,
    disconnectPolicy: 'Standard',
    costSetId: 0,
    defaultBestOf: t.defaultBestOf,
    groupSize: 4,
    has3rdPlaceMatch: false,
    winnerAdvantage: 0,
    requireOwnership: false,
    requireVerified: false,
    requireRoster: false,
    minimumMmr: 0,
    requireApproval: false,
    waitlistEnabled: false,
    scheduledStartAt: '',
    registrationDeadline: '',
    maxAccountsPerPlayer: 1,
    // T-S8b: the A36 update_tournament argument set
    format: t.format.tag,
    teamSize: t.teamSize,
    maxParticipants: t.maxParticipants,
    grandFinalBestOf: t.grandFinalBestOf,
    groupAdvanceCount: t.groupAdvanceCount,
    groupAssignmentMode: t.groupAssignmentMode.tag,
    checkInEnabled: t.checkInEnabled,
    requireResultValidation: t.requireResultValidation,
    allowMirrorPicks: t.allowMirrorPicks,
    lineupFormat: t.lineupFormat.tag,
    ...over,
}) as any;

const systemPresets = (test: Harness) => [...test.db.LobbyPreset.iter()].filter((p) => p.isSystemPreset);
const presetNamed = (test: Harness, name: string) => [...test.db.LobbyPreset.iter()].find((p) => p.name === name)!;

const actorOf = (s: Lobby, userId: number): Actor => Object.values(s.a).find((x) => x.userId === userId)!;
const captain = (s: Lobby, team: 'Blue' | 'Red') =>
    actorOf(s, captainOf(s.test, s.lobbyId, team === 'Blue' ? 'BluePlayer' : 'RedPlayer')!.userId);

/**
 * T-S7b / T-S8e: the lobby's one game is closed by the full-control host (A67: the close submits it): lineups arranged, Equipping → Scoring, both sides' scores (Blue wins), close_game (A63 staff close).
 */
function finishGame(s: Lobby) {
    closeCurrentGame(s, 'Blue');
}

/** Drafts a Classic game to completion: every step by the acting team's captain, distinct names per game. */
function draftClassicGame(s: Lobby, game: number) {
    let guard = 0;
    while (lobbyRow(s.test, s.lobbyId).stage.tag === 'Drafting' && guard++ < 40) {
        const sess = session(s.test, s.lobbyId);
        const step = sess.draftSequence[sess.turnIndex];
        const who = captain(s, step.teamTurn.tag as 'Blue' | 'Red');
        const characterName = `g${game}_${sess.turnIndex}`;
        if (step.actionRequired.tag === 'Pick') {
            tx(s.test, who, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 }));
        } else {
            tx(s.test, who, (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName }));
        }
    }
}

/** Drafts an Auction game (no bans) to completion: the nominator's captain nominates, the other captain passes. */
function draftAuctionGame(s: Lobby, game: number) {
    let guard = 0;
    while (lobbyRow(s.test, s.lobbyId).stage.tag === 'Drafting' && guard++ < 40) {
        const sess = session(s.test, s.lobbyId);
        const nominator = sess.nextNominatorTeam.tag as 'Blue' | 'Red';
        const other = nominator === 'Blue' ? 'Red' : 'Blue';
        tx(s.test, captain(s, nominator), (ctx) =>
            M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: `a${game}_${guard}` }));
        tx(s.test, captain(s, other), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
    }
}

// T-S8e (A67(1)(2)): the series tests of S6 lost their subject (BetweenGames, advance_to_next_game, the lobby / preset
// bestOf, bestOfNAdvantage, refereeControlsShelving, the start_draft head start). Deleted: "F2: game 2 of a Bo3
// drafts to completion" (Classic + Auction), "bestOf 0 on create_lobby keeps the D-11 sentinel", the casual
// bestOfNAdvantage tests (Red head start through game 1; Bo1 forces None). Kept and rewritten: one game drafts to
// completion (the F2 assertions that still have a subject), the tournament bestOf cap, the free-set edits in Waiting,
// the tournament-lobby lock, the tournament head-start validation, presets and the system preset without series fields.

describe("F2 (T-S8e): the lobby's one game drafts to completion", () => {
    it('Classic: 16 picks reach Equipping; the close of the game submits it (no next game)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        expect(session(test, s.lobbyId).draftSequence).toHaveLength(16);
        draftClassicGame(s, 1);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
        const picks = steps(test, s.lobbyId).filter((x) => x.action.tag === 'Pick');
        expect(picks).toHaveLength(16);
        expect('gameNumber' in picks[0]).toBe(false);
        expect('advance_to_next_game' in M).toBe(false);
        finishGame(s);
        // A67(1), A60(6): the close of the only game submits it; a casual Bo1 validates and finalizes inline.
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
    });

    it('Auction: 16 sales reach Equipping with 8 characters won per side', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' } } });
        expect(session(test, s.lobbyId).isAuctionPhase).toBe(true);
        draftAuctionGame(s, 1);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
        const done = session(test, s.lobbyId);
        expect(done.blueCharactersWon).toBe(8);
        expect(done.redCharactersWon).toBe(8);
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'AuctionSold')).toHaveLength(16);
    });
});

describe('A28 / A38(2) (T-S8e): bestOf capped to {1, 3} on tournaments; lobbies and presets carry no bestOf (A67(2))', () => {
    it('bestOf 5 is rejected on create_tournament / update_tournament; a stray bestOf on a lobby or preset is not stored', () => {
        const test = newHarness();
        expectReject(test, 'internal', (ctx) => M.create_tournament(ctx, { ...TOURNAMENT_ARGS, defaultBestOf: 5 } as any), BEST_OF);
        createTournament(test);
        const t = tournaments(test)[0];
        expectReject(test, 'internal', (ctx) => M.update_tournament(ctx, updateTournamentArgs(t, { defaultBestOf: 5 })), BEST_OF);

        // The reducers no longer declare the arguments; a client-built extra key has no column to land in.
        const solo = guest(test, 'solo');
        tx(test, solo, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, bestOf: 5, refereeControlsShelving: false } as any));
        const l = [...test.db.Lobby.iter()].find((x) => x.hostUserId === solo.userId)!;
        for (const k of ['bestOf', 'refereeControlsShelving', 'bestOfNAdvantage']) expect(k in l).toBe(false);
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'p', bestOf: 5 } as any));
        expect('bestOf' in presetNamed(test, 'p')).toBe(false);
    });
});

describe('Backlog #9 (T-S8e): the free set is editable in Waiting', () => {
    it('a casual host changes lineupFormat / banRestriction / hideMmr / name in Waiting and every confirmation resets', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        expect(member(test, s.lobbyId, s.a.b1.userId).isConfirmed).toBe(true);

        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, {
            lineupFormat: { tag: 'Thirds' }, banRestriction: { tag: 'MaxTwoDps' }, hideMmr: true, name: '  Friday scrim  ',
        })));
        const l = lobbyRow(test, s.lobbyId);
        expect(l.lineupFormat.tag).toBe('Thirds');
        expect(l.banRestriction.tag).toBe('MaxTwoDps');
        expect(l.hideMmr).toBe(true);
        expect(l.name).toBe('Friday scrim');
        for (const name of ['b1', 'b2', 'r1', 'r2']) {
            expect(member(test, s.lobbyId, s.a[name].userId).isConfirmed).toBe(false);
        }

        // Omitted keys keep their values.
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId)));
        const back = lobbyRow(test, s.lobbyId);
        expect(back.lineupFormat.tag).toBe('Thirds');
        expect(back.banRestriction.tag).toBe('MaxTwoDps');
        expect(back.name).toBe('Friday scrim');
    });

    it('a tournament lobby rejects a lineupFormat change and accepts free-set edits', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        const row = lobbyRow(test, s.lobbyId);
        test.db.Lobby.id.update({ ...row, isTournamentControlled: true });

        expectReject(test, s.host, (ctx) =>
            M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { lineupFormat: { tag: 'Thirds' } })), /lineupFormat is set by the tournament/);

        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, {
            lineupFormat: row.lineupFormat, banRestriction: { tag: 'MaxOnePerRole' }, hideMmr: true,
        })));
        const l = lobbyRow(test, s.lobbyId);
        expect(l.banRestriction.tag).toBe('MaxOnePerRole');
        expect(l.hideMmr).toBe(true);
        expect(l.lineupFormat.tag).toBe(row.lineupFormat.tag);
    });
});

describe('A27 (T-S8e): the head start is a tournament setting only', () => {
    it('a Bo1 final with winnerAdvantage 1 is rejected at tournament creation; Bo3 with 1 is accepted, 2 is not', () => {
        const test = newHarness();
        expectReject(test, 'internal', (ctx) =>
            M.create_tournament(ctx, { ...TOURNAMENT_ARGS, defaultBestOf: 1, grandFinalBestOf: 1, winnerAdvantage: 1 } as any), /winnerAdvantage must be less than/);
        expectReject(test, 'internal', (ctx) =>
            M.create_tournament(ctx, { ...TOURNAMENT_ARGS, defaultBestOf: 3, grandFinalBestOf: 3, winnerAdvantage: 2 } as any), /winnerAdvantage must be less than/);
        createTournament(test, { defaultBestOf: 3, winnerAdvantage: 1 });
        const t = tournaments(test)[0];
        expect(t.winnerAdvantage).toBe(1);
        expect(t.grandFinalBestOf).toBe(3);
    });

    it('start_draft seeds no head start: the session has no series tally (A67(3))', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const sess = session(test, s.lobbyId);
        for (const k of ['seriesBestOf', 'gamesWonBlue', 'gamesWonRed', 'currentGameNumber']) expect(k in sess).toBe(false);
    });
});

describe('Backlog #6 (T-S8e): presets store the free set, no series fields (A67(2))', () => {
    it('a preset round-trips lineupFormat, banRestriction and hideMmr; an update without them keeps them', () => {
        const test = newHarness();
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, {
            ...PRESET_ARGS, name: 'thirds', lineupFormat: { tag: 'Thirds' }, banRestriction: { tag: 'MaxOneDps' }, hideMmr: true,
        } as any));
        const p = presetNamed(test, 'thirds');
        expect(p.lineupFormat.tag).toBe('Thirds');
        expect(p.banRestriction.tag).toBe('MaxOneDps');
        expect(p.hideMmr).toBe(true);
        for (const k of ['bestOf', 'refereeControlsShelving', 'bestOfNAdvantage']) expect(k in p).toBe(false);

        tx(test, 'internal', (ctx) => M.update_lobby_preset(ctx, { ...PRESET_ARGS, presetId: p.id, name: 'thirds' } as any));
        expect(presetNamed(test, 'thirds').lineupFormat.tag).toBe('Thirds');
        expect(presetNamed(test, 'thirds').banRestriction.tag).toBe('MaxOneDps');
    });
});

describe('A33a: the system preset', () => {
    it('exists after init (one row, SYSTEM-owned, tournament-lobby values, no series fields) and init is idempotent', () => {
        const test = newHarness();
        expect(systemPresets(test)).toHaveLength(1);
        const p = systemPresets(test)[0];
        expect(p).toMatchObject({
            name: 'Tournament default',
            creatorUserId: 0,
            createdById: 0,
            standardTurnSeconds: 60,
            reserveBankSeconds: 120,
            minimumBidRaise: 20,
            refereeCanKick: false,
            refereeExclusiveConcede: true,
        });
        for (const k of ['bestOf', 'refereeControlsShelving', 'bestOfNAdvantage']) expect(k in p).toBe(false);
        expect(p.draftMode.tag).toBe('Classic');
        expect(p.banMode.tag).toBe('Four');

        tx(test, 'internal', (ctx) => M.init(ctx, {}));
        expect(systemPresets(test)).toHaveLength(1);
    });

    it('delete_lobby_preset on it is rejected, even for an Admin; a guest cannot edit it', () => {
        const test = newHarness();
        const presetId = systemPresets(test)[0].id;
        expectReject(test, 'internal', (ctx) => M.delete_lobby_preset(ctx, { presetId }), /system lobby preset cannot be deleted/);
        const s = setupLobby(test, { noStart: true });
        expectReject(test, s.host, (ctx) =>
            M.update_lobby_preset(ctx, { ...PRESET_ARGS, presetId, name: 'mine' } as any), /Only admins/);
        expect(systemPresets(test)).toHaveLength(1);
    });

    it('create_tournament points lobbyPresetId at it; update_tournament swaps to an own preset, rejects a missing one', () => {
        const test = newHarness();
        const systemId = systemPresets(test)[0].id;
        createTournament(test);
        const t = tournaments(test)[0];
        expect(t.lobbyPresetId).toBe(systemId);

        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'mine' } as any));
        const mine = presetNamed(test, 'mine').id;
        tx(test, 'internal', (ctx) => M.update_tournament(ctx, updateTournamentArgs(t, { lobbyPresetId: mine })));
        expect(tournaments(test)[0].lobbyPresetId).toBe(mine);

        expectReject(test, 'internal', (ctx) =>
            M.update_tournament(ctx, updateTournamentArgs(t, { lobbyPresetId: 9999 })), /Lobby preset not found/);
        tx(test, 'internal', (ctx) => M.update_tournament(ctx, updateTournamentArgs(t, { lobbyPresetId: systemId })));
        expect(tournaments(test)[0].lobbyPresetId).toBe(systemId);
    });
});
