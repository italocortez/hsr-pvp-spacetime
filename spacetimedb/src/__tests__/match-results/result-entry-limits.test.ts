// Match results: the per-user result-entry window and the adjustment bounds.
// Contracts: docs/match-results/contract.md
// From S10f (s10f-draft-results.test.ts).
import { describe, expect, it } from 'vitest';
import { M, advance, newHarness, tx, type Harness } from '../fixtures/harness';
import {
    H,
    captain,
    playToScoring,
    record,
    recordScores,
    setRole,
    side,
} from '../fixtures/draft-and-scoring-builders';
import { moderator } from '../fixtures/tournament-builders';
import { parkedLobby } from '../fixtures/ranked-game-builders';
import { rejection } from '../fixtures/calendar-roster-rating-builders';
import type { Team } from '../fixtures/team-and-turn';

const TOO_QUICK = 'You are entering results too quickly. Please wait a moment.';

// ════════════════════════════════════════════════════════════════════════════
// Results #7: the result-entry window and the adjustment bounds
// ════════════════════════════════════════════════════════════════════════════

const rateOf = (test: Harness, userId: number) => test.db.UserRateState.userId.find(userId) ?? undefined;
const adjustmentsOf = (test: Harness, recordId: number) => [...test.db.MatchResultAdjustment.by_result.filter(recordId)];

describe('Results #7: the per-user result-entry window (30 per 10 s) (match-results architecture S10f "Result-entry window")', () => {
    it('30 mixed writes inside 10 s pass, the 31st is rejected with its text and changes nothing; a new window passes (results audit #7)', () => {
        const test = newHarness();
        // The host sits on Blue: Blue captain (confirm_game) and referee (set_score_adjustment), one user for all three.
        const s = playToScoring(test, { hostSlot: 'BluePlayer', seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] });
        const { lobbyId } = s;
        expect(captain(s, 'Blue').userId).toBe(s.host.userId);
        recordScores(s, captain(s, 'Red'), 'Red', [H(20), H(20)]); // another user's window
        const rec = record(test, lobbyId);
        for (let i = 0; i < 10; i++) {
            recordScores(s, s.host, 'Blue', [H(10), H(10 + i)]);
            advance(test, 300);
            tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Blue'), value: 1 }));
            advance(test, 300);
            tx(test, s.host, (ctx) => M.confirm_game(ctx, { lobbyId, teamSide: side('Blue') }));
            advance(test, 300);
        }
        // 30 writes, the first at t0, the last at t0 + 8.7 s; now t0 + 9 s
        expect(rateOf(test, s.host.userId)!.resultEntryCount).toBe(30);
        const msgs = [
            rejection(test, s.host, (ctx) => M.record_group_scores(ctx, { lobbyId, teamSide: side('Blue'), values: [H(1), H(1)], deaths: 0 })),
            rejection(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Blue'), value: 1 })),
        ];
        expect(adjustmentsOf(test, rec.id)).toHaveLength(10);
        expect(rateOf(test, s.host.userId)!.resultEntryCount).toBe(30);
        expect(msgs).toEqual([TOO_QUICK, TOO_QUICK]);
        advance(test, 999); // t0 + 9.999 s: still the same window
        expect(rejection(test, s.host, (ctx) => M.confirm_game(ctx, { lobbyId, teamSide: side('Blue') }))).toBe(TOO_QUICK);
        advance(test, 1); // t0 + 10 s: a new window
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Blue'), value: 1 }));
        expect(adjustmentsOf(test, rec.id)).toHaveLength(11);
        expect(rateOf(test, s.host.userId)!.resultEntryCount).toBe(1);
    });

    it('one referee saving both teams\' scores at the same instant passes (results audit #7)', () => {
        const test = newHarness();
        const s = playToScoring(test);
        recordScores(s, s.host, 'Blue', [H(10), H(10)]);
        recordScores(s, s.host, 'Red', [H(20), H(20)]); // same clock instant
        expect(rateOf(test, s.host.userId)!.resultEntryCount).toBe(2);
    });

    it('staff outside the lobby (a Moderator) is not counted: 31 edits at one instant pass (results audit #7)', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const mod = moderator(test);
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), value: 1 }));
        const [adj] = adjustmentsOf(test, record(test, s.lobbyId).id);
        for (let i = 0; i < 31; i++) {
            tx(test, mod, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), value: i + 2, adjustmentId: adj.id }));
        }
        expect(test.db.MatchResultAdjustment.id.find(adj.id)!.value).toBe(32);
        expect(rateOf(test, mod.userId)?.resultEntryCount ?? 0).toBe(0);
    });

    it('the Admin closed-game edit is not counted, even by a lobby member: 31 edits at one instant pass (results audit #7, A60(7))', () => {
        const test = newHarness();
        const s = parkedLobby(test, {}, 'Blue'); // Ranked, Submitted, AwaitingResult; the host referee recorded both sides
        const before = rateOf(test, s.host.userId)!.resultEntryCount;
        setRole(test, s.host.userId, 'Admin');
        for (let i = 0; i < 31; i++) recordScores(s, s.host, 'Blue', [H(10), H(10)]);
        expect(rateOf(test, s.host.userId)!.resultEntryCount).toBe(before);
    });
});

describe('Results #7: adjustment bounds (match-results architecture S10f "Adjustment bounds")', () => {
    it('the 21st adjustment on a record is rejected with its text; an edit and a delete still pass, and a new one fits after the delete (results audit #7)', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const rec = record(test, s.lobbyId);
        const add = (team: Team, value: number) =>
            tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side(team), value }));
        for (let i = 0; i < 20; i++) add(i % 2 ? 'Red' : 'Blue', 1);
        expect(adjustmentsOf(test, rec.id)).toHaveLength(20);
        const msg = rejection(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), value: 1 }));
        expect(adjustmentsOf(test, rec.id)).toHaveLength(20);
        expect(msg).toBe('A game can carry at most 20 adjustments; edit or delete one first.');
        const [first] = adjustmentsOf(test, rec.id);
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Red'), value: 5, adjustmentId: first.id }));
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Red'), value: 0, adjustmentId: first.id }));
        expect(adjustmentsOf(test, rec.id)).toHaveLength(19);
        add('Blue', 1);
        expect(adjustmentsOf(test, rec.id)).toHaveLength(20);
    });

    it('an adjustment that would push a team\'s sum past ±100000000 is rejected with its text; the other team is unaffected (results audit #7)', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const rec = record(test, s.lobbyId);
        const adjust = (team: Team, value: number) => (ctx: any) =>
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side(team), value });
        tx(test, s.host, adjust('Blue', 100_000_000));
        expect(rejection(test, s.host, adjust('Blue', 1))).toBe('The Blue adjustments cannot add up to more than 100000000 hundredths either way.');
        tx(test, s.host, adjust('Red', 1));
        tx(test, s.host, adjust('Blue', -1));
        tx(test, s.host, adjust('Red', -100_000_000));
        expect(rejection(test, s.host, adjust('Red', -2))).toBe('The Red adjustments cannot add up to more than 100000000 hundredths either way.');
        expect(adjustmentsOf(test, rec.id).map((a) => a.value).sort((a, b) => a - b)).toEqual([-100_000_000, -1, 1, 100_000_000]);
    });

    it('naming the other team cannot move or delete an entry past the old team\'s bound; a delete that keeps the bound passes whatever teamSide says (review F2)', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const rec = record(test, s.lobbyId);
        const call = (team: Team, value: number, adjustmentId?: number) => (ctx: any) =>
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side(team), value, adjustmentId });
        tx(test, s.host, call('Blue', 100_000_000));
        tx(test, s.host, call('Blue', -100_000_000));
        tx(test, s.host, call('Blue', 100_000_000)); // Blue: +1e8, -1e8, +1e8 = 1e8
        const rows = () => adjustmentsOf(test, rec.id).map((a) => [a.teamSide.tag, a.value]).sort();
        const before = rows();
        const negative = adjustmentsOf(test, rec.id).find((a) => a.value === -100_000_000)!;
        const BLUE_SUM = 'The Blue adjustments cannot add up to more than 100000000 hundredths either way.';
        const msgs = [
            rejection(test, s.host, call('Red', 0, negative.id)), // the review's bypass: delete named as Red
            rejection(test, s.host, call('Red', -5, negative.id)), // move the entry to Red
        ];
        expect(rows()).toEqual(before);
        expect(msgs).toEqual([BLUE_SUM, BLUE_SUM]);
        const positive = adjustmentsOf(test, rec.id).find((a) => a.value === 100_000_000)!;
        tx(test, s.host, call('Red', 0, positive.id)); // a legitimate delete of a Blue entry, teamSide ignored: Blue sum 0
        expect(rows()).toEqual([['Blue', -100_000_000], ['Blue', 100_000_000]]);
    });
});
