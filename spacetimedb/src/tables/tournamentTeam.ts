import { table, t } from 'spacetimedb/server';
import { TeamStatus } from '../types/enums';

export const tournamentTeamColumns = {
    id: t.u32().primaryKey().autoInc(),
    tournamentId: t.u32(),
    name: t.string(),
    captainUserId: t.u32(),
    status: TeamStatus,                   // A26: the single gate; participants never set it
    seedNumber: t.u32().optional(),
    groupId: t.u32().optional(),          // A23: group membership (replaces the dropped group_phase_record table)
    finalPlacement: t.u8().optional(),    // set at Completed
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

// S3 (A37, C-c8): private; the public list is view_tournament_teams(id) (captainUserId only when !isAnonymousDefault), staff view_my_tournament_teams (S9).
// Never deleted after registration closes (TD-18).
export const TournamentTeam = table({
    name: 'tournament_team',
    public: false,
    indexes: [
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] },
        { accessor: 'captain_user_id', algorithm: 'btree', columns: ['captainUserId'] },
    ],
}, tournamentTeamColumns);
