import { SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import { ACTIVE_STAGES, type LobbyStage } from '@shared/lobby-rules';
import { slotTeam, slotIsCoach, slotIsSpectator, memberHasLeft } from './lobbyHelpers';
import { findLobbyResult } from './scoringHelpers';
import { updateWithAudit } from './auditHelpers';

// A22a: the grace period between a user's last disconnect and the referee / captain / host transfer check.
const REFEREE_TRANSFER_GRACE_MICROS = 15_000_000n;
// D-08: the forfeit clock (disconnectedAt -> pool decrement, isForfeitEligible) runs only in the three live-match
// stages. A67(1): those are also every ACTIVE_STAGES entry (the between-games stages are gone).
const DISCONNECT_CLOCK_STAGES: readonly LobbyStage[] = ['Drafting', 'Equipping', 'Scoring'];

/**
 * A22a (D.8.2) / A68(1): takes one membership offline, the shared body of `client_disconnected` (per membership) and
 * of a player's `leave_lobby` in a live stage: `isOnline = false`; in a live stage `disconnectedAt` stamped under
 * Standard / Deferred (D-08; NoAction tracks nothing); in an active stage one `RefereeTransferCheck` row 15 s out
 * (a stale pending one is dropped first). `extra` carries the Leave's `leftAt` (A68(2)). The row, its
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

    if (!ACTIVE_STAGES.includes(stageTag)) return;

    // One pending check per (lobby, user): drop a stale one before scheduling.
    for (const check of [...ctx.db.RefereeTransferCheck.by_lobby_and_user.filter([member.lobbyId, member.userId])]) {
        ctx.db.RefereeTransferCheck.scheduledId.delete(check.scheduledId);
    }
    ctx.db.RefereeTransferCheck.insert({
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + REFEREE_TRANSFER_GRACE_MICROS),
        lobbyId: member.lobbyId,
        userId: member.userId,
    });
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
 * Leave; a team with zero player rows is not eligible.
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

    const graceUs = BigInt((lobby.disconnectForfeitSeconds ?? 60) * 1_000_000);

    return teamPlayers.every((p: any) => {
        if (p.isOnline && !memberHasLeft(p)) return false;
        if (!p.disconnectedAt) return false;
        // Pool depleted OR grace exceeded
        if (p.disconnectPoolRemainingMs <= 0) return true;
        const elapsed = now.microsSinceUnixEpoch - p.disconnectedAt.microsSinceUnixEpoch;
        return elapsed >= graceUs;
    });
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
