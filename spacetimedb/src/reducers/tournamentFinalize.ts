import spacetimedb from '../schema';
import { TournamentFinalizeJob } from '../tables/tournamentFinalizeJob';
import { runTournamentFinalizeTick } from '../helpers/tournamentFinalization';

// ─── run_tournament_finalize ──────────────────────────────────────────────────
// A24(4)(5)(7) / D.8.1 chunked finalization (S8d), bound to TournamentFinalizeJob through `onSchedule`. One tick =
// one transaction: reschedule first (F14), then finalize the next K = 4 surviving records of the tournament in
// bracket order (runTournamentFinalizeTick, helpers/tournamentFinalization.ts); when none remain: the leaderboard
// once (MMR tournaments), Tournament.finalizedAt, and the job ends. Started by advance_tournament_stage(Completed)
// and by the cancel path (cancelTournament).
export const run_tournament_finalize = spacetimedb.reducer(
    { onSchedule: TournamentFinalizeJob },
    { arg: TournamentFinalizeJob.rowType },
    (ctx, { arg }) => {
        runTournamentFinalizeTick(ctx, arg);
    },
);
