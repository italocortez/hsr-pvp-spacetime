import { table, t } from 'spacetimedb/server';

export const lobbyBanColumns = {
    lobbyId: t.u32(),
    bannedUserId: t.u32(),
    bannedByUserId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const LobbyBan = table({
    name: 'lobby_ban',
    public: true,
    primaryKey: ['lobbyId', 'bannedUserId'],
    indexes: [
        { accessor: 'lobby_id', algorithm: 'btree', columns: ['lobbyId'] },
        { accessor: 'by_lobby_and_user', algorithm: 'btree', columns: ['lobbyId', 'bannedUserId'] },
    ],
}, lobbyBanColumns);
