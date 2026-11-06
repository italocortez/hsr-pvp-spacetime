import { table, t } from 'spacetimedb/server';

// A35 (S3): teamId says which side the stand-in may sit on (team1 -> Blue, team2 -> Red).
export const tournamentStandInColumns = {
    id: t.u32().primaryKey().autoInc(),
    bracketMatchId: t.u32(),
    teamId: t.u32(),
    userId: t.u32(),
    approvedByUserId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

// S3 (A37): private; the stand-in reads view_my_stand_ins, staff view_my_tournament_* (S9).
export const TournamentStandIn = table({
    name: 'tournament_stand_in',
    public: false,
    indexes: [
        { accessor: 'bracket_match_id', algorithm: 'btree', columns: ['bracketMatchId'] },
        { accessor: 'by_match_and_user', algorithm: 'btree', columns: ['bracketMatchId', 'userId'] },
        { accessor: 'team_id', algorithm: 'btree', columns: ['teamId'] },
    ],
}, tournamentStandInColumns);
