// ─── Tournament account locks and "has played" (A26a(4), D-21, A104) ─────────────────────────────────────────
// Moved out of tournamentHelpers.ts in S10v (unchanged): a leaf module (no import of the tournament helpers) so
// helpers/tournament/standIns.ts can use it from the bracket writers without an import cycle. tournamentHelpers.ts
// re-exports both functions.

import { SenderError } from 'spacetimedb/server';
import { insertWithAudit } from '@module/helpers/admin/auditHelpers';

function findMembership(ctx: any, tournamentId: number, userId: number): any {
    return [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([tournamentId, userId])][0];
}

/**
 * A26a(4) / D-21: locks the player's HSR accounts for the tournament (at registration for non-waitlisted players,
 * at promotion for waitlisted ones). `accountIds` omitted = every account the player owns (the pre-S8b behaviour);
 * given = those accounts, which must be the player's own. Existing locks are kept (idempotent).
 */
export function lockPlayerAccounts(ctx: any, tournamentId: number, userId: number, accountIds: number[] | undefined, actorId: number): void {
    const owned = [...ctx.db.HsrAccount.user_id.filter(userId)];
    let ids: number[];
    if (accountIds === undefined) {
        ids = owned.map((a: any) => a.id);
    } else {
        const ownedIds = new Set(owned.map((a: any) => a.id));
        ids = [...new Set(accountIds)];
        for (const id of ids) {
            if (!ownedIds.has(id)) throw new SenderError(`HSR account #${id} is not one of your accounts.`);
        }
    }
    const locked = new Set([...ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournamentId, userId])]
        .map((tpa: any) => tpa.hsrAccountId));
    for (const id of ids) {
        if (locked.has(id)) continue;
        ctx.db.TournamentPlayerAccount.insert(insertWithAudit(ctx, { tournamentId, userId, hsrAccountId: id }, actorId));
    }
}

/** True when the bracket match exists and belongs to the tournament. */
function isMatchOfTournament(ctx: any, bracketMatchId: number | undefined, tournamentId: number): boolean {
    if (bracketMatchId === undefined) return false;
    const match = ctx.db.BracketMatch.id.find(bracketMatchId);
    return !!match && match.tournamentId === tournamentId;
}

/**
 * A104: "their first game of the tournament has started" is the player's own game (S10g review F3), not the team's.
 * True when:
 * 1. the player is a participant of a result record of one of the tournament's bracket matches (start_draft writes a
 *    MatchResultParticipant row for every non-coach Blue / Red member and creates the record, A54), or
 * 2. the player sits in a player seat (non-coach Blue / Red) of a lobby of such a match that is past Waiting, or
 * 3. a Voided record of a bracket match on which the player's team played (slot 1 or 2, or its recorded winner /
 *    loser) has no participant rows left. Voiding (voidTournamentLobby → hardDeleteLobby) keeps the record for audit
 *    until the finalize job but deletes its participant and member rows, so who sat in that game is no longer known:
 *    a voided or rolled-back game counts for every member of the team (conservative; a member who sat out only a
 *    voided game is treated as having played it).
 * A team member who sat out the team's games otherwise has played nothing.
 */
export function hasPlayedTournamentGame(ctx: any, tournamentId: number, userId: number): boolean {
    for (const participant of ctx.db.MatchResultParticipant.user_id.filter(userId)) {
        const record = ctx.db.MatchResultRecord.id.find(participant.matchResultId);
        if (record && isMatchOfTournament(ctx, record.bracketMatchId, tournamentId)) return true;
    }
    for (const member of ctx.db.LobbyMember.user_id.filter(userId)) {
        const tag: string = member.lobbySlot.tag;
        if (tag !== 'BluePlayer' && tag !== 'RedPlayer') continue;
        const lobby = ctx.db.Lobby.id.find(member.lobbyId);
        if (!lobby || lobby.stage.tag === 'Waiting') continue;
        if (isMatchOfTournament(ctx, lobby.bracketMatchId, tournamentId)) return true;
    }
    const teamId = findMembership(ctx, tournamentId, userId)?.teamId;
    if (teamId === undefined) return false;
    for (const match of ctx.db.BracketMatch.tournament_id.filter(tournamentId)) {
        if (match.team1Id !== teamId && match.team2Id !== teamId && match.winnerTeamId !== teamId && match.loserTeamId !== teamId) continue;
        for (const record of ctx.db.MatchResultRecord.bracket_match_id.filter(match.id)) {
            if (record.status.tag !== 'Voided') continue;
            let hasParticipants = false;
            for (const _ of ctx.db.MatchResultParticipant.match_result_id.filter(record.id)) { hasParticipants = true; break; }
            if (!hasParticipants) return true;
        }
    }
    return false;
}
