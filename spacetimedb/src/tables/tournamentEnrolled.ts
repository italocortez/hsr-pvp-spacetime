import { table, t } from 'spacetimedb/server';
import { ParticipantStatus } from '../types/enums';

export const tournamentEnrolledColumns = {
    tournamentId: t.u32(),
    userId: t.u32(),
    status: ParticipantStatus,
    anonymousAlias: t.string().optional(),
    isWaitlisted: t.bool(),
    allowRandomTeamAssignment: t.bool(),
    approvedByToAt: t.timestamp().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const TournamentEnrolled = table({
    name: 'tournament_enrolled',
    public: true,
    primaryKey: ['tournamentId', 'userId'],
    indexes: [
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] },
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_tournament_and_user', algorithm: 'btree', columns: ['tournamentId', 'userId'] },
    ],
}, tournamentEnrolledColumns);
