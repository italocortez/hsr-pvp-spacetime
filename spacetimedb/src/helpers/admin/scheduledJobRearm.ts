import { ScheduleAt } from 'spacetimedb';

/** A row this much past its time (at least) counts as a dead chain, whatever the job's own interval. */
const MIN_OVERDUE_MICROS = 3_600_000_000n; // 1 hour

/**
 * S11a (triage L6, review M4): restarts a self-requeueing scheduled chain (`IdentityGcJob`, `LobbyGcJob`) from the
 * manual tools and the seed reducers.
 *
 * - No row: the chain has stopped (a failed run rolled back its own re-arm, or the seed never ran). One row is
 *   inserted `intervalMicros` from now.
 * - Exactly one row whose time is past by more than max(`intervalMicros`, 1 hour): the host may keep the row of a
 *   failed one-shot run, so such a row is treated as missing: it is deleted and a fresh one inserted.
 * - Anything else (a row due in the future or only slightly late, or two rows already): left alone, so the table never
 *   ends with a second row added here.
 *
 * Returns 'armed' (table was empty), 'replaced' (a long-overdue row was swapped) or 'kept'.
 */
export function rearmScheduledJob(
    ctx: any,
    jobTable: any,
    intervalMicros: bigint,
): 'armed' | 'replaced' | 'kept' {
    const rows: any[] = [];
    for (const row of jobTable.iter()) { // at most the chain's next run: stop after two
        rows.push(row);
        if (rows.length > 1) return 'kept';
    }
    const now: bigint = ctx.timestamp.microsSinceUnixEpoch;
    let outcome: 'armed' | 'replaced' = 'armed';
    if (rows.length === 1) {
        const at = rows[0].scheduledAt;
        if (at.tag !== 'Time') return 'kept';
        const threshold = intervalMicros > MIN_OVERDUE_MICROS ? intervalMicros : MIN_OVERDUE_MICROS;
        if (now - at.value.microsSinceUnixEpoch <= threshold) return 'kept';
        jobTable.scheduledId.delete(rows[0].scheduledId);
        outcome = 'replaced';
    }
    jobTable.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(now + intervalMicros) });
    return outcome;
}
