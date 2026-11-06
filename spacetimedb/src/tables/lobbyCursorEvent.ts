import { table, t } from 'spacetimedb/server';

export const lobbyCursorEventColumns = {
    lobbyId: t.u32(),
    senderUserId: t.u32(), // Who moved the mouse (persistent User ID)
    anonymousLabel: t.string().optional(),
    x: t.f32(),
    y: t.f32(),
    timestamp: t.timestamp(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const LobbyCursorEvent = table({
    name: 'lobby_cursor_event',
    public: true,
    event: true, // Broadcasts onInsert, then deletes immediately.
}, lobbyCursorEventColumns);
