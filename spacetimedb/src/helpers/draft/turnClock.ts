import { SenderError } from 'spacetimedb/server';
import { charactersPerTeam, type LineupFormatTag } from '@shared/scoring';
import { isDraftComplete } from '@module/helpers/draft/draftComplete';

// ─── Draft turn clock (S10f, draft audit #5 / BACKEND-BUGS F10 / policy review G10; S10aa: A148 to A151) ─────────
// One definition of the time left in the current turn and in the on-clock team's reserve, used by pause_draft, the
// disconnect auto-pause (run_referee_transfer_check), resume_draft, every turn action and both timer expiry reducers.
// Clients compute the same values from MatchSession.timerState (docs/match-session/architecture.md "Turn clock").
//
// TimerState fields:
//   turnStartAt        the anchor: the start of the turn, or of the running part of it after a pause / resume
//   teamBlueReserveMs  each team's reserve at the start of the current turn (A148); changes only when a turn ends
//   teamRedReserveMs
//   isPaused
//   accumulatedPauseMs the turn time left at turnStartAt; 0 = a full turn (the column keeps its old name)
//   reserveUsedMs      (S10aa) the on-clock team's reserve already used in this turn before turnStartAt
//   inReserve          (S10aa) the turn time was used up before turnStartAt (a pause during reserve time): budget 0
//   reserveMarks       (S10aa, A149) the reserves at the start of each turn that consumed reserve, keyed by the
//                      sequence of the step that ended it; undo_last_step restores from them
//
//   full       = turnFullMs (the confirm window once the draft is complete, else standardTurnSeconds * 1000)
//   team       = onClockTeam (none in the confirm window: it has no reserve)
//   budget     = inReserve ? 0 : (accumulatedPauseMs > 0 ? accumulatedPauseMs : full)
//   reserveAt  = max(0, team's reserve - reserveUsedMs)          (0 without a team)
//   elapsed    = isPaused ? 0 : now - turnStartAt
//   turnLeft   = max(0, budget - elapsed)
//   reserveLeft= max(0, reserveAt - max(0, elapsed - budget))
//   overdue    = max(0, elapsed - budget - reserveAt)            (time since both reached 0)
//   expiryDue  = !isPaused && turnLeft == 0 && reserveLeft == 0
//
// A new turn writes turnStartAt = now, accumulatedPauseMs 0, reserveUsedMs 0, inReserve false (freshTurnState). A turn
// ended by an action or an expiry first charges the on-clock team min(reserve, reserveUsedMs + overtime) (turnEndTimerState).
// A pause freezes both clocks at the anchor (pausedTimerState); a resume moves the anchor to now (resumedTimerState).

/** S10aa (A150): the refusal of a turn action more than LATE_ACTION_TOLERANCE_MS after turn time and reserve ran out. */
export const timeUpText = 'Time is up for this turn.';
export const LATE_ACTION_TOLERANCE_MS = 1000;

/** S10t (A130, A131): the full length of the running clock: the confirm window once the draft is complete, else a turn. */
export function turnFullMs(lobby: any, session: any): number {
    return lobby.stage?.tag === 'Drafting' && isDraftComplete(lobby, session)
        ? lobby.confirmWindowSeconds * 1000
        : lobby.standardTurnSeconds * 1000;
}

/**
 * S10aa (A148): the team on the clock: the team whose ban, pick or nomination it is, or in Auction bidding the team that
 * must answer the bid (the other team than currentBidTeam). null in the confirm window (and outside Drafting).
 */
export function onClockTeam(lobby: any, session: any): 'Blue' | 'Red' | null {
    if (lobby.stage?.tag !== 'Drafting' || isDraftComplete(lobby, session)) return null;
    if (!session.isAuctionPhase) {
        const tag = session.draftSequence[session.turnIndex]?.teamTurn?.tag;
        return tag === 'Blue' || tag === 'Red' ? tag : null;
    }
    if (session.currentNomination !== undefined && session.currentNomination !== null) {
        const holder = session.currentBidTeam?.tag;
        return holder === 'Blue' ? 'Red' : holder === 'Red' ? 'Blue' : null;
    }
    // The nominator; a full team never nominates (A81(1), as timer_expiry_auction resolves it).
    const target = charactersPerTeam(lobby.lineupFormat.tag as LineupFormatTag);
    const nominator = session.nextNominatorTeam?.tag;
    if (nominator !== 'Blue' && nominator !== 'Red') return null;
    const won = nominator === 'Blue' ? session.blueCharactersWon : session.redCharactersWon;
    return won >= target ? (nominator === 'Blue' ? 'Red' : 'Blue') : nominator;
}

export interface ClockReading {
    /** The team on the clock (null in the confirm window). */
    team: 'Blue' | 'Red' | null;
    /** Time left on the turn clock (or the confirm window). */
    turnRemainingMs: number;
    /** Reserve left of the on-clock team (0 without one). */
    reserveRemainingMs: number;
    /** Not paused, turn time and reserve both at 0: the expiry reducers accept the call. */
    expiryDue: boolean;
    /** Time since turn time and reserve both reached 0 (0 while paused or before). */
    overdueMs: number;
    /** The on-clock team's reserve at the start of the turn (its stored value). */
    reserveStartMs: number;
    /** Reserve the on-clock team has used in this turn so far (what a turn end at this moment charges). */
    reserveChargeMs: number;
}

/** S10aa (A148): the one clock reading from the stored fields at `nowMicros` (the formula above). */
export function readClock(lobby: any, session: any, nowMicros: bigint): ClockReading {
    const ts = session.timerState;
    const team = onClockTeam(lobby, session);
    const full = turnFullMs(lobby, session);
    const budget = ts.inReserve ? 0 : (ts.accumulatedPauseMs > 0 ? ts.accumulatedPauseMs : full);
    const reserveStartMs = team === 'Blue' ? ts.teamBlueReserveMs : team === 'Red' ? ts.teamRedReserveMs : 0;
    const usedBefore = team ? Math.min(ts.reserveUsedMs ?? 0, reserveStartMs) : 0;
    const reserveAt = reserveStartMs - usedBefore;
    const elapsed = ts.isPaused ? 0 : Math.max(0, Number(nowMicros - ts.turnStartAt.microsSinceUnixEpoch) / 1000);
    const over = Math.max(0, elapsed - budget);
    const turnRemainingMs = Math.max(0, budget - elapsed);
    const reserveRemainingMs = Math.max(0, reserveAt - over);
    return {
        team,
        turnRemainingMs,
        reserveRemainingMs,
        expiryDue: !ts.isPaused && turnRemainingMs === 0 && reserveRemainingMs === 0,
        overdueMs: Math.max(0, over - reserveAt),
        reserveStartMs,
        reserveChargeMs: Math.min(reserveStartMs, usedBefore + Math.round(Math.min(over, reserveAt))),
    };
}

/** The timerState of a new turn (the reserves and marks kept). */
export function freshTurnState(ctx: any, timerState: any): any {
    return { ...timerState, turnStartAt: ctx.timestamp, accumulatedPauseMs: 0, reserveUsedMs: 0, inReserve: false };
}

/**
 * S10aa (A148, A149): the timerState written when the current turn ends (an action, a sale or an expiry), as the step
 * with sequence `endingSequence`: the on-clock team pays the reserve it used (min(reserve, reserveUsedMs + overtime)),
 * a reserve mark keeps both reserves at the start of the turn when it paid anything, and the next turn starts fresh.
 */
export function turnEndTimerState(ctx: any, lobby: any, session: any, endingSequence: number): any {
    const ts = session.timerState;
    const r = readClock(lobby, session, ctx.timestamp.microsSinceUnixEpoch);
    let next = { ...ts };
    if (r.team && r.reserveChargeMs > 0) {
        const left = r.reserveStartMs - r.reserveChargeMs;
        next = {
            ...next,
            ...(r.team === 'Blue' ? { teamBlueReserveMs: left } : { teamRedReserveMs: left }),
            reserveMarks: [...(ts.reserveMarks ?? []), {
                sequence: endingSequence,
                teamBlueReserveMs: ts.teamBlueReserveMs,
                teamRedReserveMs: ts.teamRedReserveMs,
            }],
        };
    }
    return freshTurnState(ctx, next);
}

/**
 * S10aa (A149): the timerState after an undo that returns the draft to the turn ended by the step with sequence
 * `restoreSequence` (Classic: the undone ban or pick; Auction: the round's Nominate step). Both reserves go back to their
 * values at the start of that turn (the earliest reserve mark at or after it; none: the current turn-start values, so
 * the reserve used by the turn in progress is returned too); later marks are dropped; the turn starts fresh.
 */
export function undoneTimerState(ctx: any, session: any, restoreSequence: number): any {
    const ts = session.timerState;
    const marks: any[] = ts.reserveMarks ?? [];
    const kept = marks.filter((m) => m.sequence < restoreSequence);
    const first = marks.filter((m) => m.sequence >= restoreSequence).sort((a, b) => a.sequence - b.sequence)[0];
    return freshTurnState(ctx, {
        ...ts,
        ...(first ? { teamBlueReserveMs: first.teamBlueReserveMs, teamRedReserveMs: first.teamRedReserveMs } : {}),
        reserveMarks: kept,
    });
}

/**
 * S10aa (A150): refuses a turn action (pick, ban, nomination, bid, pass) when the turn time and the on-clock team's
 * reserve are both used up and more than LATE_ACTION_TOLERANCE_MS have passed since. A paused clock never refuses.
 */
export function ensureTurnTimeLeft(ctx: any, lobby: any, session: any): void {
    if (session.timerState.isPaused) return;
    if (readClock(lobby, session, ctx.timestamp.microsSinceUnixEpoch).overdueMs > LATE_ACTION_TOLERANCE_MS) {
        throw new SenderError(timeUpText);
    }
}

/**
 * The paused timerState and the turn time it froze (the value logged in the Pause step). Both clocks freeze at the
 * anchor: with turn time left, accumulatedPauseMs = that time (at least 1 ms); during reserve time inReserve is set and
 * reserveUsedMs holds the reserve used (at least 1 ms of reserve kept); when both are spent, 1 ms of turn time is frozen
 * (the S10f rule, so the pause does not come back as a full turn) and the reserve stays spent.
 */
export function pausedTimerState(ctx: any, lobby: any, session: any): { timerState: any; remainingMs: number } {
    const ts = session.timerState;
    const r = readClock(lobby, session, ctx.timestamp.microsSinceUnixEpoch);
    if (r.turnRemainingMs > 0) {
        const remainingMs = Math.max(1, Math.round(r.turnRemainingMs));
        return { timerState: { ...ts, isPaused: true, turnStartAt: ctx.timestamp, accumulatedPauseMs: remainingMs, inReserve: false }, remainingMs };
    }
    if (r.reserveRemainingMs > 0) {
        const reserveLeft = Math.max(1, Math.round(r.reserveRemainingMs));
        return {
            timerState: {
                ...ts, isPaused: true, turnStartAt: ctx.timestamp, accumulatedPauseMs: 0, inReserve: true,
                reserveUsedMs: r.reserveStartMs - reserveLeft,
            },
            remainingMs: 0,
        };
    }
    return {
        timerState: { ...ts, isPaused: true, turnStartAt: ctx.timestamp, accumulatedPauseMs: 1, inReserve: false, reserveUsedMs: r.reserveStartMs },
        remainingMs: 1,
    };
}

/** The resumed timerState: the frozen turn time and reserve run again from now. */
export function resumedTimerState(ctx: any, timerState: any): any {
    return { ...timerState, isPaused: false, turnStartAt: ctx.timestamp };
}
