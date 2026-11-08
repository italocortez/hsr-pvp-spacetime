import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensureNotConceded } from '@module/helpers/lobby/disconnectHelpers';
import { TeamSide } from '@module/types/enums';
import { groupCount, type LineupFormatTag } from '@shared/scoring';
import {
    ensureCaptainOrReferee,
    ensureGame,
    ensureOpenGame,
    ensureResultAuthority,
    ensureTeamTag,
    findEditableResult,
    findGame,
    isAdminRole,
    recomputeGame,
    replaceGame,
    resetConfirmations,
    teamSideValue,
} from '@module/helpers/results/scoringHelpers';
import { recomputeAfterAdminEdit } from '@module/helpers/results/gameClose';

// A21, backlog #11: result entry per lineup group. record_game_scores (one winner picked by hand, fixed
// boss columns) is gone; the server computes every game's outcome from these inputs through @shared/scoring.
// A67(3): one game per record, so neither reducer takes a game number. The edit rule (formerly ensureEditableGame)
// is ensureOpenGame's: the record's game is open, or the caller is an Admin and the record is not yet validated
// (Pending or Submitted, A60(7), A69(2)); the status rejections are findEditableResult's.

/** Input bound: group values and |adjustments| stay far below the u32 / i32 sums they feed (1,000,000.00 units). */
const MAX_SCORE_HUNDREDTHS = 100_000_000;

// ─── record_group_scores ─────────────────────────────────────────────────────
// One team's raw result per lineup group (cycles or points, hundredths) and its deaths for the record's game.
// Caller: the captain of that side, or a referee for either side. Upserts one MatchResultGroupScore row per
// group index, stores deaths on MatchResultGame.team{Blue,Red}Deaths, recomputes the game and resets both
// captains' confirmations of the game (A60(2)). No stage check. A60(3): the game must be open; A60(7): an Admin may
// edit a closed game while the record is Pending or Submitted (no reset; recomputeAfterAdminEdit).

export const record_group_scores = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        teamSide: TeamSide,
        values: t.array(t.u32()),
        deaths: t.u8(),
        screenshotUrl: t.string().optional(),   // kept from record_game_scores: override_match_result needs both screenshots for Ranked
    },
    (ctx, { lobbyId, teamSide, values, deaths, screenshotUrl }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');
        const side = ensureTeamTag(teamSide);
        const admin = isAdminRole(user);
        if (!admin) ensureCaptainOrReferee(ctx, lobbyId, user.id, side, 'record scores for that team');
        ensureNotConceded(ctx, lobby); // D-12 / F8: allowed in AwaitingResult, blocked after a concede
        const record = findEditableResult(ctx, lobbyId, user);
        const mode = ensureOpenGame(ctx, lobby, record, user);
        if (mode === 'open' && admin) ensureCaptainOrReferee(ctx, lobbyId, user.id, side, 'record scores for that team');

        const groups = groupCount(lobby.lineupFormat.tag as LineupFormatTag);
        if (values.length !== groups) {
            throw new SenderError(`A ${lobby.lineupFormat.tag} lineup has ${groups} group results; got ${values.length}.`);
        }
        if (values.some((v) => v > MAX_SCORE_HUNDREDTHS)) {
            throw new SenderError(`A group result cannot exceed ${MAX_SCORE_HUNDREDTHS} hundredths.`);
        }

        const existingRows = [...ctx.db.MatchResultGroupScore.by_result.filter(record.id)]
            .filter((r: any) => r.teamSide.tag === side);
        for (let groupIndex = 0; groupIndex < groups; groupIndex++) {
            const row = existingRows.find((r: any) => r.groupIndex === groupIndex);
            if (row) {
                ctx.db.MatchResultGroupScore.id.update(updateWithAudit(ctx, row, { value: values[groupIndex] }, user.id));
            } else {
                ctx.db.MatchResultGroupScore.insert(insertWithAudit(ctx, {
                    id: 0,
                    matchResultId: record.id,
                    teamSide: teamSideValue(side),
                    groupIndex,
                    value: values[groupIndex],
                }, user.id));
            }
        }

        const game = ensureGame(ctx, record, lobby, user.id);
        const screenshot = screenshotUrl !== undefined && screenshotUrl.length > 0 ? screenshotUrl : undefined;
        if (screenshot && screenshot.length > 500) throw new SenderError('screenshotUrl cannot exceed 500 characters.');
        replaceGame(ctx, game, side === 'Blue'
            ? { teamBlueDeaths: deaths, ...(screenshot ? { teamBlueScreenshotUrl: screenshot } : {}) }
            : { teamRedDeaths: deaths, ...(screenshot ? { teamRedScreenshotUrl: screenshot } : {}) }, user.id);
        if (mode === 'admin') {
            recomputeAfterAdminEdit(ctx, lobby, record, user.id);
        } else {
            recomputeGame(ctx, record, lobby, user.id);
            resetConfirmations(ctx, findGame(ctx, record.id), user.id);
        }

        console.log(`[MATCH] ${side} group scores recorded for match result #${record.id} by user #${user.id}`);
    }
);

// ─── set_score_adjustment ────────────────────────────────────────────────────
// A21 "additional score modifiers": an itemized, signed bonus or penalty (hundredths, in the mode's unit, added to
// the team's result as entered) for one team in the record's game. Caller: a lobby referee, a Moderator+, or in a tournament
// lobby the organizer or an assistant with canResolveResults (the A39 staff set). Reason optional (A55).
// Values are bounded to ±MAX_SCORE_HUNDREDTHS. Edit / delete semantics:
//   - adjustmentId omitted → a new entry (value 0 is rejected: it would change nothing);
//   - adjustmentId given, value ≠ 0 → that entry's value, team and reason are replaced;
//   - adjustmentId given, value = 0 → that entry is deleted.
// Every change recomputes the game and resets both captains' confirmations of the game (A60(2)); open game only
// (A60(3)), except an Admin's edit of a closed game (A60(7): no reset, recomputeAfterAdminEdit).

const MAX_REASON_LENGTH = 1000;

export const set_score_adjustment = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        teamSide: TeamSide,
        value: t.i32(),
        reason: t.string().optional(),
        adjustmentId: t.u32().optional(),
    },
    (ctx, { lobbyId, teamSide, value, reason, adjustmentId }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');
        const side = ensureTeamTag(teamSide);
        // A39 staff set (ensureResultAuthority, shared with close_game)
        ensureResultAuthority(ctx, lobby, user, 'Only a referee, a Moderator or, in a tournament lobby, the organizer or a results assistant can set score adjustments.');
        ensureNotConceded(ctx, lobby);
        const record = findEditableResult(ctx, lobbyId, user);
        const mode = ensureOpenGame(ctx, lobby, record, user);

        if (Math.abs(value) > MAX_SCORE_HUNDREDTHS) {
            throw new SenderError(`An adjustment cannot exceed ${MAX_SCORE_HUNDREDTHS} hundredths either way.`);
        }
        const trimmed = reason?.trim();
        if (trimmed && trimmed.length > MAX_REASON_LENGTH) {
            throw new SenderError(`Reason cannot exceed ${MAX_REASON_LENGTH} characters.`);
        }
        const storedReason = trimmed ? trimmed : undefined;

        if (adjustmentId === undefined) {
            if (value === 0) throw new SenderError('An adjustment of 0 changes nothing.');
            ctx.db.MatchResultAdjustment.insert(insertWithAudit(ctx, {
                id: 0,
                matchResultId: record.id,
                teamSide: teamSideValue(side),
                value,
                reason: storedReason,
                setById: user.id,
            }, user.id));
        } else {
            const existing = ctx.db.MatchResultAdjustment.id.find(adjustmentId);
            if (!existing || existing.matchResultId !== record.id) {
                throw new SenderError('Adjustment not found for this game.');
            }
            if (value === 0) {
                ctx.db.MatchResultAdjustment.id.delete(adjustmentId);
            } else {
                ctx.db.MatchResultAdjustment.id.update(updateWithAudit(ctx, existing, {
                    teamSide: teamSideValue(side),
                    value,
                    reason: storedReason,
                    setById: user.id,
                }, user.id));
            }
        }

        ensureGame(ctx, record, lobby, user.id);
        if (mode === 'admin') {
            recomputeAfterAdminEdit(ctx, lobby, record, user.id);
        } else {
            recomputeGame(ctx, record, lobby, user.id);
            resetConfirmations(ctx, findGame(ctx, record.id), user.id);
        }

        console.log(`[MATCH] Adjustment ${value} (hundredths) for ${side}, match result #${record.id} by user #${user.id}`);
    }
);
