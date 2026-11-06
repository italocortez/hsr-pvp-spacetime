import { table, t } from 'spacetimedb/server';
import { TeamSide } from '../types/enums';

/**
 * A21 (S3): raw result of one lineup group (half or third) for one team in one game.
 * `value` is cycles (Memory of Chaos / Anomaly Arbitration, lower wins) or points (Apocalyptic Shadow,
 * higher wins) in fixed-point hundredths; the shared scoring module (S7) sums the groups, applies the
 * handicaps and adjustments, then the tie-break chain. Entered by the team captain for their own side or
 * by the referee (record_group_scores, S7). Private: participants read it inside view_my_match_result_games.
 */
export const matchResultGroupScoreColumns = {
    id: t.u32().primaryKey().autoInc(),
    matchResultId: t.u32(),
    gameNumber: t.u8(),
    teamSide: TeamSide,
    groupIndex: t.u8(),       // 0..1 for halves, 0..2 for thirds
    value: t.u32(),           // cycles or points, fixed-point hundredths
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MatchResultGroupScore = table({
    name: 'match_result_group_score',
    public: false,
    indexes: [
        { accessor: 'by_result_game', algorithm: 'btree', columns: ['matchResultId', 'gameNumber'] },
    ],
}, matchResultGroupScoreColumns);
