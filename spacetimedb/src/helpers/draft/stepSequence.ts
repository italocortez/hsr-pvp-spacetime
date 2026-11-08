/**
 * Next MatchSessionStep.sequence for a lobby: max existing sequence + 1, 0 for the first step.
 * F9: every step writer uses this (picks, bans, auction steps, manual and auto Pause, the Undo
 * record), so sequences never collide and MatchSessionStepHistory's logical key
 * [matchHistoryId, sequence] stays unique (A67(3): one game per lobby). Classic turn progress is
 * `MatchSession.turnIndex`, which is not a sequence number.
 */
export function getNextSequence(ctx: any, lobbyId: number): number {
    const steps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
    if (steps.length === 0) return 0;
    return Math.max(...steps.map((s: any) => s.sequence)) + 1;
}

/**
 * A67(3): the live steps of the lobby's one game (A65's per-game filter is gone). Every reader of the draft state,
 * undo, ban restriction, edits and auto-resume goes through this.
 */
export function lobbySteps(ctx: any, lobbyId: number): any[] {
    return [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
}
