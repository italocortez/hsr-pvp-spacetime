import spacetimedb from '../schema';
import { TournamentFinalizeJob } from '../tables/tournamentFinalizeJob';

// ─── run_tournament_finalize ──────────────────────────────────────────────────
// A24(7) / D.8.1 chunked finalization, bound to TournamentFinalizeJob through `onSchedule`. S3 only
// registers the table and this binding so the schema is valid.
// S8: reschedule first (F14), then finalize the next K = 4 settled MatchResultRecords in bracket order
// (processMatchMmr when countTowardsMmr and the stage is Completed, runFinalization with tournamentId /
// bracketMatchId on the history rows, hardDeleteLobby), skip Voided records, advance `cursor`; when none
// remain: rebuildLeaderboard once and set Tournament.finalizedAt.
export const run_tournament_finalize = spacetimedb.reducer(
    { onSchedule: TournamentFinalizeJob },
    { arg: TournamentFinalizeJob.rowType },
    (_ctx, { arg }) => {
        // S8: chunked finalization tick.
        console.log(`[TOURNAMENT_FINALIZE] S3 stub: tournament #${arg.tournamentId}, cursor ${arg.cursor} (no-op until S8)`);
    },
);
