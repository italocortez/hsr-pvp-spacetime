import { table, t } from 'spacetimedb/server';
import { GameMode } from '../types/enums';

export const mmrHistoryColumns = {
    id: t.u32().primaryKey().autoInc(),
    userId: t.u32(),
    gameMode: GameMode,
    matchHistoryId: t.u32(),
    previousRating: t.u32(),
    newRating: t.u32(),
    delta: t.i32(),
    seasonId: t.u32().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MmrHistory = table({
    name: 'mmr_history',
    public: true,
    indexes: [
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'match_history_id', algorithm: 'btree', columns: ['matchHistoryId'] },
    ],
}, mmrHistoryColumns);
