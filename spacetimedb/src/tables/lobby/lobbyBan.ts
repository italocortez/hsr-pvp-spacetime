import { table, t } from 'spacetimedb/server';

export const lobbyBanColumns = {
    lobbyId: t.u32(),
    bannedUserId: t.u32(),
    bannedByUserId: t.u32(),
    bannedJoinSeq: t.u32(),   // A74(2): the seat the member held when banned; unban_member resolves the ban by it
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

// S3 (A37): private; host/referee read view_my_lobby_bans, staff view_admin_lobby_bans (S9).
export const LobbyBan = table({
    name: 'lobby_ban',
    public: false,
    primaryKey: ['lobbyId', 'bannedUserId'],
    indexes: [
        { accessor: 'lobby_id', algorithm: 'btree', columns: ['lobbyId'] },
        { accessor: 'by_lobby_and_user', algorithm: 'btree', columns: ['lobbyId', 'bannedUserId'] },
    ],
}, lobbyBanColumns);
