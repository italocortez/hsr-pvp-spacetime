// Tournaments: stand-in approvals end with the tournament and refuse a disqualified player or team.
// Decisions: A122, A128, A136
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10s, S10t (s10s-triage-fixes.test.ts, s10t-undo-any-step.test.ts).
import { describe, expect, it } from 'vitest';
import { M, tx, type Harness } from '../fixtures/harness';
import {
    AUDIT,
    advanceStage,
    bracketRows,
    insertHsrAccount,
    locks,
    resolveMatch,
    seedAndGenerate,
    seedingField,
    teamRow,
    verified,
} from '../fixtures/tournament-builders';
import { byKey, createTournamentLobby, duel, join } from '../fixtures/tournament-match-builders';
import { rejection } from '../fixtures/calendar-roster-rating-builders';
import { viewAs } from '../fixtures/tournament-admin-views';

const STANDIN_STAGE = 'Stand-ins can be approved once the bracket is generated, until the tournament ends.'; // T-S10v: A136 text
const STANDIN_DQ_TEAM = 'A disqualified team cannot get a stand-in.';
const standInsOf = (test: Harness, bracketMatchId: number) => [...test.db.TournamentStandIn.bracket_match_id.filter(bracketMatchId)];
const approveBody = (bracketMatchId: number, teamId: number, userId: number) =>
    (ctx: any) => M.approve_stand_in(ctx, { bracketMatchId, teamId, userId });

// ════════════════════════════════════════════════════════════════════════════
// L66: stand-in approvals end with the tournament; approve needs a running tournament
// ════════════════════════════════════════════════════════════════════════════

describe('A122(19), L66: stand-in approvals and their locks end with the tournament; approval needs a generated bracket (A136) and a team not disqualified', () => {
    // T-S10v: A136 supersedes the "tournament in progress" clause of A122(19): Seeding after generation is accepted,
    // Completed and Cancelled stay refused.
    it('A136 (was A122(19) L66): approve_stand_in is accepted in Seeding once the bracket is generated; refused once Cancelled', () => {
        const s = seedingField(2);
        seedAndGenerate(s.test, s.org, s.id);
        const m = bracketRows(s.test, s.id)[0];
        const sub = verified(s.test, 'sub');
        tx(s.test, s.org, approveBody(m.id, m.team1Id!, sub.userId));
        expect(standInsOf(s.test, m.id).map((r) => r.userId)).toEqual([sub.userId]);
        tx(s.test, s.org, (ctx) => M.cancel_tournament(ctx, { tournamentId: s.id }));
        const sub2 = verified(s.test, 'sub2');
        expect(rejection(s.test, s.org, approveBody(m.id, m.team1Id!, sub2.userId))).toBe(STANDIN_STAGE);
    });

    it('A122(19) L66: approve_stand_in is refused for a disqualified team; the other team of the match still gets one', () => {
        // T-S10v: in InProgress a DQ decides the team's match, which A135 / SI13 now refuses first; in Seeding after
        // generation (A136) the match stays open, so the disqualified-team refusal is checked there.
        const f = seedingField(2);
        seedAndGenerate(f.test, f.org, f.id);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const dqTeam = f.ts.find((t) => t.teamId === m.team1Id)!;
        tx(f.test, f.org, (ctx) => M.dq_participant(ctx, { tournamentId: f.id, userId: dqTeam.captain.userId, reason: 'x', dqWholeTeam: true }));
        expect(teamRow(f.test, dqTeam.teamId)!.status.tag).toBe('Disqualified');
        const sub = verified(f.test, 'sub');
        expect(rejection(f.test, f.org, approveBody(m.id, m.team1Id!, sub.userId))).toBe(STANDIN_DQ_TEAM);
        tx(f.test, f.org, approveBody(m.id, m.team2Id!, sub.userId));
        expect(standInsOf(f.test, m.id).map((r) => r.userId)).toEqual([sub.userId]);
    });

    it('A122(19) L66: cancelling deletes the approval and the locks the stand-in got when joining the match lobby', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const sub = verified(f.test, 'sub');
        insertHsrAccount(f.test, sub.userId, 'sub-main');
        tx(f.test, f.org, approveBody(m.id, m.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, m.id);
        join(f.test, sub, lobbyId);
        expect(locks(f.test, f.id, sub.userId)).toHaveLength(1);
        expect(viewAs(f.test, 'view_my_stand_ins', sub)).toHaveLength(1);

        tx(f.test, f.org, (ctx) => M.cancel_tournament(ctx, { tournamentId: f.id }));
        expect(standInsOf(f.test, m.id)).toEqual([]);
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        expect(viewAs(f.test, 'view_my_stand_ins', sub)).toEqual([]);
    });

    it('A122(19) L66: completing deletes the approval and the stand-in\'s locks; an enrolled player\'s locks stay (neighbour)', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const sub = verified(f.test, 'sub');
        const subAcct = insertHsrAccount(f.test, sub.userId, 'sub-main');
        tx(f.test, f.org, approveBody(m.id, m.team1Id!, sub.userId));
        // the lock a stand-in's lobby join writes (lobbyLifecycle D-26), and an enrolled player's registration lock
        f.test.db.TournamentPlayerAccount.insert({ tournamentId: f.id, userId: sub.userId, hsrAccountId: subAcct, ...AUDIT(f.test) });
        const player = f.ts[0].captain;
        const playerAcct = insertHsrAccount(f.test, player.userId, 'player-main');
        f.test.db.TournamentPlayerAccount.insert({ tournamentId: f.id, userId: player.userId, hsrAccountId: playerAcct, ...AUDIT(f.test) });

        resolveMatch(f.test, f.org, m.id, m.team1Id!);
        advanceStage(f.test, f.org, f.id, 'Completed');
        expect(standInsOf(f.test, m.id)).toEqual([]);
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        expect(locks(f.test, f.id, player.userId)).toEqual([playerAcct]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A128: a disqualified player cannot be a stand-in
// ════════════════════════════════════════════════════════════════════════════

describe('A128: approve_stand_in refuses a player disqualified from the tournament', () => {
    const DQ_PLAYER = 'A disqualified player cannot be a stand-in.';
    const approveBody = (bracketMatchId: number, teamId: number, userId: number) =>
        (ctx: any) => M.approve_stand_in(ctx, { bracketMatchId, teamId, userId });
    const standInsOf = (test: Harness, bracketMatchId: number) => [...test.db.TournamentStandIn.bracket_match_id.filter(bracketMatchId)];
    /** An enrolment row for `userId` in the tournament with `status`, written straight into the datastore (no team). */
    function enrol(test: Harness, tournamentId: number, userId: number, status: 'Disqualified' | 'Withdrawn') {
        const ts = test.clock.now();
        test.db.TournamentEnrolled.insert({
            tournamentId, userId, status: { tag: status }, anonymousAlias: undefined, isWaitlisted: false,
            allowRandomTeamAssignment: false, approvedByToAt: undefined,
            createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts,
        } as any);
    }

    it('A128: a player whose enrolment is Disqualified is refused as a stand-in for a team of the match; nothing is written', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const banned = verified(f.test, 'dq-sub');
        enrol(f.test, f.id, banned.userId, 'Disqualified');
        expect(rejection(f.test, f.org, approveBody(m.id, m.team1Id!, banned.userId))).toBe(DQ_PLAYER);
        expect(rejection(f.test, f.org, approveBody(m.id, m.team2Id!, banned.userId))).toBe(DQ_PLAYER);
        expect(standInsOf(f.test, m.id)).toEqual([]);
    });

    it('A128: a withdrawn player and a player never enrolled are still accepted, as before', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const withdrawn = verified(f.test, 'wd-sub');
        enrol(f.test, f.id, withdrawn.userId, 'Withdrawn');
        const outsider = verified(f.test, 'new-sub');
        tx(f.test, f.org, approveBody(m.id, m.team1Id!, withdrawn.userId));
        tx(f.test, f.org, approveBody(m.id, m.team2Id!, outsider.userId));
        expect(standInsOf(f.test, m.id).map((r) => r.userId).sort((a, b) => a - b))
            .toEqual([withdrawn.userId, outsider.userId].sort((a, b) => a - b));
    });
});
