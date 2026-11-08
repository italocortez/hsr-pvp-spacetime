import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { hasTournamentPermission } from '@module/helpers/tournament/tournamentPermissions';
import { resolveSeat } from '@module/helpers/lobby/lobbyHelpers';

// ─── transfer_referee ─────────────────────────────────────────────────────────
// Transfers the referee flag from the caller to another lobby member.
// Permission: current referee of the lobby.
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

        // A74(1): seat -> member row ("No member sits at seat N of this lobby.")
        const targetMember = resolveSeat(ctx, lobbyId, targetJoinSeq);
        const targetUserId = targetMember.userId;

        // Validate target is different from caller
        if (targetUserId === user.id) {
            throw new SenderError('You are already the referee.');
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
// NOTE: Auto-assignment of the referee flag at lobby creation is deferred to Phase 9.

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

// --- Coach Role Management --------------------------------------------------------
// ELIMINATED: set_coach and remove_coach are no longer needed.
// Coach assignment is now handled via set_team_slot (lobbySettings.ts) with the
// unified LobbySlot enum (BlueCoach/RedCoach). The coach transition guard in
// set_team_slot ensures only host/referee can assign coach slots.
