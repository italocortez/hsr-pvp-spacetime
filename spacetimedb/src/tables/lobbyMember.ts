import { table, t } from 'spacetimedb/server';
import { LobbySlot } from '../types/enums';

export const lobbyMemberColumns = {
    lobbyId: t.u32(),
    userId: t.u32(),

    isOnline: t.bool(),
    lobbySlot: LobbySlot,   // BluePlayer, BlueCoach, RedPlayer, RedCoach, or Spectator
    isReferee: t.bool(),     // Admin powers within this lobby
    isConfirmed: t.bool(),   // Ready-up per D-29
    isCaptain: t.bool(),     // Captain designation per D-30
    voluntarilyLeft: t.bool(),                // D-31: player voluntarily left active match
    disconnectedAt: t.timestamp().optional(), // D-08: timestamp of disconnect event
    disconnectPoolRemainingMs: t.u32(),       // D-10: remaining disconnect pool in ms (init 300000 at draft start)
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const LobbyMember = table({
    name: 'lobby_member',
    public: true,
    primaryKey: ['lobbyId', 'userId'],
    indexes: [
        { accessor: 'lobby_id', algorithm: 'btree', columns: ['lobbyId'] },
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_lobby_and_user', algorithm: 'btree', columns: ['lobbyId', 'userId'] },
    ]
}, lobbyMemberColumns);
