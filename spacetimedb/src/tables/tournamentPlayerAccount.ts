import { table, t } from 'spacetimedb/server';

export const tournamentPlayerAccountColumns = {
    tournamentId: t.u32(),
    userId: t.u32(),
    hsrAccountId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const TournamentPlayerAccount = table({
    name: 'tournament_player_account',
    public: true,
    primaryKey: ['tournamentId', 'userId', 'hsrAccountId'],
    indexes: [
        { accessor: 'by_tournament_and_user', algorithm: 'btree', columns: ['tournamentId', 'userId'] },
        { accessor: 'by_user', algorithm: 'btree', columns: ['userId'] },
    ],
}, tournamentPlayerAccountColumns);
