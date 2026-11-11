import { table, t } from 'spacetimedb/server';
import { AccountLockOrigin } from '@module/types/enums';

export const tournamentPlayerAccountColumns = {
    tournamentId: t.u32(),
    userId: t.u32(),
    hsrAccountId: t.u32(),
    origin: AccountLockOrigin, // A143 (S11a): Entry (the player's own entry) or StandIn (taking part as a stand-in)
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const TournamentPlayerAccount = table({
    name: 'tournament_player_account',
    public: false, // S3 (A37, C-c8): private, read through the tournament arg views and view_my_* (S9)
    primaryKey: ['tournamentId', 'userId', 'hsrAccountId'],
    indexes: [
        { accessor: 'by_tournament_and_user', algorithm: 'btree', columns: ['tournamentId', 'userId'] },
        { accessor: 'by_user', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] }, // A143 (S11a): the end-of-tournament sweep
    ],
}, tournamentPlayerAccountColumns);
