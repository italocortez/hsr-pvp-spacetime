import spacetimedb from '../schema';
import { t } from 'spacetimedb/server';
import { insertWithAudit } from '../helpers/auditHelpers';
import { computeAnonymousLabel } from '../helpers/anonymousLabels';

export const broadcast_cursor = spacetimedb.reducer({
    lobbyId: t.u32(),
    x: t.f32(),
    y: t.f32(),
}, (ctx, { lobbyId, x, y }) => {
    // Resolve identity → userId
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    if (!mapping) return; // Not registered, ignore

    // Validate membership via index filter
    const membership = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, mapping.userId])][0];

    if (!membership) {
        // User is not in this lobby, ignore the request
        return;
    }

    // D-34: Spectators do NOT broadcast cursor — silently return without error
    // Coaches have lobbySlot of Blue/Red (not Spectator), so they still broadcast
    if (membership.lobbySlot.tag === 'Spectator') return;

    // Determine if anonymous mode applies to this member (D-01, D-07)
    // After the D-34 guard above, only Blue/Red team members reach this point.
    const lobby = ctx.db.Lobby.id.find(lobbyId);
    const isAnon = lobby?.isAnonymousPlayers;

    // Broadcast (event table — ephemeral, but audit columns still applied per policy)
    ctx.db.LobbyCursorEvent.insert(insertWithAudit(ctx, {
        lobbyId,
        senderUserId: isAnon ? 0 : mapping.userId,
        anonymousLabel: isAnon ? computeAnonymousLabel(ctx, lobbyId, mapping.userId) : undefined,
        x,
        y,
        timestamp: ctx.timestamp,
    }, mapping.userId));
});
