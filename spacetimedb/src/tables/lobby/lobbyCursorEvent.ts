import { table, t } from 'spacetimedb/server';

// A19 / R2(4): event tables carry no audit columns. Rows are delivered once and never persist, so the
// audit columns were pure per-event egress and `createdById` leaked the real user id of an anonymized
// sender.
// A96 (S10h): the sender is named by the lobby seat number (`LobbyMember.joinSeq`, A74(3)), never by user id, in
// anonymous and identified lobbies alike; `senderUserId` and `anonymousLabel` are gone. A member's client resolves the
// seat through view_my_lobby_members (name, avatar, or the A97 seat label when the seat is anonymized).
export const lobbyCursorEventColumns = {
    lobbyId: t.u32(),
    senderJoinSeq: t.u32(), // A96: the sender's seat in this lobby
    x: t.f32(),
    y: t.f32(),
    timestamp: t.timestamp(),
};

export const LobbyCursorEvent = table({
    name: 'lobby_cursor_event',
    public: true,
    event: true, // Broadcasts onInsert, then deletes immediately.
}, lobbyCursorEventColumns);
