import spacetimedb from '../schema';
import { IdentityGcJob, setRunIdentityGcReducer } from '../tables/identityGcJob';
import { ScheduleAt } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
// External-invocation defense for `run_identity_gc`: SpacetimeDB v2.2.0 engine returns
// "no such reducer" for external WS callers attempting to invoke scheduled reducers
// (verified 2026-05-03 in 16.4-AUDIT-NOTES.md "v0.6 Update"). Application-level
// `ctx.senderAuth.isInternal` guard was removed by Plan 07 hotfix because the SDK
// v2.2.0 `senderAuth` factory always sets `isInternal: false`. `seed_identity_gc_job`
// and `admin_gc_identities` retain their existing project-level gates (`ServerIdentity`
// check and `ensureModerator` respectively).
import { SYSTEM_USER_ID } from '../helpers/auditColumns';
import { insertWithAudit } from '../helpers/auditHelpers';
import { ensureModerator } from '../helpers/ensurePermissions';

// ─── Constants ────────────────────────────────────────────────────────────────

// Time unit conversion (the only place "micros per day" knowledge lives).
const MICROS_PER_DAY = 86_400_000_000n;  // 24 * 60 * 60 * 1_000_000

// D-11: an identity becomes stale after 90 days of idle.
const IDENTITY_TTL_DAYS = 90;
const IDENTITY_TTL_MICROS = BigInt(IDENTITY_TTL_DAYS) * MICROS_PER_DAY;

// D-03: scheduled GC runs weekly.
const GC_INTERVAL_DAYS = 7;
const GC_INTERVAL_MICROS = BigInt(GC_INTERVAL_DAYS) * MICROS_PER_DAY;

// ─── performIdentityGc ────────────────────────────────────────────────────────
// Shared GC logic called by both scheduled and admin-triggered reducers (Pitfall 6).
// D-06: Skip guest users.
// D-07: Always preserve the newest identity per user (even if past TTL).
// D-08: Skip users who are currently online.
// D-11: 90-day TTL for verified user identities.
// D-12: Orphaned identity rows (user not found) are deleted immediately.
// D-05: Log each deletion with [IDENTITY_GC] prefix.

function performIdentityGc(ctx: any): { itemsScanned: number; itemsDeleted: number; orphanedCount: number; staleCount: number } {
    const nowMicros: bigint = ctx.timestamp.microsSinceUnixEpoch;
    let itemsScanned = 0;
    let itemsDeleted = 0;
    let orphanedCount = 0;
    let staleCount = 0;

    // Build identity map grouped by userId in ONE iter() pass (Pitfall 3)
    const identityMap = new Map<number, any[]>();
    for (const ui of ctx.db.UserIdentity.iter()) {
        itemsScanned++;
        const arr = identityMap.get(ui.userId) ?? [];
        arr.push(ui);
        identityMap.set(ui.userId, arr);
    }

    for (const [userId, identities] of identityMap) {
        const user = ctx.db.User.id.find(userId);

        // D-12: Orphaned identity (user row not found) -> delete immediately
        if (!user) {
            for (const ui of identities) {
                ctx.db.UserIdentity.identity.delete(ui.identity);
                console.log(`[IDENTITY_GC] Deleted orphaned identity for missing user #${userId}`);  // D-05
                itemsDeleted++;
                orphanedCount++;
            }
            continue;
        }

        // D-06: Skip guest users entirely
        if (user.isGuest) continue;

        // D-08: Skip users currently online
        if (user.isOnline) continue;

        // D-07: Sort by lastSeenAt descending -- preserve newest even if past TTL
        const sorted = [...identities].sort((a: any, b: any) =>
            Number(b.lastSeenAt.microsSinceUnixEpoch - a.lastSeenAt.microsSinceUnixEpoch)
        );
        const [_newest, ...rest] = sorted;

        // Delete stale identities past TTL (skip the newest -- D-07)
        for (const ui of rest) {
            const idleMicros = nowMicros - ui.lastSeenAt.microsSinceUnixEpoch;
            if (idleMicros >= IDENTITY_TTL_MICROS) {
                ctx.db.UserIdentity.identity.delete(ui.identity);
                console.log(`[IDENTITY_GC] Deleted stale identity for user #${userId} (idle: ${idleMicros / MICROS_PER_DAY} days)`);  // D-05
                itemsDeleted++;
                staleCount++;
            }
        }
    }

    return { itemsScanned, itemsDeleted, orphanedCount, staleCount };
}

// ─── run_identity_gc (scheduled) ─────────────────────────────────────────────
// D-02: Scheduled weekly identity GC.
// D-03: Self-requeues every 7 days.
// D-04: Writes GcResult audit row on each run.

export const run_identity_gc = spacetimedb.reducer(
    { arg: IdentityGcJob.rowType },
    (ctx, { arg }) => {
        console.log('[IDENTITY_GC] Scheduled run starting...');

        const result = performIdentityGc(ctx);

        // Write GcResult audit row only when something was deleted (D-10, GC-02)
        if (result.itemsDeleted > 0) {
            ctx.db.GcResult.insert(insertWithAudit(ctx, {
                id: 0,  // autoInc
                gcType: 'identity',
                ranAt: ctx.timestamp,
                itemsScanned: result.itemsScanned,
                itemsDeleted: result.itemsDeleted,
                details: JSON.stringify({
                    orphaned: result.orphanedCount,
                    stale: result.staleCount,
                }),
            }, SYSTEM_USER_ID));
        }

        console.log(`[IDENTITY_GC] Complete: scanned=${result.itemsScanned}, deleted=${result.itemsDeleted} (orphaned=${result.orphanedCount}, stale=${result.staleCount})`);

        // Self-requeue: next run in 7 days (D-03)
        ctx.db.IdentityGcJob.insert({
            scheduledId: 0n,
            scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + GC_INTERVAL_MICROS),
        });
    }
);

// ─── admin_gc_identities (admin-triggered) ────────────────────────────────────
// D-15: Admin/Moderator can trigger identity GC on demand.
// One-shot: no self-requeue (Pitfall 6).

export const admin_gc_identities = spacetimedb.reducer((ctx) => {
    const user = ensureModerator(ctx);
    console.log('[IDENTITY_GC] Admin-triggered run starting...');

    const result = performIdentityGc(ctx);

    ctx.db.GcResult.insert(insertWithAudit(ctx, {
        id: 0,
        gcType: 'identity',
        ranAt: ctx.timestamp,
        itemsScanned: result.itemsScanned,
        itemsDeleted: result.itemsDeleted,

        details: JSON.stringify({
            orphaned: result.orphanedCount,
            stale: result.staleCount,
            triggeredBy: 'admin',
        }),
    }, user.id));

    console.log(`[IDENTITY_GC] Admin run complete: scanned=${result.itemsScanned}, deleted=${result.itemsDeleted}`);
    // NOTE: No self-requeue -- admin trigger is one-shot (Pitfall 6)
});

// ─── seed_identity_gc_job (server-only, idempotent) ──────────────────────────
// Inserts the first IdentityGcJob row to kick off the scheduled GC chain.
// Called from post-publish.ts after every --clear-database publish.
// Server-identity-gated: rejects non-server callers.
// Idempotent: skips if a row already exists.

export const seed_identity_gc_job = spacetimedb.reducer((ctx) => {
    // Server-only: verify caller is the registered server identity
    const server = ctx.db.ServerIdentity.identity.find(ctx.sender);
    if (!server) {
        throw new SenderError('Forbidden: caller is not the registered server identity.');
    }

    // Idempotent: skip if table already has a row
    const existing = [...ctx.db.IdentityGcJob.iter()];
    if (existing.length > 0) {
        console.log('[IDENTITY_GC] Seed skipped -- IdentityGcJob already has a row.');
        return;
    }

    // Schedule first run 7 days from now
    ctx.db.IdentityGcJob.insert({
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + GC_INTERVAL_MICROS),
    });
    console.log('[IDENTITY_GC] Seed complete -- first run scheduled in 7 days.');
});

// Wire the scheduled reducer into the table binding (must be last)
setRunIdentityGcReducer(run_identity_gc);
