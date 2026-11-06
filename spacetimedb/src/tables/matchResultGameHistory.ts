import { table, t } from 'spacetimedb/server';
import { GameMode, TeamSide } from '../types/enums';

export const matchResultGameHistoryColumns = {
    matchHistoryId: t.u32(),
    gameNumber: t.u8(),
    gameMode: GameMode,
    teamBlueScreenshotUrl: t.string().optional(),
    teamRedScreenshotUrl: t.string().optional(),
    teamBlueCyclesUsed: t.u32().optional(),
    teamRedCyclesUsed: t.u32().optional(),
    teamBlueScore: t.u64().optional(),
    teamRedScore: t.u64().optional(),
    teamBlueBoss1Score: t.u64().optional(),
    teamBlueBoss2Score: t.u64().optional(),
    teamRedBoss1Score: t.u64().optional(),
    teamRedBoss2Score: t.u64().optional(),
    winnerTeamSide: TeamSide,
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MatchResultGameHistory = table({
    name: 'match_result_game_history',
    public: true,
    primaryKey: ['matchHistoryId', 'gameNumber'],
    indexes: [
        { accessor: 'by_match_history', algorithm: 'btree', columns: ['matchHistoryId'] },
    ],
}, matchResultGameHistoryColumns);
