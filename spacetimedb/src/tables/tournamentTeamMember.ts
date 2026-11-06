import { table, t } from 'spacetimedb/server';

export const tournamentTeamMemberColumns = {
    teamId: t.u32(),
    userId: t.u32(),
    tournamentId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const TournamentTeamMember = table({
    name: 'tournament_team_member',
    public: true,
    primaryKey: ['teamId', 'userId'],
    indexes: [
        { accessor: 'team_id', algorithm: 'btree', columns: ['teamId'] },
        { accessor: 'by_tournament_and_user', algorithm: 'btree', columns: ['tournamentId', 'userId'] },
    ],
}, tournamentTeamMemberColumns);
