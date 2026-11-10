import { isDraftComplete } from '@module/helpers/draft/draftComplete';

// ─── Draft turn clock (S10f, draft audit #5 / BACKEND-BUGS F10 / policy review G10) ─────────────────────────────
// One definition of the time left in the current turn, used by pause_draft, the disconnect auto-pause
// (run_referee_transfer_check), resume_draft, liftAutoPauseOnReturn and both timer expiry reducers. Clients compute
// the same value from MatchSession.timerState.
//
//   budgetMs    = timerState.accumulatedPauseMs > 0 ? timerState.accumulatedPauseMs : lobby.standardTurnSeconds * 1000
//                 (the column keeps its name; it holds the turn's budget measured from turnStartAt, 0 = a full turn)
//   remainingMs = isPaused ? budgetMs : max(0, budgetMs - (now - turnStartAt))
//
// A new turn (pick, ban, nomination, bid, sale, undo, start) writes turnStartAt = now and accumulatedPauseMs = 0.
// A pause freezes the clock: turnStartAt = now and accumulatedPauseMs = the remaining time (at least 1 ms, so a turn
// paused at 0 does not come back as a full turn); the Pause step's timeRemainingMs is that same value.
// A resume (manual or automatic) writes turnStartAt = now and keeps accumulatedPauseMs, so the turn continues with
// exactly the time it had left when it was paused. The expiry reducers accept the call only when remainingMs is 0.
//
// S10t (A130): a complete draft still in Drafting (isDraftComplete) runs the confirm window on the same fields: the
// full budget is the lobby's confirm window, confirmWindowSeconds (A131, default 60 s), instead of standardTurnSeconds
// (turnFullMs). turnStartAt = the moment
// the last pick or sale was made (or the window's resume), accumulatedPauseMs = the window time left after a pause.
// Every caller passes turnFullMs(lobby, session), so a pause holds the window exactly as it holds a turn.

/** S10t (A130, A131): the full length of the running clock: the confirm window once the draft is complete, else a turn. */
export function turnFullMs(lobby: any, session: any): number {
    return lobby.stage?.tag === 'Drafting' && isDraftComplete(lobby, session)
        ? lobby.confirmWindowSeconds * 1000
        : lobby.standardTurnSeconds * 1000;
}

/** The current turn's budget in ms, measured from timerState.turnStartAt (`fullMs`: turnFullMs, a turn by default). */
export function turnBudgetMs(lobby: any, timerState: any, fullMs: number = lobby.standardTurnSeconds * 1000): number {
    return timerState.accumulatedPauseMs > 0 ? timerState.accumulatedPauseMs : fullMs;
}

/** Time left in the current turn at `nowMicros` (frozen while paused). */
export function turnRemainingMs(lobby: any, timerState: any, nowMicros: bigint, fullMs?: number): number {
    const budget = turnBudgetMs(lobby, timerState, fullMs);
    if (timerState.isPaused) return budget;
    const elapsedMs = Number(nowMicros - timerState.turnStartAt.microsSinceUnixEpoch) / 1000;
    return Math.max(0, budget - elapsedMs);
}

/** The paused timerState and the remaining time it froze (the value logged in the Pause step). */
export function pausedTimerState(ctx: any, lobby: any, timerState: any, fullMs?: number): { timerState: any; remainingMs: number } {
    const remainingMs = Math.max(1, Math.round(turnRemainingMs(lobby, timerState, ctx.timestamp.microsSinceUnixEpoch, fullMs)));
    return {
        timerState: { ...timerState, isPaused: true, turnStartAt: ctx.timestamp, accumulatedPauseMs: remainingMs },
        remainingMs,
    };
}

/** The resumed timerState: the frozen remaining time runs again from now. */
export function resumedTimerState(ctx: any, timerState: any): any {
    return { ...timerState, isPaused: false, turnStartAt: ctx.timestamp };
}
