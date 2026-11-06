import { table, t } from 'spacetimedb/server';
import { TeamSide } from '../types/enums';

/**
 * A21 "additional score modifiers" (S3): one itemized, signed bonus or penalty per row, added to a team's
 * result for one game before the tie-breaks. `value` is in the mode's unit (fixed-point hundredths,
 * signed: +2 cycles is a penalty in Memory of Chaos, +500 points a bonus in Apocalyptic Shadow); `reason`
 * is required. Set by the referee or, in tournament lobbies, the organizer / admin (set_score_adjustment,
 * S7); any change resets both captains' confirmations. Private: shown inside view_my_match_result_games.
 */
export const matchResultAdjustmentColumns = {
    id: t.u32().primaryKey().autoInc(),
    matchResultId: t.u32(),
    gameNumber: t.u8(),
    teamSide: TeamSide,
    value: t.i32(),           // hundredths, signed
    reason: t.string(),
    setById: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MatchResultAdjustment = table({
    name: 'match_result_adjustment',
    public: false,
    indexes: [
        { accessor: 'by_result_game', algorithm: 'btree', columns: ['matchResultId', 'gameNumber'] },
    ],
}, matchResultAdjustmentColumns);
