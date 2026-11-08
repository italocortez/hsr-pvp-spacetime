import { table, t } from 'spacetimedb/server';
import { GameMode, ValidationStatus, TeamSide } from '@module/types/enums';

// A21: raw results are entered per group in MatchResultGroupScore rows; this row keeps the per-team
// totals, deaths (one total per team per game), and the server-computed outcome for audit and replay.
// The fixed boss1/boss2 columns are gone (they could not hold thirds).
export const matchResultGameColumns = {
    matchResultId: t.u32(),
    gameMode: GameMode,
    teamBlueScreenshotUrl: t.string().optional(),
    teamRedScreenshotUrl: t.string().optional(),
    teamBlueCyclesUsed: t.u32().optional(),
    teamRedCyclesUsed: t.u32().optional(),
    teamBlueScore: t.u64().optional(),
    teamRedScore: t.u64().optional(),
    teamBlueDeaths: t.u8(),
    teamRedDeaths: t.u8(),
    // Stored computation (A21 todo "Schema impact"): adjusted results in fixed-point hundredths of the
    // mode's unit (signed: handicaps can push a result below 0) and which tie-break level decided the
    // winner (0 = adjusted result, 1 = roster cost, 2 = 4-star count, 3 = 5-star eidolons, 4 = referee override).
    teamBlueAdjustedResult: t.i32().optional(),
    teamRedAdjustedResult: t.i32().optional(),
    tieBreakLevel: t.u8().optional(),
    winnerTeamSide: TeamSide,
    validationStatus: ValidationStatus,
    validatedByUserId: t.u32().optional(),
    // A60(3): one confirmation per captain per game (confirm_game); every open-game edit resets both. The game is
    // closed when closedAt is set (set by close_game: a captain once both flags are set, or staff; A63): every edit reducer then rejects it, except
    // an Admin's edit while the record is Pending or Submitted (A60(7)).
    blueConfirmed: t.bool(),
    redConfirmed: t.bool(),
    closedAt: t.timestamp().optional(),
    closedById: t.u32().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

// S3 (A37): private; participants read view_my_match_result_games (S9). A67(3): one row per record (the lobby's one game);
// the key is the record id (decorative table-level key, as before; rows are read through match_result_id).
export const MatchResultGame = table({
    name: 'match_result_game',
    public: false,
    primaryKey: ['matchResultId'],
    indexes: [
        { accessor: 'match_result_id', algorithm: 'btree', columns: ['matchResultId'] },
    ],
}, matchResultGameColumns);
