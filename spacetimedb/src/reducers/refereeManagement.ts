import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { updateWithAudit } from '../helpers/auditHelpers';

// ─── transfer_referee ─────────────────────────────────────────────────────────
// Transfers the referee flag from the caller to another lobby member.
// Permission: current referee of the lobby.

export const transfer_referee = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        targetUserId: t.u32(),
    },
    (ctx, { lobbyId, targetUserId }) => {
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

        // Validate target is different from caller
        if (targetUserId === user.id) {
            throw new SenderError('You are already the referee.');
        }

        // Find target's LobbyMember row
        const targetMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, targetUserId])][0];
        if (!targetMember) {
            throw new SenderError('Target user is not a member of this lobby.');
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
// Permission: lobby host only.
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
        if (lobby.hostUserId !== user.id) {
            throw new SenderError('Only the lobby host can reclaim the referee flag.');
        }

        // Find the current referee (iterate lobby members to find the one with isReferee = true)
        // Using lobby_id index for efficiency
        const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
        const currentReferee = members.find((m: any) => m.isReferee === true);

        // No-op: if there is no current referee or the host is already the referee
        if (!currentReferee || currentReferee.userId === user.id) {
            return;
        }

        // Find host's LobbyMember row
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
