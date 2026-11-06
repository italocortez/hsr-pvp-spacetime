import { table, t } from 'spacetimedb/server';

export const groupPhaseRecordColumns = {
    tournamentId: t.u32(),
    groupId: t.u32(),
    teamId: t.u32(),
    wins: t.u32(),
    losses: t.u32(),
    draws: t.u32(),
    points: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const GroupPhaseRecord = table({
    name: 'group_phase_record',
    public: true,
    primaryKey: ['tournamentId', 'groupId', 'teamId'],
    indexes: [
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] },
        { accessor: 'by_tournament_group_and_team', algorithm: 'btree', columns: ['tournamentId', 'groupId', 'teamId'] },
    ],
}, groupPhaseRecordColumns);
