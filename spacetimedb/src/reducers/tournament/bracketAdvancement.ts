import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { generateDoubleElim, generateSingleElim } from '@shared/bracket';
import { ensureTournamentPermission } from '@module/helpers/tournament/tournamentPermissions';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { deleteCalendarEventForBracketMatch } from '@module/helpers/calendar/calendarCascade';
import { insertBracket } from '@module/helpers/tournament/bracketStore';
import { applyBracketResult, matchGames, rollbackBracketResult } from '@module/helpers/tournament/bracketResults';
import { qualifiersFor } from '@module/helpers/tournament/tournamentStandings';
import { voidMatchLobbies } from '@module/helpers/tournament/tournamentResults';

// ─── Group advancement and staff corrections (A23, A24(1)(3), A25, A26, A30, A38(1), D.8.3, T7, T11; S8c) ──
// advance_group_to_elimination, advance_bracket_match, submit_and_advance_bracket and admin_set_bracket_winner
// are deleted (A23): every result reaches the bracket through `applyBracketResult` (the single writer of
// BracketMatch.winnerTeamId, besides the structural walkovers of `bracketStore.settle`) and every correction
// through `rollbackBracketResult`.

const unit = (tag: string) => ({ tag, value: {} }) as any;
const MAX_REASON = 1000;

function normalizeReason(reason: string): string {
    const trimmed = reason.trim();
    if (trimmed.length > MAX_REASON) throw new SenderError(`Reason must be at most ${MAX_REASON} characters.`);
    return trimmed;
}

/** `results` permission on the match's tournament, which must be InProgress. */
function ensureResultsMatch(ctx: any, bracketMatchId: number): { user: any; tournament: any; match: any } {
    const match = ctx.db.BracketMatch.id.find(bracketMatchId);
    if (!match) throw new SenderError('Bracket match not found.');
    const { user, tournament } = ensureTournamentPermission(ctx, match.tournamentId, 'results');
    if (tournament.stage.tag !== 'InProgress') throw new SenderError('Tournament is not in progress.');
    return { user, tournament, match };
}

// ─── advance_group_stage ──────────────────────────────────────────────────────
// `bracket`; InProgress; GroupIntoSingleElim / GroupIntoDoubleElim. Every group match settled, no elimination
// row yet. Qualifiers = qualifiersFor (A30 ranking, status-gated per A26, review T7 placement); the elimination
// bracket is generated over them like generate_bracket does (A27, A29). Group teams that did not qualify and
// are still Active become Eliminated.

export const advance_group_stage = spacetimedb.reducer(
    { tournamentId: t.u32() },
    (ctx, { tournamentId }) => {
        const { user, tournament } = ensureTournamentPermission(ctx, tournamentId, 'bracket');
        if (tournament.stage.tag !== 'InProgress') throw new SenderError('Tournament is not in progress.');
        const formatTag = tournament.format.tag as string;
        if (formatTag === 'GroupOnly') {
            // GroupOnly has no elimination stage; placements come from the standings at the Completed transition (S8d).
            throw new SenderError('A group-only tournament has no elimination stage.');
        }
        if (formatTag !== 'GroupIntoSingleElim' && formatTag !== 'GroupIntoDoubleElim') {
            throw new SenderError('This tournament has no group stage.');
        }
        if (tournament.groupAdvanceCount < 1 || tournament.groupAdvanceCount > 2) {
            throw new SenderError('groupAdvanceCount must be 1 or 2.');
        }

        const rows = [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)];
        const groupRows = rows.filter((m: any) => m.bracketSide.tag === 'Group');
        if (groupRows.length === 0) throw new SenderError('Generate the bracket first.');
        // The grand final key 'GF' starts with G too: the side, not the key prefix, tells group rows apart.
        if (rows.some((m: any) => m.bracketSide.tag !== 'Group')) throw new SenderError('The elimination bracket already exists.');
        const open = groupRows.filter((m: any) => m.state.tag !== 'Decided' && m.state.tag !== 'Walkover' && m.state.tag !== 'Void');
        if (open.length > 0) throw new SenderError(`${open.length} group match(es) are not settled.`);

        const qualifiers = qualifiersFor(ctx, tournamentId, tournament.groupAdvanceCount);
        if (qualifiers.length < 2) throw new SenderError('At least 2 teams must qualify.');
        if (tournament.has3rdPlaceMatch && formatTag !== 'GroupIntoSingleElim') {
            throw new SenderError('A third-place match exists only in single elimination.');
        }
        const spec = formatTag === 'GroupIntoSingleElim'
            ? generateSingleElim(qualifiers.length, { thirdPlace: tournament.has3rdPlaceMatch })
            : generateDoubleElim(qualifiers.length, { winnerAdvantage: tournament.winnerAdvantage });
        insertBracket(ctx, tournament, spec, qualifiers, user.id);

        const qualified = new Set(qualifiers);
        for (const team of [...ctx.db.TournamentTeam.tournament_id.filter(tournamentId)]) {
            if (team.groupId !== undefined && team.status.tag === 'Active' && !qualified.has(team.id)) {
                ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { status: unit('Eliminated') }, user.id));
            }
        }

        console.log(`[BRACKET] advance_group_stage: ${qualifiers.length} teams placed in the elimination bracket of tournament #${tournamentId}`);
    }
);

// ─── resolve_bracket_match ────────────────────────────────────────────────────
// `results`; InProgress. Staff walkover or correction (A24(3), TD-13): a Ready match is decided for
// `winnerTeamId`; a Decided match with another winner is rolled back first (refused while anything downstream
// is Decided) and then decided again; the same winner again is a no-op. decidedBy Staff. `reason` has no column: it goes to the
// log and the actor to the audit columns (lastModifiedById). Replaces admin_set_bracket_winner.
// A67(4)(8), A24(3), D.8.3: every Validated game record of the match is kept (its lobby stays parked and is finalized
// at Completed), the rollback of a Decided match voids nothing; only the unsettled lobbies of the match (Waiting or
// playing, or a Pending / Submitted / Disputed record) are voided (voidMatchLobbies). The staff result is applied
// with the current derived tally (matchGames: head start + Validated games).

export const resolve_bracket_match = spacetimedb.reducer(
    { bracketMatchId: t.u32(), winnerTeamId: t.u32(), reason: t.string() },
    (ctx, { bracketMatchId, winnerTeamId, reason }) => {
        const { user, match } = ensureResultsMatch(ctx, bracketMatchId);
        const why = normalizeReason(reason);
        if (match.state.tag !== 'Ready' && match.state.tag !== 'Decided') {
            throw new SenderError(`${match.positionKey} is ${match.state.tag}; only a Ready or Decided match can be resolved.`);
        }
        if (winnerTeamId !== match.team1Id && winnerTeamId !== match.team2Id) {
            throw new SenderError(`Team ${winnerTeamId} does not play ${match.positionKey}.`);
        }
        if (match.state.tag === 'Decided' && match.winnerTeamId === winnerTeamId) {
            console.log(`[BRACKET] resolve_bracket_match: ${match.positionKey} (#${bracketMatchId}) already decided for team #${winnerTeamId}; no change.`);
            return;
        }

        if (match.state.tag === 'Decided') rollbackBracketResult(ctx, bracketMatchId, user.id, false, false); // A67(8): keep every game; staff decide below
        else deleteCalendarEventForBracketMatch(ctx, bracketMatchId); // D-22: a Ready match settled by staff
        voidMatchLobbies(ctx, bracketMatchId, user.id); // A67(8): unsettled lobbies only
        applyBracketResult(ctx, bracketMatchId, winnerTeamId, 'Staff',
            matchGames(ctx, ctx.db.BracketMatch.id.find(bracketMatchId)), user.id);

        console.log(`[BRACKET] resolve_bracket_match: ${match.positionKey} (#${bracketMatchId}) → team #${winnerTeamId} by user #${user.id}. Reason: ${why}`);
    }
);

// ─── rollback_bracket_match ───────────────────────────────────────────────────
// `results`; InProgress; the match Decided. Reverts it through rollbackBracketResult (A24(3)): refused while a
// downstream match is Decided ("roll that back first"); the match returns to Ready, the loser is un-eliminated.
// The match's calendar event is deleted as before (D-22). `reason`: log only (no column).
// A67(4), A24(3), D.8.3: a match decided by play voids its deciding record only (marked Voided and kept for audit
// until the finalize job deletes it; its lobby hard-deleted so a replay lobby can be made); earlier Validated games
// stay and the tally is recomputed from them. Any unsettled lobby of the match is voided too (voidMatchLobbies).

export const rollback_bracket_match = spacetimedb.reducer(
    { bracketMatchId: t.u32(), reason: t.string() },
    (ctx, { bracketMatchId, reason }) => {
        const { user, match } = ensureResultsMatch(ctx, bracketMatchId);
        const why = normalizeReason(reason);
        if (match.state.tag !== 'Decided') {
            throw new SenderError(`${match.positionKey} is ${match.state.tag}; only a decided match can be rolled back.`);
        }

        rollbackBracketResult(ctx, bracketMatchId, user.id);
        deleteCalendarEventForBracketMatch(ctx, bracketMatchId);
        voidMatchLobbies(ctx, bracketMatchId, user.id); // A24(3); A67(8): unsettled lobbies only

        console.log(`[BRACKET] rollback_bracket_match: ${match.positionKey} (#${bracketMatchId}) rolled back by user #${user.id}. Reason: ${why}`);
    }
);
