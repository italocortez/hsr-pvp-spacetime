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
    leftAt: t.timestamp().optional(),         // A68(2): away ("out of the room"): a player's Leave in a live stage; cleared by an explicit return through join_lobby
    abandonedAt: t.timestamp().optional(),    // A68(4): gone: the away player took another lobby (abandonCurrentMatch); never cleared, no return
    disconnectedAt: t.timestamp().optional(), // D-08: timestamp of disconnect event (A22a: the grace check compares against it)
    disconnectPoolRemainingMs: t.u32(),       // D-10: remaining disconnect pool in ms (init 300000 at draft start)
    joinSeq: t.u32(),                         // R4: per-lobby join counter assigned at join; anonymous labels derive from it, never from the id
    lastCursorAt: t.timestamp().optional(),   // B-4 (§B.5): broadcast_cursor throttle stamp
    lastLineupAt: t.timestamp().optional(),   // B-4: arrange_lineup throttle stamp (fan-out reducer)
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

// S3 (A37): private; members read view_my_lobby_members (R3/R4 anonymization, S9).
export const LobbyMember = table({
    name: 'lobby_member',
    public: false,
    primaryKey: ['lobbyId', 'userId'],
    indexes: [
        { accessor: 'lobby_id', algorithm: 'btree', columns: ['lobbyId'] },
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_lobby_and_user', algorithm: 'btree', columns: ['lobbyId', 'userId'] },
    ]
}, lobbyMemberColumns);
