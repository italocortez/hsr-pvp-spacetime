import { hardDeleteLobby } from '@module/reducers/lobby/lobbyGc';
import { transferFlagsOnRemoval } from './flagTransferHelpers';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { releaseMemberAccounts } from './lobbyHelpers';
import { deleteCursorStamps } from './cursorStamps';

// ─── removeMemberRow ─────────────────────────────────────────────────────────
// A68(5)(6)(7): the one row-removal path (leave in Waiting / AwaitingResult, a spectator's or coach's leave in any
// stage, kick, ban, user deletion outside a live stage). Flags first (captain, referee, host in the A22(5) order,
// online first then any; the row must still exist), then the member's LobbyMemberAccount rows (review finding 9) and
// the row, then currentPlayerCount on the re-read Lobby row (the host may have moved). An emptied Waiting lobby is
// hard-deleted. Returns false when the lobby was deleted.
export function removeMemberRow(ctx: any, lobbyId: number, userId: number, actorId: number): boolean {
    transferFlagsOnRemoval(ctx, lobbyId, userId);
    releaseMemberAccounts(ctx, lobbyId, userId);
    deleteCursorStamps(ctx, lobbyId, userId); // S11a (L19)
    ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, userId]);

    const lobby = ctx.db.Lobby.id.find(lobbyId);
    if (!lobby) return false;
    const newCount = lobby.currentPlayerCount > 0 ? lobby.currentPlayerCount - 1 : 0;
    if (newCount === 0 && lobby.stage.tag === 'Waiting') {
        hardDeleteLobby(ctx, lobbyId);
        console.log(`[LOBBY] Lobby #${lobbyId} auto-closed after last member left`);
        return false;
    }
    ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
        currentPlayerCount: newCount,
        lastActivityAt: ctx.timestamp,
    }, actorId));
    return true;
}
