// Lobby: the lobby free set, series settings and presets (with the tournament series fields).
// Decisions: A27, A28, A33a, A38, A67
// Contracts: docs/lobby/contract.md
// From S6 (s6-series-presets.test.ts).
//
// T-S6 / T-S8e: in-memory tests for the lobby free set, presets and the tournament series settings (A67: no lobby series) (backlog #6, #7, #8, #9; BACKEND-BUGS F2;
// DECISIONS A27, A28, A33, A33a, A38). Reuses the S4 builders; in-memory datastore on the TestClock, no maincloud.
// Admin / TournamentHost calls run as the owner identity (TestAuth.internal()), which init links to SYSTEM (Admin).
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    ONE_V_ONE,
    expectReject,
    guest,
    advanceToEquipping,
    draftDone,
    lobbyRow,
    member,
    newHarness,
    session,
    setupLobby,
    steps,
    tx,
    type Harness,
    type Lobby,
    priceCharacters,
    priceBanNames,
    advance,
    linkerAuth,
    rejection,
    type Actor,
} from '../fixtures/harness';
import { finishGame as closeCurrentGame, captain } from '../fixtures/draft-and-scoring';
import { PRESET_ARGS, presetArgs, settingsArgs, updatePresetArgs } from '../fixtures/lobby';
import { admin } from '../fixtures/identity';

const BEST_OF = 'bestOf must be 1 or 3.';

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
            tx(s.test, who, (ctx) => (priceCharacters(ctx, s.lobbyId, [characterName]), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 })));
        } else {
            tx(s.test, who, (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName }));
        }
        if (draftDone(s.test, s.lobbyId)) advanceToEquipping(s); // T-S10t re-alignment (A129): the last step leaves the lobby in Drafting; the referee advances it.
    }
}

/** Drafts an Auction game (no bans) to completion: the nominator's captain nominates, the other captain passes. */
function draftAuctionGame(s: Lobby, game: number) {
    let guard = 0;
    while (lobbyRow(s.test, s.lobbyId).stage.tag === 'Drafting' && guard++ < 40) {
        const sess = session(s.test, s.lobbyId);
        const nominator = sess.nextNominatorTeam.tag as 'Blue' | 'Red';
        const other = nominator === 'Blue' ? 'Red' : 'Blue';
        // T-S10c (A81(2)): with the other team full (8, Halves) the nomination sells at once: no pass_bid follows.
        const otherFull = (other === 'Blue' ? sess.blueCharactersWon : sess.redCharactersWon) >= 8;
        tx(s.test, captain(s, nominator), (ctx) =>
            (priceCharacters(ctx, s.lobbyId, [`a${game}_${guard}`]), M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: `a${game}_${guard}` })));
        if (!otherFull) tx(s.test, captain(s, other), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
        if (draftDone(s.test, s.lobbyId)) advanceToEquipping(s); // T-S10t re-alignment (A129): the last step leaves the lobby in Drafting; the referee advances it.
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
            minimumBidRaise: 5, // T-S14.4s: user ruling 2026-11-18 (was 20)
            characterBudget: 30, // T-S14.4s: A190 item 5 / A221 R8 (was 0)
            lightconeBudget: 15, // T-S14.4s: A190 item 5 / A221 R8 (was 0)
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

    // T-S14.4s: a row seeded before S14.4s (budgets 0 / 0, raise 20) gets the new values from the path that ensures the row.
    it('T-S14.4s: an old row (budgets 0 / 0, raise 20, never edited) is brought to 30 / 15 / 5 by the ensure path; the rest of the row stays', () => {
        const test = newHarness();
        const seeded = systemPresets(test)[0];
        test.db.LobbyPreset.id.update({ ...seeded, characterBudget: 0, lightconeBudget: 0, minimumBidRaise: 20 });
        const old = systemPresets(test)[0];

        tx(test, 'internal', (ctx) => M.init(ctx, {}));
        expect(systemPresets(test)).toHaveLength(1);
        const viaInit = systemPresets(test)[0];
        expect(viaInit).toMatchObject({ id: old.id, characterBudget: 30, lightconeBudget: 15, minimumBidRaise: 5, lastModifiedById: 0, createdById: 0 });
        const { characterBudget: _c1, lightconeBudget: _l1, minimumBidRaise: _r1, lastModifiedDate: _d1, ...restOld } = old;
        const { characterBudget: _c2, lightconeBudget: _l2, minimumBidRaise: _r2, lastModifiedDate: _d2, ...restNew } = viaInit;
        expect(restNew).toEqual(restOld);

        // create_tournament without a preset (the other ensure path) upgrades it too.
        test.db.LobbyPreset.id.update({ ...viaInit, characterBudget: 0, lightconeBudget: 0, minimumBidRaise: 20 });
        createTournament(test);
        expect(systemPresets(test)[0]).toMatchObject({ id: old.id, characterBudget: 30, lightconeBudget: 15, minimumBidRaise: 5 });
        expect(tournaments(test)[0].lobbyPresetId).toBe(old.id);
    });

    it('T-S14.4s: a row an Admin edited is not upgraded, even with budgets 0 / 0', () => {
        const test = newHarness();
        const presetId = systemPresets(test)[0].id;
        tx(test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(presetId, 'Admin zero', { characterBudget: 0, lightconeBudget: 0 })));
        const edited = test.db.LobbyPreset.id.find(presetId)!;
        expect(edited.lastModifiedById).not.toBe(0);

        tx(test, 'internal', (ctx) => M.init(ctx, {}));
        createTournament(test);
        expect(test.db.LobbyPreset.id.find(presetId)).toMatchObject({ name: 'Admin zero', characterBudget: 0, lightconeBudget: 0 });
    });

    it('T-S14.4s: its values pass create_lobby in both draft modes, and the Auction lobby can nominate a priced character and take a raise', () => {
        const test = newHarness();
        const p = systemPresets(test)[0];
        const fromPreset = (draftMode: string) => ({
            teamSize: p.teamSize, draftMode: { tag: draftMode }, banMode: p.banMode, gameMode: p.gameMode, matchType: p.matchType,
            isPublic: p.isPublic, password: '', standardTurnSeconds: p.standardTurnSeconds, reserveBankSeconds: p.reserveBankSeconds,
            characterBudget: p.characterBudget, lightconeBudget: p.lightconeBudget, minimumBidRaise: p.minimumBidRaise,
            rosterDiffAdvantage: p.rosterDiffAdvantage, rosterThreshold: p.rosterThreshold,
            underThresholdAdvantage: p.underThresholdAdvantage, aboveThresholdPenalty: p.aboveThresholdPenalty, deathPenalty: p.deathPenalty,
            isAnonymousPlayers: p.isAnonymousPlayers, isAnonymousSpectators: p.isAnonymousSpectators, rosterVisibility: p.rosterVisibility,
            requireOwnership: p.requireOwnership, costSetId: p.costSetId, disconnectPolicy: p.disconnectPolicy,
            disconnectForfeitSeconds: p.disconnectForfeitSeconds ?? 0, allowMirrorPicks: p.allowMirrorPicks, autoRandomPick: p.autoRandomPick,
            refereeCanUndo: p.refereeCanUndo, refereeCanPause: p.refereeCanPause, refereeCanSetCaptain: p.refereeCanSetCaptain,
            refereeCanKick: p.refereeCanKick, allowPlayerPause: p.allowPlayerPause, teamBlueAlias: '', teamRedAlias: '',
            banRestriction: p.banRestriction, lineupFormat: p.lineupFormat, hideMmr: p.hideMmr,
            refereeExclusiveConcede: p.refereeExclusiveConcede, maxSpectators: p.maxSpectators, confirmWindowSeconds: p.confirmWindowSeconds,
        });

        // The same validation create_lobby applies, once per draft mode.
        const classicHost = guest(test, 'classic-host');
        tx(test, classicHost, (ctx) => M.create_lobby(ctx, fromPreset('Classic') as any));
        expect([...test.db.Lobby.iter()].find((l) => l.hostUserId === classicHost.userId)!.draftMode.tag).toBe('Classic');

        // Auction with the preset's values, played: the ban phase, then a nomination at cost 1 and a raise of minimumBidRaise.
        const s = setupLobby(test, { seats: ONE_V_ONE, lobby: fromPreset('Auction') });
        expect(lobbyRow(test, s.lobbyId)).toMatchObject({ characterBudget: 30, lightconeBudget: 15 });
        let guard = 0;
        while (!session(test, s.lobbyId).isAuctionPhase && guard++ < 20) {
            const sess = session(test, s.lobbyId);
            const who = captain(s, sess.draftSequence[sess.turnIndex].teamTurn.tag as 'Blue' | 'Red');
            const characterName = `ban${guard}`;
            tx(test, who, (ctx) => (priceBanNames(ctx, s.lobbyId, [characterName]), M.ban_character(ctx, { lobbyId: s.lobbyId, characterName })));
        }
        expect(session(test, s.lobbyId).isAuctionPhase).toBe(true);
        const nominator = session(test, s.lobbyId).nextNominatorTeam.tag as 'Blue' | 'Red';
        const bidder = nominator === 'Blue' ? 'Red' : 'Blue';
        tx(test, captain(s, nominator), (ctx) => (priceCharacters(ctx, s.lobbyId, ['priced'], 1), M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'priced' })));
        tx(test, captain(s, bidder), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: Math.fround(1 + p.minimumBidRaise) }));
        expect(session(test, s.lobbyId)).toMatchObject({ currentNomination: 'priced', currentBidAmount: 1 + p.minimumBidRaise, currentBidTeam: { tag: bidder } });
    });
});

// T-S14.4s: server_refresh_system_preset, the operator's way to bring a live database's system preset to the constants.
describe('S14.4s: server_refresh_system_preset', () => {
    const NOT_SERVER = 'Forbidden: caller is not a registered server identity.';
    const refresh = (ctx: any) => M.server_refresh_system_preset(ctx, {});

    it('brings a never-edited old row to the constants (same id, SYSTEM modifier)', () => {
        const test = newHarness();
        const seeded = systemPresets(test)[0];
        test.db.LobbyPreset.id.update({ ...seeded, characterBudget: 0, lightconeBudget: 0, minimumBidRaise: 20, banMode: { tag: 'Six' } as any });
        tx(test, 'internal', refresh);
        expect(systemPresets(test)).toHaveLength(1);
        expect(systemPresets(test)[0]).toMatchObject({
            id: seeded.id, characterBudget: 30, lightconeBudget: 15, minimumBidRaise: 5, banMode: { tag: 'Four' }, lastModifiedById: 0, createdById: 0,
        });
    });

    it('leaves a row an Admin edited as it is', () => {
        const test = newHarness();
        const presetId = systemPresets(test)[0].id;
        tx(test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(presetId, 'Admin edit', { minimumBidRaise: 20 })));
        const before = test.db.LobbyPreset.id.find(presetId)!;
        tx(test, 'internal', refresh);
        expect(test.db.LobbyPreset.id.find(presetId)).toEqual(before);
    });

    it('writes nothing when the row is current', () => {
        const test = newHarness();
        const before = systemPresets(test)[0];
        advance(test, 5_000);
        tx(test, 'internal', refresh);
        expect(systemPresets(test)[0]).toEqual(before); // lastModifiedDate unchanged: no write
    });

    it('is refused for a user, an Admin and the Linker', () => {
        const test = newHarness();
        const before = systemPresets(test)[0];
        test.db.LobbyPreset.id.update({ ...before, minimumBidRaise: 20 });
        const old = systemPresets(test)[0];
        const user = guest(test, 'plain');
        const adm = admin(test, 'adm');
        const linker = { auth: linkerAuth(test) } as Actor;
        for (const who of [user, adm, linker]) expect(rejection(test, who, refresh)).toBe(NOT_SERVER);
        expect(systemPresets(test)[0]).toEqual(old);
    });
});

// T-S14.4s (user ruling 2026-11-18): an Auction lobby needs a character budget and a minimum raise above 0.
describe('S14.4s: Auction lobbies refuse a character budget or a minimum raise of 0', () => {
    const BUDGET = 'characterBudget must be above 0 in an Auction lobby.';
    const RAISE = 'minimumBidRaise must be above 0 in an Auction lobby.';

    it('create_lobby: Auction with budget 0 or raise 0 is refused; Classic with both 0 is accepted', () => {
        const test = newHarness();
        const a = guest(test, 'a');
        expect(rejection(test, a, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, draftMode: { tag: 'Auction' }, characterBudget: 0 } as any))).toBe(BUDGET);
        expect(rejection(test, a, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, draftMode: { tag: 'Auction' }, minimumBidRaise: 0 } as any))).toBe(RAISE);
        expect([...test.db.Lobby.iter()].filter((l) => l.hostUserId === a.userId)).toHaveLength(0);
        tx(test, a, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, characterBudget: 0, minimumBidRaise: 0 } as any));
        expect([...test.db.Lobby.iter()].find((l) => l.hostUserId === a.userId)).toMatchObject({ draftMode: { tag: 'Classic' }, characterBudget: 0, minimumBidRaise: 0 });
    });

    it('update_lobby_settings: a switch to Auction, or an Auction lobby set to budget 0 or raise 0, is refused; Classic with both 0 is accepted', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { characterBudget: 0, minimumBidRaise: 0 })));
        expect(lobbyRow(test, s.lobbyId)).toMatchObject({ draftMode: { tag: 'Classic' }, characterBudget: 0, minimumBidRaise: 0 });
        expect(rejection(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { draftMode: { tag: 'Auction' }, characterBudget: 0 })))).toBe(BUDGET);
        expect(rejection(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { draftMode: { tag: 'Auction' }, minimumBidRaise: 0 })))).toBe(RAISE);
        expect(lobbyRow(test, s.lobbyId).draftMode.tag).toBe('Classic');
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { draftMode: { tag: 'Auction' } })));
        expect(lobbyRow(test, s.lobbyId)).toMatchObject({ draftMode: { tag: 'Auction' }, characterBudget: 100, minimumBidRaise: 1 });
    });

    // T-S14.4t (user ruling 2026-11-18): flipped; S14.4s let this preset save ("a preset may still be saved").
    it('T-S14.4t: create_lobby_preset refuses an Auction preset with budget 0 or raise 0; Classic with both 0 saves', () => {
        const test = newHarness();
        expect(rejection(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('auction zero', { draftMode: { tag: 'Auction' }, characterBudget: 0, minimumBidRaise: 0 })))).toBe(BUDGET);
        expect(rejection(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('auction budget', { draftMode: { tag: 'Auction' }, characterBudget: 0 })))).toBe(BUDGET);
        expect(rejection(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('auction raise', { draftMode: { tag: 'Auction' }, minimumBidRaise: 0 })))).toBe(RAISE);
        for (const name of ['auction zero', 'auction budget', 'auction raise']) expect(presetNamed(test, name)).toBeUndefined();

        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('classic zero', { characterBudget: 0, minimumBidRaise: 0 })));
        expect(presetNamed(test, 'classic zero')).toMatchObject({ draftMode: { tag: 'Classic' }, characterBudget: 0, minimumBidRaise: 0 });
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('auction ok', { draftMode: { tag: 'Auction' } })));
        expect(presetNamed(test, 'auction ok')).toMatchObject({ draftMode: { tag: 'Auction' }, characterBudget: 100, minimumBidRaise: 1 });
    });

    it('T-S14.4t: update_lobby_preset refuses a switch to Auction, or an Auction preset set to budget 0 or raise 0; Classic with both 0 saves', () => {
        const test = newHarness();
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('p', { characterBudget: 0, minimumBidRaise: 0 })));
        const id = presetNamed(test, 'p')!.id;
        expect(rejection(test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(id, 'p', { draftMode: { tag: 'Auction' }, characterBudget: 0, minimumBidRaise: 0 })))).toBe(BUDGET);
        expect(presetNamed(test, 'p')!.draftMode.tag).toBe('Classic');

        tx(test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(id, 'p', { draftMode: { tag: 'Auction' } })));
        expect(presetNamed(test, 'p')).toMatchObject({ draftMode: { tag: 'Auction' }, characterBudget: 100, minimumBidRaise: 1 });
        expect(rejection(test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(id, 'p', { draftMode: { tag: 'Auction' }, characterBudget: 0 })))).toBe(BUDGET);
        expect(rejection(test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(id, 'p', { draftMode: { tag: 'Auction' }, minimumBidRaise: 0 })))).toBe(RAISE);
        expect(presetNamed(test, 'p')).toMatchObject({ draftMode: { tag: 'Auction' }, characterBudget: 100, minimumBidRaise: 1 });

        tx(test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(id, 'p', { characterBudget: 0, minimumBidRaise: 0 })));
        expect(presetNamed(test, 'p')).toMatchObject({ draftMode: { tag: 'Classic' }, characterBudget: 0, minimumBidRaise: 0 });
    });

    it('T-S14.4t: a bad Auction row stored before S14.4t stays as it is and readable, and attaching it to a tournament is refused', () => {
        const test = newHarness();
        createTournament(test);
        const t = tournaments(test)[0];
        const organizerId = t.organizerId;
        // An old row, written straight to the table as a pre-S14.4t save would have left it.
        const old = test.db.LobbyPreset.insert({
            ...systemPresets(test)[0], id: 0, isSystemPreset: false, name: 'old auction', creatorUserId: organizerId,
            draftMode: { tag: 'Auction' } as any, characterBudget: 0, minimumBidRaise: 0,
        });
        expect(test.db.LobbyPreset.id.find(old.id)).toMatchObject({ name: 'old auction', draftMode: { tag: 'Auction' }, characterBudget: 0, minimumBidRaise: 0 });

        expect(rejection(test, 'internal', (ctx) => M.create_tournament(ctx, { ...TOURNAMENT_ARGS, name: 'Cup 2', lobbyPresetId: old.id } as any))).toBe(BUDGET);
        expect(tournaments(test)).toHaveLength(1);
        expect(rejection(test, 'internal', (ctx) => M.update_tournament(ctx, updateTournamentArgs(t, { lobbyPresetId: old.id })))).toBe(BUDGET);
        expect(tournaments(test)[0].lobbyPresetId).toBe(t.lobbyPresetId);

        test.db.LobbyPreset.id.update({ ...test.db.LobbyPreset.id.find(old.id)!, characterBudget: 30 });
        expect(rejection(test, 'internal', (ctx) => M.update_tournament(ctx, updateTournamentArgs(t, { lobbyPresetId: old.id })))).toBe(RAISE);
        // The row is never rewritten by the refusals.
        expect(test.db.LobbyPreset.id.find(old.id)).toMatchObject({ draftMode: { tag: 'Auction' }, characterBudget: 30, minimumBidRaise: 0 });
    });

    // T-S14.4d-fix (review D S6): create_tournament without a preset checks the system preset as the by-id branch does.
    it('T-S14.4d-fix: create_tournament without a preset is refused while the system preset is an Admin-edited Auction row with budget or raise 0', () => {
        const test = newHarness();
        const presetId = systemPresets(test)[0].id;
        // An Admin edit stored before S14.4t (written straight to the row, as the save was allowed then).
        const seeded = test.db.LobbyPreset.id.find(presetId)!;
        test.db.LobbyPreset.id.update({ ...seeded, draftMode: { tag: 'Auction' } as any, characterBudget: 0, lastModifiedById: 999 });
        expect(rejection(test, 'internal', (ctx) => M.create_tournament(ctx, { ...TOURNAMENT_ARGS } as any))).toBe(BUDGET);
        expect(tournaments(test)).toHaveLength(0);

        test.db.LobbyPreset.id.update({ ...test.db.LobbyPreset.id.find(presetId)!, characterBudget: 30, minimumBidRaise: 0 });
        expect(rejection(test, 'internal', (ctx) => M.create_tournament(ctx, { ...TOURNAMENT_ARGS } as any))).toBe(RAISE);
        expect(tournaments(test)).toHaveLength(0);
        // The refusals leave the Admin's row as it is.
        expect(test.db.LobbyPreset.id.find(presetId)).toMatchObject({ draftMode: { tag: 'Auction' }, characterBudget: 30, minimumBidRaise: 0, lastModifiedById: 999 });

        test.db.LobbyPreset.id.update({ ...test.db.LobbyPreset.id.find(presetId)!, minimumBidRaise: 5 });
        createTournament(test);
        expect(tournaments(test)[0].lobbyPresetId).toBe(presetId);
    });
});

// T-S14.4r (A221(4)): the two appended ban restrictions are accepted wherever the older four are.
describe('A221(4) (T-S14.4r): MaxOneSupport and MaxOneSustain on lobbies and presets', () => {
    it('create_lobby stores MaxOneSupport; update_lobby_settings switches it to MaxOneSustain and back', () => {
        const test = newHarness();
        const solo = guest(test, 'solo');
        tx(test, solo, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, banRestriction: { tag: 'MaxOneSupport' } } as any));
        const created = [...test.db.Lobby.iter()].find((x) => x.hostUserId === solo.userId)!;
        expect(created.banRestriction.tag).toBe('MaxOneSupport');

        const s = setupLobby(test, { noStart: true });
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { banRestriction: { tag: 'MaxOneSustain' } })));
        expect(lobbyRow(test, s.lobbyId).banRestriction.tag).toBe('MaxOneSustain');
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId))); // omitted: kept
        expect(lobbyRow(test, s.lobbyId).banRestriction.tag).toBe('MaxOneSustain');
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { banRestriction: { tag: 'MaxOneSupport' } })));
        expect(lobbyRow(test, s.lobbyId).banRestriction.tag).toBe('MaxOneSupport');
    });

    it('a preset carries MaxOneSupport and MaxOneSustain; an update without the key keeps it', () => {
        const test = newHarness();
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'sup', banRestriction: { tag: 'MaxOneSupport' } } as any));
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'sus', banRestriction: { tag: 'MaxOneSustain' } } as any));
        expect(presetNamed(test, 'sup').banRestriction.tag).toBe('MaxOneSupport');
        expect(presetNamed(test, 'sus').banRestriction.tag).toBe('MaxOneSustain');

        const sup = presetNamed(test, 'sup');
        tx(test, 'internal', (ctx) => M.update_lobby_preset(ctx, { ...PRESET_ARGS, presetId: sup.id, name: 'sup' } as any));
        expect(presetNamed(test, 'sup').banRestriction.tag).toBe('MaxOneSupport');
        tx(test, 'internal', (ctx) => M.update_lobby_preset(ctx, {
            ...PRESET_ARGS, presetId: sup.id, name: 'sup', banRestriction: { tag: 'MaxOneSustain' },
        } as any));
        expect(presetNamed(test, 'sup').banRestriction.tag).toBe('MaxOneSustain');
    });
});
