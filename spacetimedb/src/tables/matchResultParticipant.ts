import { table, t } from 'spacetimedb/server';
import { TeamSide } from '../types/enums';

export const matchResultParticipantColumns = {
    matchResultId: t.u32(),
    userId: t.u32(),
    teamSide: TeamSide,
    isCaptain: t.bool(),
    accountRatingSnapshot: t.f64(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MatchResultParticipant = table({
    name: 'match_result_participant',
    public: true,
    primaryKey: ['matchResultId', 'userId'],
    indexes: [
        { accessor: 'match_result_id', algorithm: 'btree', columns: ['matchResultId'] },
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_result_and_user', algorithm: 'btree', columns: ['matchResultId', 'userId'] },
    ],
}, matchResultParticipantColumns);
