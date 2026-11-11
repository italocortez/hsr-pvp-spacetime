// Tournaments: the unused columns of the closing triage are gone (Tournament.seasonId, TournamentFinalizeJob.cursor).
// Decisions: A36 (no season logic in the tournament row), A24(7) (the finalize job)
// Contracts: docs/tournament/contract.md
// From S11a.
//
// T-S11a (triage L84): Tournament.seasonId was always 0 and read by nobody (the rating reads resolve the active season
// themselves); TournamentFinalizeJob.cursor was read by log lines only. Both are removed. The other two columns of the
// row are kept because a later step gave them a reader: BracketMatch.scheduledAt (A157(12), the calendar match time)
// and TournamentStandIn.approvedByUserId (view_my_tournament_stand_ins).
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { BracketMatch, Tournament, TournamentFinalizeJob, TournamentStandIn } from '@bindings/types';
import { liveField, resolveMatch, advanceStage, tRow, BO1 } from '../fixtures/tournaments';
import { jobsOf, tick } from '../fixtures/tournament-matches';

describe('L84: Tournament.seasonId and TournamentFinalizeJob.cursor are removed', () => {
    it('a created tournament row and its finalize job rows carry neither key; the job still finalizes', () => {
        const f = liveField(4, BO1);
        expect('seasonId' in tRow(f.test, f.id)).toBe(false);
        for (let guard = 0; guard < 16; guard++) {
            const ready = [...f.test.db.BracketMatch.iter()].filter((m) => m.tournamentId === f.id && m.state.tag === 'Ready');
            if (ready.length === 0) break;
            resolveMatch(f.test, f.org, ready[0].id, ready[0].team1Id!);
        }
        advanceStage(f.test, f.org, f.id, 'Completed');
        const [job] = jobsOf(f.test, f.id);
        expect(Object.keys(job).sort()).toEqual(['scheduledAt', 'scheduledId', 'tournamentId']);
        tick(f.test, f.id);
        expect(tRow(f.test, f.id).finalizedAt).toBeDefined();
    });

    it('bindings: the removed keys are gone; scheduledAt and approvedByUserId stay (they have readers now)', () => {
        expectTypeOf<Tournament>().not.toHaveProperty('seasonId');
        expectTypeOf<TournamentFinalizeJob>().not.toHaveProperty('cursor');
        expectTypeOf<BracketMatch>().toHaveProperty('scheduledAt');
        expectTypeOf<TournamentStandIn>().toHaveProperty('approvedByUserId');
    });
});
