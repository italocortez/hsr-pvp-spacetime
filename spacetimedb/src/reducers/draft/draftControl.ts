import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensureLobbyMember, ensureStageIs, slotToTeamSide, isSeatedPlayer, memberHasLeft } from '@module/helpers/lobby/lobbyHelpers';
import { ensureMatchAlive } from '@module/helpers/lobby/disconnectHelpers';
import { lobbySteps, getNextSequence } from '@module/helpers/draft/stepSequence';

// ─── undo_last_step ───────────────────────────────────────────────────────────
// Undoes the last draft step.
// Per D-60: Referee only (when refereeCanUndo=true). Last step only.
// F9: "last step" = the highest-sequence Pick/Ban, never a Pause or Undo audit row; rejected while paused
// and during the auction phase. Decrements turnIndex, deletes that step, inserts an Undo record.

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

        ensureStageIs(lobby, 'Drafting');
        ensureMatchAlive(ctx, lobby);

        const member = ensureLobbyMember(ctx, lobbyId, user.id);

        // D-60: Only referees with refereeCanUndo permission
        if (!member.isReferee || !lobby.refereeCanUndo) {
            throw new SenderError('Only referees with undo permission can undo.');
        }

        // Validation: must have at least one step to undo
        if (session.turnIndex === 0) {
            throw new SenderError('No steps to undo.');
        }

        // F9: no undo while paused (the Pause step is not a draft action) and none during the auction
        // phase (undoing an AuctionSold would not restore budgets, won counts or the nomination).
        if (session.timerState.isPaused) {
            throw new SenderError('Nothing to undo right now.');
        }
        if (session.isAuctionPhase) {
            throw new SenderError('Undo is not available during the auction phase.');
        }

        // F9: the last *draft action* = the highest-sequence Pick or Ban; Pause / Undo audit rows are skipped.
        // A67(3): the lobby's one game.
        const allSteps = lobbySteps(ctx, lobbyId);
        const lastStep = allSteps
            .filter((s) => s.action.tag === 'Pick' || s.action.tag === 'Ban')
            .sort((a, b) => b.sequence - a.sequence)[0];
        if (!lastStep) {
            throw new SenderError('Nothing to undo in this game.');
        }

        // Delete the last step
        ctx.db.MatchSessionStep.id.delete(lastStep.id);

        // Insert an Undo audit record (F9: its own sequence, so it never collides with a draft step)
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            sequence: getNextSequence(ctx, lobbyId),
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

        // Decrement turnIndex (the undone Pick/Ban advanced it by one)
        const newTurnIndex = session.turnIndex - 1;

        ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
            turnIndex: newTurnIndex,
            timerState: {
                ...session.timerState,
                turnStartAt: ctx.timestamp,
                accumulatedPauseMs: 0,
            },
        }, user.id));

        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(`[DRAFT] undo_last_step: Referee #${user.id} undid ${lastStep.action.tag} step (sequence ${lastStep.sequence}) in lobby #${lobbyId}`);
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

        const member = ensureLobbyMember(ctx, lobbyId, user.id);

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

        // Calculate time remaining at point of pause
        const elapsedMicros =
            ctx.timestamp.microsSinceUnixEpoch -
            session.timerState.turnStartAt.microsSinceUnixEpoch;
        const elapsedMs = Number(elapsedMicros) / 1000;
        const timeRemainingMs = Math.max(
            0,
            lobby.standardTurnSeconds * 1000 - elapsedMs + session.timerState.accumulatedPauseMs
        );

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
                value: { timeRemainingMs: Math.round(timeRemainingMs), isAutoPause: false },
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
            timerState: {
                ...session.timerState,
                isPaused: true,
            },
            pausesUsedBlue: newPausesBlue,
            pausesUsedRed: newPausesRed,
        }, user.id));

        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(`[DRAFT] pause_draft: User #${user.id} paused lobby #${lobbyId}. timeRemainingMs=${Math.round(timeRemainingMs)}`);
    }
);

// ─── resume_draft ─────────────────────────────────────────────────────────────
// Resumes a paused draft.
// Per D-62: referee OR the original pausing player can resume a manual pause.
// A85(2): an auto-pause (disconnect) is resumed by the referee or any seated player of either team; coaches and
// spectators without the referee flag are rejected.
// Sets accumulatedPauseMs to the timeRemainingMs stored in the Pause step so the
// clock continues from where it was paused.

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

        const member = ensureLobbyMember(ctx, lobbyId, user.id);

        // Find the most recent Pause step to determine who paused and what timeRemaining was
        const allSteps = lobbySteps(ctx, lobbyId);
        const pauseSteps = allSteps
            .filter((s: any) => s.action.tag === 'Pause')
            .sort((a: any, b: any) => b.sequence - a.sequence);
        const lastPauseStep = pauseSteps[0];

        const isReferee = member.isReferee;
        const isAutoPause = lastPauseStep?.payload?.tag === 'Pause' && lastPauseStep.payload.value?.isAutoPause === true;
        if (isAutoPause) {
            // A85(2): the referee or any seated player of either team; a seated row that is away or abandoned is not
            if (!isReferee && !(isSeatedPlayer(member) && !memberHasLeft(member))) {
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

        // Restore timeRemainingMs from the Pause step
        const timeRemainingMs =
            lastPauseStep && lastPauseStep.payload.tag === 'Pause'
                ? lastPauseStep.payload.value.timeRemainingMs
                : lobby.standardTurnSeconds * 1000;

        ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
            timerState: {
                ...session.timerState,
                isPaused: false,
                turnStartAt: ctx.timestamp,
                accumulatedPauseMs: timeRemainingMs,
            },
        }, user.id));

        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, user.id));

        console.log(`[DRAFT] resume_draft: User #${user.id} resumed lobby #${lobbyId}. timeRemainingMs=${timeRemainingMs}`);
    }
);
