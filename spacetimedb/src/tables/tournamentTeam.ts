import { table, t } from 'spacetimedb/server';

export const tournamentTeamColumns = {
    id: t.u32().primaryKey().autoInc(),
    tournamentId: t.u32(),
    name: t.string(),
    captainUserId: t.u32(),
    seedNumber: t.u32().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const TournamentTeam = table({
    name: 'tournament_team',
    public: true,
    indexes: [
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] },
        { accessor: 'captain_user_id', algorithm: 'btree', columns: ['captainUserId'] },
    ],
}, tournamentTeamColumns);
