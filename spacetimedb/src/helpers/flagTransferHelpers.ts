import { slotTeam, slotIsCoach, slotIsSpectator } from './lobbyHelpers';
import { SYSTEM_USER_ID } from './auditColumns';
import { updateWithAudit } from './auditHelpers';

/**
 * Transfers captain flag from the leaving user to the next eligible teammate (D-34).
 * Deterministic: picks lowest userId candidate on the same team.
 */
export function transferCaptain(ctx: any, lobbyId: number, leavingUserId: number): void {
    const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
    const leavingMember = members.find((m: any) => m.userId === leavingUserId);
    if (!leavingMember || !leavingMember.isCaptain) return;

    const team = slotTeam(leavingMember.lobbySlot);
    if (!team) return; // spectator — no captain transfer needed

    const candidates = members
        .filter(
            (m: any) =>
                slotTeam(m.lobbySlot) === team &&
                !slotIsCoach(m.lobbySlot) &&
                !m.voluntarilyLeft &&
                m.userId !== leavingUserId,
        )
        .sort((a: any, b: any) => a.userId - b.userId);

    if (candidates.length > 0) {
        const newCaptain = candidates[0];
        ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, newCaptain.userId]);
        ctx.db.LobbyMember.insert(
            updateWithAudit(ctx, newCaptain, { isCaptain: true }, SYSTEM_USER_ID),
        );
    }

    // Demote leaving member
    ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, leavingUserId]);
    ctx.db.LobbyMember.insert(
        updateWithAudit(ctx, leavingMember, { isCaptain: false }, SYSTEM_USER_ID),
    );
}

/**
 * Transfers referee flag from the leaving user to next eligible member (D-35).
 * Priority: (1) host if online and on a team, (2) lowest-userId eligible member.
 */
export function transferReferee(ctx: any, lobbyId: number, leavingUserId: number): void {
    const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
    const leavingMember = members.find((m: any) => m.userId === leavingUserId);
    if (!leavingMember || !leavingMember.isReferee) return;

    const lobby = ctx.db.Lobby.id.find(lobbyId);
    if (!lobby) return;

    // Find eligible candidates: online, non-spectator, non-coach, not leaving
    const eligible = members.filter(
        (m: any) =>
            m.userId !== leavingUserId &&
            m.isOnline &&
            !slotIsSpectator(m.lobbySlot) &&
            !slotIsCoach(m.lobbySlot) &&
            !m.voluntarilyLeft,
    );

    // Priority 1: host
    let newReferee = eligible.find((m: any) => m.userId === lobby.hostUserId);
    // Priority 2: lowest userId
    if (!newReferee) {
        newReferee = eligible.sort((a: any, b: any) => a.userId - b.userId)[0];
    }

    if (newReferee) {
        ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, newReferee.userId]);
        ctx.db.LobbyMember.insert(
            updateWithAudit(ctx, newReferee, { isReferee: true }, SYSTEM_USER_ID),
        );

        ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, leavingUserId]);
        ctx.db.LobbyMember.insert(
            updateWithAudit(ctx, leavingMember, { isReferee: false }, SYSTEM_USER_ID),
        );
    }
    // If no eligible member: leaving member keeps referee flag (GC handles orphan)
}

/**
 * Transfers host from the leaving user to next eligible member (D-36).
 * Priority: (1) current referee if online and on a team, (2) lowest-userId eligible member.
 */
export function transferHost(ctx: any, lobbyId: number, lobby: any, leavingUserId: number): void {
    if (lobby.hostUserId !== leavingUserId) return;

    const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];

    const eligible = members.filter(
        (m: any) =>
            m.userId !== leavingUserId &&
            m.isOnline &&
            !slotIsSpectator(m.lobbySlot) &&
            !slotIsCoach(m.lobbySlot) &&
            !m.voluntarilyLeft,
    );

    // Priority 1: current referee
    let newHost = eligible.find((m: any) => m.isReferee);
    // Priority 2: lowest userId
    if (!newHost) {
        newHost = eligible.sort((a: any, b: any) => a.userId - b.userId)[0];
    }

    if (newHost) {
        ctx.db.Lobby.id.update(
            updateWithAudit(ctx, lobby, { hostUserId: newHost.userId }, SYSTEM_USER_ID),
        );
    }
    // If no eligible member: host stays (GC handles abandoned lobby)
}
