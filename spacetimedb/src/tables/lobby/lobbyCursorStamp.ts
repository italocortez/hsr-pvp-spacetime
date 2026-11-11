import { table, t } from 'spacetimedb/server';

/**
 * S11a (triage L19): the `broadcast_cursor` throttle stamp, one row per (lobby, member) that has sent a cursor. It was
 * `LobbyMember.lastCursorAt`, so every accepted cursor (up to 20 Hz per player) rewrote the member row that the lobby
 * views read. No view reads this table. Written by `broadcast_cursor` (reducers/lobby/cursor.ts); removed with the
 * lobby (hardDeleteLobby), with the member (removeMemberRow, user deletion) and by `server_nuke_test_data`.
 * Audit columns: the member at the first stamp; later stamps leave them as they are (not a user edit, §B.5).
 */
export const lobbyCursorStampColumns = {
    lobbyId: t.u32(),
    userId: t.u32(),
    lastCursorAt: t.timestamp(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const LobbyCursorStamp = table({
    name: 'lobby_cursor_stamp',
    public: false,
    primaryKey: ['lobbyId', 'userId'],
    indexes: [
        { accessor: 'lobby_id', algorithm: 'btree', columns: ['lobbyId'] }, // the lobby cascade (hardDeleteLobby)
        { accessor: 'by_lobby_and_user', algorithm: 'btree', columns: ['lobbyId', 'userId'] },
    ],
}, lobbyCursorStampColumns);
