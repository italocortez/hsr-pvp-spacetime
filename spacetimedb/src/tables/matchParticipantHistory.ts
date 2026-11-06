import { table, t } from 'spacetimedb/server';
import { TeamSide } from '../types/enums';

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
    public: true,
    primaryKey: ['userId', 'matchHistoryId'],
    indexes: [
        { accessor: 'by_user', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_match_history', algorithm: 'btree', columns: ['matchHistoryId'] },
        { accessor: 'by_user_and_match', algorithm: 'btree', columns: ['userId', 'matchHistoryId'] },
    ],
}, matchParticipantHistoryColumns);
