/**
 * Next MatchSessionStep.sequence for a lobby: max existing sequence + 1, 0 for the first step.
 * F9: every step writer uses this (picks, bans, auction steps, manual and auto Pause, the Undo
 * record), so sequences never collide and MatchSessionStepHistory's logical key
 * [matchHistoryId, gameNumber, sequence] stays unique. Classic turn progress is `MatchSession.turnIndex`,
 * which is not a sequence number.
 * A65: lobby-wide on purpose. The steps of every game stay until finalization, so sequences keep increasing
 * across the series (game 2 starts after game 1's last sequence); the archive key tolerates both.
 */
export function getNextSequence(ctx: any, lobbyId: number): number {
    const steps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
    if (steps.length === 0) return 0;
    return Math.max(...steps.map((s: any) => s.sequence)) + 1;
}

/**
 * A65(2): the live steps of one game of the lobby (the current game, or the earlier game an Admin edits). Every
 * game-scoped reader (draft state, undo, ban restriction, edits, auto-resume) goes through this; lobby-wide readers
 * (getNextSequence, the user-deletion guard, the lobby GC, the finalization archive) read every game.
 */
export function currentGameSteps(ctx: any, lobbyId: number, gameNumber: number): any[] {
    return [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)].filter((s: any) => s.gameNumber === gameNumber);
}
