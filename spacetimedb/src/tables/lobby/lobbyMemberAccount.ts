import { table, t } from 'spacetimedb/server';

/**
 * Per-match account selection join table.
 * Tracks which HSR account(s) each lobby member is using for this match.
 *
 * Non-public (D-02): opponents cannot see account selection via raw subscription.
 * No audit columns (D-03 pattern): ephemeral join table, created at join, deleted at leave/close.
 */
export const lobbyMemberAccountColumns = {
    lobbyId: t.u32(),
    userId: t.u32(),
    hsrAccountId: t.u32(),
};

export const LobbyMemberAccount = table({
    name: 'lobby_member_account',
    // D-02: Intentionally NOT public — account selection never broadcast to opponents
    primaryKey: ['lobbyId', 'userId', 'hsrAccountId'],
    indexes: [
        { accessor: 'lobby_id', algorithm: 'btree', columns: ['lobbyId'] },
        { accessor: 'by_lobby_and_user', algorithm: 'btree', columns: ['lobbyId', 'userId'] },
        { accessor: 'by_account', algorithm: 'btree', columns: ['hsrAccountId'] },
    ],
}, lobbyMemberAccountColumns);
