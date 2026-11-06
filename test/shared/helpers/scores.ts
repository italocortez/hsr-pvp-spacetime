/**
 * Shared game score test helpers.
 *
 * Exports:
 *   - gameScoreArgs: defaults for record_game_scores with all optional fields
 *     set to null (no value). Callers override matchResultId, gameNumber,
 *     winnerTeamSide, and whichever optional score fields are under test.
 */

export function gameScoreArgs(overrides: Record<string, unknown> = {}) {
    return {
        matchResultId: 0,
        gameNumber: 1,
        winnerTeamSide: 'Blue',
        teamBlueCyclesUsed: undefined,
        teamRedCyclesUsed: undefined,
        teamBlueScore: undefined,
        teamRedScore: undefined,
        teamBlueBoss1Score: undefined,
        teamBlueBoss2Score: undefined,
        teamRedBoss1Score: undefined,
        teamRedBoss2Score: undefined,
        teamBlueScreenshotUrl: undefined,
        teamRedScreenshotUrl: undefined,
        ...overrides,
    };
}
