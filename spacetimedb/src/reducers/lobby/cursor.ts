import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { memberHasLeft } from '@module/helpers/lobby/lobbyHelpers';
import { readAbuseConfig } from '@module/helpers/lobby/abuseControls';

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

    // A98: an away or abandoned member cannot act. The cursor stream is fire-and-forget at up to 20 Hz, so the call is
    // dropped silently, as for a non-member or a spectator, instead of throwing.
    if (memberHasLeft(membership)) return;

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

    // Broadcast (event table — no audit columns, A19 / R2(4)). A96: the sender is named by seat, never by user id,
    // in every lobby; the client maps the seat to a name or the A97 seat label through view_my_lobby_members.
    ctx.db.LobbyCursorEvent.insert({
        lobbyId,
        senderJoinSeq: membership.joinSeq,
        x,
        y,
        timestamp: ctx.timestamp,
    });
});
