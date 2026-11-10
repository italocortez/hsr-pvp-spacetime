import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensurePresentMember, ensureStageIs, slotToTeamSide, isSeatedPlayer, slotIsCoach } from '@module/helpers/lobby/lobbyHelpers';
import { ensureMatchAlive } from '@module/helpers/lobby/disconnectHelpers';
import { lobbySteps, getNextSequence, ensurePauseInterval, ensureUndoStepRoom } from '@module/helpers/draft/stepSequence';
import { pausedTimerState, resumedTimerState, turnBudgetMs, turnFullMs } from '@module/helpers/draft/turnClock';
import { otherTeamTag, teamIsFull } from './draftAuction';

// ─── undo_last_step ───────────────────────────────────────────────────────────
// S10t (A127, A132): removes the last character step of the lobby's game (A67(3)) and restores the state before it, one
// step per call, in every draft mode and phase, while the lobby stage is Drafting. Per D-60: referee only
// (refereeCanUndo), A98: present. Rejected while paused ("Nothing to undo right now."). Supersedes the S4 F9
// auction-phase refusal and the window ends of A122(9), A123 and A125.
//
// "Last step" = the highest-sequence character step (UNDOABLE_TAGS): Ban, Pick, Nominate, Bid, AuctionSold. A132: an
// eidolon selection (SetEidolon, written by set_eidolon during Drafting once the character is drafted, A60(1)) is not a
// step of its own for undo: it is never the target and never blocks one, even when it is the most recent step. Pause
// and Undo rows are skipped and kept as before. No other step kind exists during Drafting.
//
// What each undo restores (the step row is deleted in every case):
// - Ban / Pick (ban_character, pick_character, timer_expiry_classic): turnIndex - 1; isAuctionPhase false when it was
//   set (the last ban of the Auction ban phase opened it); fresh turn clock. A132: a Pick also takes with it every
//   SetEidolon step of the picking side on that character made after it (Classic edits move no budget).
// - Nominate (nominate_character, the timer's EMPTY nomination): no open nomination (currentNomination and
//   currentBidAmount unset, currentBidTeam Spectator); fresh turn for the nominator. nextNominatorTeam was not moved.
// - Bid (place_bid): currentBidAmount = Bid.previousAmount, currentBidTeam = the other team (bids alternate, D-48);
//   fresh turn clock.
// - AuctionSold (pass_bid, the timer's sale, the A81(2) immediate sale): A132: the sale and every SetEidolon step of
//   the winner on that character after it are removed, and the winner's budgets get back exactly what they cost, per
//   budget: the sale's charCharged / lcCharged plus each removed edit's charCharged / lcCharged (a lowering edit's
//   negative values take its refund back). Edits on other characters keep their charges, even when made after this
//   sale. The winner's won count - 1; nextNominatorTeam = the nominating team (the nomination's Nominate step: a
//   nomination never moves nextNominatorTeam and the nominator is always the team whose turn it was); fresh turn clock.
//   A sale by pass or by the timer: the nomination comes back open as it stood before the sale (currentNomination = the
//   character, currentBidAmount = winningAmount, currentBidTeam = winningTeam), the Nominate and Bid steps stay. The
//   A81(2) immediate sale (the team other than the nominator was full before the sale: the nomination and the sale were
//   written in one call) removes the Nominate step too and returns to "no nomination, same nominator": an open
//   nomination facing a full team is a state no reducer produces. The last sale of the auction is always such a sale.
//   S10t (A129): the last sale (and the last Classic pick) leaves the lobby in Drafting with the draft complete and no
//   roll-over, so it is undone like any other: the turn it ended reopens with a fresh clock. The D-50 roll-over
//   happens only at finishDraft, after which undo is refused (the draft is finished).
// Every undo inserts exactly one Undo row (originalSequenceId = the undone pick / ban / nomination / bid / sale), counted
// by the 300-row cap (A122(10), ensureUndoStepRoom), and stamps Lobby.lastActivityAt; removed SetEidolon steps add no
// Undo row and free their slots in the per-side edit cap (ensureEditStepRoom counts live steps). The A117 re-roll keys on
// the next sequence, which the Undo row raises. Not restored: the editors' lineup throttle stamps (LobbyMember.lastLineupAt);
// no lineup or game row exists during Drafting, so an edit's refresh / recompute was a no-op.

const UNDOABLE_TAGS = new Set(['Ban', 'Pick', 'Nominate', 'Bid', 'AuctionSold']);

export const undoFinishedText = 'The draft is finished: undo works only while the lobby is in the draft stage.';

const freshTurn = (ctx: any, session: any) => ({
    ...session.timerState,
    turnStartAt: ctx.timestamp,
    accumulatedPauseMs: 0,
});

const noNomination = {
    currentNomination: undefined,
    currentBidAmount: undefined,
    currentBidTeam: { tag: 'Spectator', value: {} } as any,
};

/** S10t review 2 G2: the text of the one refusal inside the draft (see the Bid branch of undo_last_step). */
export const bidUndoUnbackedText = 'Cannot undo this bid: the previous bidder can no longer cover their bid.';

/**
 * S10t review 2 G1: the winner's budgets after a sale undo, never below 0. A lowering edit refunds to the light-cone
 * budget; if the team spent that refund elsewhere, taking it back would leave the light-cone budget negative (and a
 * later chargeExtra clamp would turn that into budget). The shortfall is moved to the character budget and 0 stored, so
 * the total is unchanged and no value is dropped. The mirror case is handled the same way for completeness: every
 * amount given back to the character budget was taken from it (charCharged >= 0), so it cannot go negative here.
 */
function restoredBudgets(side: 'Blue' | 'Red', charBudget: number, lcBudget: number): Record<string, number> {
    let char = charBudget;
    let lc = lcBudget;
    if (lc < 0) { char += lc; lc = 0; }
    if (char < 0) { lc += char; char = 0; }
    return side === 'Blue' ? { teamBlueCharBudget: char, teamBlueLcBudget: lc } : { teamRedCharBudget: char, teamRedLcBudget: lc };
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

        if (tag === 'Ban' || tag === 'Pick') {
            // A132: a pick goes with the picking side's eidolon selections on that character.
            if (tag === 'Pick') {
                removed.push(...eidolonEditsOf(allSteps, lastStep.actorSlot.tag, lastStep.payload.value.characterName, lastStep.sequence));
            }
            changes = {
                turnIndex: session.turnIndex - 1,
                ...(session.isAuctionPhase ? { isAuctionPhase: false } : {}),
                timerState: freshTurn(ctx, session),
            };
        } else if (tag === 'Nominate') {
            // Defensive: a Nominate as the last step always has its nomination open (a sale writes a later step).
            if (session.currentNomination === undefined) throw new SenderError('The draft state does not match its steps; undo refused.');
            changes = { ...noNomination, timerState: freshTurn(ctx, session) };
        } else if (tag === 'Bid') {
            const bidder = lastStep.actorSlot.tag;
            const previousHolder = otherTeamTag(bidder);
            const previousAmount: number = lastStep.payload.value.previousAmount;
            // S10t review 2 G2: the one refusal inside the draft. A team that was outbid may spend its character budget on
            // an eidolon raise (set_eidolon reserves the bid only for the holder) and A132 does not walk that edit back,
            // so the previous bidder may no longer cover its bid. Restoring such a hold would leave a bid that no sale can
            // settle (resolveSale refuses it); the referee can let the bid stand instead.
            const holderCharBudget = previousHolder === 'Blue' ? session.teamBlueCharBudget : session.teamRedCharBudget;
            if (holderCharBudget < previousAmount) {
                throw new SenderError(bidUndoUnbackedText);
            }
            changes = {
                currentBidAmount: previousAmount,
                currentBidTeam: { tag: previousHolder, value: {} } as any,
                timerState: freshTurn(ctx, session),
            };
        } else {
            // AuctionSold
            const sold = lastStep.payload.value;
            const winner: string = sold.winningTeam.tag;
            const nominateStep = allSteps
                .filter((s) => s.action.tag === 'Nominate' && s.sequence < lastStep.sequence)
                .sort((a, b) => b.sequence - a.sequence)[0];
            if (!nominateStep) throw new SenderError('The draft state does not match its steps; undo refused.');
            const nominator: string = nominateStep.actorSlot.tag;
            const before = {
                blueCharactersWon: session.blueCharactersWon - (winner === 'Blue' ? 1 : 0),
                redCharactersWon: session.redCharactersWon - (winner === 'Red' ? 1 : 0),
            };
            // A81(2): the nomination sold at once because the other team was already full; won counts move only at a
            // sale, so this test is exact.
            const immediate = teamIsFull(before, lobby, otherTeamTag(nominator));
            if (immediate) removed.push(nominateStep);
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
                ...(immediate
                    ? noNomination
                    : { currentNomination: sold.characterName, currentBidAmount: sold.winningAmount, currentBidTeam: sold.winningTeam }),
                ...(winner === 'Blue' ? restoredBudgets('Blue', session.teamBlueCharBudget + charBack, session.teamBlueLcBudget + lcBack) : {}),
                ...(winner === 'Red' ? restoredBudgets('Red', session.teamRedCharBudget + charBack, session.teamRedLcBudget + lcBack) : {}),
                ...before,
                nextNominatorTeam: nominateStep.actorSlot,
                timerState: freshTurn(ctx, session),
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

        // S10f (F10): freeze the clock at the time left in the turn (helpers/draft/turnClock.ts).
        const paused = pausedTimerState(ctx, lobby, session.timerState, turnFullMs(lobby, session)); // A130: holds the confirm window too
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
// A85(2): an auto-pause (disconnect) is resumed by the referee or any seated player of either team; coaches and
// spectators without the referee flag are rejected.
// S10f (F10): the pause froze the time left in accumulatedPauseMs (equal to the Pause step's timeRemainingMs);
// the resume sets turnStartAt = now and keeps it, so the clock continues from where it was paused (turnClock.ts).

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
            // A85(2): the referee or any seated player of either team (an away or abandoned row was already rejected by
            // ensurePresentMember, A98)
            if (!isReferee && !isSeatedPlayer(member)) {
                throw new SenderError('Only the referee or a seated player can resume an auto-paused draft.');
            }
        } else {
            // D-62: referee OR the original pausing player can resume
            const isOriginalPauser =
                lastPauseStep && lastPauseStep.actorUserId === user.id;

            if (!isReferee && !isOriginalPauser) {
                throw new SenderError('Only the referee or the player who paused can resume the draft.');
            }
        }

        // S10f (F10): the pause froze the remaining time in accumulatedPauseMs; it runs again from now
        // (helpers/draft/turnClock.ts, the same write as liftAutoPauseOnReturn).
        const timeRemainingMs = turnBudgetMs(lobby, session.timerState, turnFullMs(lobby, session));
        ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
            timerState: resumedTimerState(ctx, session.timerState),
        }, user.id));

        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(`[DRAFT] resume_draft: User #${user.id} resumed lobby #${lobbyId}. timeRemainingMs=${timeRemainingMs}`);
    }
);
