// Match results: dispute, override, finalize, concede and defer, force-finalize and void, group scores.
// Decisions: A21, A45, D-07, D-26, D-30, D-31, D-52, D-53, D-81
// Contracts: docs/match-results/contract.md
// From S10 (s10-results.test.ts).
//
// T-S10 (batch A2): in-memory port of the live result-lifecycle suites (test/backend/match-results/match-lifecycle,
// lobby/disconnect-concede, lobby/disconnect-admin-tools, the score-entry fold) plus the standalone Ranked
// finalize_match_result happy path (orchestrator ruling). Contract: docs/match-results/contract.md
// (dispute_match_result, finalize_match_result, admin_force_finalize, admin_void_match, override_match_result,
// record_group_scores), docs/lobby/contract.md (disconnect policies). Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    M,
    expectReject,
    guest,
    lobbyRow,
    newHarness,
    setupLobby,
    tx,
    type Harness,
    type Lobby,
} from '../fixtures/harness';
import { moderator, setUserRole, verified } from '../fixtures/identity';
import { H, captain, playToScoring, side } from '../fixtures/draft-and-scoring';
import { recordsOfLobby, seedElo } from '../fixtures/tournament-matches';
import { parkedLobby, playRanked, rankedHook } from '../fixtures/ranked';

const dispute = (matchResultId: number, reason: string) => (ctx: any) => M.dispute_match_result(ctx, { matchResultId, reason });
const override = (matchResultId: number, newStatusTag: string, winnerTeamSideTag: string, reason = 'staff') => (ctx: any) =>
    M.override_match_result(ctx, { matchResultId, newStatusTag, winnerTeamSideTag, reason });
const finalize = (matchResultId: number) => (ctx: any) => M.finalize_match_result(ctx, { matchResultId });
const recordOf = (test: Harness, id: number) => test.db.MatchResultRecord.id.find(id);
const NOT_STAFF = 'Only moderators, admins, or the tournament organizer can perform this action.';

// ─── dispute_match_result ─────────────────────────────────────────────────────

describe('dispute_match_result guards (contract dispute_match_result; Acceptance: Dispute After Submission)', () => {
    it('rejected while Pending; then on the Submitted record: outsider, empty and over-long reasons rejected; a participant disputes; a second dispute rejected', () => {
        // Pending: a Ranked lobby still drafting.
        const t0 = newHarness();
        const pending = setupLobby(t0, { beforeStart: rankedHook(t0) });
        const pendingId = recordsOfLobby(t0, pending.lobbyId)[0].id;
        expectReject(t0, pending.a.r1, dispute(pendingId, 'early'), 'A match result can only be disputed after it has been submitted.');

        const test = newHarness();
        const outsider = guest(test, 'outsider');
        const { s, recId } = playRanked(test, 'Blue');
        expect(recordOf(test, recId)!.status.tag).toBe('Submitted');
        expectReject(test, outsider, dispute(recId, 'Not fair'), 'You are not a participant of this match.');
        expectReject(test, s.a.r1, dispute(recId, '   '), 'Dispute reason cannot be empty.');
        expectReject(test, s.a.r1, dispute(recId, 'x'.repeat(1001)), 'Dispute reason cannot exceed 1000 characters.');

        tx(test, s.a.r1, dispute(recId, '  Scores were incorrect  '));
        const r = recordOf(test, recId)!;
        expect(r.status.tag).toBe('Disputed');
        expect(r.disputedByUserId).toBe(s.a.r1.userId);
        expect(r.disputeReason).toBe('Scores were incorrect');
        expectReject(test, s.a.b1, dispute(recId, 'Another dispute'), 'This match result has already been disputed.');
    });
});

// ─── override_match_result ────────────────────────────────────────────────────

describe('override_match_result on a standalone record (contract override_match_result, D-07, D-30, D-31)', () => {
    it('an invalid status tag is rejected; a non-Moderator is rejected; a Moderator validates a Disputed Ranked record (Acceptance: Ranked Override)', () => {
        const test = newHarness();
        const mod = moderator(test);
        const user = verified(test, 'plain');
        const { s, recId } = playRanked(test, 'Red');
        tx(test, s.a.b1, dispute(recId, 'wrong scores'));

        expectReject(test, mod, override(recId, 'Pending', 'Blue'), /Invalid status override/);
        expectReject(test, user, override(recId, 'Validated', 'Blue'), 'Forbidden: Requires Moderator or Admin privileges.');
        tx(test, mod, override(recId, 'Validated', 'Blue', 'Reviewed and confirmed'));
        const r = recordOf(test, recId)!;
        expect(r.status.tag).toBe('Validated');
        expect(r.winnerTeamSide?.tag).toBe('Blue');
        expect(r.matchEndReason?.tag).toBe('Completed');
        // S11a (L49): the staff reason has its own column; the player's dispute text is kept
        expect(r.staffOverrideReason).toBe('Reviewed and confirmed');
        expect(r.disputeReason).toBe('wrong scores');
    });

    it('Ranked screenshot gate: Validated without both screenshots is rejected; Rejected needs none', () => {
        const test = newHarness();
        const mod = moderator(test);
        const { recId } = playRanked(test, 'Blue', { screenshots: false });
        expectReject(test, mod, override(recId, 'Validated', 'Blue'), /missing screenshot\(s\)/);
        expect(recordOf(test, recId)!.status.tag).toBe('Submitted');
        tx(test, mod, override(recId, 'Rejected', '', 'No screenshots provided'));
        expect(recordOf(test, recId)!.status.tag).toBe('Rejected');
    });
});

// ─── finalize_match_result: standalone Ranked (orchestrator ruling) ──────────

describe('finalize_match_result on a standalone Ranked record (contract finalize_match_result; MMR contract: First Ranked Match)', () => {
    it('guards: not Validated, no authority; then the referee finalizes: record, participants and lobby gone, history and MMR written', () => {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const { s, recId } = playRanked(test, 'Blue');

        expectReject(test, s.host, finalize(recId), 'Match result must be Validated before finalization.');
        tx(test, mod, override(recId, 'Validated', 'Blue'));
        expectReject(test, s.a.b1, finalize(recId), 'You do not have authority to finalize this match result.');
        tx(test, s.host, finalize(recId)); // the match referee

        expect(recordOf(test, recId)).toBeFalsy();
        expect([...test.db.MatchResultParticipant.match_result_id.filter(recId)]).toHaveLength(0);
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect([...test.db.LobbyMember.lobby_id.filter(s.lobbyId)]).toHaveLength(0);
        const history = [...test.db.MatchSessionHistory.iter()];
        expect(history).toHaveLength(1);
        const mmr = [...test.db.MmrHistory.iter()];
        expect(mmr).toHaveLength(4);
        expect(mmr.every((h) => h.matchHistoryId === history[0].id)).toBe(true);
        expect([...test.db.MmrRating.iter()]).toHaveLength(4);
        expectReject(test, s.host, finalize(recId), 'Match result not found.'); // the structural double-processing guard
    });
});

// ─── concede_match / defer_match under the disconnect policies ────────────────

describe('concede_match and defer_match (docs/lobby/contract.md disconnect policies, D-26, D-81, A45(5))', () => {
    it('without referee exclusivity a player concedes with losingTeamSide 0 (casual: finalized inline, lobby gone); a non-zero side is rejected', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { refereeExclusiveConcede: false } });
        expectReject(test, s.a.b1, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 2 }),
            'Players must pass losingTeamSide=0 (derived from your team slot).');
        tx(test, s.a.b1, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 0 }));
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect([...test.db.MatchResultRecord.iter()]).toHaveLength(0);
    });

    it('referee exclusivity (default): a player is rejected; the Spectator referee concedes for a side', () => {
        const test = newHarness();
        const s = setupLobby(test);
        expectReject(test, s.a.b1, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 0 }),
            'Only the referee can concede when referee exclusive concede is active.');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        tx(test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 1 }));
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
    });

    it('defer_match is rejected under the Standard policy (the lobby keeps drafting)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { disconnectPolicy: { tag: 'Standard' } } });
        expectReject(test, s.host, (ctx) => M.defer_match(ctx, { lobbyId: s.lobbyId }),
            'Defer is only available under Deferred disconnect policy.');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        expect(recordsOfLobby(test, s.lobbyId)[0].status.tag).toBe('Pending');
    });
});

// ─── admin_force_finalize / admin_void_match ──────────────────────────────────

/**
 * A standalone lobby parked in AwaitingResult. T-S10d (A91(2)): Deferred is no longer selectable outside tournaments,
 * so the lobby is a Ranked one whose game Blue won and the host's close submitted (parkedLobby); the EloConfig row is
 * seeded so a force-finalize can run the Ranked finalization.
 */
function parked(test: Harness): Lobby {
    seedElo(test);
    return parkedLobby(test);
}

describe('admin_force_finalize / admin_void_match (contract; Acceptance: Admin Force-Finalizes / Admin Voids a Match, D-52, D-53)', () => {
    it('a User-role caller is rejected by both tools; the lobby stays parked', () => {
        const test = newHarness();
        const user = verified(test, 'plain');
        setUserRole(test, user.userId, 'User');
        const s = parked(test);
        expectReject(test, user, (ctx) => M.admin_force_finalize(ctx, { lobbyId: s.lobbyId, winnerTeamId: 1 }), NOT_STAFF);
        expectReject(test, user, (ctx) => M.admin_void_match(ctx, { lobbyId: s.lobbyId }), NOT_STAFF);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
    });

    it('both tools reject a lobby that is not in AwaitingResult (a live draft)', () => {
        const test = newHarness();
        const mod = moderator(test);
        const s = setupLobby(test); // T-S10d (A91(2)): the stage is what matters; Standard instead of Deferred
        expectReject(test, mod, (ctx) => M.admin_force_finalize(ctx, { lobbyId: s.lobbyId, winnerTeamId: 1 }),
            'Can only force-finalize matches in AwaitingResult stage.');
        expectReject(test, mod, (ctx) => M.admin_void_match(ctx, { lobbyId: s.lobbyId }), 'Can only void matches in AwaitingResult stage.');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
    });

    it('a Moderator force-finalizes: Validated for the named side, history written, lobby gone', () => {
        const test = newHarness();
        const mod = moderator(test);
        const s = parked(test);
        tx(test, mod, (ctx) => M.admin_force_finalize(ctx, { lobbyId: s.lobbyId, winnerTeamId: 2 }));
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(1);
        const statOf = (userId: number) => [...test.db.PlayerStat.by_user.filter(userId)][0];
        expect(statOf(s.a.r1.userId)).toMatchObject({ wins: 1, losses: 0 }); // winnerTeamId 2 = Red
        expect(statOf(s.a.b1.userId)).toMatchObject({ wins: 0, losses: 1 });
    });

    it('a Moderator voids: lobby, members, record and participants deleted; no history, no stats', () => {
        const test = newHarness();
        const mod = moderator(test);
        const s = parked(test);
        const recId = recordsOfLobby(test, s.lobbyId)[0].id;
        tx(test, mod, (ctx) => M.admin_void_match(ctx, { lobbyId: s.lobbyId }));
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect([...test.db.LobbyMember.lobby_id.filter(s.lobbyId)]).toHaveLength(0);
        expect(recordOf(test, recId)).toBeFalsy();
        expect([...test.db.MatchResultParticipant.match_result_id.filter(recId)]).toHaveLength(0);
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(0);
        expect([...test.db.PlayerStat.iter()]).toHaveLength(0);
    });
});

// ─── record_group_scores (the score-entry fold) ───────────────────────────────

describe('record_group_scores guards (score-entry fold; contract Server-Computed Scoring, A21)', () => {
    it('a teamSide other than Blue / Red is rejected; a non-member cannot record either side', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const outsider = guest(test, 'outsider');
        expectReject(test, s.host, (ctx) => M.record_group_scores(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Spectator' } as any, values: [H(5), H(5)], deaths: 0 }),
            'teamSide must be Blue or Red.');
        expectReject(test, outsider, (ctx) => M.record_group_scores(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), values: [H(5), H(5)], deaths: 0 }),
            'Only the Blue captain or a referee can record scores for that team.');
        // The captain of the other team is no better placed than an outsider.
        expectReject(test, captain(s, 'Red'), (ctx) => M.record_group_scores(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), values: [H(5), H(5)], deaths: 0 }),
            'Only the Blue captain or a referee can record scores for that team.');
    });
});
