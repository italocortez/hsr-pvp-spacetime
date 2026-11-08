import { table, t } from 'spacetimedb/server';
import { GameMode, TeamSide } from '@module/types/enums';

// Archived copy of MatchResultGame (same A21 shape: deaths + stored computation, no boss columns).
export const matchResultGameHistoryColumns = {
    matchHistoryId: t.u32(),
    gameMode: GameMode,
    teamBlueScreenshotUrl: t.string().optional(),
    teamRedScreenshotUrl: t.string().optional(),
    teamBlueCyclesUsed: t.u32().optional(),
    teamRedCyclesUsed: t.u32().optional(),
    teamBlueScore: t.u64().optional(),
    teamRedScore: t.u64().optional(),
    teamBlueDeaths: t.u8(),
    teamRedDeaths: t.u8(),
    teamBlueAdjustedResult: t.i32().optional(),
    teamRedAdjustedResult: t.i32().optional(),
    tieBreakLevel: t.u8().optional(),
    winnerTeamSide: TeamSide,
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

// S3 (A37, R5): private; participants and Moderator+ read view_my_match_result_game_history (S9).
export const MatchResultGameHistory = table({
    name: 'match_result_game_history',
    public: false,
    primaryKey: ['matchHistoryId'], // A67(3): one game per match
    indexes: [
        { accessor: 'by_match_history', algorithm: 'btree', columns: ['matchHistoryId'] },
    ],
}, matchResultGameHistoryColumns);
