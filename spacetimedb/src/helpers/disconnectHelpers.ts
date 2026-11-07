import { SenderError } from 'spacetimedb/server';
import { slotTeam, slotIsCoach, slotIsSpectator } from './lobbyHelpers';

/**
 * True when any MatchResultRecord of the lobby carries matchEndReason Concede. Scans every record on purpose:
 * performConcede and defer_match insert a second record next to the Pending one from start_draft (an old-repo
 * sequencing accident, see docs/log/2026-11-06-s4.md finding 13), so reading [0] misses the concede. S8 consolidates
 * to one record per lobby (DECISIONS.md A54); this scan stays correct either way.
 */
function hasConcededRecord(ctx: any, lobbyId: number): boolean {
    return [...ctx.db.MatchResultRecord.lobby_id.filter(lobbyId)].some((r: any) => r.matchEndReason?.tag === 'Concede');
}

/**
 * Guard: ensures the match has not ended or been conceded.
 * Called at the top of every draft/equip reducer (D-12). Result reducers use `ensureNotConceded`
 * instead (F8, A22(4)): they legitimately run in AwaitingResult.
 */
export function ensureMatchAlive(ctx: any, lobby: any): void {
    if (lobby.stage.tag === 'AwaitingResult' || lobby.stage.tag === 'Finished') {
        throw new SenderError('Match has ended.');
    }
    if (hasConcededRecord(ctx, lobby.id)) {
        throw new SenderError('Match has been conceded.');
    }
}

/**
 * Guard for the result reducers (`record_group_scores`, `set_score_adjustment`, `confirm_match_scores`, `submit_match_result`):
 * rejects a conceded record or a Finished lobby, but allows AwaitingResult, where `advance_stage` parks the
 * lobby after Scoring (F8, A22(4)).
 */
export function ensureNotConceded(ctx: any, lobby: any): void {
    if (hasConcededRecord(ctx, lobby.id)) {
        throw new SenderError('Match has been conceded.');
    }
    if (lobby.stage.tag === 'Finished') {
        throw new SenderError('Match has ended.');
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
 * their disconnect grace period has elapsed (D-12, D-13).
 * Used by claim_forfeit in Plan 02.
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
            !slotIsSpectator(m.lobbySlot) &&
            !m.voluntarilyLeft,
    );

    if (teamPlayers.length === 0) return false;

    const graceUs = BigInt((lobby.disconnectForfeitSeconds ?? 60) * 1_000_000);

    return teamPlayers.every((p: any) => {
        if (p.isOnline) return false;
        if (!p.disconnectedAt) return false;
        // Pool depleted OR grace exceeded
        if (p.disconnectPoolRemainingMs <= 0) return true;
        const elapsed = now.microsSinceUnixEpoch - p.disconnectedAt.microsSinceUnixEpoch;
        return elapsed >= graceUs;
    });
}

/**
 * Returns the LobbyMember who is a 3rd-party spectator referee, or null (D-81).
 */
export function isThirdPartyReferee(ctx: any, lobbyId: number): any | null {
    const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
    return (
        members.find(
            (m: any) =>
                m.isReferee &&
                m.lobbySlot.tag === 'Spectator' &&
                !m.voluntarilyLeft,
        ) ?? null
    );
}
