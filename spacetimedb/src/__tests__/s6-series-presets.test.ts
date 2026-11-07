// T-S6: in-memory tests for the series settings, presets and tournaments (backlog #6, #7, #8, #9; BACKEND-BUGS F2;
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
};

/** update_lobby_settings arguments mirroring the create defaults, with overrides. */
const settingsArgs = (lobbyId: number, over: Record<string, unknown> = {}) => {
    const { joinCode: _j, presetId: _p, bestOf: _b, refereeControlsShelving: _r, ...rest } = DEFAULT_LOBBY_ARGS;
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
    ...over,
}) as any;

const systemPresets = (test: Harness) => [...test.db.LobbyPreset.iter()].filter((p) => p.isSystemPreset);
const presetNamed = (test: Harness, name: string) => [...test.db.LobbyPreset.iter()].find((p) => p.name === name)!;

const actorOf = (s: Lobby, userId: number): Actor => Object.values(s.a).find((x) => x.userId === userId)!;
const captain = (s: Lobby, team: 'Blue' | 'Red') =>
    actorOf(s, captainOf(s.test, s.lobbyId, team === 'Blue' ? 'BluePlayer' : 'RedPlayer')!.userId);

/** Host moves the lobby Drafting → Equipping → Scoring → BetweenGames (no game scores recorded). */
function finishGame(s: Lobby) {
    for (let i = 0; i < 3; i++) tx(s.test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
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
            M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: `a${game}_${guard}`, eidolon: 0 }));
        tx(s.test, captain(s, other), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
    }
}

describe('F2: game 2 of a Bo3 drafts to completion', () => {
    it('Classic: advance_to_next_game rebuilds the sequence; game 2 reaches Equipping with 16 picks', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { bestOf: 3 } });
        draftClassicGame(s, 1);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');

        tx(test, s.host, (ctx) => M.advance_to_next_game(ctx, { lobbyId: s.lobbyId }));
        const g2 = session(test, s.lobbyId);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        expect(g2.currentGameNumber).toBe(2);
        expect(g2.turnIndex).toBe(0);
        expect(g2.draftSequence).toHaveLength(16);

        draftClassicGame(s, 2);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
        const picks = steps(test, s.lobbyId).filter((x) => x.action.tag === 'Pick');
        expect(picks).toHaveLength(16);
        expect(picks.every((x) => x.gameNumber === 2)).toBe(true);
    });

    it('Auction: game 2 opens the auction phase and reaches Equipping after 16 sales; won counters kept', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { bestOf: 3, draftMode: { tag: 'Auction' } } });
        expect(session(test, s.lobbyId).isAuctionPhase).toBe(true);
        finishGame(s); // game 1 skipped by the host
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');

        tx(test, s.host, (ctx) => M.advance_to_next_game(ctx, { lobbyId: s.lobbyId }));
        const g2 = session(test, s.lobbyId);
        expect(g2.isAuctionPhase).toBe(true);
        expect(g2.nextNominatorTeam.tag).toBe('Blue');
        expect(g2.teamBlueCharBudget).toBe(100);

        draftAuctionGame(s, 2);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
        const done = session(test, s.lobbyId);
        expect(done.blueCharactersWon).toBe(8);
        expect(done.redCharactersWon).toBe(8);
        expect(done.currentGameNumber).toBe(2);
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'AuctionSold')).toHaveLength(16);
    });
});

describe('A28 / A38(2): bestOf capped to {1, 3} everywhere', () => {
    it('bestOf 5 is rejected on create_lobby, update_lobby_settings, presets and tournaments', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        expectReject(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { bestOf: 5 })), BEST_OF);

        const solo = guest(test, 'solo');
        expectReject(test, solo, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, bestOf: 5 } as any), BEST_OF);

        expectReject(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'p', bestOf: 5 } as any), BEST_OF);
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'ok' } as any));
        const presetId = presetNamed(test, 'ok').id;
        expectReject(test, 'internal', (ctx) =>
            M.update_lobby_preset(ctx, { ...PRESET_ARGS, presetId, name: 'ok', bestOf: 5 } as any), BEST_OF);

        expectReject(test, 'internal', (ctx) => M.create_tournament(ctx, { ...TOURNAMENT_ARGS, defaultBestOf: 5 } as any), BEST_OF);
        createTournament(test);
        const t = tournaments(test)[0];
        expectReject(test, 'internal', (ctx) => M.update_tournament(ctx, updateTournamentArgs(t, { defaultBestOf: 5 })), BEST_OF);
    });

    it('bestOf 0 on create_lobby keeps the D-11 sentinel (1)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true, lobby: { bestOf: 0 } });
        expect(lobbyRow(test, s.lobbyId).bestOf).toBe(1);
    });
});

describe('Backlog #9: series settings editable in Waiting', () => {
    it('a casual host changes bestOf 1 → 3 in Waiting and every confirmation resets', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        expect(member(test, s.lobbyId, s.a.b1.userId).isConfirmed).toBe(true);

        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, {
            bestOf: 3, bestOfNAdvantage: { tag: 'Blue' }, lineupFormat: { tag: 'Thirds' },
            banRestriction: { tag: 'MaxTwoDps' }, hideMmr: true, refereeControlsShelving: false, name: '  Friday scrim  ',
        })));
        const l = lobbyRow(test, s.lobbyId);
        expect(l.bestOf).toBe(3);
        expect(l.bestOfNAdvantage.tag).toBe('Blue');
        expect(l.lineupFormat.tag).toBe('Thirds');
        expect(l.banRestriction.tag).toBe('MaxTwoDps');
        expect(l.hideMmr).toBe(true);
        expect(l.refereeControlsShelving).toBe(false);
        expect(l.name).toBe('Friday scrim');
        for (const name of ['b1', 'b2', 'r1', 'r2']) {
            expect(member(test, s.lobbyId, s.a[name].userId).isConfirmed).toBe(false);
        }

        // Omitted keys keep their values; bestOf back to 1 forces the advantage to None.
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { bestOf: 1 })));
        const back = lobbyRow(test, s.lobbyId);
        expect(back.bestOfNAdvantage.tag).toBe('None');
        expect(back.lineupFormat.tag).toBe('Thirds');
        expect(back.name).toBe('Friday scrim');
    });

    it('a tournament lobby rejects bestOf / lineupFormat / bestOfNAdvantage edits and accepts refereeControlsShelving', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        const row = lobbyRow(test, s.lobbyId);
        test.db.Lobby.id.update({ ...row, isTournamentControlled: true });

        expectReject(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { bestOf: 3 })), /bestOf is set by the tournament/);
        expectReject(test, s.host, (ctx) =>
            M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { lineupFormat: { tag: 'Thirds' } })), /lineupFormat is set by the tournament/);
        // A27 / backlog #7: the head start is bracket-authoritative in a tournament lobby (orchestrator fix, S6 review).
        expectReject(test, s.host, (ctx) =>
            M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { bestOfNAdvantage: { tag: 'Blue' } })), /bestOfNAdvantage is set by the tournament/);

        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, {
            bestOf: 1, refereeControlsShelving: false, banRestriction: { tag: 'MaxOnePerRole' },
        })));
        const l = lobbyRow(test, s.lobbyId);
        expect(l.refereeControlsShelving).toBe(false);
        expect(l.banRestriction.tag).toBe('MaxOnePerRole');
        expect(l.bestOf).toBe(1);
    });
});

describe('A27 / backlog #7: bestOfNAdvantage', () => {
    it('a casual Bo3 lobby with bestOfNAdvantage = Red starts 0–1 and keeps it through game 1', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { bestOf: 3, bestOfNAdvantage: { tag: 'Red' } } });
        expect(lobbyRow(test, s.lobbyId).bestOfNAdvantage.tag).toBe('Red');
        expect(session(test, s.lobbyId).gamesWonBlue).toBe(0);
        expect(session(test, s.lobbyId).gamesWonRed).toBe(1);

        finishGame(s);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');
        expect(session(test, s.lobbyId).gamesWonRed).toBe(1);
        tx(test, s.host, (ctx) => M.advance_to_next_game(ctx, { lobbyId: s.lobbyId }));
        expect(session(test, s.lobbyId).gamesWonRed).toBe(1);
    });

    it('a Bo1 lobby forces the advantage to None (0–0)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { bestOf: 1, bestOfNAdvantage: { tag: 'Blue' } } });
        expect(lobbyRow(test, s.lobbyId).bestOfNAdvantage.tag).toBe('None');
        expect(session(test, s.lobbyId).gamesWonBlue).toBe(0);
    });

    it('a Bo1 final with winnerAdvantage 1 is rejected at tournament creation; Bo3 with 1 is accepted, 2 is not', () => {
        const test = newHarness();
        expectReject(test, 'internal', (ctx) =>
            M.create_tournament(ctx, { ...TOURNAMENT_ARGS, defaultBestOf: 1, winnerAdvantage: 1 } as any), /winnerAdvantage must be less than/);
        expectReject(test, 'internal', (ctx) =>
            M.create_tournament(ctx, { ...TOURNAMENT_ARGS, defaultBestOf: 3, winnerAdvantage: 2 } as any), /winnerAdvantage must be less than/);
        createTournament(test, { defaultBestOf: 3, winnerAdvantage: 1 });
        const t = tournaments(test)[0];
        expect(t.winnerAdvantage).toBe(1);
        expect(t.grandFinalBestOf).toBe(3);
    });
});

describe('Backlog #6: presets store the series fields', () => {
    it('a Bo3 preset round-trips bestOf, refereeControlsShelving, bestOfNAdvantage and lineupFormat', () => {
        const test = newHarness();
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, {
            ...PRESET_ARGS, name: 'bo3', bestOf: 3, refereeControlsShelving: false,
            bestOfNAdvantage: { tag: 'Red' }, lineupFormat: { tag: 'Thirds' },
            banRestriction: { tag: 'MaxOneDps' }, hideMmr: true,
        } as any));
        const p = presetNamed(test, 'bo3');
        expect(p.bestOf).toBe(3);
        expect(p.refereeControlsShelving).toBe(false);
        expect(p.bestOfNAdvantage.tag).toBe('Red');
        expect(p.lineupFormat.tag).toBe('Thirds');
        expect(p.banRestriction.tag).toBe('MaxOneDps');
        expect(p.hideMmr).toBe(true);

        // update without the series keys keeps them; bestOf 1 forces None
        tx(test, 'internal', (ctx) => M.update_lobby_preset(ctx, { ...PRESET_ARGS, presetId: p.id, name: 'bo3' } as any));
        expect(presetNamed(test, 'bo3').lineupFormat.tag).toBe('Thirds');
        tx(test, 'internal', (ctx) => M.update_lobby_preset(ctx, { ...PRESET_ARGS, presetId: p.id, name: 'bo3', bestOf: 1 } as any));
        expect(presetNamed(test, 'bo3').bestOfNAdvantage.tag).toBe('None');
    });
});

describe('A33a: the system preset', () => {
    it('exists after init (one row, SYSTEM-owned, tournament-lobby values) and init is idempotent', () => {
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
            refereeControlsShelving: true,
            bestOf: 1,
        });
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
