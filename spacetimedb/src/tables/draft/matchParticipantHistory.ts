import { table, t } from 'spacetimedb/server';
import { TeamSide } from '@module/types/enums';

export const matchParticipantHistoryColumns = {
    userId: t.u32(),
    matchHistoryId: t.u32(),
    teamSide: TeamSide,
    displayName: t.string(),
    isReferee: t.bool(),
    isCoach: t.bool(),
    isCaptain: t.bool(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MatchParticipantHistory = table({
    name: 'match_participant_history',
    public: false, // S3 (A37): private, read through views (S9)
    primaryKey: ['userId', 'matchHistoryId'],
    indexes: [
        { accessor: 'by_user', algorithm: 'btree', columns: ['userId'] },
    ],
}, matchParticipantHistoryColumns);
