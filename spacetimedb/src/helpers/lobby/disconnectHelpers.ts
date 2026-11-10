import { SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import { ACTIVE_STAGES, type LobbyStage } from '@shared/lobby-rules';
import { slotTeam, slotIsCoach, slotIsSpectator, memberHasLeft, isSeatedPlayer, anySeatedPlayerAway } from './lobbyHelpers';
import { lobbySteps } from '@module/helpers/draft/stepSequence';
import { resumedTimerState } from '@module/helpers/draft/turnClock';
import { findLobbyResult } from '@module/helpers/results/scoringHelpers';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';

// A22a: the grace period between a user's last disconnect and the referee / captain / host transfer check.
const REFEREE_TRANSFER_GRACE_MICROS = 15_000_000n;
// D-08: the forfeit clock (disconnectedAt -> pool decrement, isForfeitEligible) runs only in the three live-match
// stages. A67(1): those are also every ACTIVE_STAGES entry (the between-games stages are gone).
const DISCONNECT_CLOCK_STAGES: readonly LobbyStage[] = ['Drafting', 'Equipping', 'Scoring'];

/**
 * A22a (D.8.2) / A68(1): takes one membership offline, the shared body of `client_disconnected` (per membership) and
 * of a player's `leave_lobby` in a live stage: `isOnline = false`; in a live stage `disconnectedAt` stamped under
 * Standard / Deferred (D-08; NoAction tracks nothing); in an active stage, and in Waiting for the referee only
 * (A92(5) as narrowed by A93(1): a host who is not the referee schedules nothing in Waiting), one
 * `RefereeTransferCheck` row 15 s out (a stale pending one is dropped first). `extra` carries the Leave's `leftAt` (A68(2)). The row, its
 * LobbyMemberAccount rows and currentPlayerCount are untouched; the flags move only through the 15 s check.
 */
export function markMemberOffline(ctx: any, lobby: any, member: any, actorId: number, extra: { leftAt?: any } = {}): void {
    const stageTag = lobby.stage.tag as LobbyStage;
    const tracksDisconnect = DISCONNECT_CLOCK_STAGES.includes(stageTag) && lobby.disconnectPolicy.tag !== 'NoAction';

    ctx.db.LobbyMember.by_lobby_and_user.delete([member.lobbyId, member.userId]);
    ctx.db.LobbyMember.insert(updateWithAudit(ctx, member, {
        isOnline: false,
        disconnectedAt: tracksDisconnect ? ctx.timestamp : member.disconnectedAt,
        ...extra,
    }, actorId));

    // A92(5) / A93(1): in Waiting the 15 s check runs only for the referee (the referee flag moves; the host role does
    // not move on a disconnect in Waiting; no clock, no pause).
    if (!ACTIVE_STAGES.includes(stageTag) && !(stageTag === 'Waiting' && member.isReferee)) return;

    // One pending check per (lobby, user): drop a stale one before scheduling.
    for (const check of [...ctx.db.RefereeTransferCheck.by_lobby_and_user.filter([member.lobbyId, member.userId])]) {
        ctx.db.RefereeTransferCheck.scheduledId.delete(check.scheduledId);
    }
    insertTransferCheck(ctx, member.lobbyId, member.userId);
}

function insertTransferCheck(ctx: any, lobbyId: number, userId: number): void {
    ctx.db.RefereeTransferCheck.insert({
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + REFEREE_TRANSFER_GRACE_MICROS),
        lobbyId,
        userId,
    });
}

/**
 * S10e review F2 (A93(4)): called by start_draft as the lobby enters Drafting. A host or referee row that is offline at
 * that moment (offline, away or abandoned) gets the 15 s RefereeTransferCheck, so the host role and the referee flag
 * move in the live stages as they do for a disconnect after the start (in Waiting the host's disconnect scheduled
 * nothing, A93(1)). A check already pending for the row (a referee who dropped in Waiting) is kept as is. Nothing is
 * stamped or paused here; the check decides as for any other subject (a seated player is online at the start, A92(1)).
 */
export function scheduleChecksForOfflineStaff(ctx: any, lobby: any): void {
    for (const m of [...ctx.db.LobbyMember.lobby_id.filter(lobby.id)]) {
        if (!m.isReferee && lobby.hostUserId !== m.userId) continue;
        if (m.isOnline && !memberHasLeft(m)) continue;
        if ([...ctx.db.RefereeTransferCheck.by_lobby_and_user.filter([lobby.id, m.userId])].length > 0) continue;
        insertTransferCheck(ctx, lobby.id, m.userId);
    }
}

/**
 * A85(1), A92(7): the one automatic lift of a disconnect auto-pause, shared by the `join_lobby` reconnect branch and
 * `client_connected` so the two paths cannot drift (policy review G10). Lifts only in Drafting, only when the returning
 * row is a seated player and no seated player of either team is still offline, away or abandoned (call it after the
 * returning row is back online), and only when the latest Pause step is an auto-pause (a manual pause keeps D-62).
 * Clock write (S10f, F10 / G10): resumedTimerState, the same write as resume_draft (turnStartAt = now, the frozen
 * remaining time in accumulatedPauseMs kept), so the turn continues with the time it had when it was auto-paused.
 */
export function liftAutoPauseOnReturn(ctx: any, lobby: any, member: any, actorId: number): void {
    if (lobby.stage.tag !== 'Drafting' || !isSeatedPlayer(member) || anySeatedPlayerAway(ctx, lobby.id)) return;
    const session = ctx.db.MatchSession.lobbyId.find(lobby.id);
    if (!session || !session.timerState.isPaused) return;
    // The latest Pause step decides (S7b hand-off: a SetEidolon or other step logged after the pause does not hide it).
    const lastPause = lobbySteps(ctx, lobby.id)
        .filter((s: any) => s.payload?.tag === 'Pause')
        .sort((a: any, b: any) => b.sequence - a.sequence)[0];
    if (!lastPause?.payload?.value?.isAutoPause) return;
    ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
        timerState: resumedTimerState(ctx, session.timerState),
    }, actorId));
}

/**
 * True when the lobby's MatchResultRecord carries matchEndReason Concede. A54 (S8d): one record per lobby; concede and
 * defer update the start_draft record in place, so the one record is read explicitly.
 */
function hasConcededRecord(ctx: any, lobbyId: number): boolean {
    return findLobbyResult(ctx, lobbyId)?.matchEndReason?.tag === 'Concede';
}

/**
 * Guard: ensures the match has not ended or been conceded.
 * Called at the top of every draft/equip reducer (D-12). Result reducers use `ensureNotConceded`
 * instead (F8, A22(4)): they legitimately run in AwaitingResult.
 */
export function ensureMatchAlive(ctx: any, lobby: any): void {
    if (lobby.stage.tag === 'AwaitingResult') {
        throw new SenderError('Match has ended.');
    }
    if (hasConcededRecord(ctx, lobby.id)) {
        throw new SenderError('Match has been conceded.');
    }
}

/**
 * Guard for the result reducers (`record_group_scores`, `set_score_adjustment`) and the A60(7) Admin edit path of a
 * closed game (`equip_lightcone`, `arrange_lineup`, `set_eidolon`; S7b removed `confirm_match_scores` / `submit_match_result`):
 * rejects a conceded record, but allows AwaitingResult, where the game close parks the lobby (F8, A22(4), A60, A67(1)).
 */
export function ensureNotConceded(ctx: any, lobby: any): void {
    if (hasConcededRecord(ctx, lobby.id)) {
        throw new SenderError('Match has been conceded.');
    }
}

/**
 * Builds a deterministic concede summary string for audit/admin review (D-71).
 */
export function buildConcedeSummary(
    ctx: any,
    lobby: any,
    disconnectedMembers: any[],
    triggerUserId: number,
    trigger: string,
): string {
    const labels = disconnectedMembers.map((m: any) => {
        if (lobby.isAnonymousPlayers) {
            return `${slotTeam(m.lobbySlot)}-Player (userId: ${m.userId})`;
        }
        return `User#${m.userId} (userId: ${m.userId})`;
    });

    const session = ctx.db.MatchSession.lobbyId.find(lobby.id);
    const turnIndex = session ? session.turnIndex : 0;
    const poolMs = disconnectedMembers[0]?.disconnectPoolRemainingMs ?? 0;

    return `${labels.join(', ')} disconnected at step ${turnIndex}, pool remaining: ${poolMs}ms, stage: ${lobby.stage.tag}, trigger: ${trigger} by userId:${triggerUserId}`;
}

/**
 * Computes the updated disconnect pool after reconnect (D-10, D-11).
 * Returns the remaining pool in ms after deducting elapsed disconnect time.
 */
export function handleDisconnectPoolUpdate(
    ctx: any,
    member: any,
    lobby: any,
    now: any,
): number {
    if (!member.disconnectedAt) return member.disconnectPoolRemainingMs;
    const diffMicros: bigint = BigInt(now.microsSinceUnixEpoch) - BigInt(member.disconnectedAt.microsSinceUnixEpoch);
    const elapsed = Number(diffMicros / BigInt(1000));
    return Math.max(0, member.disconnectPoolRemainingMs - elapsed);
}

/**
 * Checks if ALL non-coach players on the target team are offline and
 * their disconnect grace period has elapsed (D-12, D-13). Used by claim_forfeit.
 * A68(3): away and abandoned rows (A68(2)(4)) count as offline players, with the disconnectedAt stamped at the
 * Leave; a team with zero player rows is not eligible. A92(6): the pool test uses the live drain
 * (isPastDisconnectThreshold).
 */
export function isForfeitEligible(
    ctx: any,
    lobby: any,
    targetTeam: string,
    now: any,
): boolean {
    const members = [...ctx.db.LobbyMember.lobby_id.filter(lobby.id)];
    const teamPlayers = members.filter(
        (m: any) =>
            slotTeam(m.lobbySlot) === targetTeam &&
            !slotIsCoach(m.lobbySlot) &&
            !slotIsSpectator(m.lobbySlot),
    );

    if (teamPlayers.length === 0) return false;

    return teamPlayers.every((p: any) => isPastDisconnectThreshold(lobby, p, now));
}

/** A92(2): the forfeit grace when the lobby leaves it unset (D-09). */
export const DEFAULT_DISCONNECT_FORFEIT_SECONDS = 60;
const MIN_DISCONNECT_FORFEIT_SECONDS = 30;
const MAX_DISCONNECT_FORFEIT_SECONDS = 600;

/**
 * A92(2): `disconnectForfeitSeconds` is 30 to 600 wherever it is set (lobby, preset, tournament); 0 / unset keeps the
 * default 60. Writers: create_lobby, update_lobby_settings (unlocked), create_lobby_preset, update_lobby_preset,
 * create_tournament, update_tournament.
 */
export function ensureForfeitSecondsInRange(seconds: number | undefined): void {
    if (!seconds) return;
    if (seconds < MIN_DISCONNECT_FORFEIT_SECONDS || seconds > MAX_DISCONNECT_FORFEIT_SECONDS) {
        throw new SenderError(
            `disconnectForfeitSeconds must be between ${MIN_DISCONNECT_FORFEIT_SECONDS} and ${MAX_DISCONNECT_FORFEIT_SECONDS} (0 keeps the default of ${DEFAULT_DISCONNECT_FORFEIT_SECONDS}).`,
        );
    }
}

/**
 * A91(2): the Deferred policy is for tournaments and their lobbies only. Called by create_lobby, update_lobby_settings
 * on a lobby that is not tournament-controlled, create_lobby_preset and update_lobby_preset (create_tournament,
 * update_tournament and create_tournament_lobby keep it).
 */
export function ensureNotDeferredOutsideTournament(policyTag: string): void {
    if (policyTag === 'Deferred') {
        throw new SenderError('The Deferred disconnect policy is only available for tournaments and their lobbies.');
    }
}

/** A92(3): the NoAction policy is for casual lobbies only (rejected for Ranked lobbies and for tournaments). */
export function ensureNoActionAllowed(policyTag: string, isRankedOrTournament: boolean): void {
    if (policyTag === 'NoAction' && isRankedOrTournament) {
        throw new SenderError('The NoAction disconnect policy is only available for casual lobbies.');
    }
}

/**
 * The instant (micros since epoch) from which an offline, away or abandoned player with a `disconnectedAt` stamp is
 * past the threshold: the earlier of the grace end (`disconnectedAt + disconnectForfeitSeconds`, default 60) and the
 * live pool's end (A92(6): `disconnectedAt + pool`, the pool drained live, not only a stored 0). Undefined when the
 * player has no stamp. Shared by the forfeit claim, the defer precondition (A91(1)) and view_my_lobby_members (A92(9)).
 */
export function disconnectThresholdMicros(lobby: any, player: any): bigint | undefined {
    if (!player.disconnectedAt) return undefined;
    const stamp: bigint = player.disconnectedAt.microsSinceUnixEpoch;
    const graceEnd = stamp + BigInt((lobby.disconnectForfeitSeconds ?? DEFAULT_DISCONNECT_FORFEIT_SECONDS) * 1_000_000);
    const poolEnd = stamp + BigInt(Math.max(0, player.disconnectPoolRemainingMs)) * 1000n;
    return poolEnd < graceEnd ? poolEnd : graceEnd;
}

/**
 * The row test for "this player is gone" used by the forfeit claim, the defer precondition and view_my_lobby_members
 * (A92(9)): the row is offline, away or abandoned. Reads the LobbyMember row only (never User presence on another
 * identity), so the view column is set exactly when isPastDisconnectThreshold can become true for the row.
 */
export function isMemberRowAway(player: any): boolean {
    return !player.isOnline || memberHasLeft(player);
}

/**
 * D-12 / D-13 as amended by A92(6): a player is past the threshold when offline (or away / abandoned), stamped, and
 * either the grace has elapsed or the live pool is spent (`pool - (now - disconnectedAt) <= 0`).
 */
export function isPastDisconnectThreshold(lobby: any, player: any, now: any): boolean {
    if (!isMemberRowAway(player)) return false;
    const threshold = disconnectThresholdMicros(lobby, player);
    return threshold !== undefined && now.microsSinceUnixEpoch >= threshold;
}

/**
 * Returns the LobbyMember who is a 3rd-party spectator referee, or null (D-81). A referee row that is away or
 * abandoned (A68(2)(4)) does not count.
 */
export function isThirdPartyReferee(ctx: any, lobbyId: number): any | null {
    const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
    return (
        members.find(
            (m: any) =>
                m.isReferee &&
                m.lobbySlot.tag === 'Spectator' &&
                !memberHasLeft(m),
        ) ?? null
    );
}
