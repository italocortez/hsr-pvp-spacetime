// Match results: server-computed scoring, the tie-break chain, winner overrides and adjustments.
// Decisions: A21, A31, A39, A60
// Contracts: docs/match-results/contract.md
// From S7 (s7-scoring.test.ts).
//
// T-S7(b): in-memory tests for the S7 server-computed scoring (A21, A31, A39, A55, A56; backlog #11): group scores,
// deaths, adjustments, the computed winner and tie-break chain, the A39 override authority, finalization history and
// cleanup. In-memory datastore on the TestClock; nothing reaches maincloud.
// T-S7b (A60, A63): ready flags live on the game row; both captains confirm, then a captain submits with close_game,
// which closes the game and submits the series; the staff close carries the winner override; A39 applies at the close.
import { describe, expect, it } from 'vitest';
import { M, expectReject, guest, lobbyRow, newHarness, tx, type Harness } from '../fixtures/harness';
import {
    H,
    captain,
    closeGame,
    confirmAndClose,
    confirmBoth,
    confirmGame,
    game,
    playToScoring,
    record,
    recordScores,
    setRole,
    side,
    type ScoringLobbyOpts,
} from '../fixtures/draft-and-scoring';

const TIE_REJECT = /tied after every tie-break: staff closes the game with winnerOverride/;

/** Both captains record identical groups and no deaths: the outcome falls to the tie-break chain. */
function tiedGame(test: Harness, opts: ScoringLobbyOpts = {}) {
    const s = playToScoring(test, opts);
    recordScores(s, captain(s, 'Blue'), 'Blue', [H(5), H(6)]);
    recordScores(s, captain(s, 'Red'), 'Red', [H(5), H(6)]);
    const rec = record(test, s.lobbyId);
    return { s, rec, g: game(test, rec.id) };
}

describe('A21 end to end: a 4v4 + 4v4 Bo1 scored by the server', () => {
    it('lineups, group scores + deaths per captain, an adjustment that resets the game confirmations, both ready → submit', () => {
        const test = newHarness();
        const s = playToScoring(test, { lobby: { deathPenalty: H(1) } });
        const { lobbyId } = s;
        const rec0 = record(test, lobbyId);

        recordScores(s, captain(s, 'Blue'), 'Blue', [H(10), H(12)], 1); // raw 22 cycles, +1 death = 23
        recordScores(s, captain(s, 'Red'), 'Red', [H(11), H(11.5)]);    // raw 22.5 cycles
        let g = game(test, rec0.id);
        expect(g.teamBlueDeaths).toBe(1);
        expect(g.teamBlueCyclesUsed).toBe(H(22));
        expect(g.teamRedCyclesUsed).toBe(H(22.5));
        expect(g.teamBlueAdjustedResult).toBe(H(23));
        expect(g.winnerTeamSide.tag).toBe('Red');
        expect([...test.db.MatchResultGroupScore.by_result.filter(rec0.id)]).toHaveLength(4);

        // A60(3): the confirmation lives on the game row.
        confirmGame(s, captain(s, 'Blue'), 'Blue');
        g = game(test, rec0.id);
        expect(g.blueConfirmed).toBe(true);
        expect(g.redConfirmed).toBe(false);
        expect(g.closedAt).toBeUndefined();

        // The referee (host) adds a 1-cycle penalty to Red, without a reason (A55): both confirmations reset (A60(2)).
        tx(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Red'), value: H(1) }));
        g = game(test, rec0.id);
        expect(g.blueConfirmed).toBe(false);
        expect(g.redConfirmed).toBe(false);
        expect(g.teamRedAdjustedResult).toBe(H(23.5));
        expect(g.winnerTeamSide.tag).toBe('Blue');
        expect(g.tieBreakLevel).toBe(0);
        expect([...test.db.MatchResultAdjustment.by_result.filter(rec0.id)][0].reason).toBeUndefined();

        // A63: both ready flags leave the game open; a captain's close_game submits the Bo1 (A60(6)).
        confirmBoth(s);
        expect(game(test, rec0.id).closedAt).toBeUndefined();
        closeGame(s, captain(s, 'Red')); // the Red captain submits


        // Casual: validated and finalized inline. History keeps raw vs adjusted, the level, the winner and the lineups.
        const history = [...test.db.MatchSessionHistory.iter()];
        expect(history).toHaveLength(1);
        expect(history[0].handicapApplied).toBe(-H(1)); // Blue's death penalty; modifiers are not handicaps
        const gh = [...test.db.MatchResultGameHistory.by_match_history.filter(history[0].id)][0];
        expect(gh.teamBlueCyclesUsed).toBe(H(22));
        expect(gh.teamRedAdjustedResult).toBe(H(23.5));
        expect(gh.tieBreakLevel).toBe(0);
        expect(gh.winnerTeamSide.tag).toBe('Blue');
        const lineups = [...test.db.MatchLineupHistory.by_match_history.filter(history[0].id)];
        expect(lineups.map((l) => l.teamSide.tag).sort()).toEqual(['Blue', 'Red']);
        expect(JSON.parse(lineups[0].groups)).toHaveLength(2);

        // A56(3): the live scoring rows are gone with the record.
        expect(test.db.MatchResultGroupScore.count()).toBe(0n);
        expect(test.db.MatchResultAdjustment.count()).toBe(0n);
        expect(test.db.MatchLineup.count()).toBe(0n);
        expect(test.db.MatchResultRecord.id.find(rec0.id)).toBeNull();
    });

    it('rejects a wrong group count, a non-captain, the other team\'s captain, and an adjustment from a player', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const { lobbyId } = s;
        expectReject(test, captain(s, 'Blue'), (ctx) =>
            M.record_group_scores(ctx, { lobbyId, teamSide: side('Blue'), values: [1, 2, 3], deaths: 0 }),
            /Halves lineup has 2 group results; got 3/);
        expectReject(test, captain(s, 'Red'), (ctx) =>
            M.record_group_scores(ctx, { lobbyId, teamSide: side('Blue'), values: [1, 2], deaths: 0 }),
            'Only the Blue captain or a referee can record scores for that team.');
        expectReject(test, s.a.b2.userId === captain(s, 'Blue').userId ? s.a.b1 : s.a.b2, (ctx) =>
            M.record_group_scores(ctx, { lobbyId, teamSide: side('Blue'), values: [1, 2], deaths: 0 }),
            'Only the Blue captain or a referee can record scores for that team.');
        expectReject(test, captain(s, 'Red'), (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Blue'), value: 100 }),
            /Only a referee/);
        // The referee may record either side.
        tx(test, s.host, (ctx) =>
            M.record_group_scores(ctx, { lobbyId, teamSide: side('Red'), values: [100, 200], deaths: 2 }));
        expect(game(test, record(test, lobbyId).id).teamRedDeaths).toBe(2);
    });

    it('set_score_adjustment edits and deletes an entry by adjustmentId', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const { lobbyId } = s;
        tx(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Blue'), value: 300, reason: ' late ' }));
        const recId = record(test, lobbyId).id;
        const adj = [...test.db.MatchResultAdjustment.by_result.filter(recId)][0];
        expect(adj.reason).toBe('late');
        tx(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Red'), value: -50, adjustmentId: adj.id }));
        const edited = test.db.MatchResultAdjustment.id.find(adj.id)!;
        expect(edited.value).toBe(-50);
        expect(edited.teamSide.tag).toBe('Red');
        expect(edited.reason).toBeUndefined();
        tx(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Red'), value: 0, adjustmentId: adj.id }));
        expect(test.db.MatchResultAdjustment.id.find(adj.id)).toBeNull();
        expectReject(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Red'), value: 0 }), /changes nothing/);
    });
});

describe('A21 tie-break chain on an engineered tie', () => {
    it('level 1: the cheaper roster wins', () => {
        const test = newHarness();
        const { g } = tiedGame(test, { costs: { 'blue-1': 2 } });
        expect(g.tieBreakLevel).toBe(1);
        expect(g.winnerTeamSide.tag).toBe('Red');
    });

    it('level 2: more 4-star characters wins', () => {
        const test = newHarness();
        const { g } = tiedGame(test, { fourStars: ['blue-1'] });
        expect(g.tieBreakLevel).toBe(2);
        expect(g.winnerTeamSide.tag).toBe('Blue');
    });

    it('level 3: fewer eidolons on 5-star characters wins (from the Pick payloads)', () => {
        const test = newHarness();
        const { g } = tiedGame(test, { eidolons: { 'blue-1': 2 } });
        expect(g.tieBreakLevel).toBe(3);
        expect(g.winnerTeamSide.tag).toBe('Red');
    });

    it('level 4: both confirmations leave the game open; close_game needs the override, which then finalizes', () => {
        const test = newHarness();
        const { s, rec, g } = tiedGame(test);
        expect(g.tieBreakLevel).toBe(4);
        expect(g.winnerTeamSide.tag).toBe('Spectator');

        confirmBoth(s); // no error: the tie stays open with both flags set (A60(3), S7b)
        const open = game(test, rec.id);
        expect(open.blueConfirmed && open.redConfirmed).toBe(true);
        expect(open.closedAt).toBeUndefined();
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Scoring');

        expectReject(test, s.host, (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId }), TIE_REJECT);
        closeGame(s, s.host, 'Blue', 'coin toss');

        const history = [...test.db.MatchSessionHistory.iter()];
        expect(history).toHaveLength(1);
        const gh = [...test.db.MatchResultGameHistory.by_match_history.filter(history[0].id)][0];
        expect(gh.tieBreakLevel).toBe(4);
        expect(gh.winnerTeamSide.tag).toBe('Blue');
        expect(history[0].winnerOverride?.tag).toBe('Blue');
        expect(history[0].winnerOverrideById).toBe(s.host.userId);
        expect(history[0].winnerOverrideReason).toBe('coin toss');
    });
});

describe('A39 winnerOverride authority at the close (A60(4))', () => {
    it('an override off a tie is rejected', () => {
        const test = newHarness();
        const s = playToScoring(test);
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(5), H(5)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(6), H(6)]);
        expectReject(test, s.host, (ctx) =>
            M.close_game(ctx, { lobbyId: s.lobbyId, winnerOverride: side('Red') }),
            'A winner override is only accepted on an unresolved tie.');
        expect(game(test, record(test, s.lobbyId).id).closedAt).toBeUndefined();
    });

    it('a spectator referee\'s override on a level-4 tie is accepted in a casual lobby', () => {
        const test = newHarness();
        const { s } = tiedGame(test);
        const redPlayer = captain(s, 'Red');
        closeGame(s, s.host, 'Red', 'coin');
        const history = [...test.db.MatchSessionHistory.iter()][0];
        const gh = [...test.db.MatchResultGameHistory.by_match_history.filter(history.id)][0];
        expect(gh.tieBreakLevel).toBe(4);
        expect(gh.winnerTeamSide.tag).toBe('Red');
        expect(history.winnerOverride?.tag).toBe('Red'); // A21 / A39: the override survives finalization
        expect(history.winnerOverrideById).toBe(s.host.userId);
        expect(history.winnerOverrideReason).toBe('coin');
        const stat = [...test.db.PlayerStat.iter()].find((p) => p.userId === redPlayer.userId)!;
        expect(stat.wins).toBe(1);
        expect(stat.losses).toBe(0);
    });

    it('a seated player-referee cannot close a tie with an override in a tournament lobby (record Pending, game open)', () => {
        const test = newHarness();
        const { s, rec } = tiedGame(test, {
            hostSlot: 'BluePlayer',
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        });
        expect([...test.db.LobbyMember.lobby_id.filter(s.lobbyId)].find((m) => m.userId === s.host.userId)!.isReferee).toBe(true);
        test.db.MatchResultRecord.id.update({ ...record(test, s.lobbyId), isTournamentControlled: true });
        confirmBoth(s);
        expectReject(test, s.host, (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId, winnerOverride: side('Blue') }),
            'A referee seated on a team cannot decide a tie in a tournament lobby; staff must close this game.');
        const after = test.db.MatchResultRecord.id.find(rec.id)!;
        expect(after.status.tag).toBe('Pending');
        expect(after.winnerOverride).toBeUndefined();
        expect(game(test, rec.id).closedAt).toBeUndefined();
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Scoring');
        expect(test.db.MatchSessionHistory.count()).toBe(0n);
    });

    it('a seated player-referee\'s override in a casual lobby is accepted and finalized', () => {
        const test = newHarness();
        const { s, rec } = tiedGame(test, {
            hostSlot: 'BluePlayer',
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        });
        confirmBoth(s);
        closeGame(s, s.host, 'Blue');
        expect(test.db.MatchResultRecord.id.find(rec.id)).toBeNull();
        expect(test.db.MatchSessionHistory.count()).toBe(1n);
        expect([...test.db.MatchSessionHistory.iter()][0].winnerOverrideById).toBe(s.host.userId);
    });
});

describe('A31: no draws in the staff tools', () => {
    it('override_match_result rejects a Validated result without a winner', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const rec = record(test, s.lobbyId);
        expectReject(test, 'internal', (ctx) =>
            M.override_match_result(ctx, { matchResultId: rec.id, newStatusTag: 'Validated', winnerTeamSideTag: '', reason: 'x' }),
            /needs "Blue" or "Red"/);
    });

});

describe('review fixes: adjustment authority and input bounds', () => {
    it('a Moderator who is not in the lobby may set an adjustment (A39 staff)', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const mod = guest(test, 'mod');
        setRole(test, mod.userId, 'Moderator');
        tx(test, mod, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), value: 100 }));
        const recId = record(test, s.lobbyId).id;
        expect([...test.db.MatchResultAdjustment.by_result.filter(recId)][0].setById).toBe(mod.userId);
    });

    it('rejects a group value or an adjustment above 100,000,000 hundredths', () => {
        const test = newHarness();
        const s = playToScoring(test);
        expectReject(test, captain(s, 'Blue'), (ctx) =>
            M.record_group_scores(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), values: [100_000_001, 0], deaths: 0 }),
            /A group result cannot exceed 100000000 hundredths/);
        expectReject(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Red'), value: -100_000_001 }),
            /An adjustment cannot exceed 100000000 hundredths/);
    });
});
