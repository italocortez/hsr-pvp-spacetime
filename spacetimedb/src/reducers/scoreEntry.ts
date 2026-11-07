import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { ensureNotConceded } from '../helpers/disconnectHelpers';
import { TeamSide } from '../types/enums';
import { groupCount, type LineupFormatTag } from '@shared/scoring';
import {
    ensureCaptainOrReferee,
    ensureGame,
    ensureTeamTag,
    findPendingResult,
    recomputeGame,
    replaceGame,
    resetConfirmations,
    teamSideValue,
} from '../helpers/scoringHelpers';

// A21, backlog #11: result entry per lineup group. record_game_scores (one winner picked by hand, fixed
// boss columns) is gone; the server computes every game's outcome from these inputs through @shared/scoring.

/** The game the scores belong to must be the one being played: tie-breaks 2 and 3 read that game's steps. */
function ensureCurrentGame(ctx: any, lobbyId: number, gameNumber: number): void {
    const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
    if (!session) throw new SenderError('Match session not found.');
    if (gameNumber !== session.currentGameNumber) {
        throw new SenderError(`Scores can only be entered for the current game (${session.currentGameNumber}).`);
    }
}

/** Input bound: group values and |adjustments| stay far below the u32 / i32 sums they feed (1,000,000.00 units). */
const MAX_SCORE_HUNDREDTHS = 100_000_000;

// ─── record_group_scores ─────────────────────────────────────────────────────
// One team's raw result per lineup group (cycles or points, hundredths) and its deaths for one game.
// Caller: the captain of that side, or a referee for either side. Upserts one MatchResultGroupScore row per
// group index, stores deaths on MatchResultGame.team{Blue,Red}Deaths, recomputes the game and resets both
// captains' score confirmations.

export const record_group_scores = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        gameNumber: t.u8(),
        teamSide: TeamSide,
        values: t.array(t.u32()),
        deaths: t.u8(),
        screenshotUrl: t.string().optional(),   // kept from record_game_scores: override_match_result needs both screenshots for Ranked
    },
    (ctx, { lobbyId, gameNumber, teamSide, values, deaths, screenshotUrl }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');
        const side = ensureTeamTag(teamSide);
        ensureCaptainOrReferee(ctx, lobbyId, user.id, side, 'record scores for that team');
        ensureNotConceded(ctx, lobby); // D-12 / F8: allowed in AwaitingResult, blocked after a concede
        const record = findPendingResult(ctx, lobbyId);
        ensureCurrentGame(ctx, lobbyId, gameNumber);

        const groups = groupCount(lobby.lineupFormat.tag as LineupFormatTag);
        if (values.length !== groups) {
            throw new SenderError(`A ${lobby.lineupFormat.tag} lineup has ${groups} group results; got ${values.length}.`);
        }
        if (values.some((v) => v > MAX_SCORE_HUNDREDTHS)) {
            throw new SenderError(`A group result cannot exceed ${MAX_SCORE_HUNDREDTHS} hundredths.`);
        }

        const existingRows = [...ctx.db.MatchResultGroupScore.by_result_game.filter([record.id, gameNumber])]
            .filter((r: any) => r.teamSide.tag === side);
        for (let groupIndex = 0; groupIndex < groups; groupIndex++) {
            const row = existingRows.find((r: any) => r.groupIndex === groupIndex);
            if (row) {
                ctx.db.MatchResultGroupScore.id.update(updateWithAudit(ctx, row, { value: values[groupIndex] }, user.id));
            } else {
                ctx.db.MatchResultGroupScore.insert(insertWithAudit(ctx, {
                    id: 0,
                    matchResultId: record.id,
                    gameNumber,
                    teamSide: teamSideValue(side),
                    groupIndex,
                    value: values[groupIndex],
                }, user.id));
            }
        }

        const game = ensureGame(ctx, record, lobby, gameNumber, user.id);
        const screenshot = screenshotUrl !== undefined && screenshotUrl.length > 0 ? screenshotUrl : undefined;
        if (screenshot && screenshot.length > 500) throw new SenderError('screenshotUrl cannot exceed 500 characters.');
        replaceGame(ctx, game, side === 'Blue'
            ? { teamBlueDeaths: deaths, ...(screenshot ? { teamBlueScreenshotUrl: screenshot } : {}) }
            : { teamRedDeaths: deaths, ...(screenshot ? { teamRedScreenshotUrl: screenshot } : {}) }, user.id);
        recomputeGame(ctx, record, lobby, gameNumber, user.id);
        resetConfirmations(ctx, record, user.id);

        console.log(`[MATCH] Game ${gameNumber} ${side} group scores recorded for match result #${record.id} by user #${user.id}`);
    }
);

// ─── set_score_adjustment ────────────────────────────────────────────────────
// A21 "additional score modifiers": an itemized, signed bonus or penalty (hundredths, in the mode's unit, added to
// the team's result as entered) for one team in one game. Caller: a lobby referee, a Moderator+, or in a tournament
// lobby the organizer or an assistant with canResolveResults (the A39 staff set). Reason optional (A55).
// Values are bounded to ±MAX_SCORE_HUNDREDTHS. Edit / delete semantics:
//   - adjustmentId omitted → a new entry (value 0 is rejected: it would change nothing);
//   - adjustmentId given, value ≠ 0 → that entry's value, team and reason are replaced;
//   - adjustmentId given, value = 0 → that entry is deleted.
// Every change recomputes the game and resets both captains' confirmations.

const MAX_REASON_LENGTH = 1000;

// A39 staff, the same set submit_match_result accepts: a lobby referee; Moderator+ anywhere; in a tournament lobby
// the organizer or an assistant with canResolveResults.
function ensureAdjustmentAuthority(ctx: any, lobby: any, user: any): void {
    const member = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobby.id, user.id])][0];
    if (member?.isReferee) return;
    if (isRoleAtLeast(user.role, 'Moderator')) return;
    if (lobby.isTournamentControlled && lobby.tournamentId !== undefined) {
        const tournament = ctx.db.Tournament.id.find(lobby.tournamentId);
        if (tournament && tournament.organizerId === user.id) return;
        const assistant = [...ctx.db.TournamentAssistant.by_tournament_and_user.filter([lobby.tournamentId, user.id])][0];
        if (assistant?.canResolveResults) return;
    }
    throw new SenderError('Only a referee, a Moderator or, in a tournament lobby, the organizer or a results assistant can set score adjustments.');
}

export const set_score_adjustment = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        gameNumber: t.u8(),
        teamSide: TeamSide,
        value: t.i32(),
        reason: t.string().optional(),
        adjustmentId: t.u32().optional(),
    },
    (ctx, { lobbyId, gameNumber, teamSide, value, reason, adjustmentId }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');
        const side = ensureTeamTag(teamSide);
        ensureAdjustmentAuthority(ctx, lobby, user);
        ensureNotConceded(ctx, lobby);
        const record = findPendingResult(ctx, lobbyId);
        ensureCurrentGame(ctx, lobbyId, gameNumber);

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
                gameNumber,
                teamSide: teamSideValue(side),
                value,
                reason: storedReason,
                setById: user.id,
            }, user.id));
        } else {
            const existing = ctx.db.MatchResultAdjustment.id.find(adjustmentId);
            if (!existing || existing.matchResultId !== record.id || existing.gameNumber !== gameNumber) {
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

        ensureGame(ctx, record, lobby, gameNumber, user.id);
        recomputeGame(ctx, record, lobby, gameNumber, user.id);
        resetConfirmations(ctx, record, user.id);

        console.log(`[MATCH] Adjustment ${value} (hundredths) for ${side}, game ${gameNumber}, match result #${record.id} by user #${user.id}`);
    }
);
