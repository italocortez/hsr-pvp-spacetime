import { slotIsSpectator, slotSameTeam } from '@module/helpers/lobby/lobbyHelpers';

/**
 * Determines whether the caller should see an anonymized view of the target user
 * within the given lobby.
 *
 * Per D-69/D-70/D-71:
 * - D-70: Same team = real identities. Spectators see all players anonymized.
 * - D-71: Spectator referees (lobbySlot=Spectator + isReferee=true) see all real identities.
 * - Opponents on a team = anonymize based on lobby.isAnonymousPlayers.
 *
 * Returns false (no anonymization) when:
 * - Lobby has no anonymous settings enabled
 * - Caller is looking at themselves
 * - Caller or target is not a member
 * - Caller is a spectator referee (D-71)
 * - Caller and target are on the same team (D-70)
 *
 * Returns true (anonymize) when (S9a fix: the flag follows the target's seat kind):
 * - Target is a player or coach not on the caller's team (spectator callers included) and isAnonymousPlayers
 * - Target is a spectator and isAnonymousSpectators
 */
export function shouldAnonymize(ctx: any, lobbyId: number, targetUserId: number, lobby?: any): boolean {
    if (!lobby) lobby = ctx.db.Lobby.id.find(lobbyId);
    if (!lobby) return false;
    if (!lobby.isAnonymousPlayers && !lobby.isAnonymousSpectators) return false;

    // Resolve caller
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    if (!mapping) return false;
    const callerUserId = mapping.userId;

    // Never anonymize self
    if (callerUserId === targetUserId) return false;

    const callerMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, callerUserId])][0];
    const targetMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, targetUserId])][0];
    if (!callerMember || !targetMember) return false;

    // D-71: Spectator referee sees all real identities
    if (callerMember.isReferee && slotIsSpectator(callerMember.lobbySlot)) return false;

    // D-70: Same team = real identities
    if (slotSameTeam(callerMember.lobbySlot, targetMember.lobbySlot)) return false;

    // S9a fix (A37; anonymous-play contract "two independent toggles"): the target's own seat kind picks the flag.
    // A spectator target follows isAnonymousSpectators; a player or coach target follows isAnonymousPlayers, for a
    // spectator caller (D-70) and an opposing player alike.
    if (slotIsSpectator(targetMember.lobbySlot)) return lobby.isAnonymousSpectators;
    return lobby.isAnonymousPlayers;
}
