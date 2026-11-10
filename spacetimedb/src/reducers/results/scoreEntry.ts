import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensureNotConceded } from '@module/helpers/lobby/disconnectHelpers';
import { consumeResultEntryAllowance } from '@module/helpers/lobby/abuseControls';
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

/**
 * Results audit #7 (S10f): at most MAX_ADJUSTMENTS_PER_RECORD adjustment rows per result record (both teams together;
 * each row rides nested in every member's view_my_match_result_games row), and the sum of one team's adjustments stays
 * within ±MAX_SCORE_HUNDREDTHS, so the adjusted result (at most 3 groups × MAX_SCORE_HUNDREDTHS + the sum) fits the
 * i32 team*AdjustedResult columns. The value argument is an i32, so it is always a finite integer.
 */
const MAX_ADJUSTMENTS_PER_RECORD = 20;

/**
 * Results audit #7 (S10f): the per-user result-entry window (consumeResultEntryAllowance, abuseControls.ts: 30 writes
 * per fixed 10 s window) on the open-game path, for a caller with a LobbyMember row in the lobby. Staff outside the
 * lobby (Moderator+, tournament organizer or assistant) and the A60(7) Admin closed-game edit are not counted.
 */
function countResultEntry(ctx: any, lobbyId: number, userId: number, mode: 'open' | 'admin'): void {
    if (mode !== 'open') return;
    if ([...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, userId])][0]) consumeResultEntryAllowance(ctx, userId);
}

// ─── record_group_scores ─────────────────────────────────────────────────────
// One team's raw result per lineup group (cycles or points, hundredths) and its deaths for the record's game.
// Caller: the captain of that side, or a referee for either side. Upserts one MatchResultGroupScore row per
// group index, stores deaths on MatchResultGame.team{Blue,Red}Deaths, recomputes the game and resets both
// captains' confirmations of the game (A60(2)). No stage check. S10f: counted in the per-user result-entry window. A60(3): the game must be open; A60(7): an Admin may
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
        countResultEntry(ctx, lobbyId, user.id, mode);

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
// Values are bounded to ±MAX_SCORE_HUNDREDTHS, each team's sum after the call too (checked for the entry's team and,
// on an edit or a delete, the existing row's team; a delete ignores teamSide, review F2), and a record holds at most
// MAX_ADJUSTMENTS_PER_RECORD entries (S10f); a caller with a member row is counted in the result-entry window. Edit / delete semantics:
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
        countResultEntry(ctx, lobbyId, user.id, mode);

        if (Math.abs(value) > MAX_SCORE_HUNDREDTHS) {
            throw new SenderError(`An adjustment cannot exceed ${MAX_SCORE_HUNDREDTHS} hundredths either way.`);
        }
        // S10f (results audit #7): the per-record row cap (new entries only) and the per-team running sum, computed
        // on the rows as they will be after this call (an edited entry replaces its old value and may change team).
        const rows = [...ctx.db.MatchResultAdjustment.by_result.filter(record.id)];
        if (adjustmentId === undefined && rows.length >= MAX_ADJUSTMENTS_PER_RECORD) {
            throw new SenderError(`A game can carry at most ${MAX_ADJUSTMENTS_PER_RECORD} adjustments; edit or delete one first.`);
        }
        let existing: any = undefined;
        if (adjustmentId !== undefined) {
            existing = ctx.db.MatchResultAdjustment.id.find(adjustmentId);
            if (!existing || existing.matchResultId !== record.id) {
                throw new SenderError('Adjustment not found for this game.');
            }
        }
        // Review F2: the bound holds for every team whose sum this call changes: the entry's team after the call
        // (a delete keeps the existing row's team and ignores the teamSide argument) and, on an edit or a delete, the
        // existing row's team, which loses the old value.
        const isDelete = existing !== undefined && value === 0;
        const entrySide: 'Blue' | 'Red' = isDelete ? existing.teamSide.tag : side;
        const after = rows
            .filter((a: any) => a.id !== adjustmentId)
            .map((a: any) => ({ team: a.teamSide.tag as string, value: a.value as number }));
        if (!isDelete) after.push({ team: side, value });
        const touched = existing !== undefined && existing.teamSide.tag !== entrySide
            ? [entrySide, existing.teamSide.tag as 'Blue' | 'Red']
            : [entrySide];
        for (const team of touched) {
            const sum = after.filter((a) => a.team === team).reduce((s, a) => s + a.value, 0);
            if (Math.abs(sum) > MAX_SCORE_HUNDREDTHS) {
                throw new SenderError(`The ${team} adjustments cannot add up to more than ${MAX_SCORE_HUNDREDTHS} hundredths either way.`);
            }
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
            if (isDelete) {
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

        console.log(`[MATCH] Adjustment ${value} (hundredths) for ${entrySide}, match result #${record.id} by user #${user.id}`);
    }
);
