// T-S7b: in-memory tests for the A60 game package: edit windows (set_eidolon, equip_lightcone, arrange_lineup), the
// per-game confirmation (confirm_game) and staff close (close_game), the automatic series submission, the Admin edit
// path of a closed game, and the ConfirmGame / SetEidolon step log. In-memory datastore on the TestClock; no maincloud.
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    expectReject,
    guest,
    joinAsSpectator,
    lobbyRow,
    newHarness,
    session,
    setupLobby,
    steps,
    tx,
    type Harness,
    type Lobby,
    type SetupOpts,
} from './s4-fixtures';
import {
    H,
    arrange,
    blueNames,
    captain,
    closeGame,
    confirmAndClose,
    confirmBoth,
    confirmGame,
    draftClassic,
    equip,
    finishGame,
    gameRow,
    halves,
    insertCharacterCostLadder,
    insertLightconeCost,
    insertRoster,
    insertSynergy,
    lineup,
    playToScoring,
    record,
    recordScores,
    redNames,
    selectAccount,
    setEidolon,
    setRole,
    side,
} from './s7-fixtures';

const CLOSED = 'This game is closed.';
const NOT_READY = 'Both captains must confirm the game before it can be submitted.';
const stageMsg = (stage: string) => `This action is not allowed in the current lobby stage (${stage}).`;
const g2Blue = blueNames().map((n) => `g2-${n}`);
const g2Red = redNames().map((n) => `g2-${n}`);

/** beforeStart hook: the lobby becomes Ranked (guests cannot create one, D-23) with one selected account per player (D-08). */
const makeRanked = (test: Harness) => (l: Lobby) => {
    test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
    let accountId = 800;
    for (const name of ['b1', 'b2', 'r1', 'r2']) {
        test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: l.a[name].userId, hsrAccountId: accountId++ });
    }
};

const confirmSteps = (test: Harness, lobbyId: number) =>
    steps(test, lobbyId).filter((st) => st.action.tag === 'ConfirmGame').sort((a, b) => a.sequence - b.sequence);
type ConfirmPayload = { confirmedSide: { tag: string }; closed: boolean; winnerOverride?: { tag: string }; winnerOverrideReason?: string };

// ─── A60(1): edit windows ────────────────────────────────────────────────────────────────────────────────

describe('A60(1): set_eidolon edit window', () => {
    it('rejected in Waiting', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        expectReject(test, s.a.b1, (ctx) =>
            M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'blue-1', eidolon: 1 }), stageMsg('Waiting'));
    });

    it('accepted in Drafting once picked, in Equipping and in Scoring; rejected in BetweenGames (closed game)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { bestOf: 3 } });
        const blueCap = captain(s, 'Blue');
        expectReject(test, blueCap, (ctx) =>
            M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'blue-1', eidolon: 1 }),
            "blue-1 is not in the Blue team's draft of this game.");
        tx(test, blueCap, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'blue-1', eidolon: 0 }));
        setEidolon(s, blueCap, 'Blue', 'blue-1', 1); // Drafting
        const step = steps(test, s.lobbyId).find((st) => st.action.tag === 'SetEidolon')!;
        expect(step.actorSlot.tag).toBe('Blue');
        expect(step.payload.value).toMatchObject({ characterName: 'blue-1', eidolon: 1, previousEidolon: 0, costPaid: 0 });

        draftClassic(s, blueNames().slice(1), redNames());
        advance(test, 300);
        setEidolon(s, blueCap, 'Blue', 'blue-1', 2); // Equipping
        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        advance(test, 300);
        setEidolon(s, blueCap, 'Blue', 'blue-1', 3); // Scoring
        expect(steps(test, s.lobbyId).filter((st) => st.action.tag === 'SetEidolon')).toHaveLength(3);

        finishGame(s);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');
        advance(test, 300);
        expectReject(test, blueCap, (ctx) =>
            M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'blue-1', eidolon: 4 }), CLOSED);
    });

    it('rejected while the draft is paused (A22(3); pending review fix)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const blueCap = captain(s, 'Blue');
        tx(test, blueCap, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'blue-1', eidolon: 0 }));
        tx(test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        expectReject(test, blueCap, (ctx) =>
            M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'blue-1', eidolon: 2 }), 'Draft is paused.');
    });
});

describe('A60(1)/(2): edits in Scoring recompute the game and reset both confirmations', () => {
    it('equip_lightcone, arrange_lineup and set_eidolon in Scoring each move tie-break 1 and clear both flags', () => {
        const test = newHarness();
        insertCharacterCostLadder(test, 'blue-2', 'Classic', [0, 1, 2, 3, 4, 5, 6]);
        insertLightconeCost(test, 'lc-1', 3);
        insertSynergy(test, 'red-1', 'red-5', 5, 'Classic');
        const s = playToScoring(test);
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(5), H(6)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(5), H(6)]);
        const recId = record(test, s.lobbyId).id;
        expect(gameRow(test, recId).tieBreakLevel).toBe(4);
        const flags = () => [gameRow(test, recId).blueConfirmed, gameRow(test, recId).redConfirmed];

        confirmGame(s, captain(s, 'Blue'), 'Blue');
        expect(flags()).toEqual([true, false]);
        equip(s, captain(s, 'Blue'), 'blue-1', 'lc-1'); // Blue roster 3 > Red 0
        expect(flags()).toEqual([false, false]);
        expect(lineup(test, s.lobbyId, 'Blue').rosterCost).toBe(H(3));
        expect(gameRow(test, recId).tieBreakLevel).toBe(1);
        expect(gameRow(test, recId).winnerTeamSide.tag).toBe('Red');

        confirmGame(s, captain(s, 'Red'), 'Red');
        expect(flags()).toEqual([false, true]);
        arrange(s, captain(s, 'Red'), 'Red', [['red-1', 'red-5', 'red-3', 'red-4'], ['red-2', 'red-6', 'red-7', 'red-8']]);
        expect(flags()).toEqual([false, false]);
        expect(lineup(test, s.lobbyId, 'Red').rosterCost).toBe(H(5)); // Red 5 > Blue 3
        expect(gameRow(test, recId).winnerTeamSide.tag).toBe('Blue');

        confirmGame(s, captain(s, 'Blue'), 'Blue');
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'blue-2', 6); // Classic: the cost at E6 = 6, Blue 9 > Red 5
        expect(flags()).toEqual([false, false]);
        expect(lineup(test, s.lobbyId, 'Blue').rosterCost).toBe(H(9));
        expect(gameRow(test, recId).tieBreakLevel).toBe(1);
        expect(gameRow(test, recId).winnerTeamSide.tag).toBe('Red');
        const edit = steps(test, s.lobbyId).find((st) => st.action.tag === 'SetEidolon')!;
        expect((edit.payload.value as { costPaid: number }).costPaid).toBe(6);
    });
});

describe('A60(1): set_eidolon authority, throttle and levels', () => {
    it('a player of that team or a referee; a coach, a spectator and the other team rejected; throttled; EMPTY and E7 rejected', () => {
        const test = newHarness();
        const s = setupLobby(test, {
            seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        });
        const spec = joinAsSpectator(s, 'spec'); // new joins are Spectators, allowed while Drafting
        draftClassic(s, blueNames(), redNames());
        const blueNonCaptain = [s.a.b1, s.a.b2].find((a) => a.userId !== captain(s, 'Blue').userId)!;
        const set = (who: typeof spec, eidolon: number, characterName = 'blue-1') => (ctx: any) =>
            M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName, eidolon });
        const NOT_ALLOWED = 'Only a Blue player or a referee can set an eidolon for that team.';

        expectReject(test, s.a.bc, set(s.a.bc, 1), NOT_ALLOWED);
        expectReject(test, spec, set(spec, 1), NOT_ALLOWED);
        expectReject(test, s.a.r1, set(s.a.r1, 1), NOT_ALLOWED);

        tx(test, blueNonCaptain, set(blueNonCaptain, 1)); // any Blue player, not only the captain
        expectReject(test, blueNonCaptain, set(blueNonCaptain, 2), /too frequent/);
        tx(test, s.host, set(s.host, 2)); // the spectator referee, naming the team
        advance(test, 300);
        expectReject(test, blueNonCaptain, set(blueNonCaptain, 2), 'blue-1 is already at E2.');
        expectReject(test, blueNonCaptain, set(blueNonCaptain, 7), 'eidolon must be between 0 and 6.');
        expectReject(test, blueNonCaptain, set(blueNonCaptain, 1, 'EMPTY'), 'EMPTY has no eidolon.');
        expectReject(test, blueNonCaptain, set(blueNonCaptain, 1, 'red-1'), "red-1 is not in the Blue team's draft of this game.");
    });

    it('requireOwnership: only levels the team owns (accounts at E2 and E6: 2 and 6 accepted, 4 rejected)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { requireOwnership: true } });
        const blueCap = captain(s, 'Blue');
        selectAccount(test, s.lobbyId, blueCap.userId, 900, { 'blue-1': 2 });
        selectAccount(test, s.lobbyId, blueCap.userId, 901, { 'blue-1': 6 });
        tx(test, blueCap, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'blue-1', eidolon: 0 }));
        setEidolon(s, blueCap, 'Blue', 'blue-1', 2);
        advance(test, 300);
        expectReject(test, blueCap, (ctx) =>
            M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'blue-1', eidolon: 4 }),
            'Your team does not own that eidolon level on its selected accounts.');
        setEidolon(s, blueCap, 'Blue', 'blue-1', 6);
        const edits = steps(test, s.lobbyId).filter((st) => st.action.tag === 'SetEidolon');
        expect(edits.map((st) => (st.payload.value as { eidolon: number }).eidolon)).toEqual([2, 6]);
    });
});

// ─── A60(3): confirm_game ────────────────────────────────────────────────────────────────────────────────

describe('A60(3): confirm_game', () => {
    it('captain only; needs the lineup and both scores; a side cannot confirm twice', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        const s = setupLobby(test, {
            seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        });
        draftClassic(s, blueNames(), redNames());
        const blueCap = captain(s, 'Blue');
        const blueNonCaptain = [s.a.b1, s.a.b2].find((a) => a.userId !== blueCap.userId)!;
        const confirm = (team: 'Blue' | 'Red') => (ctx: any) => M.confirm_game(ctx, { lobbyId: s.lobbyId, teamSide: side(team) });

        expectReject(test, blueNonCaptain, confirm('Blue'), 'Only the team captain can confirm the game.');
        expectReject(test, s.a.bc, confirm('Blue'), 'Only the team captain can confirm the game.');
        expectReject(test, captain(s, 'Red'), confirm('Blue'), 'Only the team captain can confirm the Blue side of the game.');
        expectReject(test, blueCap, confirm('Blue'), 'Arrange the lineup before confirming the game.');

        arrange(s, blueCap, 'Blue', halves(blueNames()));
        arrange(s, captain(s, 'Red'), 'Red', halves(redNames()));
        expectReject(test, blueCap, confirm('Blue'), "Both teams' group scores are needed before confirming.");
        recordScores(s, blueCap, 'Blue', [H(5), H(5)]);
        expectReject(test, blueCap, confirm('Blue'), "Both teams' group scores are needed before confirming.");
        recordScores(s, captain(s, 'Red'), 'Red', [H(6), H(6)]);

        confirmGame(s, blueCap, 'Blue'); // allowed in Equipping (A60(3): Equipping or Scoring)
        expectReject(test, blueCap, confirm('Blue'), 'The Blue captain has already confirmed this game.');
        expect(gameRow(test, record(test, s.lobbyId).id).blueConfirmed).toBe(true);
    });

    it('a referee seated on a team who is not its captain cannot confirm', () => {
        const test = newHarness();
        const s = setupLobby(test, { hostSlot: 'BluePlayer', seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer']] });
        tx(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: s.lobbyId, targetUserId: s.a.b1.userId }));
        expect(captain(s, 'Blue').userId).toBe(s.a.b1.userId);
        draftClassic(s, blueNames(), redNames());
        arrange(s, s.a.b1, 'Blue', halves(blueNames()));
        arrange(s, s.a.r1, 'Red', halves(redNames()));
        recordScores(s, s.host, 'Blue', [H(5), H(5)]);
        recordScores(s, s.host, 'Red', [H(6), H(6)]);
        expectReject(test, s.host, (ctx) => M.confirm_game(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue') }),
            'Only the team captain can confirm the game.');
    });

    it('A63(4): the spectator referee cannot confirm; its close_game closes without ready flags (one ConfirmGame step)', () => {
        const test = newHarness();
        const s = scoredBo3(test);
        expectReject(test, s.host, (ctx) => M.confirm_game(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue') }),
            'Only the team captain can confirm the game.');
        expect(confirmSteps(test, s.lobbyId)).toHaveLength(0);
        closeGame(s, s.host);
        const g = gameRow(test, record(test, s.lobbyId).id);
        expect(g.closedAt).toBeDefined();
        expect(g.closedById).toBe(s.host.userId);
        const cs = confirmSteps(test, s.lobbyId);
        expect(cs).toHaveLength(1);
        expect(cs[0].actorSlot.tag).toBe('Spectator');
        expect(cs[0].payload.value as ConfirmPayload).toMatchObject({ confirmedSide: { tag: 'Spectator' }, closed: true });
    });

    it('a closed game rejects every edit; advance_stage from Scoring is rejected', () => {
        const test = newHarness();
        insertLightconeCost(test, 'lc-1', 1);
        const s = playToScoring(test, { lobby: { bestOf: 3 } });
        expectReject(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }),
            'Games close through confirm_game or close_game; the stage moves on the close.');
        finishGame(s);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');
        advance(test, 300);
        const blueCap = captain(s, 'Blue');
        const { lobbyId } = s;
        expectReject(test, blueCap, (ctx) =>
            M.equip_lightcone(ctx, { lobbyId, characterName: 'blue-1', lightconeName: 'lc-1', superimposition: 1 }), CLOSED);
        expectReject(test, blueCap, (ctx) =>
            M.arrange_lineup(ctx, { lobbyId, teamSide: side('Blue'), groups: JSON.stringify(halves(blueNames())) }), CLOSED);
        expectReject(test, blueCap, (ctx) =>
            M.set_eidolon(ctx, { lobbyId, teamSide: side('Blue'), characterName: 'blue-1', eidolon: 1 }), CLOSED);
        expectReject(test, blueCap, (ctx) =>
            M.record_group_scores(ctx, { lobbyId, gameNumber: 1, teamSide: side('Blue'), values: [1, 2], deaths: 0 }), CLOSED);
        expectReject(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, gameNumber: 1, teamSide: side('Blue'), value: 100 }), CLOSED);
    });
});

// ─── A60(3)/(6): series ──────────────────────────────────────────────────────────────────────────────────

describe('A60(3)/(6): series tally and automatic submission', () => {
    it('Bo3: game 1 close → BetweenGames and the tally; game 2 after advance_to_next_game; the deciding close finalizes (Casual)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { bestOf: 3 } });
        draftClassic(s, blueNames(), redNames());
        finishGame(s, 'Blue');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');
        expect([session(test, s.lobbyId).gamesWonBlue, session(test, s.lobbyId).gamesWonRed]).toEqual([1, 0]);
        expect(record(test, s.lobbyId).status.tag).toBe('Pending');

        tx(test, s.host, (ctx) => M.advance_to_next_game(ctx, { lobbyId: s.lobbyId }));
        expect(session(test, s.lobbyId).currentGameNumber).toBe(2);
        const recId = record(test, s.lobbyId).id;
        expect(gameRow(test, recId, 1).closedAt).toBeDefined(); // nothing in a closed game changes (A60(3))
        draftClassic(s, g2Blue, g2Red);
        finishGame(s, 'Blue');

        const history = [...test.db.MatchSessionHistory.iter()];
        expect(history).toHaveLength(1);
        const games = [...test.db.MatchResultGameHistory.by_match_history.filter(history[0].id)];
        expect(games.map((g) => g.winnerTeamSide.tag)).toEqual(['Blue', 'Blue']);
        expect(test.db.MatchResultRecord.id.find(recId)).toBeNull();
    });

    it('A27 head start: Blue advantage + Blue wins game 1 = 2-0, decided at once and finalized', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { bestOf: 3, bestOfNAdvantage: { tag: 'Blue' } } });
        expect(session(test, s.lobbyId).gamesWonBlue).toBe(1);
        draftClassic(s, blueNames(), redNames());
        finishGame(s, 'Blue');
        const history = [...test.db.MatchSessionHistory.iter()];
        expect(history).toHaveLength(1);
        expect([...test.db.MatchResultGameHistory.by_match_history.filter(history[0].id)]).toHaveLength(1);
    });

    it('Ranked: the deciding close submits (Submitted, AwaitingResult); a participant can dispute', () => {
        const test = newHarness();
        const s = playToScoring(test, { beforeStart: makeRanked(test) });
        finishGame(s, 'Red');
        const rec = record(test, s.lobbyId);
        expect(rec.status.tag).toBe('Submitted');
        expect(rec.winnerTeamSide?.tag).toBe('Red');
        expect(rec.matchEndReason?.tag).toBe('Completed');
        expect(rec.refereeUserId).toBe(s.host.userId);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(test.db.MatchSessionHistory.count()).toBe(0n);
        tx(test, captain(s, 'Blue'), (ctx) => M.dispute_match_result(ctx, { matchResultId: rec.id, reason: 'wrong scores' }));
        expect(record(test, s.lobbyId).status.tag).toBe('Disputed');
    });
});

// ─── A60(4): staff close ─────────────────────────────────────────────────────────────────────────────────

/** A tournament (created by the owner, then handed to `organizerId`) linked to the lobby row (flags set directly). */
function linkTournament(test: Harness, s: Lobby, organizerId: number): number {
    tx(test, 'internal', (ctx) => M.create_tournament(ctx, {
        name: 'Cup', description: '', format: 'SingleElimination', teamSize: 2, defaultGameMode: 'MemoryOfChaos',
        maxParticipants: 8, rosterVisibility: 'OpenRoster', isAnonymousDefault: false, disconnectPolicy: 'Standard',
        costSetId: 0, defaultBestOf: 3, groupSize: 4, has3rdPlaceMatch: false, countTowardsMmr: false, winnerAdvantage: 0,
        requireOwnership: false, requireVerified: false, requireRoster: false, minimumMmr: 0, requireApproval: false,
        waitlistEnabled: false, scheduledStartAt: '', registrationDeadline: '', maxAccountsPerPlayer: 1,
    } as any));
    const t = [...test.db.Tournament.iter()][0];
    test.db.Tournament.id.update({ ...t, organizerId });
    test.db.Lobby.id.update({ ...lobbyRow(test, s.lobbyId), isTournamentControlled: true, tournamentId: t.id });
    return t.id;
}

function scoredBo3(test: Harness, opts: SetupOpts = {}) {
    const s = playToScoring(test, { ...opts, lobby: { bestOf: 3, ...(opts.lobby ?? {}) } });
    recordScores(s, captain(s, 'Blue'), 'Blue', [H(5), H(5)]);
    recordScores(s, captain(s, 'Red'), 'Red', [H(6), H(6)]);
    return s;
}

describe('A60(4): staff close without confirmations', () => {
    it('a Moderator who is not in the lobby closes the game', () => {
        const test = newHarness();
        const s = scoredBo3(test);
        const mod = guest(test, 'mod');
        setRole(test, mod.userId, 'Moderator');
        closeGame(s, mod);
        const g = gameRow(test, record(test, s.lobbyId).id);
        expect(g.closedById).toBe(mod.userId);
        expect(g.winnerTeamSide.tag).toBe('Blue');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');
    });

    it('in a tournament lobby the organizer and a canResolveResults assistant may close; a plain player and a plain assistant may not', () => {
        const STAFF_ONLY = 'Only a captain (once both sides confirmed), a referee, a Moderator or, in a tournament lobby, the organizer or a results assistant can close a game.';
        // Organizer.
        let test = newHarness();
        let s = scoredBo3(test);
        const organizer = guest(test, 'org');
        linkTournament(test, s, organizer.userId);
        expectReject(test, captain(s, 'Blue'), (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId }), NOT_READY); // A63(2)
        closeGame(s, organizer);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');

        // Assistants: canResolveResults closes, without it rejected.
        test = newHarness();
        s = scoredBo3(test);
        const tournamentId = linkTournament(test, s, guest(test, 'org').userId);
        const helper = guest(test, 'helper');
        const resolver = guest(test, 'resolver');
        const AUDIT = { createdById: 0, createdDate: test.clock.now(), lastModifiedById: 0, lastModifiedDate: test.clock.now() };
        test.db.TournamentAssistant.insert({ id: 0, tournamentId, userId: helper.userId, canManageParticipants: true, canManageBracket: true, canResolveResults: false, ...AUDIT });
        test.db.TournamentAssistant.insert({ id: 0, tournamentId, userId: resolver.userId, canManageParticipants: false, canManageBracket: false, canResolveResults: true, ...AUDIT });
        expectReject(test, helper, (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId }), STAFF_ONLY);
        closeGame(s, resolver);
        expect(gameRow(test, record(test, s.lobbyId).id).closedById).toBe(resolver.userId);
    });
});

// ─── A60(7): Admin edits of a closed game ────────────────────────────────────────────────────────────────

describe('A60(7): Admin edits a closed game', () => {
    it('between games: scores / adjustment / eidolon / lineup / light cone edit the closed game, which stays closed; the tally follows', () => {
        const test = newHarness();
        insertLightconeCost(test, 'lc-1', 1);
        const s = playToScoring(test, { lobby: { bestOf: 3 } });
        finishGame(s, 'Blue');
        const recId = record(test, s.lobbyId).id;
        const admin = guest(test, 'admin');
        setRole(test, admin.userId, 'Admin');
        const mod = guest(test, 'mod');
        setRole(test, mod.userId, 'Moderator');
        const { lobbyId } = s;

        // Flip game 1 to Red: Blue's cycles 30 per group > Red's 20.
        tx(test, admin, (ctx) =>
            M.record_group_scores(ctx, { lobbyId, gameNumber: 1, teamSide: side('Blue'), values: [H(30), H(30)], deaths: 0 }));
        let g = gameRow(test, recId);
        expect(g.winnerTeamSide.tag).toBe('Red');
        expect(g.closedAt).toBeDefined();
        expect(g.blueConfirmed && g.redConfirmed).toBe(true); // not reset
        expect([session(test, lobbyId).gamesWonBlue, session(test, lobbyId).gamesWonRed]).toEqual([0, 1]);
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('BetweenGames');

        tx(test, admin, (ctx) => M.set_score_adjustment(ctx, { lobbyId, gameNumber: 1, teamSide: side('Blue'), value: -H(25) }));
        expect(gameRow(test, recId).winnerTeamSide.tag).toBe('Blue');
        expect([session(test, lobbyId).gamesWonBlue, session(test, lobbyId).gamesWonRed]).toEqual([1, 0]);

        // An edit that leaves the game tied (40 = 40, equal rosters; no override) is rejected.
        expectReject(test, admin, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, gameNumber: 1, teamSide: side('Blue'), value: H(5) }),
            'The edit would leave the game tied; add an adjustment that decides it.');
        // A Moderator is not an Admin: the closed game is not editable for it.
        expectReject(test, mod, (ctx) => M.set_score_adjustment(ctx, { lobbyId, gameNumber: 1, teamSide: side('Blue'), value: 100 }), CLOSED);

        setEidolon(s, admin, 'Blue', 'blue-1', 3);
        tx(test, admin, (ctx) =>
            M.arrange_lineup(ctx, { lobbyId, teamSide: side('Blue'), groups: JSON.stringify([blueNames().slice(4), blueNames().slice(0, 4)]) }));
        tx(test, admin, (ctx) => M.equip_lightcone(ctx, { lobbyId, characterName: 'red-1', lightconeName: 'lc-1', superimposition: 1 }));
        expect(lineup(test, lobbyId, 'Red').rosterCost).toBe(H(1)); // the team is the character's owner
        g = gameRow(test, recId);
        expect(g.closedAt).toBeDefined();
        expect(g.blueConfirmed && g.redConfirmed).toBe(true);
        expect(steps(test, lobbyId).filter((st) => st.action.tag === 'SetEidolon')).toHaveLength(1);
    });

    it('an Admin edit that decides a Pending series between games submits it (S7b)', () => {
        const test = newHarness();
        const s = playToScoring(test, { lobby: { bestOf: 3, bestOfNAdvantage: { tag: 'Blue' } } });
        finishGame(s, 'Red'); // 1-1 with the head start
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');
        const admin = guest(test, 'admin');
        setRole(test, admin.userId, 'Admin');
        tx(test, admin, (ctx) =>
            M.record_group_scores(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Blue'), values: [H(5), H(5)], deaths: 0 }));
        const history = [...test.db.MatchSessionHistory.iter()];
        expect(history).toHaveLength(1); // 2-0 → Casual finalized inline
    });

    it('Submitted ranked series: the winner follows an Admin edit; an edit that undoes the result is rejected', () => {
        // Bo1: flipping the only game keeps the series decided, the record's winner follows.
        let test = newHarness();
        let s = playToScoring(test, { beforeStart: makeRanked(test) });
        finishGame(s, 'Blue');
        const admin = guest(test, 'admin');
        setRole(test, admin.userId, 'Admin');
        tx(test, admin, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Blue'), value: H(50) }));
        expect(record(test, s.lobbyId).status.tag).toBe('Submitted');
        expect(record(test, s.lobbyId).winnerTeamSide?.tag).toBe('Red');

        // Bo3 with the Blue head start: 2-0 after game 1; flipping game 1 would make it 1-1.
        test = newHarness();
        s = playToScoring(test, { lobby: { bestOf: 3, bestOfNAdvantage: { tag: 'Blue' } }, beforeStart: makeRanked(test) });
        finishGame(s, 'Blue');
        expect(record(test, s.lobbyId).status.tag).toBe('Submitted');
        const admin2 = guest(test, 'admin');
        setRole(test, admin2.userId, 'Admin');
        expectReject(test, admin2, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Blue'), value: H(50) }),
            'The edit would undo the series result; void or force-finalize the match instead.');
        expect(record(test, s.lobbyId).winnerTeamSide?.tag).toBe('Blue');
    });
});

// ─── A60(8): step log ────────────────────────────────────────────────────────────────────────────────────

describe('A60(8): ConfirmGame and SetEidolon steps', () => {
    it('captain confirmations log actorSlot + confirmedSide (closed: false); the captain\'s submit logs closed: true; finalization archives them', () => {
        const test = newHarness();
        const s = playToScoring(test);
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'blue-1', 2);
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(5), H(5)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(6), H(6)]);
        confirmGame(s, captain(s, 'Blue'), 'Blue');
        const first = confirmSteps(test, s.lobbyId);
        expect(first).toHaveLength(1);
        expect(first[0].actorSlot.tag).toBe('Blue');
        expect(first[0].payload.value as ConfirmPayload).toMatchObject({ confirmedSide: { tag: 'Blue' }, closed: false });

        confirmGame(s, captain(s, 'Red'), 'Red'); // A63: never closes
        expect(confirmSteps(test, s.lobbyId).map((st) => (st.payload.value as ConfirmPayload).closed)).toEqual([false, false]);
        closeGame(s, captain(s, 'Red')); // the Red captain submits; Casual Bo1 finalizes
        const history = [...test.db.MatchSessionHistory.iter()][0];
        const archived = [...test.db.MatchSessionStepHistory.by_match_history.filter(history.id)];
        const confirms = archived.filter((r) => r.action.tag === 'ConfirmGame').sort((a, b) => a.sequence - b.sequence);
        expect(confirms).toHaveLength(3);
        expect(confirms.map((r) => r.teamSide.tag)).toEqual(['Blue', 'Red', 'Red']);
        expect(confirms.every((r) => r.targetName === undefined)).toBe(true);
        expect(confirms[2].payload).toContain('true'); // closed: true on the submit
        const edit = archived.find((r) => r.action.tag === 'SetEidolon')!;
        expect(edit.targetName).toBe('blue-1');
        expect(edit.teamSide.tag).toBe('Blue');
    });

    it('a tie: both confirmations stay open (closed: false); the override close logs Spectator, closed, winnerOverride and reason', () => {
        const test = newHarness();
        const s = playToScoring(test, { lobby: { bestOf: 3 } });
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(5), H(5)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(5), H(5)]);
        confirmBoth(s);
        expect(confirmSteps(test, s.lobbyId).map((st) => (st.payload.value as ConfirmPayload).closed)).toEqual([false, false]);
        closeGame(s, s.host, 'Red', 'coin');
        const last = confirmSteps(test, s.lobbyId)[2];
        expect(last.actorSlot.tag).toBe('Spectator');
        expect(last.payload.value as ConfirmPayload).toMatchObject({
            confirmedSide: { tag: 'Spectator' }, closed: true, winnerOverride: { tag: 'Red' }, winnerOverrideReason: 'coin',
        });
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');
        expect(session(test, s.lobbyId).gamesWonRed).toBe(1);
        expect(record(test, s.lobbyId).winnerOverride?.tag).toBe('Red');
    });
});

describe('A60(7) review fix: a stale winner override is cleared', () => {
    /** A Bo3 tie closed by the host with winnerOverride Red. */
    function overriddenTie(test: Harness, lobby: Record<string, unknown> = {}) {
        const s = playToScoring(test, { lobby: { bestOf: 3, ...lobby } });
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(5), H(5)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(5), H(5)]);
        closeGame(s, s.host, 'Red', 'coin');
        const admin = guest(test, 'admin');
        setRole(test, admin.userId, 'Admin');
        return { s, admin };
    }

    it('an Admin edit that keeps the tie keeps the override; one that decides the game at level ≤ 3 clears it', () => {
        const test = newHarness();
        const { s, admin } = overriddenTie(test);
        const recId = record(test, s.lobbyId).id;
        expect(record(test, s.lobbyId).winnerOverride?.tag).toBe('Red');

        tx(test, admin, (ctx) =>
            M.record_group_scores(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Blue'), values: [H(5), H(5)], deaths: 0 }));
        expect(gameRow(test, recId).winnerTeamSide.tag).toBe('Red');
        expect(record(test, s.lobbyId).winnerOverride?.tag).toBe('Red');
        expect(record(test, s.lobbyId).winnerOverrideById).toBe(s.host.userId);

        tx(test, admin, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Blue'), value: H(1) }));
        const g = gameRow(test, recId);
        expect(g.tieBreakLevel).toBe(0);
        expect(g.winnerTeamSide.tag).toBe('Red');
        const rec = record(test, s.lobbyId);
        expect(rec.winnerOverride).toBeUndefined();
        expect(rec.winnerOverrideById).toBeUndefined();
        expect(rec.winnerOverrideReason).toBeUndefined();
    });

    it('the finalized history carries no override after the edit decided the game', () => {
        const test = newHarness();
        const { s, admin } = overriddenTie(test, { bestOfNAdvantage: { tag: 'Blue' } }); // 1-1 after the override
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');
        tx(test, admin, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Red'), value: H(1) }));
        const history = [...test.db.MatchSessionHistory.iter()];
        expect(history).toHaveLength(1); // Blue 2-0 → submitted and finalized inline
        expect(history[0].winnerOverride).toBeUndefined();
        expect(history[0].winnerOverrideById).toBeUndefined();
        expect(history[0].winnerOverrideReason).toBeUndefined();
        const gh = [...test.db.MatchResultGameHistory.by_match_history.filter(history[0].id)][0];
        expect(gh.tieBreakLevel).toBe(0);
        expect(gh.winnerTeamSide.tag).toBe('Blue');
    });
});

// ─── A63: ready flags and the explicit submit ────────────────────────────────────────────────────────────

describe('A63: confirm_game sets a ready flag; close_game is the submit', () => {
    it('a captain cannot submit before both are ready; both ready leaves the game open; an edit clears both flags', () => {
        const test = newHarness();
        const s = scoredBo3(test);
        const recId = record(test, s.lobbyId).id;
        expectReject(test, captain(s, 'Blue'), (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId }), NOT_READY);
        confirmGame(s, captain(s, 'Blue'), 'Blue');
        expectReject(test, captain(s, 'Blue'), (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId }), NOT_READY);
        expectReject(test, captain(s, 'Red'), (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId }), NOT_READY);
        confirmGame(s, captain(s, 'Red'), 'Red');
        let g = gameRow(test, recId);
        expect(g.blueConfirmed && g.redConfirmed).toBe(true);
        expect(g.closedAt).toBeUndefined();
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Scoring');

        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Blue'), value: 1 }));
        g = gameRow(test, recId);
        expect([g.blueConfirmed, g.redConfirmed]).toEqual([false, false]);
        expectReject(test, captain(s, 'Blue'), (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId }), NOT_READY);
    });

    for (const closer of ['Blue', 'Red'] as const) {
        it(`the ${closer} captain submits once both are ready (actorSlot = confirmedSide = ${closer}, closed: true)`, () => {
            const test = newHarness();
            const s = scoredBo3(test);
            confirmBoth(s);
            closeGame(s, captain(s, closer));
            const g = gameRow(test, record(test, s.lobbyId).id);
            expect(g.closedAt).toBeDefined();
            expect(g.closedById).toBe(captain(s, closer).userId);
            const last = confirmSteps(test, s.lobbyId)[2];
            expect(last.actorSlot.tag).toBe(closer);
            expect(last.payload.value as ConfirmPayload).toMatchObject({ confirmedSide: { tag: closer }, closed: true });
            expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');
            expect(session(test, s.lobbyId).gamesWonBlue).toBe(1);
        });
    }

    it('a non-captain player cannot submit even when both are ready', () => {
        const test = newHarness();
        const s = scoredBo3(test);
        confirmBoth(s);
        const blueNonCaptain = [s.a.b1, s.a.b2].find((a) => a.userId !== captain(s, 'Blue').userId)!;
        expectReject(test, blueNonCaptain, (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId }),
            'Only a captain (once both sides confirmed), a referee, a Moderator or, in a tournament lobby, the organizer or a results assistant can close a game.');
        expect(gameRow(test, record(test, s.lobbyId).id).closedAt).toBeUndefined();
    });

    it('a tie with both flags stays open; a captain cannot decide it; the staff override close does', () => {
        const test = newHarness();
        const s = playToScoring(test, { lobby: { bestOf: 3 } });
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(5), H(5)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(5), H(5)]);
        confirmBoth(s);
        expect(gameRow(test, record(test, s.lobbyId).id).closedAt).toBeUndefined();
        expectReject(test, captain(s, 'Blue'), (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId, winnerOverride: side('Blue') }),
            'Only staff may decide a tie.');
        expectReject(test, captain(s, 'Blue'), (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId }), /tied after every tie-break/);
        closeGame(s, s.host, 'Red', 'coin');
        expect(gameRow(test, record(test, s.lobbyId).id).winnerTeamSide.tag).toBe('Red');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('BetweenGames');
    });
});
