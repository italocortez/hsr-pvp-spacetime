/**
 * Next MatchSessionStep.sequence for a lobby: max existing sequence + 1, 0 for the first step.
 * F9: every step writer uses this (picks, bans, auction steps, manual and auto Pause, the Undo
 * record), so sequences never collide and MatchSessionStepHistory's logical key
 * [matchHistoryId, gameNumber, sequence] stays unique. Classic turn progress is `MatchSession.turnIndex`,
 * which is not a sequence number.
 */
export function getNextSequence(ctx: any, lobbyId: number): number {
    const steps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
    if (steps.length === 0) return 0;
    return Math.max(...steps.map((s: any) => s.sequence)) + 1;
}
