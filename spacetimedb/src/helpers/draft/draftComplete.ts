import { charactersPerTeam, type LineupFormatTag } from '@shared/scoring';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { postSystemChat } from '@module/helpers/results/scoringHelpers';

// ─── The end of the draft (S10t: A129, A130, A131) ───────────────────────────────────────────────────────────────
// The last pick (Classic) or the last sale (Auction) leaves the lobby in Drafting with the draft complete
// (isDraftComplete). No turn runs: pick, ban, nominate, bid and pass are refused (draftCompleteText). The lobby's
// confirm window (Lobby.confirmWindowSeconds, 0-300, default 60, A131) runs on the session's turn clock fields: the
// last step wrote timerState.turnStartAt = its time and accumulatedPauseMs = 0, and turnFullMs (turnClock.ts) gives the
// window length in place of standardTurnSeconds, so a pause holds the window exactly as it holds a turn. During the
// window the referee may undo the last step (A127, the turn reopens with a fresh clock) or call advance_stage. Once the
// window has elapsed, either timer expiry reducer (any present member, validated against the elapsed time like a turn)
// moves the lobby to Equipping. With confirmWindowSeconds = 0 the last step moves the lobby in the same call (no window,
// so the last step cannot be undone). Every move goes through finishDraft, so all paths write the same state.

export const confirmWindowOpenText = 'The confirm window has not yet expired.';

export const draftCompleteText = 'The draft is complete. It moves to Equipping when the referee advances it or the confirm window ends.';

/**
 * True when the lobby's draft is complete (the stage is not checked here). Classic: every turn of the sequence is played
 * (turnIndex at its end). Auction: the auction phase is open and both teams hold charactersPerTeam characters (A81(3)).
 */
export function isDraftComplete(lobby: any, session: any): boolean {
    if (lobby.draftMode.tag === 'Classic') return session.turnIndex >= session.draftSequence.length;
    const target = charactersPerTeam(lobby.lineupFormat.tag as LineupFormatTag);
    return session.isAuctionPhase && session.blueCharactersWon >= target && session.redCharactersWon >= target;
}

/**
 * A129 / A130: the move from the complete draft to Equipping, shared by advance_stage, the window expiry (both timer
 * expiry reducers) and the no-window case: the D-50 roll-over (each team's leftover character budget added to its
 * light-cone budget, character budgets 0), the pause cleared (S10t review F3), stage Equipping, lastActivityAt, and the
 * system chat line. `lobby` and
 * `session` are the current rows.
 */
export function finishDraft(ctx: any, lobby: any, session: any, actorId: number): void {
    ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
        teamBlueLcBudget: session.teamBlueLcBudget + session.teamBlueCharBudget,
        teamRedLcBudget: session.teamRedLcBudget + session.teamRedCharBudget,
        teamBlueCharBudget: 0,
        teamRedCharBudget: 0,
        // S10t review F3: a manual pause or a disconnect auto-pause held the window; the move ends it, so Equipping
        // never starts paused (resume_draft is Drafting-only). The pause counters (pausesUsedBlue / Red) and the Pause
        // step rows stay as they are (the counters are spent, the rows are the log).
        timerState: { ...session.timerState, isPaused: false, accumulatedPauseMs: 0, turnStartAt: ctx.timestamp },
    }, actorId));
    ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
        stage: { tag: 'Equipping', value: {} } as any,
        lastActivityAt: ctx.timestamp,
    }, actorId));
    postSystemChat(ctx, lobby.id, 'Draft complete. Stage: Equipping', actorId);
}

/**
 * A131: called after a pick or a sale has been written. When that step completed the draft and the lobby has no confirm
 * window (confirmWindowSeconds = 0), the lobby moves to Equipping in the same call (finishDraft). Re-reads both rows.
 */
export function finishDraftWithoutWindow(ctx: any, lobbyId: number, actorId: number): void {
    const lobby = ctx.db.Lobby.id.find(lobbyId);
    const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
    if (!lobby || !session || lobby.stage.tag !== 'Drafting') return;
    if (lobby.confirmWindowSeconds === 0 && isDraftComplete(lobby, session)) finishDraft(ctx, lobby, session, actorId);
}
