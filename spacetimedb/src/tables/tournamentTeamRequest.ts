import { table, t } from 'spacetimedb/server';

export const tournamentTeamRequestColumns = {
    teamId: t.u32(),
    userId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const TournamentTeamRequest = table({
    name: 'tournament_team_request',
    public: true,
    primaryKey: ['teamId', 'userId'],
    indexes: [
        { accessor: 'team_id', algorithm: 'btree', columns: ['teamId'] },
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_team_and_user', algorithm: 'btree', columns: ['teamId', 'userId'] },
    ],
}, tournamentTeamRequestColumns);
