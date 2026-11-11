import spacetimedb from '@module/schema';
import { TournamentFinalizeJob } from '@module/tables/tournament/tournamentFinalizeJob';
import { runTournamentFinalizeTick } from '@module/helpers/tournament/tournamentFinalization';
import { ensureScheduler } from '@module/helpers/admin/schedulerGuard';

// ─── run_tournament_finalize ──────────────────────────────────────────────────
// A24(4)(5)(7) / D.8.1 chunked finalization (S8d), bound to TournamentFinalizeJob through `onSchedule`. One tick =
// one transaction: reschedule first (F14), then finalize the next K = 4 surviving records of the tournament in
// bracket order (runTournamentFinalizeTick, helpers/tournament/tournamentFinalization.ts); when none remain: the leaderboard
// once (MMR tournaments), Tournament.finalizedAt, and the job ends. Started by advance_tournament_stage(Completed)
// and by the cancel path (cancelTournament).
export const run_tournament_finalize = spacetimedb.reducer(
    { onSchedule: TournamentFinalizeJob },
    { arg: TournamentFinalizeJob.rowType },
    (ctx, { arg }) => {
        ensureScheduler(ctx, 'run_tournament_finalize'); // S11a (L11)
        runTournamentFinalizeTick(ctx, arg);
    },
);
