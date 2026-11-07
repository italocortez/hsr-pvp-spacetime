// T-S7(b): in-memory tests for the S7 server-computed scoring (A21, A31, A39, A55, A56; backlog #11): group scores,
// deaths, adjustments, the computed winner and tie-break chain, the A39 override authority, finalization history and
// cleanup. In-memory datastore on the TestClock; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { M, expectReject, guest, lobbyRow, newHarness, tx, type Harness } from './s4-fixtures';
import {
    H,
    captain,
    confirmBoth,
    game,
    playToScoring,
    record,
    recordScores,
    side,
    type ScoringLobbyOpts,
} from './s7-fixtures';

const TIE_REJECT = /tied after every tie-break: the referee decides with winnerOverride/;

/** Both captains record identical groups and no deaths: the outcome falls to the tie-break chain. */
function tiedGame(test: Harness, opts: ScoringLobbyOpts = {}) {
    const s = playToScoring(test, opts);
    recordScores(s, captain(s, 'Blue'), 'Blue', [H(5), H(6)]);
    recordScores(s, captain(s, 'Red'), 'Red', [H(5), H(6)]);
    const rec = record(test, s.lobbyId);
    return { s, rec, g: game(test, rec.id) };
}

describe('A21 end to end: a 4v4 + 4v4 Bo1 scored by the server', () => {
    it('lineups, group scores + deaths per captain, a referee adjustment that resets confirmations, confirm, submit', () => {
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
        expect([...test.db.MatchResultGroupScore.by_result_game.filter([rec0.id, 1])]).toHaveLength(4);

        confirmBoth(s, rec0.id);
        expect(record(test, lobbyId).blueConfirmed && record(test, lobbyId).redConfirmed).toBe(true);

        // The referee (host) adds a 1-cycle penalty to Red, without a reason (A55): confirmations reset.
        tx(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, gameNumber: 1, teamSide: side('Red'), value: H(1) }));
        expect(record(test, lobbyId).blueConfirmed).toBe(false);
        expect(record(test, lobbyId).redConfirmed).toBe(false);
        g = game(test, rec0.id);
        expect(g.teamRedAdjustedResult).toBe(H(23.5));
        expect(g.winnerTeamSide.tag).toBe('Blue');
        expect(g.tieBreakLevel).toBe(0);
        expect([...test.db.MatchResultAdjustment.by_result_game.filter([rec0.id, 1])][0].reason).toBeUndefined();

        expectReject(test, s.host, (ctx) => M.submit_match_result(ctx, { matchResultId: rec0.id }), /must confirm scores/);
        confirmBoth(s, rec0.id);
        tx(test, s.host, (ctx) => M.submit_match_result(ctx, { matchResultId: rec0.id }));

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
            M.record_group_scores(ctx, { lobbyId, gameNumber: 1, teamSide: side('Blue'), values: [1, 2, 3], deaths: 0 }),
            /Halves lineup has 2 group results; got 3/);
        expectReject(test, captain(s, 'Red'), (ctx) =>
            M.record_group_scores(ctx, { lobbyId, gameNumber: 1, teamSide: side('Blue'), values: [1, 2], deaths: 0 }),
            'Only the Blue captain or a referee can record scores for that team.');
        expectReject(test, s.a.b2.userId === captain(s, 'Blue').userId ? s.a.b1 : s.a.b2, (ctx) =>
            M.record_group_scores(ctx, { lobbyId, gameNumber: 1, teamSide: side('Blue'), values: [1, 2], deaths: 0 }),
            'Only the Blue captain or a referee can record scores for that team.');
        expectReject(test, captain(s, 'Red'), (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, gameNumber: 1, teamSide: side('Blue'), value: 100 }),
            /Only a referee/);
        // The referee may record either side.
        tx(test, s.host, (ctx) =>
            M.record_group_scores(ctx, { lobbyId, gameNumber: 1, teamSide: side('Red'), values: [100, 200], deaths: 2 }));
        expect(game(test, record(test, lobbyId).id).teamRedDeaths).toBe(2);
    });

    it('set_score_adjustment edits and deletes an entry by adjustmentId', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const { lobbyId } = s;
        tx(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, gameNumber: 1, teamSide: side('Blue'), value: 300, reason: ' late ' }));
        const recId = record(test, lobbyId).id;
        const adj = [...test.db.MatchResultAdjustment.by_result_game.filter([recId, 1])][0];
        expect(adj.reason).toBe('late');
        tx(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, gameNumber: 1, teamSide: side('Red'), value: -50, adjustmentId: adj.id }));
        const edited = test.db.MatchResultAdjustment.id.find(adj.id)!;
        expect(edited.value).toBe(-50);
        expect(edited.teamSide.tag).toBe('Red');
        expect(edited.reason).toBeUndefined();
        tx(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, gameNumber: 1, teamSide: side('Red'), value: 0, adjustmentId: adj.id }));
        expect(test.db.MatchResultAdjustment.id.find(adj.id)).toBeNull();
        expectReject(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId, gameNumber: 1, teamSide: side('Red'), value: 0 }), /changes nothing/);
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

    it('level 4: unresolved; submit without an override is rejected', () => {
        const test = newHarness();
        const { s, rec, g } = tiedGame(test);
        expect(g.tieBreakLevel).toBe(4);
        expect(g.winnerTeamSide.tag).toBe('Spectator');
        confirmBoth(s, rec.id);
        expectReject(test, s.host, (ctx) => M.submit_match_result(ctx, { matchResultId: rec.id }), TIE_REJECT);
    });
});

describe('A39 winnerOverride authority', () => {
    it('an override off a tie is rejected', () => {
        const test = newHarness();
        const s = playToScoring(test);
        recordScores(s, captain(s, 'Blue'), 'Blue', [H(5), H(5)]);
        recordScores(s, captain(s, 'Red'), 'Red', [H(6), H(6)]);
        const rec = record(test, s.lobbyId);
        confirmBoth(s, rec.id);
        expectReject(test, s.host, (ctx) =>
            M.submit_match_result(ctx, { matchResultId: rec.id, winnerOverride: side('Red') }),
            'A winner override is only accepted on an unresolved tie.');
    });

    it('a spectator referee\'s override on a level-4 tie is accepted in a casual lobby', () => {
        const test = newHarness();
        const { s, rec } = tiedGame(test);
        confirmBoth(s, rec.id);
        const redPlayer = captain(s, 'Red');
        tx(test, s.host, (ctx) =>
            M.submit_match_result(ctx, { matchResultId: rec.id, winnerOverride: side('Red'), winnerOverrideReason: 'coin' }));
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

    it('a seated player-referee\'s override in a tournament lobby leaves the record Disputed', () => {
        const test = newHarness();
        const { s, rec } = tiedGame(test, {
            hostSlot: 'BluePlayer',
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        });
        expect([...test.db.LobbyMember.lobby_id.filter(s.lobbyId)].find((m) => m.userId === s.host.userId)!.isReferee).toBe(true);
        test.db.MatchResultRecord.id.update({ ...record(test, s.lobbyId), isTournamentControlled: true });
        confirmBoth(s, rec.id);
        tx(test, s.host, (ctx) =>
            M.submit_match_result(ctx, { matchResultId: rec.id, winnerOverride: side('Blue') }));
        const after = test.db.MatchResultRecord.id.find(rec.id)!;
        expect(after.status.tag).toBe('Disputed');
        expect(after.winnerTeamSide).toBeUndefined();
        expect(after.winnerOverride?.tag).toBe('Blue');
        expect(after.winnerOverrideById).toBe(s.host.userId);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(test.db.MatchSessionHistory.count()).toBe(0n);
    });

    it('a seated player-referee\'s override in a casual lobby is accepted and finalized', () => {
        const test = newHarness();
        const { s, rec } = tiedGame(test, {
            hostSlot: 'BluePlayer',
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        });
        confirmBoth(s, rec.id);
        tx(test, s.host, (ctx) => M.submit_match_result(ctx, { matchResultId: rec.id, winnerOverride: side('Blue') }));
        expect(test.db.MatchResultRecord.id.find(rec.id)).toBeNull();
        expect(test.db.MatchSessionHistory.count()).toBe(1n);
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
        test.db.User.id.update({ ...test.db.User.id.find(mod.userId)!, role: { tag: 'Moderator' } });
        tx(test, mod, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Blue'), value: 100 }));
        const recId = record(test, s.lobbyId).id;
        expect([...test.db.MatchResultAdjustment.by_result_game.filter([recId, 1])][0].setById).toBe(mod.userId);
    });

    it('rejects a group value or an adjustment above 100,000,000 hundredths', () => {
        const test = newHarness();
        const s = playToScoring(test);
        expectReject(test, captain(s, 'Blue'), (ctx) =>
            M.record_group_scores(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Blue'), values: [100_000_001, 0], deaths: 0 }),
            /A group result cannot exceed 100000000 hundredths/);
        expectReject(test, s.host, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, gameNumber: 1, teamSide: side('Red'), value: -100_000_001 }),
            /An adjustment cannot exceed 100000000 hundredths/);
    });
});
