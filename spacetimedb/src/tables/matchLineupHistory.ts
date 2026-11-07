import { table, t } from 'spacetimedb/server';
import { TeamSide } from '../types/enums';

/**
 * A56(1): archived copy of a MatchLineup, written by finalization (runFinalization) next to the step, game
 * and participant history rows; the replay view (S9) reads it. One row per team per game of the match.
 * `groups` is the JSON string[][] of the lineup, `synergySurcharge` and `rosterCost` are hundredths (A21); the
 * roster cost lives here, not on MatchResultGameHistory (S3 review L4, settled by A56).
 * Private, like the other history tables (A37): participants and Moderator+ read it through views (S9).
 */
export const matchLineupHistoryColumns = {
    id: t.u32().primaryKey().autoInc(),
    matchHistoryId: t.u32(),
    gameNumber: t.u8(),
    teamSide: TeamSide,
    groups: t.string(),
    synergySurcharge: t.u32(),
    rosterCost: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MatchLineupHistory = table({
    name: 'match_lineup_history',
    public: false,
    indexes: [
        { accessor: 'by_match_history', algorithm: 'btree', columns: ['matchHistoryId'] },
    ],
}, matchLineupHistoryColumns);
