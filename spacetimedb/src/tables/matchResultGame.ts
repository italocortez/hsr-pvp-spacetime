import { table, t } from 'spacetimedb/server';
import { GameMode, ValidationStatus, TeamSide } from '../types/enums';

export const matchResultGameColumns = {
    matchResultId: t.u32(),
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
    validationStatus: ValidationStatus,
    validatedByUserId: t.u32().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MatchResultGame = table({
    name: 'match_result_game',
    public: true,
    primaryKey: ['matchResultId', 'gameNumber'],
    indexes: [
        { accessor: 'match_result_id', algorithm: 'btree', columns: ['matchResultId'] },
        { accessor: 'by_result_and_game', algorithm: 'btree', columns: ['matchResultId', 'gameNumber'] },
    ],
}, matchResultGameColumns);
