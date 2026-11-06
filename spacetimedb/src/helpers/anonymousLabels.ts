import { slotTeam, slotIsCoach, slotSameTeam } from './lobbyHelpers';

/**
 * Computes anonymous label for a lobby member based on team side and join order.
 * Labels: "Blue-1", "Blue-2", "Red-1", "Red-2", "Spectator-1", "Coach-Blue", "Coach-Red"
 * Deterministic: same LobbyMember data always produces same label.
 */
export function computeAnonymousLabel(ctx: any, lobbyId: number, userId: number): string {
    // Look up the target member
    const member = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, userId])][0];
    if (!member) return 'Unknown';

    // Coaches get a special label: "Coach-Blue", "Coach-Red"
    if (slotIsCoach(member.lobbySlot)) {
        return `Coach-${slotTeam(member.lobbySlot)}`;
    }

    // Spectators: label among other spectators
    const isSpectator = member.lobbySlot.tag === 'Spectator';

    // Get peers: same-team non-coach players, or fellow spectators
    const peers = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)]
        .filter((m: any) => isSpectator
            ? m.lobbySlot.tag === 'Spectator'
            : slotSameTeam(m.lobbySlot, member.lobbySlot) && !slotIsCoach(m.lobbySlot));

    // Sort by createdDate ascending (join order -- earlier = lower number)
    peers.sort((a: any, b: any) => {
        return Number(a.createdDate.microsSinceUnixEpoch / 1000n) - Number(b.createdDate.microsSinceUnixEpoch / 1000n);
    });

    // Find the index of the target userId in the sorted list
    const index = peers.findIndex((m: any) => m.userId === userId);
    const prefix = isSpectator ? 'Spectator' : slotTeam(member.lobbySlot);

    return `${prefix}-${index + 1}`;
}
