import { table, t } from 'spacetimedb/server';

/**
 * A24(7) / D-D1 / D.8.1 (S3): chunked tournament finalization. advance_tournament_stage(Completed) inserts
 * one row { tournamentId, cursor: 0 } scheduled now; run_tournament_finalize (S8) processes the next K = 4
 * settled records in bracket order per tick (MMR from the stored snapshots, then per-match history / stats /
 * achievements, then hardDeleteLobby), advances `cursor`, reschedules itself before doing the work (F14
 * lesson) and stops when no record remains, then rebuilds the leaderboard once and sets Tournament.finalizedAt.
 * `cursor` = number of settled records already finalized (the bracket-order offset to resume from).
 * Scheduled table: no audit columns, like the GC jobs. Binds through `onSchedule`.
 */
export const tournamentFinalizeJobColumns = {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    tournamentId: t.u32(),
    cursor: t.u32(),
};

export const TournamentFinalizeJob = table({
    name: 'tournament_finalize_job',
    indexes: [
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] },
    ],
}, tournamentFinalizeJobColumns);
