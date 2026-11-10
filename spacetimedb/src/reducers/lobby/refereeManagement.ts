import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { hasTournamentPermission } from '@module/helpers/tournament/tournamentPermissions';
import { ensureMemberPresent, ensurePresentIfMember, memberHasLeft, resolveSeat } from '@module/helpers/lobby/lobbyHelpers';

// ─── transfer_referee ─────────────────────────────────────────────────────────
// Transfers the referee flag from the caller to another lobby member.
// Permission: current referee of the lobby. A98: the caller and the target must both be present (not away, not
// abandoned; target rule: S10h review F5, the transfer_host text shape).
// A74(1): the target is a seat number (`targetJoinSeq`), resolved to the member row. The reducer has no Lobby
// lookup; the seat is resolved after the caller's membership and referee checks, so a non-referee learns nothing
// about the lobby's seats.

export const transfer_referee = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        targetJoinSeq: t.u32(),
    },
    (ctx, { lobbyId, targetJoinSeq }) => {
        const user = getAuthenticatedUser(ctx);

        // Find caller's LobbyMember row
        const senderMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, user.id])][0];
        if (!senderMember) {
            throw new SenderError('You are not a member of this lobby.');
        }

        // Validate caller has the referee flag
        if (!senderMember.isReferee) {
            throw new SenderError('You are not the referee of this lobby.');
        }
        ensureMemberPresent(senderMember); // A98

        // A74(1): seat -> member row ("No member sits at seat N of this lobby.")
        const targetMember = resolveSeat(ctx, lobbyId, targetJoinSeq);
        const targetUserId = targetMember.userId;

        // Validate target is different from caller
        if (targetUserId === user.id) {
            throw new SenderError('You are already the referee.');
        }
        // A98 (S10h review F5): an away or abandoned member cannot act, so cannot receive the referee flag
        if (memberHasLeft(targetMember)) {
            throw new SenderError(`The member at seat ${targetJoinSeq} has left the match and cannot become the referee.`);
        }

        // Remove referee flag from caller
        ctx.db.LobbyMember.delete(senderMember);
        ctx.db.LobbyMember.insert(updateWithAudit(ctx, senderMember, { isReferee: false }, user.id));

        // Add referee flag to target
        ctx.db.LobbyMember.delete(targetMember);
        ctx.db.LobbyMember.insert(updateWithAudit(ctx, targetMember, { isReferee: true }, user.id));

        console.log(`[LOBBY] Referee transferred from user #${user.id} to user #${targetUserId} in lobby #${lobbyId}`);
    }
);

// ─── reclaim_referee ──────────────────────────────────────────────────────────
// Reclaims the referee flag from the current holder back to the lobby host.
// Permission: lobby host only. D.8.4 (S8d): in a tournament lobby also a seated (member) staff member with the
// `results` permission (canResolveResults assistant, organizer, Moderator+), who takes the flag themself.
// A68(7): when no member holds the flag, any member who calls takes it (a lobby with members always has a referee).
// The host gets the flag at creation (create_lobby, create_tournament_lobby: isReferee = true).

export const reclaim_referee = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);

        // Find the lobby and validate caller is the host
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        // A68(7): nobody holds the referee flag: the calling member takes it.
        const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
        if (!members.some((m: any) => m.isReferee)) {
            const callerMember = members.find((m: any) => m.userId === user.id);
            if (!callerMember) {
                throw new SenderError('You are not a member of this lobby.');
            }
            ensureMemberPresent(callerMember); // A98
            ctx.db.LobbyMember.delete(callerMember);
            ctx.db.LobbyMember.insert(updateWithAudit(ctx, callerMember, { isReferee: true }, user.id));
            console.log(`[LOBBY] Unheld referee flag taken by user #${user.id} in lobby #${lobbyId} (A68(7))`);
            return;
        }

        const isTournamentStaff = lobby.isTournamentControlled && lobby.tournamentId !== undefined
            && [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, user.id])].length > 0
            && (() => {
                const tournament = ctx.db.Tournament.id.find(lobby.tournamentId);
                return !!tournament && hasTournamentPermission(ctx, user, tournament, 'results');
            })();
        if (lobby.hostUserId !== user.id && !isTournamentStaff) {
            throw new SenderError('Only the lobby host can reclaim the referee flag.');
        }
        // A98: the caller takes the flag onto their own row, which must be present.
        ensurePresentIfMember(ctx, lobbyId, user.id);

        // Find the current referee (held: the A68(7) branch above handled the unheld flag)
        const currentReferee = members.find((m: any) => m.isReferee === true);

        // No-op: the caller is already the referee
        if (!currentReferee || currentReferee.userId === user.id) {
            return;
        }

        // Find the caller's LobbyMember row (the host, or the D.8.4 tournament staff member)
        const hostMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, user.id])][0];
        if (!hostMember) {
            throw new SenderError('Host is not a member of this lobby.');
        }

        // Remove referee flag from current holder
        ctx.db.LobbyMember.delete(currentReferee);
        ctx.db.LobbyMember.insert(updateWithAudit(ctx, currentReferee, { isReferee: false }, user.id));

        // Add referee flag to host
        ctx.db.LobbyMember.delete(hostMember);
        ctx.db.LobbyMember.insert(updateWithAudit(ctx, hostMember, { isReferee: true }, user.id));

        console.log(`[LOBBY] Referee reclaimed by host #${user.id} from user #${currentReferee.userId} in lobby #${lobbyId}`);
    }
);

// ─── transfer_host ────────────────────────────────────────────────────────────
// A93(3): the host hands the host role (Lobby.hostUserId) to another member who is present (not away, not abandoned,
// A68(2)(4)), by seat (A74). Every stage of a lobby that exists. Caller: the host, or a Moderator / Admin (who need
// not be a member). The referee flag does not move with it (transfer_referee / reclaim_referee).
// Guard order (A74): lobby -> the caller's permission -> seat -> target rules, so a stranger learns nothing about the
// lobby's seats.

export const transfer_host = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        targetJoinSeq: t.u32(),
    },
    (ctx, { lobbyId, targetJoinSeq }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        if (lobby.hostUserId !== user.id && !isRoleAtLeast(user.role, 'Moderator')) {
            throw new SenderError('Only the host, moderators, or admins can hand over the host role.');
        }
        // A98: the host role is a membership power: a host who is not Moderator+ must be present.
        if (!isRoleAtLeast(user.role, 'Moderator')) ensurePresentIfMember(ctx, lobbyId, user.id);

        // A74(1): seat -> member row ("No member sits at seat N of this lobby.")
        const target = resolveSeat(ctx, lobbyId, targetJoinSeq);
        if (target.userId === lobby.hostUserId) {
            throw new SenderError(`The member at seat ${targetJoinSeq} is already the host.`);
        }
        if (memberHasLeft(target)) {
            throw new SenderError(`The member at seat ${targetJoinSeq} has left the match and cannot become the host.`);
        }

        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            hostUserId: target.userId,
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(`[LOBBY] Host role of lobby #${lobbyId} handed from user #${lobby.hostUserId} to user #${target.userId} by user #${user.id}`);
    }
);

// --- Coach Role Management --------------------------------------------------------
// ELIMINATED: set_coach and remove_coach are no longer needed.
// Coach assignment is now handled via set_team_slot (lobbySettings.ts) with the
// unified LobbySlot enum (BlueCoach/RedCoach). The coach transition guard in
// set_team_slot ensures only host/referee can assign coach slots.
