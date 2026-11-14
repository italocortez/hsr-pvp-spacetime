import { deleteScoringRows, lobbyLineups } from '@module/helpers/results/scoringHelpers';
import spacetimedb from '@module/schema';
import { LobbyGcJob, setRunLobbyGcReducer } from '@module/tables/lobby/lobbyGcJob';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { insertWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensureModerator } from '@module/helpers/identity/ensurePermissions';
import { memberHasLeft } from '@module/helpers/lobby/lobbyHelpers';
import { ScheduleAt } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import { ensureScheduler } from '@module/helpers/admin/schedulerGuard';
import { rearmScheduledJob } from '@module/helpers/admin/scheduledJobRearm';
import { deleteCursorStamps } from '@module/helpers/lobby/cursorStamps';
import { trustedServerRow } from '@module/helpers/identity/serverIdentities';
// S11a (L11): `run_lobby_gc` is refused unless the scheduler calls it (ensureScheduler). `seed_lobby_gc_job` and
// `admin_gc_lobbies` keep their project-level gates (`ServerIdentity` check and `ensureModerator` respectively).

// ─── hardDeleteLobby ─────────────────────────────────────────────────────────
// Shared cascade-delete helper: removes a lobby and all associated data.
// Used by the GC reducer (abandoned lobbies) and exported for use in close_lobby.
// Cascade order per D-19, D-28:
//   1.  ChatMessage (event: lobby_id index)
//   1.5 LobbyMemberAccount (lobby_id btree index) — D-28
//   2.  LobbyMember (composite PK: lobbyId + userId)
//   3.  LobbyBan (composite PK: lobbyId + bannedUserId)
//   4.  LobbyPassword (unique PK: lobbyId)
//   5.  LobbyCursorEvent — event table, auto-deleted after broadcast (no manual cleanup)
//   6.  MatchSessionStep (lobby_id index)
//   7.  MatchSession (unique PK: lobbyId)
//   8.  Lobby row
//
// GC-04 audit (Phase 12.1): All match termination paths (runFinalization, hardDeleteLobby,
// admin_force_finalize, admin_void_match) clean MatchResult* rows. AwaitingResult lobbies
// are admin-only resolution (D-48). No orphaned MatchResultRecord gaps found.

export function hardDeleteLobby(ctx: any, lobbyId: number, keepResultRecord = false): void {
    // 0a. Delete MatchResult* rows (MatchResultParticipant, MatchResultGame, MatchResultRecord) and, A56(3),
    //     the scoring inputs (MatchResultGroupScore, MatchResultAdjustment) and the live MatchLineup rows.
    //     keepResultRecord (A24(3), S8d voidTournamentLobby): the record row itself survives (the caller marked it
    //     Voided for audit); its children are deleted as usual. The finalize job deletes it later.
    const matchResults = [...ctx.db.MatchResultRecord.lobby_id.filter(lobbyId)];
    for (const mr of matchResults) {
        deleteScoringRows(ctx, mr.id, lobbyId);
        for (const p of [...ctx.db.MatchResultParticipant.match_result_id.filter(mr.id)]) {
            ctx.db.MatchResultParticipant.delete(p);
        }
        for (const g of [...ctx.db.MatchResultGame.match_result_id.filter(mr.id)]) {
            ctx.db.MatchResultGame.delete(g);
        }
        if (!keepResultRecord) ctx.db.MatchResultRecord.delete(mr);
    }
    // Lineups are keyed by lobby: also sweep them when no record exists.
    for (const l of lobbyLineups(ctx, lobbyId)) ctx.db.MatchLineup.id.delete(l.id);

    // 1. Delete all ChatMessage rows
    for (const msg of [...ctx.db.ChatMessage.lobby_id.filter(lobbyId)]) {
        ctx.db.ChatMessage.id.delete(msg.id);
    }

    // 1.5. Delete all LobbyMemberAccount rows (D-28)
    for (const lma of [...ctx.db.LobbyMemberAccount.lobby_id.filter(lobbyId)]) {
        ctx.db.LobbyMemberAccount.delete(lma);
    }

    // 1.6. S11a (L19): the cursor throttle stamps
    deleteCursorStamps(ctx, lobbyId);

    // 2. Delete all LobbyMember rows
    for (const member of [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)]) {
        ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, member.userId]);
    }

    // 3. Delete all LobbyBan rows
    for (const ban of [...ctx.db.LobbyBan.lobby_id.filter(lobbyId)]) {
        ctx.db.LobbyBan.by_lobby_and_user.delete([lobbyId, ban.bannedUserId]);
    }

    // 4. Delete LobbyPassword if exists
    const pw = ctx.db.LobbyPassword.lobbyId.find(lobbyId);
    if (pw) {
        ctx.db.LobbyPassword.lobbyId.delete(lobbyId);
    }

    // 5. LobbyCursorEvent is an event table — rows auto-delete after broadcast.
    //    No manual cleanup needed.

    // 6. Delete all MatchSessionStep rows for this lobby
    for (const step of [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)]) {
        ctx.db.MatchSessionStep.id.delete(step.id);
    }

    // 7. Delete MatchSession if exists (1-to-1 with lobbyId as PK)
    const ms = ctx.db.MatchSession.lobbyId.find(lobbyId);
    if (ms) {
        ctx.db.MatchSession.lobbyId.delete(lobbyId);
    }

    // 8. Delete Lobby row
    ctx.db.Lobby.id.delete(lobbyId);
}

// ─── performLobbyGc ──────────────────────────────────────────────────────────
// Shared GC logic called by both scheduled and admin-triggered reducers (D-14, D-15).
// D-47: Also cleans Drafting/Equipping/Scoring where ALL members are offline + idle > 30 min.
// A68(9): Waiting lobbies take the same presence test before the 30 min idle rule (D-49's unconditional rule is
// retired); away and abandoned rows (A68(2)(4)) count as offline.
// D-48: NEVER touches AwaitingResult (admin-only resolution).

function performLobbyGc(ctx: any): { lobbiesScanned: number; lobbiesDeleted: number; deletedByStage: Record<string, number> } {
    const now = ctx.timestamp;
    const THIRTY_MINUTES_MICROS = BigInt(30 * 60 * 1_000_000);

    let lobbiesScanned = 0;
    let lobbiesDeleted = 0;
    const deletedByStage: Record<string, number> = {};

    // Iterate all lobbies — GC handles Waiting and abandoned active stages (A67(1): no other stage)
    for (const lobby of ctx.db.Lobby.iter()) {
        lobbiesScanned++;

        // D-48: AwaitingResult NEVER GC'd (admin-only resolution)
        if (lobby.stage.tag === 'AwaitingResult') continue;


        // D-47 / A68(9): Waiting, Drafting, Equipping, Scoring: ALL members offline + 30 min idle -> hard delete
        // (void, no winner in the live stages)
        // Check ALL members are offline (away / abandoned rows are offline, A68(2))
        const members = [...ctx.db.LobbyMember.lobby_id.filter(lobby.id)];
        const anyOnline = members.some((m: any) => m.isOnline && !memberHasLeft(m));
        if (anyOnline) continue; // At least one active member — skip

        // D-49: the 30-min idle rule
        // Check idle time based on lastActivityAt
        const idleTime = now.microsSinceUnixEpoch - lobby.lastActivityAt.microsSinceUnixEpoch;
        if (idleTime < THIRTY_MINUTES_MICROS) {
            continue;
        }

        // Hard delete cascade
        console.log(`[LOBBY_GC] Auto-cleaning lobby #${lobby.id} (stage: ${lobby.stage.tag}, idle: ${idleTime} µs)`);
        lobbiesDeleted++;
        deletedByStage[lobby.stage.tag] = (deletedByStage[lobby.stage.tag] ?? 0) + 1;
        hardDeleteLobby(ctx, lobby.id);
    }

    return { lobbiesScanned, lobbiesDeleted, deletedByStage };
}

// ─── run_lobby_gc ─────────────────────────────────────────────────────────────
// Scheduled GC reducer: safety net for abandoned lobbies idle > 30 min.
// D-14: Writes GcResult audit row on each run.
// Reschedules itself every 15 minutes after each run.

export const run_lobby_gc = spacetimedb.reducer(
    { arg: LobbyGcJob.rowType },
    (ctx, { arg }) => {
        ensureScheduler(ctx, 'run_lobby_gc');
        const result = performLobbyGc(ctx);

        // D-14: Write GcResult audit row only when something was deleted
        if (result.lobbiesDeleted > 0) {
            ctx.db.GcResult.insert(insertWithAudit(ctx, {
                id: 0,
                gcType: 'lobby',
                ranAt: ctx.timestamp,
                itemsScanned: result.lobbiesScanned,
                itemsDeleted: result.lobbiesDeleted,
                details: JSON.stringify({ deletedByStage: result.deletedByStage }),
            }, SYSTEM_USER_ID));
        }

        // Reschedule next GC run in 15 minutes
        const FIFTEEN_MINUTES_MICROS = ctx.timestamp.microsSinceUnixEpoch + BigInt(15 * 60 * 1_000_000);
        ctx.db.LobbyGcJob.insert({
            scheduledId: 0n,
            scheduledAt: ScheduleAt.time(FIFTEEN_MINUTES_MICROS),
        });
    }
);

// ─── admin_gc_lobbies (admin-triggered) ───────────────────────────────────────
// D-15: Admin/Moderator can trigger lobby GC on demand.
// One-shot: no self-requeue (Pitfall 6).

export const admin_gc_lobbies = spacetimedb.reducer((ctx) => {
    const user = ensureModerator(ctx);
    console.log('[LOBBY_GC] Admin-triggered run starting...');

    const result = performLobbyGc(ctx);

    ctx.db.GcResult.insert(insertWithAudit(ctx, {
        id: 0,
        gcType: 'lobby',
        ranAt: ctx.timestamp,
        itemsScanned: result.lobbiesScanned,
        itemsDeleted: result.lobbiesDeleted,
        details: JSON.stringify({ deletedByStage: result.deletedByStage, triggeredBy: 'admin' }),
    }, user.id));

    console.log(`[LOBBY_GC] Admin run complete: scanned=${result.lobbiesScanned}, deleted=${result.lobbiesDeleted}`);
    // NOTE: No self-requeue -- admin trigger is one-shot (Pitfall 6)
    // S11a (L6): but a chain that has stopped (no LobbyGcJob row: a failed scheduled run rolled back its own re-arm, or
    // the seed never ran; or, review M4, only a row long past its time) is restarted here, so a manual run is the way
    // back without a server identity.
    armLobbyGcJobIfMissing(ctx);
});

/**
 * S11a (L6, review M4): inserts the next scheduled run (15 minutes out) when the table holds no row, or when its only row
 * is more than 1 hour past its time (a dead chain whose row the host kept); returns whether it inserted.
 */
function armLobbyGcJobIfMissing(ctx: any): boolean {
    const outcome = rearmScheduledJob(ctx, ctx.db.LobbyGcJob, BigInt(15 * 60 * 1_000_000));
    if (outcome === 'kept') return false;
    console.log(outcome === 'armed'
        ? '[LOBBY_GC] LobbyGcJob was empty: next run scheduled in 15 minutes.'
        : '[LOBBY_GC] LobbyGcJob held a long-overdue row: replaced, next run scheduled in 15 minutes.');
    return true;
}

// ─── seed_lobby_gc_job (server-only, idempotent) ────────────────────────────
// Inserts the first LobbyGcJob row to kick off the scheduled GC chain.
// Called from scripts/stdb/bootstrap.ts after every wipe publish.
// Retroactive fix: Phase 09 required manual seeding — this automates it.

export const seed_lobby_gc_job = spacetimedb.reducer((ctx) => {
    // M5a3: a Linker is not a trusted server identity (trustedServerRow).
    const server = trustedServerRow(ctx, ctx.sender);
    if (!server) {
        throw new SenderError('Forbidden: caller is not the registered server identity.');
    }

    if (!armLobbyGcJobIfMissing(ctx)) {
        console.log('[LOBBY_GC] Seed skipped -- LobbyGcJob already has a row.');
        return;
    }
    console.log('[LOBBY_GC] Seed complete -- first run scheduled in 15 minutes.');
});

// Wire the reducer into the scheduled table's lazy reference
setRunLobbyGcReducer(run_lobby_gc);
