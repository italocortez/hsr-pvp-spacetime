import { table, t } from 'spacetimedb/server';

/**
 * A24(7) / D-D1 / D.8.1 (S3): chunked tournament finalization. advance_tournament_stage(Completed) inserts
 * one row { tournamentId } scheduled now; run_tournament_finalize (S8) processes the next K = 4
 * settled records in bracket order per tick (MMR from the stored snapshots, then per-match history / stats /
 * achievements, then hardDeleteLobby), reschedules itself before doing the work (F14 lesson) and stops when no
 * record remains, then rebuilds the leaderboard once and sets Tournament.finalizedAt. Finalized records are deleted,
 * so each tick reads the first K survivors; S11a (triage L84): the progress `cursor` column, read by log lines only,
 * is removed.
 * Scheduled table: no audit columns, like the GC jobs. Binds through `onSchedule`.
 */
export const tournamentFinalizeJobColumns = {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    tournamentId: t.u32(),
};

export const TournamentFinalizeJob = table({
    name: 'tournament_finalize_job',
    indexes: [
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] },
    ],
}, tournamentFinalizeJobColumns);
