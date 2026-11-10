import { slotTeam, slotIsCoach } from '@module/helpers/lobby/lobbyHelpers';

/**
 * A97 (S10h): the anonymous label of a member row, from the seat kind and the seat number (`joinSeq`, A74(3)):
 * "Blue Player #3", "Red Player #4", "Blue Coach #5", "Red Coach #6", "Spectator #7". The seat number never changes
 * and is never reused, so a label names one membership for the lobby's lifetime; it changes only when the member
 * changes seat kind (a Waiting-stage move), never because another member left. Never contains a user id (A37).
 */
export function anonymousSeatLabel(member: any): string {
    const team = slotTeam(member.lobbySlot);
    const kind = team === null ? 'Spectator' : `${team} ${slotIsCoach(member.lobbySlot) ? 'Coach' : 'Player'}`;
    return `${kind} #${member.joinSeq}`;
}

/**
 * The A97 label of `userId`'s row in the lobby (anonymousSeatLabel), or 'Unknown' when the user holds no row.
 * Deterministic: the same LobbyMember row always produces the same label; no other member's row is read.
 */
export function computeAnonymousLabel(ctx: any, lobbyId: number, userId: number): string {
    const member = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, userId])][0];
    if (!member) return 'Unknown';
    return anonymousSeatLabel(member);
}
