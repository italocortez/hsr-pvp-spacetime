import spacetimedb from '@module/schema';
import { IdentityGcJob, setRunIdentityGcReducer } from '@module/tables/identity/identityGcJob';
import { ScheduleAt } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
// External-invocation defense for `run_identity_gc`: SpacetimeDB v2.2.0 engine returns
// "no such reducer" for external WS callers attempting to invoke scheduled reducers
// (verified 2026-05-03 in 16.4-AUDIT-NOTES.md "v0.6 Update"). Application-level
// `ctx.senderAuth.isInternal` guard was removed by Plan 07 hotfix because the SDK
// v2.2.0 `senderAuth` factory always set `isInternal: false`. Since SDK 2.14 (M1),
// `isInternal` is `sender === databaseIdentity`: true for scheduled reducers, false for
// `init`, and `jwt` is null when internal. The guard is not re-added yet (deferred,
// upgrade report §10 Q8). `seed_identity_gc_job` and `admin_gc_identities` retain their existing project-level gates (`ServerIdentity`
// check and `ensureModerator` respectively).
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { insertWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensureModerator } from '@module/helpers/identity/ensurePermissions';
import { hasLivePresence } from '@module/helpers/identity/presenceHelpers';
import { hasHistoryReferences, performUserDeletion } from '@module/helpers/identity/userDeletionHelper';

// ─── Constants ────────────────────────────────────────────────────────────────

// Time unit conversion (the only place "micros per day" knowledge lives).
const MICROS_PER_DAY = 86_400_000_000n;  // 24 * 60 * 60 * 1_000_000

// D-11: an identity becomes stale after 90 days of idle.
const IDENTITY_TTL_DAYS = 90;
const IDENTITY_TTL_MICROS = BigInt(IDENTITY_TTL_DAYS) * MICROS_PER_DAY;

// A95(1): a guest user idle this long with no match history at all is deleted.
const GUEST_IDLE_DAYS = 30;
const GUEST_IDLE_MICROS = BigInt(GUEST_IDLE_DAYS) * MICROS_PER_DAY;

// A95(1): at most this many guest users are deleted per run (each is one performUserDeletion cascade). The scan visits
// every identity each run, so the guests over the cap are found again and deleted by the next run (one hour later
// when a scheduled run reached the cap, review F4; or an admin_gc_identities call); no cursor is kept.
const GUEST_DELETIONS_PER_RUN = 500;

// D-03: scheduled GC runs weekly.
const GC_INTERVAL_DAYS = 7;
const GC_INTERVAL_MICROS = BigInt(GC_INTERVAL_DAYS) * MICROS_PER_DAY;

// S10h review F4: a scheduled run that reached GUEST_DELETIONS_PER_RUN may have left expired guests behind, so the
// next run comes after this delay instead of the weekly interval (the run still schedules exactly one next run).
const GC_BACKLOG_INTERVAL_MICROS = 3_600_000_000n; // 1 hour

// A48: the per-identity UserPresence row goes with the identity it describes.
function deletePresenceRow(ctx: any, identity: any): void {
    if (ctx.db.UserPresence.identity.find(identity)) {
        ctx.db.UserPresence.identity.delete(identity);
    }
}

/**
 * A95(1): whether a guest user is past retention. Every check is an index read.
 * - Idle: no live UserPresence row of the user (user_id index), and the latest sign of life of every identity of the
 *   user is GUEST_IDLE_DAYS or older: the later of UserIdentity.lastSeenAt (bumped by login_as_guest) and the
 *   identity's UserPresence.lastSeenAt (stamped by client_disconnected; identity PK). A guest who holds a LobbyMember
 *   row (any lobby, any stage: user_id index) or an enrolment in a tournament that is not Completed or Cancelled
 *   (TournamentEnrolled.user_id, Tournament.id) is never idle. A user already scheduled for deletion (deletedAt) is
 *   left to that job.
 * - No match history at all: no MatchParticipantHistory row (archived matches; by_user index) and nothing
 *   hasHistoryReferences finds (one index probe each): MatchResultParticipant (live and pending records), MmrHistory,
 *   PlayerStat, PlayerCharacterStat, PlayerRelationship, Leaderboard, TournamentEnrolled (any stage; a finished
 *   tournament's enrolment keeps the guest), UserAchievement. S10h review F1: a casual concede or forfeit archives no
 *   participant row but writes PlayerStat, so the stat rows count as match history.
 */
function guestPastRetention(ctx: any, user: any, identities: any[], nowMicros: bigint): boolean {
    if (user.deletedAt !== undefined) return false;
    if (hasLivePresence(ctx, user.id)) return false;
    for (const ui of identities) {
        const presence = ctx.db.UserPresence.identity.find(ui.identity);
        let lastSeen: bigint = ui.lastSeenAt.microsSinceUnixEpoch;
        if (presence && presence.lastSeenAt.microsSinceUnixEpoch > lastSeen) lastSeen = presence.lastSeenAt.microsSinceUnixEpoch;
        if (nowMicros - lastSeen < GUEST_IDLE_MICROS) return false;
    }
    for (const _ of ctx.db.LobbyMember.user_id.filter(user.id)) return false;
    for (const enrolled of ctx.db.TournamentEnrolled.user_id.filter(user.id)) {
        const stage = ctx.db.Tournament.id.find(enrolled.tournamentId)?.stage.tag;
        if (stage !== undefined && stage !== 'Completed' && stage !== 'Cancelled') return false;
    }
    for (const _ of ctx.db.MatchParticipantHistory.by_user.filter(user.id)) return false;
    if (hasHistoryReferences(ctx, user.id)) return false;
    return true;
}

// ─── performIdentityGc ────────────────────────────────────────────────────────
// Shared GC logic called by both scheduled and admin-triggered reducers (Pitfall 6).
// D-06: Skip guest users; A95(1): except a guest idle for 30 days with no match history, which is deleted
//       through performUserDeletion (at most GUEST_DELETIONS_PER_RUN per run).
// D-07: Always preserve the newest identity per user (even if past TTL).
// D-08: Skip users who are currently online.
// D-11: 90-day TTL for verified user identities.
// D-12: Orphaned identity rows (user not found) are deleted immediately.
// D-05: Log each deletion with [IDENTITY_GC] prefix.

function performIdentityGc(ctx: any, actorId: number): { itemsScanned: number; itemsDeleted: number; orphanedCount: number; staleCount: number; guestCount: number } {
    const nowMicros: bigint = ctx.timestamp.microsSinceUnixEpoch;
    let itemsScanned = 0;
    let itemsDeleted = 0;
    let orphanedCount = 0;
    let staleCount = 0;
    let guestCount = 0;

    // Build identity map grouped by userId in ONE iter() pass (Pitfall 3)
    const identityMap = new Map<number, any[]>();
    for (const ui of ctx.db.UserIdentity.iter()) {
        itemsScanned++;
        const arr = identityMap.get(ui.userId) ?? [];
        arr.push(ui);
        identityMap.set(ui.userId, arr);
    }

    // S10e (identity audit #1): the server identities (Owner, Delegates) and every mapping of the SYSTEM user are never
    // collected: losing them strips the Owner / a delegate of the admin rights the SYSTEM link gives
    // (getAuthenticatedUser), and nothing re-creates the mapping (init does not rerun; server_register_delegate
    // rejects an already registered identity).
    const systemUserId = ctx.db.User.username.find('SYSTEM')?.id;
    const isProtected = (ui: any) => ui.userId === systemUserId || !!ctx.db.ServerIdentity.identity.find(ui.identity);

    for (const [userId, allIdentities] of identityMap) {
        const identities = allIdentities.filter((ui: any) => !isProtected(ui));
        if (identities.length === 0) continue;
        const user = ctx.db.User.id.find(userId);

        // D-12: Orphaned identity (user row not found) -> delete immediately
        if (!user) {
            for (const ui of identities) {
                ctx.db.UserIdentity.identity.delete(ui.identity);
                deletePresenceRow(ctx, ui.identity);
                console.log(`[IDENTITY_GC] Deleted orphaned identity for missing user #${userId}`);  // D-05
                itemsDeleted++;
                orphanedCount++;
            }
            continue;
        }

        // D-06: guest identities are never collected one by one; A95(1): a guest user past retention is deleted whole
        // (identities, presence and every other row through performUserDeletion).
        if (user.isGuest) {
            if (guestCount < GUEST_DELETIONS_PER_RUN && guestPastRetention(ctx, user, allIdentities, nowMicros)) {
                performUserDeletion(ctx, userId, actorId);
                console.log(`[IDENTITY_GC] Deleted guest user #${userId} (idle ${GUEST_IDLE_DAYS}+ days, no match history; A95)`);  // D-05
                itemsDeleted++;
                guestCount++;
            }
            continue;
        }

        // D-08: Skip users currently online (A48: any live UserPresence row of the user)
        if (hasLivePresence(ctx, userId)) continue;

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
                deletePresenceRow(ctx, ui.identity);
                console.log(`[IDENTITY_GC] Deleted stale identity for user #${userId} (idle: ${idleMicros / MICROS_PER_DAY} days)`);  // D-05
                itemsDeleted++;
                staleCount++;
            }
        }
    }

    return { itemsScanned, itemsDeleted, orphanedCount, staleCount, guestCount };
}

// ─── run_identity_gc (scheduled) ─────────────────────────────────────────────
// D-02: Scheduled weekly identity GC.
// D-03: Self-requeues every 7 days (one hour when the run reached GUEST_DELETIONS_PER_RUN, review F4).
// D-04: Writes GcResult audit row on each run.

export const run_identity_gc = spacetimedb.reducer(
    { arg: IdentityGcJob.rowType },
    (ctx, { arg }) => {
        console.log('[IDENTITY_GC] Scheduled run starting...');

        const result = performIdentityGc(ctx, SYSTEM_USER_ID);

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
                    guests: result.guestCount, // A95(1)
                }),
            }, SYSTEM_USER_ID));
        }

        console.log(`[IDENTITY_GC] Complete: scanned=${result.itemsScanned}, deleted=${result.itemsDeleted} (orphaned=${result.orphanedCount}, stale=${result.staleCount}, guests=${result.guestCount})`);

        // Self-requeue: next run in 7 days (D-03), or in one hour when the guest deletion cap was reached (review F4)
        const capReached = result.guestCount >= GUEST_DELETIONS_PER_RUN;
        ctx.db.IdentityGcJob.insert({
            scheduledId: 0n,
            scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch
                + (capReached ? GC_BACKLOG_INTERVAL_MICROS : GC_INTERVAL_MICROS)),
        });
    }
);

// ─── admin_gc_identities (admin-triggered) ────────────────────────────────────
// D-15: Admin/Moderator can trigger identity GC on demand.
// One-shot: no self-requeue (Pitfall 6).

export const admin_gc_identities = spacetimedb.reducer((ctx) => {
    const user = ensureModerator(ctx);
    console.log('[IDENTITY_GC] Admin-triggered run starting...');

    const result = performIdentityGc(ctx, user.id);

    ctx.db.GcResult.insert(insertWithAudit(ctx, {
        id: 0,
        gcType: 'identity',
        ranAt: ctx.timestamp,
        itemsScanned: result.itemsScanned,
        itemsDeleted: result.itemsDeleted,

        details: JSON.stringify({
            orphaned: result.orphanedCount,
            stale: result.staleCount,
            guests: result.guestCount, // A95(1)
            triggeredBy: 'admin',
        }),
    }, user.id));

    console.log(`[IDENTITY_GC] Admin run complete: scanned=${result.itemsScanned}, deleted=${result.itemsDeleted}`);
    // NOTE: No self-requeue -- admin trigger is one-shot (Pitfall 6)
});

// ─── seed_identity_gc_job (server-only, idempotent) ──────────────────────────
// Inserts the first IdentityGcJob row to kick off the scheduled GC chain.
// Called from scripts/stdb/bootstrap.ts after every wipe publish.
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
