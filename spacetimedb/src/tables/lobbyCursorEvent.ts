import { table, t } from 'spacetimedb/server';

// A19 / R2(4): event tables carry no audit columns. Rows are delivered once and never persist, so the
// audit columns were pure per-event egress and `createdById` leaked the real user id of an anonymized
// sender. `senderUserId` is 0 and `anonymousLabel` is set when the lobby anonymizes players.
export const lobbyCursorEventColumns = {
    lobbyId: t.u32(),
    senderUserId: t.u32(), // Who moved the mouse (persistent User ID); 0 when anonymized
    anonymousLabel: t.string().optional(),
    x: t.f32(),
    y: t.f32(),
    timestamp: t.timestamp(),
};

export const LobbyCursorEvent = table({
    name: 'lobby_cursor_event',
    public: true,
    event: true, // Broadcasts onInsert, then deletes immediately.
}, lobbyCursorEventColumns);
