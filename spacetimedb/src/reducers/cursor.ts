import spacetimedb from '../schema';
import { t } from 'spacetimedb/server';
import { computeAnonymousLabel } from '../helpers/anonymousLabels';
import { readAbuseConfig } from '../helpers/abuseControls';

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

    // B-4 (§B.5): out-of-range coordinates are dropped silently (the negated range test also drops NaN).
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;

    // B-4: per-member throttle, AbuseConfig.cursorMinIntervalMs (D-B5: 50 ms = 20 Hz) since LobbyMember.lastCursorAt.
    const minIntervalMicros = BigInt(readAbuseConfig(ctx).cursorMinIntervalMs) * 1000n;
    const now = ctx.timestamp.microsSinceUnixEpoch;
    if (membership.lastCursorAt && now - membership.lastCursorAt.microsSinceUnixEpoch < minIntervalMicros) return;

    // Throttle stamp on the private member row: no audit bump (not a user edit, §B.5).
    ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, mapping.userId]);
    ctx.db.LobbyMember.insert({ ...membership, lastCursorAt: ctx.timestamp });

    // Determine if anonymous mode applies to this member (D-01, D-07)
    // After the D-34 guard above, only Blue/Red team members reach this point.
    const lobby = ctx.db.Lobby.id.find(lobbyId);
    const isAnon = lobby?.isAnonymousPlayers;

    // Broadcast (event table — no audit columns, A19 / R2(4))
    ctx.db.LobbyCursorEvent.insert({
        lobbyId,
        senderUserId: isAnon ? 0 : mapping.userId,
        anonymousLabel: isAnon ? computeAnonymousLabel(ctx, lobbyId, mapping.userId) : undefined,
        x,
        y,
        timestamp: ctx.timestamp,
    });
});
