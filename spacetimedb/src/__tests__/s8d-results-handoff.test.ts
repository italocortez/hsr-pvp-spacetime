// T-S8d: in-memory tests for the one result record per lobby (A54) and the result → bracket hand-off (A24(1)(2)(3)(4),
// A35, A36, A38(1), A60(6), A63, ACCESS-SECURITY-OPS §D.8.3): concede / defer settle the start_draft record in place;
// a tournament lobby's deciding close validates (or submits) and hands the result to the bracket's single writer, the
// lobby parks in AwaitingResult with no history and no MMR; validate_match_result; the casual-only admin tools and
// finalize_match_result; the record / lobby side effects of resolve_bracket_match, rollback_bracket_match and
// override_match_result. Builders in s8d-fixtures.ts. Nothing reaches maincloud.
// T-S8e (A67): one lobby per game; the bracket match is the series. The Bo3 hand-off plays two lobbies; resolve keeps
// every Validated game (A67(8)); an override of a record of a Decided match reverts the decision (no game or lobby
// voided), updates the record and re-decides from the new tally (A67(4), S8e review addendum).
import { describe, expect, it } from 'vitest';
import { TOURNAMENT_PERM_MESSAGES } from '@module/helpers/tournament/tournamentPermissions';
import { M, expectReject, lobbyRow, newHarness, session, setupLobby, tx, type Harness, type Lobby } from './s4-fixtures';
import { assignAssistant, liveField, matchRow, resolveMatch, verified } from './s8-fixtures';
import {
    byKey,
    captainActor,
    lobbiesOf,
    openMatchLobby,
    playBracketMatch,
    playMatch,
    recordsOfLobby,
    recordsOfMatch,
    validate,
} from './s8d-fixtures';

const RESULTS = TOURNAMENT_PERM_MESSAGES.results;
const BO1 = { defaultBestOf: 1, grandFinalBestOf: 1 };

const nothingDerived = (test: Harness) => {
    expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(0);
    expect([...test.db.MmrHistory.iter()]).toHaveLength(0);
    expect([...test.db.PlayerStat.iter()]).toHaveLength(0);
};
const concede = (s: Lobby, losingTeamSide: 1 | 2) =>
    tx(s.test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide }));
const rollback = (test: Harness, who: any, bracketMatchId: number) =>
    tx(test, who, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId, reason: 'replay' }));
const override = (test: Harness, who: any, matchResultId: number, newStatusTag: string, winnerTeamSideTag = '') =>
    tx(test, who, (ctx) => M.override_match_result(ctx, { matchResultId, newStatusTag, winnerTeamSideTag, reason: 'staff' }));

// ─── A54: one record per lobby ────────────────────────────────────────────────

describe('A54: one MatchResultRecord per lobby', () => {
    it('start_draft creates the one Pending record; a tournament concede settles it in place (no second record)', () => {
        const f = liveField(2, BO1);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id);
        const [pending] = recordsOfLobby(f.test, s.lobbyId);
        expect(recordsOfLobby(f.test, s.lobbyId)).toHaveLength(1);
        expect(pending).toMatchObject({ isTournamentControlled: true, bracketMatchId: m.id });
        expect(pending.status.tag).toBe('Pending');
        expect(pending.settledAt).toBeUndefined();

        concede(s, 2); // the Spectator referee (refereeExclusiveConcede) concedes for Red
        const rows = recordsOfLobby(f.test, s.lobbyId);
        expect(rows).toHaveLength(1);
        const r = rows[0];
        expect(r.id).toBe(pending.id);
        expect(r.status.tag).toBe('Validated');
        expect(r.winnerTeamSide?.tag).toBe('Blue');
        expect(r.matchEndReason?.tag).toBe('Concede');
        expect(r.concedeTrigger?.tag).toBe('RefereeDecision');
        expect(r.concedeAtStage).toBe('Drafting');
        expect(r.concedeSummary).toBeDefined();
        expect(r.settledAt).toBeDefined();
        expect(r.refereeUserId).toBe(f.org.userId);
        // A38(1): the concede is a settled result: the bracket advances (decidedBy Concede, A35 Blue = team1).
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Concede');
        expect(after.winnerTeamId).toBe(m.team1Id);
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult'); // A24(2): parked
        nothingDerived(f.test);
    });

    it('a casual concede updates the one record and finalizes it inline (lobby and record gone)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        expect(recordsOfLobby(test, s.lobbyId)).toHaveLength(1);
        tx(test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 1 })); // the exclusive Spectator referee
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect([...test.db.MatchResultRecord.iter()]).toHaveLength(0);
        // D-77 tier 1 (casual, not a tournament): a concede archives nothing.
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(0);
    });

    it('defer_match keeps the one record Pending with no winner and records summary + stage on it', () => {
        const f = liveField(2, { ...BO1, disconnectPolicy: 'Deferred' });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id);
        tx(f.test, s.host, (ctx) => M.defer_match(ctx, { lobbyId: s.lobbyId }));
        const rows = recordsOfLobby(f.test, s.lobbyId);
        expect(rows).toHaveLength(1);
        expect(rows[0].status.tag).toBe('Pending');
        expect(rows[0].winnerTeamSide).toBeUndefined();
        expect(rows[0].concedeSummary).toBeDefined();
        expect(rows[0].concedeAtStage).toBe('Drafting');
        expect(rows[0].settledAt).toBeUndefined();
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(matchRow(f.test, m.id).state.tag).toBe('Ready'); // nothing settled
    });
});

// ─── The hand-off (A24(1)(2)(4), A35, A60(6)) ─────────────────────────────────

describe('hand-off: a Casual tournament Bo1 played to the deciding close', () => {
    it.each(['Blue', 'Red'] as const)('%s wins → the match Decided (Played) for its team; the lobby parks; no history, no MMR', (winner) => {
        const f = liveField(2, BO1);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, winner);
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        expect(recordsOfLobby(f.test, s.lobbyId)).toHaveLength(1);
        expect(r.status.tag).toBe('Validated');
        expect(r.matchEndReason?.tag).toBe('Completed');
        expect(r.winnerTeamSide?.tag).toBe(winner);
        expect(r.settledAt).toBeDefined();
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Played');
        expect(after.winnerTeamId).toBe(winner === 'Blue' ? m.team1Id : m.team2Id);
        expect(after.loserTeamId).toBe(winner === 'Blue' ? m.team2Id : m.team1Id);
        expect(winner === 'Blue' ? after.team1Games : after.team2Games).toBe(1);
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(session(f.test, s.lobbyId)).toBeDefined(); // A24(2): session rows stay with the parked lobby
        nothingDerived(f.test);
    });

    it('a Bo3 played 2-0 over two lobbies hands off each game; the second decides (A67(4))', () => {
        const f = liveField(2, { defaultBestOf: 3, grandFinalBestOf: 3 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        expect(m.bestOf).toBe(3);
        const [g1] = playBracketMatch(f, m.id, ['Red']);
        const mid = matchRow(f.test, m.id);
        expect(mid.state.tag).toBe('Ready');
        expect([mid.team1Games, mid.team2Games]).toEqual([0, 1]);
        const [g2] = playBracketMatch(f, m.id, ['Red']);
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Played');
        expect(after.winnerTeamId).toBe(m.team2Id);
        expect([after.team1Games, after.team2Games]).toEqual([0, 2]);
        for (const s of [g1, g2]) expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(recordsOfMatch(f.test, m.id).map((r) => r.status.tag)).toEqual(['Validated', 'Validated']);
        nothingDerived(f.test);
    });
});

describe('hand-off: requireResultValidation / Ranked (A36, D.8.3 validate_match_result)', () => {
    it('Submitted at the deciding close, bracket untouched; a captain cannot validate; results staff validate → Validated + hand-off', () => {
        const f = liveField(2, { ...BO1, requireResultValidation: true });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Red');
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        expect(r.status.tag).toBe('Submitted');
        expect(r.settledAt).toBeUndefined();
        expect(matchRow(f.test, m.id).state.tag).toBe('Ready');

        expectReject(f.test, s.a.r1, (ctx) => M.validate_match_result(ctx, { matchResultId: r.id }), RESULTS);
        const res = verified(f.test, 'res');
        assignAssistant(f.test, f.org, f.id, res, { results: true });
        validate(f.test, res, s.lobbyId);
        const after = recordsOfLobby(f.test, s.lobbyId)[0];
        expect(after.status.tag).toBe('Validated');
        expect(after.settledAt).toBeDefined();
        const bm = matchRow(f.test, m.id);
        expect(bm.state.tag).toBe('Decided');
        expect(bm.decidedBy?.tag).toBe('Played');
        expect(bm.winnerTeamId).toBe(m.team2Id);
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        nothingDerived(f.test);
        // Already Validated: a second validation is rejected.
        expectReject(f.test, res, (ctx) => M.validate_match_result(ctx, { matchResultId: r.id }), /Only a Submitted or Disputed result can be validated/);
    });

    it('countTowardsMmr forces validation: the Ranked record is Submitted, then validated by the organizer', () => {
        const f = liveField(2, { ...BO1, countTowardsMmr: true });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Blue');
        expect(lobbyRow(f.test, s.lobbyId).matchType.tag).toBe('Ranked');
        expect(recordsOfLobby(f.test, s.lobbyId)[0].status.tag).toBe('Submitted');
        validate(f.test, f.org, s.lobbyId);
        expect(matchRow(f.test, m.id).winnerTeamId).toBe(m.team1Id);
        nothingDerived(f.test);
    });

    it('a Disputed record is validated after staff review', () => {
        const f = liveField(2, { ...BO1, requireResultValidation: true });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Blue');
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        tx(f.test, captainActor(s, 'Red'), (ctx) => M.dispute_match_result(ctx, { matchResultId: r.id, reason: 'lag' }));
        expect(recordsOfLobby(f.test, s.lobbyId)[0].status.tag).toBe('Disputed');
        expect(matchRow(f.test, m.id).state.tag).toBe('Ready');
        validate(f.test, f.org, s.lobbyId);
        expect(recordsOfLobby(f.test, s.lobbyId)[0].status.tag).toBe('Validated');
        expect(matchRow(f.test, m.id).winnerTeamId).toBe(m.team1Id);
    });

    it('guards: a Pending record, a standalone record, an unknown id', () => {
        const f = liveField(2, BO1);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id);
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        expectReject(f.test, f.org, (ctx) => M.validate_match_result(ctx, { matchResultId: r.id }), /Only a Submitted or Disputed result can be validated/);
        expectReject(f.test, f.org, (ctx) => M.validate_match_result(ctx, { matchResultId: 99999 }), 'Match result not found.');
        const casual = setupLobby(f.test, { seats: [['cb', 'BluePlayer'], ['cr', 'RedPlayer']], hostSlot: 'Spectator', actors: { host: verified(f.test, 'chost') } });
        const [cr] = recordsOfLobby(f.test, casual.lobbyId);
        expectReject(f.test, 'internal', (ctx) => M.validate_match_result(ctx, { matchResultId: cr.id }), /Only tournament results are validated by staff/);
    });
});

// ─── finalize_match_result and the admin tools (A24(4), D.8.3) ────────────────

describe('casual-only tools: finalize_match_result, admin_force_finalize, admin_void_match', () => {
    it('finalize_match_result rejects a tournament record', () => {
        const f = liveField(2, BO1);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Blue');
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        expectReject(f.test, 'internal', (ctx) => M.finalize_match_result(ctx, { matchResultId: r.id }),
            'Tournament matches finalize when the tournament completes (A24).');
        nothingDerived(f.test);
    });

    it('admin_force_finalize / admin_void_match reject a parked tournament lobby (pointer to the bracket reducers)', () => {
        const f = liveField(2, BO1);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Blue');
        expectReject(f.test, 'internal', (ctx) => M.admin_force_finalize(ctx, { lobbyId: s.lobbyId, winnerTeamId: 1 }), /This is a tournament lobby: use resolve_bracket_match/);
        expectReject(f.test, 'internal', (ctx) => M.admin_void_match(ctx, { lobbyId: s.lobbyId }), /This is a tournament lobby: use rollback_bracket_match/);
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        nothingDerived(f.test);
    });

    it('casual: admin_force_finalize finalizes a deferred lobby; admin_void_match voids another', () => {
        const test = newHarness();
        const deferred = { lobby: { disconnectPolicy: { tag: 'Deferred' } } };
        const a = setupLobby(test, deferred);
        tx(test, a.host, (ctx) => M.defer_match(ctx, { lobbyId: a.lobbyId }));
        expect(lobbyRow(test, a.lobbyId).stage.tag).toBe('AwaitingResult');
        tx(test, 'internal', (ctx) => M.admin_force_finalize(ctx, { lobbyId: a.lobbyId, winnerTeamId: 1 }));
        expect(test.db.Lobby.id.find(a.lobbyId)).toBeFalsy();
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(1);

        // The first lobby is gone: the same players may host / join a second one.
        const b = setupLobby(test, { ...deferred, actors: a.a });
        tx(test, b.host, (ctx) => M.defer_match(ctx, { lobbyId: b.lobbyId }));
        tx(test, 'internal', (ctx) => M.admin_void_match(ctx, { lobbyId: b.lobbyId }));
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(1); // a void writes no history
    });
});

// ─── resolve / rollback side effects (A24(3), D.8.3) ──────────────────────────

describe('resolve_bracket_match / rollback_bracket_match: the record and the lobby (A24(3))', () => {
    it('resolve on a match with a parked Pending (deferred) record: the record Voided, the lobby hard-deleted', () => {
        const f = liveField(2, { ...BO1, disconnectPolicy: 'Deferred' });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id);
        tx(f.test, s.host, (ctx) => M.defer_match(ctx, { lobbyId: s.lobbyId }));
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        resolveMatch(f.test, f.org, m.id, m.team2Id!);
        expect(lobbyOrUndefined(f.test, s.lobbyId)).toBeFalsy();
        expect(f.test.db.MatchSessionStep.lobby_id.filter(s.lobbyId).next().done).toBe(true);
        const kept = f.test.db.MatchResultRecord.id.find(r.id)!;
        expect(kept.status.tag).toBe('Voided');
        expect([...f.test.db.MatchResultParticipant.match_result_id.filter(r.id)]).toHaveLength(0);
        expect(matchRow(f.test, m.id).decidedBy?.tag).toBe('Staff');
        expect(matchRow(f.test, m.id).winnerTeamId).toBe(m.team2Id);
    });

    // T-S8e (A67(8)): resolve keeps every Validated game record; only unsettled lobbies are voided.
    it('resolve for the same winner as a Validated record leaves it parked; another winner keeps it Validated and parked too', () => {
        const f = liveField(2, BO1);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Blue');
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        resolveMatch(f.test, f.org, m.id, m.team1Id!); // same winner: no change
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(f.test.db.MatchResultRecord.id.find(r.id)!.status.tag).toBe('Validated');
        expect(matchRow(f.test, m.id).decidedBy?.tag).toBe('Played');

        resolveMatch(f.test, f.org, m.id, m.team2Id!); // staff overrule: rollback (keeping the game) + re-apply
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(f.test.db.MatchResultRecord.id.find(r.id)!.status.tag).toBe('Validated');
        const after = matchRow(f.test, m.id);
        expect(after.winnerTeamId).toBe(m.team2Id);
        expect(after.decidedBy?.tag).toBe('Staff');
        expect([after.team1Games, after.team2Games]).toEqual([1, 0]); // the derived tally: the kept Blue game
    });

    it('rollback voids the record (kept), hard-deletes the parked lobby, and a replay lobby can be created', () => {
        const f = liveField(2, BO1);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Blue');
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        rollback(f.test, f.org, m.id);
        expect(matchRow(f.test, m.id).state.tag).toBe('Ready');
        expect(lobbyOrUndefined(f.test, s.lobbyId)).toBeFalsy();
        expect(lobbiesOf(f.test, m.id)).toHaveLength(0);
        expect(f.test.db.MatchResultRecord.id.find(r.id)!.status.tag).toBe('Voided');
        expect([...f.test.db.MatchResultGame.match_result_id.filter(r.id)]).toHaveLength(0);
        expect(f.test.db.MatchSession.lobbyId.find(s.lobbyId)).toBeFalsy();
        nothingDerived(f.test);

        const replay = playMatch(f, m.id, 'Red');
        expect(replay.lobbyId).not.toBe(s.lobbyId);
        expect(matchRow(f.test, m.id).winnerTeamId).toBe(m.team2Id);
        expect(recordsOfMatch(f.test, m.id).map((x) => x.status.tag).sort()).toEqual(['Validated', 'Voided']);
    });
});

describe('override_match_result on a tournament record (A24(1)(3), A67(4): through the single writer)', () => {
    it('Validated for the other side on a Decided Bo1: the winner flips, the downstream slot is rebuilt (decidedBy Staff); a Submitted record of a Ready match decides it too', () => {
        const f = liveField(4, BO1);
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        const s = playMatch(f, m1.id, 'Blue');
        const slotOfM1 = () => {
            const row = matchRow(f.test, final.id);
            return m1.nextWinnerSlot === 1 ? row.team1Id : row.team2Id;
        };
        expect(slotOfM1()).toBe(m1.team1Id);
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        expectReject(f.test, s.a.b1, (ctx) => M.override_match_result(ctx, { matchResultId: r.id, newStatusTag: 'Validated', winnerTeamSideTag: 'Red', reason: 'x' }), RESULTS);
        override(f.test, f.org, r.id, 'Validated', 'Red');
        const flipped = matchRow(f.test, m1.id);
        expect(flipped.state.tag).toBe('Decided');
        expect(flipped.winnerTeamId).toBe(m1.team2Id);
        expect(flipped.decidedBy?.tag).toBe('Staff');
        expect([flipped.team1Games, flipped.team2Games]).toEqual([0, 1]);
        expect(slotOfM1()).toBe(m1.team2Id);
        expect(f.test.db.MatchResultRecord.id.find(r.id)!.winnerTeamSide?.tag).toBe('Red');
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult'); // parked, not voided

        const g = liveField(4, { ...BO1, requireResultValidation: true });
        const n1 = byKey(g.test, g.id, 'W-R1-M1');
        const finalG = byKey(g.test, g.id, 'W-R2-M1');
        const slotOfN1 = () => {
            const row = matchRow(g.test, finalG.id);
            return n1.nextWinnerSlot === 1 ? row.team1Id : row.team2Id;
        };
        const t = playMatch(g, n1.id, 'Blue');
        const [sub] = recordsOfLobby(g.test, t.lobbyId);
        expect(sub.status.tag).toBe('Submitted');
        expect(slotOfN1()).toBeUndefined();
        override(g.test, g.org, sub.id, 'Validated', 'Red');
        const after = matchRow(g.test, n1.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.winnerTeamId).toBe(n1.team2Id);
        expect(after.decidedBy?.tag).toBe('Staff');
        expect([after.team1Games, after.team2Games]).toEqual([0, 1]);
        expect(slotOfN1()).toBe(n1.team2Id);
        const rec = g.test.db.MatchResultRecord.id.find(sub.id)!;
        expect(rec.status.tag).toBe('Validated');
        expect(rec.winnerTeamSide?.tag).toBe('Red');
        expect(lobbyRow(g.test, t.lobbyId).stage.tag).toBe('AwaitingResult'); // parked
        nothingDerived(g.test);
    });

    it('refused while a downstream match is Decided; Rejected on a Submitted record voids the lobby (record kept as Rejected), the match stays Ready', () => {
        const f = liveField(4, { ...BO1, requireResultValidation: true });
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        const s = playMatch(f, m1.id, 'Blue');
        validate(f.test, f.org, s.lobbyId); // Decided for team1
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        resolveMatch(f.test, f.org, m2.id, m2.team1Id!);
        resolveMatch(f.test, f.org, final.id, matchRow(f.test, final.id).team1Id!);
        expectReject(f.test, f.org, (ctx) => M.override_match_result(ctx, { matchResultId: r.id, newStatusTag: 'Validated', winnerTeamSideTag: 'Red', reason: 'x' }), /roll/i);
        expectReject(f.test, f.org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m1.id, reason: 'x' }), /roll that back first/);
        expect(matchRow(f.test, m1.id).winnerTeamId).toBe(m1.team1Id);

        rollback(f.test, f.org, final.id);
        rollback(f.test, f.org, m1.id); // voids the deciding record and its lobby (A67(4))
        expect(f.test.db.MatchResultRecord.id.find(r.id)!.status.tag).toBe('Voided');
        const again = playMatch(f, m1.id, 'Blue'); // Submitted (validation on)
        const [sub] = recordsOfLobby(f.test, again.lobbyId);
        override(f.test, f.org, sub.id, 'Rejected');
        expect(matchRow(f.test, m1.id).state.tag).toBe('Ready');
        expect(lobbyOrUndefined(f.test, again.lobbyId)).toBeFalsy();
        expect(f.test.db.MatchResultRecord.id.find(sub.id)!.status.tag).toBe('Rejected');
        // A Voided record cannot be overridden.
        const replay = playMatch(f, m1.id, 'Red');
        validate(f.test, f.org, replay.lobbyId);
        const [r2] = recordsOfLobby(f.test, replay.lobbyId);
        rollback(f.test, f.org, m1.id);
        expectReject(f.test, f.org, (ctx) => M.override_match_result(ctx, { matchResultId: r2.id, newStatusTag: 'Validated', winnerTeamSideTag: 'Blue', reason: 'x' }),
            'This result was voided by a rollback.');
    });
});

// A23 single writer: no S8d test writes BracketMatch rows (winnerTeamId comes only from the reducers above).

function lobbyOrUndefined(test: Harness, lobbyId: number) {
    return test.db.Lobby.id.find(lobbyId);
}


describe('override_match_result: status and lobby guards for tournament records (S8d review)', () => {
    it('a Pending record is rejected; Submitted and Disputed are accepted', () => {
        const f = liveField(4, { ...BO1, requireResultValidation: true });
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const live = openMatchLobby(f, m1.id); // Drafting: Pending record
        const [pending] = recordsOfLobby(f.test, live.lobbyId);
        expectReject(f.test, f.org, (ctx) => M.override_match_result(ctx, { matchResultId: pending.id, newStatusTag: 'Validated', winnerTeamSideTag: 'Blue', reason: 'x' }),
            'Only a Submitted, Disputed or Validated tournament result can be overridden (this one is Pending).');
        expect(f.test.db.MatchResultRecord.id.find(pending.id)!.status.tag).toBe('Pending');
        expect(matchRow(f.test, m1.id).state.tag).toBe('Ready');

        // Submitted → Validated (Blue): the hand-off through the single writer.
        tx(f.test, f.org, (ctx) => M.concede_match(ctx, { lobbyId: live.lobbyId, losingTeamSide: 2 })); // park m1 (concede)
        const s2 = playMatch(f, m2.id, 'Red');
        const [submitted] = recordsOfLobby(f.test, s2.lobbyId);
        expect(submitted.status.tag).toBe('Submitted');
        override(f.test, f.org, submitted.id, 'Validated', 'Blue');
        expect(matchRow(f.test, m2.id).winnerTeamId).toBe(m2.team1Id);
        expect(f.test.db.MatchResultRecord.id.find(submitted.id)!.status.tag).toBe('Validated');
    });

    it('a Disputed record is accepted', () => {
        const f = liveField(2, { ...BO1, requireResultValidation: true });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Blue');
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        tx(f.test, captainActor(s, 'Red'), (ctx) => M.dispute_match_result(ctx, { matchResultId: r.id, reason: 'lag' }));
        override(f.test, f.org, r.id, 'Validated', 'Red');
        expect(f.test.db.MatchResultRecord.id.find(r.id)!.status.tag).toBe('Validated');
        expect(matchRow(f.test, m.id).winnerTeamId).toBe(m.team2Id);
    });

    it('rejected when the record\'s lobby no longer exists (direct row delete: no reducer leaves a non-Voided record without its lobby)', () => {
        const f = liveField(2, BO1);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Blue');
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        f.test.db.Lobby.id.delete(s.lobbyId);
        expectReject(f.test, f.org, (ctx) => M.override_match_result(ctx, { matchResultId: r.id, newStatusTag: 'Validated', winnerTeamSideTag: 'Red', reason: 'x' }),
            'The match lobby no longer exists; use resolve_bracket_match.');
        expect(matchRow(f.test, m.id).winnerTeamId).toBe(m.team1Id);
    });

    it('casual records are unchanged: a Pending casual record is overridden by a Moderator', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { disconnectPolicy: { tag: 'Deferred' } } });
        tx(test, s.host, (ctx) => M.defer_match(ctx, { lobbyId: s.lobbyId }));
        const [r] = recordsOfLobby(test, s.lobbyId);
        expect(r.status.tag).toBe('Pending');
        override(test, 'internal', r.id, 'Validated', 'Red');
        const after = test.db.MatchResultRecord.id.find(r.id)!;
        expect(after.status.tag).toBe('Validated');
        expect(after.winnerTeamSide?.tag).toBe('Red');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
    });
});
