// Match results: a staff override keeps the player's dispute text and stores its own reason; the unused validation
// columns of the game row are gone.
// Decisions: D-07, A83
// Contracts: docs/match-results/contract.md (override_match_result)
// From S11a.
//
// T-S11a (triage L49): override_match_result wrote the staff reason over MatchResultRecord.disputeReason, so the
// participants read the staff text as the disputer's reason. It now writes MatchResultRecord.staffOverrideReason (new
// column), which view_my_match_result also carries.
// T-S11a (triage L60): MatchResultGame.validationStatus (always Pending) and validatedByUserId (never set) are removed,
// with the ValidationStatus enum, from the table and from view_my_match_result_games.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { MatchResultGame, MatchResultGameViewRow, MatchResultRecord, MatchResultViewRow } from '@bindings/types';
import { M, newHarness, tx } from '../fixtures/harness';
import { moderator } from '../fixtures/identity';
import { playRanked } from '../fixtures/ranked';
import { view } from '../fixtures/views';
import * as Enums from '@module/types/enums';

describe('L49: the staff override reason has its own column', () => {
    it('a Disputed record overridden to Validated keeps the dispute text; the participants read both texts apart', () => {
        const test = newHarness();
        const mod = moderator(test);
        const { s, recId } = playRanked(test, 'Red');
        tx(test, s.a.b1, (ctx) => M.dispute_match_result(ctx, { matchResultId: recId, reason: 'Red miscounted the cycles' }));
        tx(test, mod, (ctx) => M.override_match_result(ctx, {
            matchResultId: recId, newStatusTag: 'Validated', winnerTeamSideTag: 'Blue', reason: 'Screenshots checked',
        }));

        const record = test.db.MatchResultRecord.id.find(recId)!;
        expect(record).toMatchObject({ disputedByUserId: s.a.b1.userId, disputeReason: 'Red miscounted the cycles', staffOverrideReason: 'Screenshots checked' });

        const [row] = view<MatchResultViewRow>(test, 'view_my_match_result', s.a.r1);
        expect(row.disputeReason).toBe('Red miscounted the cycles');
        expect(row.staffOverrideReason).toBe('Screenshots checked');
    });

    it('a record never overridden has no staff reason', () => {
        const test = newHarness();
        const { recId } = playRanked(test, 'Blue');
        expect(test.db.MatchResultRecord.id.find(recId)!.staffOverrideReason).toBeUndefined();
    });

    it('the column is on the record type and the participant row type (bindings)', () => {
        expectTypeOf<MatchResultRecord>().toHaveProperty('staffOverrideReason');
        expectTypeOf<MatchResultViewRow>().toHaveProperty('staffOverrideReason');
    });
});

describe('L60: the game row has no validation columns', () => {
    it('a written game row carries neither key; the ValidationStatus enum is gone', () => {
        const test = newHarness();
        const { recId } = playRanked(test, 'Blue');
        const [game] = [...test.db.MatchResultGame.match_result_id.filter(recId)];
        expect(game).toBeDefined();
        expect('validationStatus' in game).toBe(false);
        expect('validatedByUserId' in game).toBe(false);
        expect('ValidationStatus' in Enums).toBe(false);
    });

    it('neither the table type nor the participant game row type has them (bindings)', () => {
        expectTypeOf<MatchResultGame>().not.toHaveProperty('validationStatus');
        expectTypeOf<MatchResultGame>().not.toHaveProperty('validatedByUserId');
        expectTypeOf<MatchResultGameViewRow>().not.toHaveProperty('validationStatus');
        expectTypeOf<MatchResultGameViewRow>().not.toHaveProperty('validatedByUserId');
    });
});
