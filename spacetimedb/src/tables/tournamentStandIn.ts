import { table, t } from 'spacetimedb/server';

export const tournamentStandInColumns = {
    bracketMatchId: t.u32(),
    userId: t.u32(),
    approvedByUserId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const TournamentStandIn = table({
    name: 'tournament_stand_in',
    public: true,
    primaryKey: ['bracketMatchId', 'userId'],
    indexes: [
        { accessor: 'bracket_match_id', algorithm: 'btree', columns: ['bracketMatchId'] },
        { accessor: 'by_match_and_user', algorithm: 'btree', columns: ['bracketMatchId', 'userId'] },
    ],
}, tournamentStandInColumns);
