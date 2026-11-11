// ─── A112 (S10l): a guest's tournament entries follow the guest to an existing account ────────────────────────────
// server_link_provider, the case where the caller's identity points at a guest and the provider account already
// belongs to another user: the identity is re-pointed and the guest deleted (performUserDeletion). Before the deletion,
// moveTournamentTiesToUser moves each of the guest's enrolments in a tournament that is not Completed or Cancelled to
// the existing user when that user can hold it (canHoldEntry); what is not moved is settled by the deletion as before
// (A94(2), settleTournamentTiesForDeletion: withdrawn before the bracket, disqualified once it exists).
//
// Moved for one tournament:
//   - TournamentEnrolled: re-keyed to the existing user, every other field kept (status, alias, waitlist flag and
//     place (the row's createdDate is kept), approval, random-team opt-in).
//   - TournamentTeamMember: re-keyed; TournamentTeam.captainUserId follows when the guest was the captain, also for a
//     team the guest no longer belongs to (review F7: a disqualified guest's emptied team). A solo team
//     (teamSize 1) of a non-anonymous tournament is renamed by soloTeamName (display name, unique " (2)" pass); an
//     anonymous tournament keeps its alias / "Player <n>" name (the display name never reaches it, A36a / A37).
//   - TournamentStandIn of the existing user (review F2): deleted for every bracket match of this tournament in which
//     the team they now belong to plays, so they cannot sit on both sides; their other stand-in rows stay.
//   - TournamentTeamRequest made by the guest to a team of this tournament: re-keyed to the existing user. Requests
//     addressed to a team the guest captains are keyed by the requester and stay with the team untouched.
//   - Locks (A112(2)): the guest's TournamentPlayerAccount and TournamentWaitlistAccount rows of the tournament are
//     deleted (the guest's HSR accounts go with the guest); a non-waitlisted, non-Disqualified entry gets every game
//     account of the existing user locked (lockPlayerAccounts with no ids, as a registration that names none); a
//     waitlisted entry carries no remembered choice, so promotion locks every account (lockAccountsAtPromotion).
//   - Calendar invites (A113(5), S10m): the guest's invites to events linked to bracket matches of the tournament are
//     re-pointed to the existing user (moveUserInvitesForTournament; dropped when that user is already invited).
// Not moved: BracketMatch rows (they reference teams), lobby memberships and lobby account selections, result
// participants, other calendar invites, assistant and stand-in rows of the guest: all left to the deletion.
// No rate-limit allowance is consumed; audit columns carry `actorId` (the link path's SYSTEM_USER_ID).

import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { moveUserInvitesForTournament } from '@module/helpers/calendar/calendarCascade';
import { STILL_IN_TEAM_STATUSES, removeStandIn, removeUserStandIns } from './standIns';
import { deleteWaitlistAccounts, findEnrolled, findMembership, lockPlayerAccounts, soloTeamName, updateEnrolled } from './tournamentHelpers';

/**
 * A112(3) / S10l review F1: the rating test of register_for_tournament's ensureMinimumMmr (tournamentRegistration.ts)
 * as a yes / no answer: a guest never passes a floor; otherwise the user's MmrRating for the tournament's game mode in
 * the active season (the Season row with isActive, else 0), else EloConfig.initialRating. Without an EloConfig row the
 * rating is unknown and the floor is not met (registration throws in that case; the sign-in must not).
 */
function meetsMinimumMmr(ctx: any, tournament: any, user: any): boolean {
    if (!tournament.minimumMmr) return true;
    if (user.isGuest) return false;
    const activeSeason = [...ctx.db.Season.is_active.filter(true)][0];
    const seasonId = activeSeason ? activeSeason.id : 0;
    const row = [...ctx.db.MmrRating.by_user_mode_season.filter([user.id, tournament.defaultGameMode, seasonId])][0];
    let rating: number;
    if (row) {
        rating = row.rating;
    } else {
        const config = ctx.db.EloConfigTable.id.find(1);
        if (!config) return false;
        rating = config.initialRating;
    }
    return rating >= tournament.minimumMmr;
}

/**
 * A112(3): the existing user can hold the guest's entry in `tournament` when
 *   - they have no TournamentEnrolled row there in any status (a Disqualified row included) and no team membership
 *     there (an orphan membership would collide on re-keying),
 *   - minimumMmr: their rating meets the floor (meetsMinimumMmr, the register_for_tournament test),
 *   - requireVerified: they are not a guest,
 *   - requireRoster: they own an active HSR account (the register_for_tournament check).
 * The gates are checked even though the guest's own entry may predate them: update_tournament lets the organizer set
 * minimumMmr, requireVerified and requireRoster in Registration and CheckIn after guests enrolled (existing
 * registrants are not re-checked), so a guest entry can sit in a tournament with any of them. The requireVerified line
 * is defensive: the existing user always has a provider link (that is how the sign-in found them), so it never fails.
 * Since A113(1)(2) (S10m) these three gates force requireVerified on and update_tournament refuses to turn it on while
 * guests are enrolled, so new guest entries never sit under them; the checks stay for rows written before A113.
 */
function canHoldEntry(ctx: any, tournament: any, target: any): boolean {
    if (findEnrolled(ctx, tournament.id, target.id)) return false;
    if (findMembership(ctx, tournament.id, target.id)) return false;
    if (!meetsMinimumMmr(ctx, tournament, target)) return false;
    if (tournament.requireVerified && target.isGuest) return false;
    // S10v review G5 (A137(4)): requireOwnership needs an active account like requireRoster. Unreachable today for
    // ownership (A113 forces requireVerified with it, so no guest entry sits in such a tournament); kept for the letter.
    if ((tournament.requireRoster || tournament.requireOwnership)
        && ![...ctx.db.HsrAccount.user_id.filter(target.id)].some((a: any) => a.isActive)) return false;
    return true;
}

function moveEntry(ctx: any, tournament: any, enrolled: any, fromGuestId: number, target: any, actorId: number): void {
    const tournamentId = tournament.id;
    const toUserId = target.id;

    updateEnrolled(ctx, enrolled, { userId: toUserId }, actorId);

    const ttm = findMembership(ctx, tournamentId, fromGuestId);
    if (ttm) {
        ctx.db.TournamentTeamMember.delete(ttm);
        ctx.db.TournamentTeamMember.insert(updateWithAudit(ctx, ttm, { userId: toUserId }, actorId));
        const team = ctx.db.TournamentTeam.id.find(ttm.teamId);
        if (team) {
            const changes: Record<string, unknown> = {};
            if (team.captainUserId === fromGuestId) changes.captainUserId = toUserId;
            if (tournament.teamSize === 1 && !tournament.isAnonymousDefault) {
                const name = soloTeamName(ctx, tournament, target.displayName, enrolled.anonymousAlias, team.id);
                if (name !== team.name) changes.name = name;
            }
            if (Object.keys(changes).length > 0) {
                ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, changes as any, actorId));
            }
        }

        // S10l review F2: the existing user must not sit on both sides of a bracket match. Their stand-in approvals
        // (TournamentStandIn.user_id) for a match of this tournament (BracketMatch.id) in which their new team plays
        // are deleted; approve_stand_in refuses a member of the other team, but only at approval time. Stand-in rows
        // for other matches stay.
        // S10v review F2 (A135(3)): when the received team is still in (Forming, Ready, Active) every approval of the user
        // in this tournament goes; otherwise only those of matches the team plays. Through removeStandIn (seat, invite,
        // lock release) instead of a raw delete.
        if (STILL_IN_TEAM_STATUSES.has(ctx.db.TournamentTeam.id.find(ttm.teamId)?.status.tag ?? '')) {
            removeUserStandIns(ctx, tournamentId, toUserId, actorId);
        } else {
            for (const si of [...ctx.db.TournamentStandIn.user_id.filter(toUserId)]) {
                const match = ctx.db.BracketMatch.id.find(si.bracketMatchId);
                if (!match || match.tournamentId !== tournamentId) continue;
                if (match.team1Id === ttm.teamId || match.team2Id === ttm.teamId) removeStandIn(ctx, si, actorId);
            }
        }
    }

    // S10l review F7: a team of this tournament that records the guest as captain is re-pointed even when the guest has
    // no membership left (a disqualified guest whose team was emptied keeps captainUserId), so no team of an unfinished
    // tournament names the deleted guest (TournamentTeam.captain_user_id).
    for (const team of [...ctx.db.TournamentTeam.captain_user_id.filter(fromGuestId)]) {
        if (team.tournamentId !== tournamentId) continue;
        ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { captainUserId: toUserId } as any, actorId));
    }

    for (const req of [...ctx.db.TournamentTeamRequest.user_id.filter(fromGuestId)]) {
        const team = ctx.db.TournamentTeam.id.find(req.teamId);
        if (!team || team.tournamentId !== tournamentId) continue;
        ctx.db.TournamentTeamRequest.delete(req);
        if ([...ctx.db.TournamentTeamRequest.by_team_and_user.filter([req.teamId, toUserId])].length === 0) {
            ctx.db.TournamentTeamRequest.insert(updateWithAudit(ctx, req, { userId: toUserId }, actorId));
        }
    }

    for (const tpa of [...ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournamentId, fromGuestId])]) {
        ctx.db.TournamentPlayerAccount.delete(tpa);
    }
    deleteWaitlistAccounts(ctx, tournamentId, fromGuestId);
    if (enrolled.isWaitlisted) {
        deleteWaitlistAccounts(ctx, tournamentId, toUserId); // no remembered choice: promotion locks every account
    } else if (enrolled.status.tag !== 'Disqualified') {
        lockPlayerAccounts(ctx, tournamentId, toUserId, undefined, actorId, 'Entry');
    }
    moveUserInvitesForTournament(ctx, fromGuestId, toUserId, tournamentId, actorId); // A113(5)
    console.log(`[TOURNAMENT] A112: entry of guest #${fromGuestId} in tournament #${tournamentId} moved to user #${toUserId}`);
}

/**
 * A112 (S10l): moves the guest's entries in unfinished tournaments to `toUserId` (see the header). Called by
 * server_link_provider before performUserDeletion; entries it leaves behind are settled by the deletion (A94(2)).
 */
export function moveTournamentTiesToUser(ctx: any, fromGuestId: number, toUserId: number, actorId: number): void {
    const target = ctx.db.User.id.find(toUserId);
    if (!target) return;
    for (const enrolled of [...ctx.db.TournamentEnrolled.user_id.filter(fromGuestId)]) {
        const tournament = ctx.db.Tournament.id.find(enrolled.tournamentId);
        if (!tournament) continue;
        const stage = tournament.stage.tag;
        if (stage === 'Completed' || stage === 'Cancelled') continue;
        if (!canHoldEntry(ctx, tournament, target)) continue;
        moveEntry(ctx, tournament, enrolled, fromGuestId, target, actorId);
    }
}
