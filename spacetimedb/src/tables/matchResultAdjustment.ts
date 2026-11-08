import { table, t } from 'spacetimedb/server';
import { TeamSide } from '../types/enums';

/**
 * A21 "additional score modifiers" (S3): one itemized, signed bonus or penalty per row, added to a team's
 * result for one game before the tie-breaks. `value` is in the mode's unit (fixed-point hundredths,
 * signed: +2 cycles is a penalty in Memory of Chaos, +500 points a bonus in Apocalyptic Shadow); `reason`
 * is optional (A55; A21 had it required). Set by the referee or, in tournament lobbies, the organizer / admin (set_score_adjustment);
 * any change resets both captains' confirmations. Private: shown inside view_my_match_result_games.
 */
export const matchResultAdjustmentColumns = {
    id: t.u32().primaryKey().autoInc(),
    matchResultId: t.u32(),
    teamSide: TeamSide,
    value: t.i32(),           // hundredths, signed
    reason: t.string().optional(),   // A55: optional (A21 said required)
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
        { accessor: 'by_result', algorithm: 'btree', columns: ['matchResultId'] }, // A67(3): one game per record
    ],
}, matchResultAdjustmentColumns);
