import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensurePresentMember, ensureStageIs, slotToTeamSide, isSeatedPlayer, slotIsCoach } from '@module/helpers/lobby/lobbyHelpers';
import { ensureMatchAlive } from '@module/helpers/lobby/disconnectHelpers';
import { lobbySteps, getNextSequence, ensurePauseInterval, ensureUndoStepRoom } from '@module/helpers/draft/stepSequence';
import { pausedTimerState, resumedTimerState, undoneTimerState } from '@module/helpers/draft/turnClock';

// ─── undo_last_step ───────────────────────────────────────────────────────────
// S10t (A127, A132), S10u (A134): removes the last character step of the lobby's game (A67(3)) and restores the state
// before it, while the lobby stage is Drafting: one ban or pick per call, one nomination round per call in the auction
// phase (A134, below). Per D-60: referee only
// (refereeCanUndo), A98: present. Rejected while paused ("Nothing to undo right now."). Supersedes the S4 F9
// auction-phase refusal and the window ends of A122(9), A123 and A125.
//
// "Last step" = the highest-sequence character step (UNDOABLE_TAGS): Ban, Pick, Nominate, Bid, AuctionSold. A132: an
// eidolon selection (SetEidolon, written by set_eidolon during Drafting once the character is drafted, A60(1)) is not a
// step of its own for undo: it is never the target and never blocks one, even when it is the most recent step. Pause
// and Undo rows are skipped and kept as before. No other step kind exists during Drafting.
//
// What each undo restores:
// - Ban / Pick (ban_character, pick_character, timer_expiry_classic): one step per call (A127). The step is deleted;
//   turnIndex - 1; isAuctionPhase false when it was set (the last ban of the Auction ban phase opened it); fresh turn
//   clock. A132: a Pick also takes with it every SetEidolon step of the picking side on that character made after it
//   (Classic edits move no budget).
// - S10u (A134): in the auction phase the unit is the nomination round (its Nominate step, its Bid steps and its
//   AuctionSold step when it was sold). Rounds never overlap (a nomination ends only with a sale), so the round of the
//   last auction step is the latest Nominate step and every Bid step after it.
//   - The last step is a Nominate or a Bid (a round is open; nominate_character, the timer's EMPTY nomination,
//     place_bid): the Nominate step and every Bid step of the round are deleted; no open nomination (currentNomination
//     and currentBidAmount unset, currentBidTeam Spectator); nextNominatorTeam = the round's nominator (unchanged: a
//     nomination never moves it); fresh turn clock. Bids charge nothing, so no budget moves.
//   - The last step is an AuctionSold (pass_bid, the timer's sale, the A81(2) immediate sale): the sale, its Nominate
//     and Bid steps and (A132) every SetEidolon step of the winner on that character after the sale are deleted; the
//     winner's budgets get back exactly what they cost, per budget: the sale's charCharged / lcCharged plus each removed
//     edit's charCharged / lcCharged (a lowering edit's negative values take its refund back; restoredBudgets keeps
//     both at least 0). Edits on other characters keep their rows and charges, even when made during the round or after
//     the sale. The winner's won count - 1; nextNominatorTeam = the round's nominator; no open nomination; fresh clock.
//   No undo path restores a team as the holder of a bid (A134; the S10t bid branch and its refusal are gone).
//   S10t (A129): the last sale (and the last Classic pick) leaves the lobby in Drafting with the draft complete and no
//   roll-over, so it is undone like any other: the turn it ended reopens with a fresh clock (a standard turn: the draft
//   is no longer complete). The D-50 roll-over happens only at finishDraft, after which undo is refused.
// S10aa (A149): every undo returns both teams' reserves to their values at the start of the turn the draft returns to
// (the undone ban or pick; in the auction phase the round's nomination) and starts that turn with a full turn clock
// (undoneTimerState, helpers/draft/turnClock.ts); the reserve used by the turn in progress is returned too.
// Every undo inserts exactly one Undo row (originalSequenceId = the last character step removed: the ban, the pick,
// the round's last Nominate / Bid step, or the sale), counted
// by the 300-row cap (A122(10), ensureUndoStepRoom), and stamps Lobby.lastActivityAt; removed SetEidolon steps add no
// Undo row and free their slots in the per-side edit cap (ensureEditStepRoom counts live steps). The A117 re-roll keys on
// the next sequence, which the Undo row raises. Not restored: the editors' lineup throttle stamps (LobbyMember.lastLineupAt);
// no lineup or game row exists during Drafting, so an edit's refresh / recompute was a no-op.

const UNDOABLE_TAGS = new Set(['Ban', 'Pick', 'Nominate', 'Bid', 'AuctionSold']);

export const undoFinishedText = 'The draft is finished: undo works only while the lobby is in the draft stage.';

const noNomination = {
    currentNomination: undefined,
    currentBidAmount: undefined,
    currentBidTeam: { tag: 'Spectator', value: {} } as any,
};

/**
 * S10t review 2 G1, S10u (review 3 F3): the winner's budgets after a sale undo, neither below 0 once stored. A lowering
 * edit refunds to the light-cone budget; if the team spent that refund elsewhere, taking it back would leave the
 * light-cone budget negative (and a later chargeExtra would see a shortfall). The shortfall is moved to the character
 * budget, so the total is unchanged; the mirror case (a negative character budget) moves to the light-cone budget the
 * same way. Only one move runs: when both sums are negative the total itself is negative, and the final clamp drops it.
 * In exact arithmetic the restored total is at least 0 (it equals the start minus what the team still holds), so the
 * dropped value is f32 noise: at most one unit in the last place of the larger budget (review 3 D2: 9.5e-7 at
 * 33.3 / 12.7). Both values are clamped at 0 at the end, so the f32 store (Math.fround of a value >= 0 is >= 0) is
 * never negative.
 */
function restoredBudgets(side: 'Blue' | 'Red', charBudget: number, lcBudget: number): Record<string, number> {
    let char = charBudget;
    let lc = lcBudget;
    if (lc < 0) { char += lc; lc = 0; }
    else if (char < 0) { lc += char; char = 0; }
    char = Math.max(0, char);
    lc = Math.max(0, lc);
    return side === 'Blue' ? { teamBlueCharBudget: char, teamBlueLcBudget: lc } : { teamRedCharBudget: char, teamRedLcBudget: lc };
}

/** S10u (A134): the round of an auction step: the latest Nominate step at or before `upTo`, and its Bid steps. */
function roundOf(steps: any[], upTo: number): { nominateStep: any; bids: any[] } | undefined {
    const nominateStep = steps
        .filter((s) => s.action.tag === 'Nominate' && s.sequence <= upTo)
        .sort((a, b) => b.sequence - a.sequence)[0];
    if (!nominateStep) return undefined;
    const bids = steps.filter((s) => s.action.tag === 'Bid' && s.sequence > nominateStep.sequence && s.sequence <= upTo);
    return { nominateStep, bids };
}

/** A132: the SetEidolon steps of `side` on `characterName` made after `afterSequence` (the character's pick or sale). */
function eidolonEditsOf(steps: any[], side: string, characterName: string, afterSequence: number): any[] {
    return steps.filter((s) => s.action.tag === 'SetEidolon' && s.actorSlot.tag === side
        && s.payload.value.characterName === characterName && s.sequence > afterSequence);
}

export const undo_last_step = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
        if (!session) {
            throw new SenderError('Draft session not found.');
        }

        // A127 / A129: undo stops when the draft is finished, i.e. once the lobby has moved on to Equipping.
        if (lobby.stage.tag === 'Equipping' || lobby.stage.tag === 'Scoring' || lobby.stage.tag === 'AwaitingResult') {
            throw new SenderError(undoFinishedText);
        }
        ensureStageIs(lobby, 'Drafting');
        ensureMatchAlive(ctx, lobby);

        const member = ensurePresentMember(ctx, lobbyId, user.id); // A98: present, not away or abandoned

        // D-60: Only referees with refereeCanUndo permission
        if (!member.isReferee || !lobby.refereeCanUndo) {
            throw new SenderError('Only referees with undo permission can undo.');
        }

        // A67(3): the lobby's one game. The last character step; SetEidolon, Pause and Undo rows are skipped (A132).
        const allSteps = lobbySteps(ctx, lobbyId);
        const lastStep = allSteps
            .filter((s) => UNDOABLE_TAGS.has(s.action.tag))
            .sort((a, b) => b.sequence - a.sequence)[0];
        if (!lastStep) {
            throw new SenderError('No steps to undo.');
        }

        // F9: no undo while paused (the Pause step is not a draft action).
        if (session.timerState.isPaused) {
            throw new SenderError('Nothing to undo right now.');
        }

        const tag: string = lastStep.action.tag;
        let changes: Record<string, unknown>;
        const removed: any[] = [lastStep];
        const mismatch = 'The draft state does not match its steps; undo refused.';

        if (tag === 'Ban' || tag === 'Pick') {
            // A132: a pick goes with the picking side's eidolon selections on that character.
            if (tag === 'Pick') {
                removed.push(...eidolonEditsOf(allSteps, lastStep.actorSlot.tag, lastStep.payload.value.characterName, lastStep.sequence));
            }
            changes = {
                turnIndex: session.turnIndex - 1,
                ...(session.isAuctionPhase ? { isAuctionPhase: false } : {}),
                timerState: undoneTimerState(ctx, session, lastStep.sequence),
            };
        } else if (tag === 'Nominate' || tag === 'Bid') {
            // S10u (A134): an open round: its nomination and all its bids go; nobody holds a bid; the nominator again.
            // Defensive: a Nominate / Bid as the last step always has its nomination open (a sale writes a later step).
            const round = roundOf(allSteps, lastStep.sequence);
            if (session.currentNomination === undefined || !round) throw new SenderError(mismatch);
            removed.length = 0;
            removed.push(round.nominateStep, ...round.bids);
            changes = { ...noNomination, nextNominatorTeam: round.nominateStep.actorSlot, timerState: undoneTimerState(ctx, session, round.nominateStep.sequence) };
        } else {
            // AuctionSold. S10u (A134): the whole round goes with the sale, by pass, by the timer or the A81(2) immediate
            // sale alike; the draft returns to the moment before that nomination.
            const sold = lastStep.payload.value;
            const winner: string = sold.winningTeam.tag;
            const round = roundOf(allSteps, lastStep.sequence - 1);
            if (!round) throw new SenderError(mismatch);
            removed.push(round.nominateStep, ...round.bids);
            // A132: the character's eidolon selections go with it; the budgets get back what the sale and they charged.
            const edits = eidolonEditsOf(allSteps, winner, sold.characterName, lastStep.sequence);
            removed.push(...edits);
            let charBack = sold.charCharged;
            let lcBack = sold.lcCharged;
            for (const e of edits) {
                charBack += e.payload.value.charCharged;
                lcBack += e.payload.value.lcCharged;
            }
            changes = {
                ...noNomination,
                ...(winner === 'Blue' ? restoredBudgets('Blue', session.teamBlueCharBudget + charBack, session.teamBlueLcBudget + lcBack) : {}),
                ...(winner === 'Red' ? restoredBudgets('Red', session.teamRedCharBudget + charBack, session.teamRedLcBudget + lcBack) : {}),
                blueCharactersWon: session.blueCharactersWon - (winner === 'Blue' ? 1 : 0),
                redCharactersWon: session.redCharactersWon - (winner === 'Red' ? 1 : 0),
                nextNominatorTeam: round.nominateStep.actorSlot,
                timerState: undoneTimerState(ctx, session, round.nominateStep.sequence),
            };
        }

        // S10r (A122(10), L35): Undo rows count toward the edit-step cap (300 per game).
        ensureUndoStepRoom(ctx, lobbyId);

        // F9: the Undo record's own sequence, taken before the delete (draft audit LOW #15: taken after it, the Undo row
        // could reuse the deleted step's sequence)
        const undoSequence = getNextSequence(ctx, lobbyId);
        for (const step of removed) ctx.db.MatchSessionStep.id.delete(step.id);
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            sequence: undoSequence,
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: slotToTeamSide(member.lobbySlot),
            action: { tag: 'Undo' },
            payload: {
                tag: 'Undo',
                value: { originalSequenceId: lastStep.sequence },
            },
            timestamp: ctx.timestamp,
        }, user.id));

        if (Object.keys(changes).length > 0) {
            ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, changes, user.id));
        }

        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(`[DRAFT] undo_last_step: Referee #${user.id} undid ${tag} step (sequence ${lastStep.sequence}${removed.length > 1 ? `, with ${removed.length - 1} linked step(s)` : ''}) in lobby #${lobbyId}`);
    }
);

// ─── pause_draft ──────────────────────────────────────────────────────────────
// Pauses the draft timer.
// Per D-61: referee (unlimited, when refereeCanPause=true) or players (3 pauses per team).
// Per D-33: allowPlayerPause must be true for non-referee players.
// Spectators cannot pause.

export const pause_draft = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
        if (!session) {
            throw new SenderError('Draft session not found.');
        }

        ensureStageIs(lobby, 'Drafting');
        ensureMatchAlive(ctx, lobby);

        const member = ensurePresentMember(ctx, lobbyId, user.id); // A98: present, not away or abandoned

        // Already paused?
        if (session.timerState.isPaused) {
            throw new SenderError('Draft is already paused.');
        }

        // Permission check
        const isRefereeWithPower = member.isReferee && lobby.refereeCanPause;
        const isSpectator = member.lobbySlot.tag === 'Spectator' && !member.isReferee;

        if (isSpectator) {
            throw new SenderError('Spectators cannot pause the draft.');
        }

        if (!isRefereeWithPower) {
            // S10r (A122(8), L33): a coach is not a player and cannot pause (coaches act nowhere else in the draft, D-39);
            // the referee power above is unchanged.
            if (slotIsCoach(member.lobbySlot)) {
                throw new SenderError('Coaches cannot pause the draft.');
            }
            // Non-referee player path
            if (!lobby.allowPlayerPause) {
                throw new SenderError('Player pausing is not allowed in this lobby.');
            }

            // Enforce 3-per-team limit
            if (member.lobbySlot.tag.startsWith('Blue')) {
                if (session.pausesUsedBlue >= 3) {
                    throw new SenderError('Blue team has used all 3 pauses.');
                }
            } else if (member.lobbySlot.tag.startsWith('Red')) {
                if (session.pausesUsedRed >= 3) {
                    throw new SenderError('Red team has used all 3 pauses.');
                }
            } else {
                // Spectator role (but not isReferee) already handled above
                throw new SenderError('Spectators cannot pause the draft.');
            }
        }

        // Draft audit #8 (S10f): at most one manual pause per PAUSE_MIN_INTERVAL_MS per pausing party (review F3):
        // a referee with the pause power against the referees' last manual pause, a player against their team's.
        ensurePauseInterval(ctx, lobby, isRefereeWithPower ? 'Referee' : member.lobbySlot.tag.startsWith('Blue') ? 'Blue' : 'Red');

        // S10f (F10), S10aa (A148): freeze the turn clock and the reserve where they are (helpers/draft/turnClock.ts);
        // A130: holds the confirm window too.
        const paused = pausedTimerState(ctx, lobby, session);
        const timeRemainingMs = paused.remainingMs;

        // Insert Pause step (F9: its own sequence, so it never collides with a draft step)
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            sequence: getNextSequence(ctx, lobbyId),
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: slotToTeamSide(member.lobbySlot),
            action: { tag: 'Pause' },
            payload: {
                tag: 'Pause',
                value: { timeRemainingMs, isAutoPause: false },
            },
            timestamp: ctx.timestamp,
        }, user.id));

        // Update session: set isPaused, increment pause counter for non-referees
        const newPausesBlue =
            !isRefereeWithPower && member.lobbySlot.tag.startsWith('Blue')
                ? session.pausesUsedBlue + 1
                : session.pausesUsedBlue;
        const newPausesRed =
            !isRefereeWithPower && member.lobbySlot.tag.startsWith('Red')
                ? session.pausesUsedRed + 1
                : session.pausesUsedRed;

        ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
            timerState: paused.timerState,
            pausesUsedBlue: newPausesBlue,
            pausesUsedRed: newPausesRed,
        }, user.id));

        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(`[DRAFT] pause_draft: User #${user.id} paused lobby #${lobbyId}. timeRemainingMs=${timeRemainingMs}`);
    }
);

// ─── resume_draft ─────────────────────────────────────────────────────────────
// Resumes a paused draft.
// Per D-62: referee OR the original pausing player can resume a manual pause.
// A85(2), narrowed by A153 and A155: an auto-pause (disconnect) is resumed by the referee or a present seated player of
// the team whose player's absence caused it (the Pause step's actorSlot); the other team's players (A155: even when
// holding the referee flag), and coaches and spectators without the referee flag, are rejected. S10aa (A151): this is the only way an auto-pause ends; a returning player's
// reconnect no longer lifts it (the returned player sits on the paused team, so may resume it).
// S10f (F10): the pause froze the time left in accumulatedPauseMs (equal to the Pause step's timeRemainingMs) and,
// S10aa (A148), the reserve used in reserveUsedMs / inReserve; the resume sets turnStartAt = now and keeps them, so both
// clocks continue from where they were paused (turnClock.ts).

export const resume_draft = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
        if (!session) {
            throw new SenderError('Draft session not found.');
        }

        ensureStageIs(lobby, 'Drafting');
        ensureMatchAlive(ctx, lobby);

        // Must be paused
        if (!session.timerState.isPaused) {
            throw new SenderError('Draft is not paused.');
        }

        const member = ensurePresentMember(ctx, lobbyId, user.id); // A98: present, not away or abandoned

        // Find the most recent Pause step to determine who paused and what timeRemaining was
        const allSteps = lobbySteps(ctx, lobbyId);
        const pauseSteps = allSteps
            .filter((s: any) => s.action.tag === 'Pause')
            .sort((a: any, b: any) => b.sequence - a.sequence);
        const lastPauseStep = pauseSteps[0];

        const isReferee = member.isReferee;
        const isAutoPause = lastPauseStep?.payload?.tag === 'Pause' && lastPauseStep.payload.value?.isAutoPause === true;
        if (isAutoPause) {
            // A85(2): the referee or a seated player (an away or abandoned row was already rejected by
            // ensurePresentMember, A98). A153 narrows the players to the team whose player's absence caused the pause:
            // the 15 s check records the dropped player's team in the Pause step's actorSlot (refereeTransfer.ts).
            if (!isReferee && !isSeatedPlayer(member)) {
                throw new SenderError('Only the referee or a seated player can resume an auto-paused draft.');
            }
            // A155: a seated player of the other team is refused even with the referee flag (the 15 s check can move
            // the flag to them); a flag holder who is a spectator, a coach or a player of the paused team resumes.
            if (isSeatedPlayer(member) && slotToTeamSide(member.lobbySlot).tag !== lastPauseStep.actorSlot.tag) {
                throw new SenderError('Only the paused team or a referee can resume this pause.');
            }
        } else {
            // D-62: referee OR the original pausing player can resume
            const isOriginalPauser =
                lastPauseStep && lastPauseStep.actorUserId === user.id;

            if (!isReferee && !isOriginalPauser) {
                throw new SenderError('Only the referee or the player who paused can resume the draft.');
            }
        }

        // S10f (F10): the frozen turn time and reserve run again from now (helpers/draft/turnClock.ts).
        const timeRemainingMs = lastPauseStep?.payload?.value?.timeRemainingMs;
        ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
            timerState: resumedTimerState(ctx, session.timerState),
        }, user.id));

        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(`[DRAFT] resume_draft: User #${user.id} resumed lobby #${lobbyId}. timeRemainingMs=${timeRemainingMs}`);
    }
);
