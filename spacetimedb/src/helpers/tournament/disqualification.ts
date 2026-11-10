// ─── Disqualification (A23, A25, A26, A26a(2), A68(6), A94, D-21, D-25; S10g) ─────────────────────────────────
// The body of dq_participant, shared with the user-deletion cascade (A94(2)): no permission check here (the reducer
// runs ensureTournamentPermission, the deletion is already authorized), any audit actor (staff, an admin, the user
// deleting their own account, or SYSTEM_USER_ID for a server deletion).
//   - The enrolment becomes Disqualified (row kept: excluded from capacity, blocks re-registration).
//   - The player leaves the team (captain transferred to the lowest remaining user id, D-21); with
//     `dqWholeTeam` every member of the player's team is disqualified and leaves it.
//   - A team left empty becomes Disqualified (the team row stays for the bracket record, TD-18). In Seeding
//     after generation that stamps lastSeedChangeAt, so the bracket must be regenerated before InProgress.
//   - InProgress: every open match of the disqualified team is settled through the single writer (A23):
//     Ready -> applyBracketResult(opponent, decidedBy Dq, the derived tally, A67(4)); Pending (opponent not known yet) -> the team's
//     slot becomes a BYE and `settle` walks the opponent over once it arrives. Repeated until the team holds
//     no open slot (a double-elimination loss routes it into the losers bracket first).
//     S10g (audit #2, A68(6) "unsettled lobby voided"): every lobby of a match settled this way that is not settled
//     itself (Waiting, playing, or parked with a Pending / Submitted / Disputed record) is voided (voidMatchLobbies),
//     except the team's live lobby, which is force-conceded below.
//   - Live lobby of the team: Drafting / Equipping / Scoring -> force-concede on the last member (D-25; A54: the
//     lobby's record becomes the Validated concede record, the bracket is already settled by the DQ, and the lobby
//     parks until the finalize job). A68(6): a player DQ'd from a team that plays on is not removed from the live
//     lobby (the D-25 kick is gone): the current game plays on with them, and the DQ bites from the next lobby
//     (team membership gone, allowedSlotsFor seats nobody who is not on a team).
//     A67(1): the between-games stages are gone, so the D-26 hard-delete branch is too.

import { SenderError } from 'spacetimedb/server';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { deleteCalendarEventForBracketMatch } from '@module/helpers/calendar/calendarCascade';
import { performConcede } from '@module/reducers/results/concede';
import { findEnrolled, findMembership, refreshTeamStatus, removeEnrolment, transferTournamentCaptain, updateEnrolled } from './tournamentHelpers';
import { applyBracketResult, matchGames, writeMatchGames } from './bracketResults';
import { voidMatchLobbies } from './tournamentResults';
import { setSlotBye, settle } from './bracketStore';
import { teamSideOf } from './matchSides';

// Active lobby stages where players are engaged in the match
const ACTIVE_LOBBY_STAGES = new Set(['Drafting', 'Equipping', 'Scoring']);

const unit = (tag: string) => ({ tag, value: {} }) as any;

/** Settles every open bracket slot of a disqualified team (see the header); `keepLobbyId` = the live lobby. */
function settleDisqualifiedTeam(ctx: any, tournamentId: number, teamId: number, actorId: number, keepLobbyId?: number): void {
    let changed = true;
    while (changed) {
        changed = false;
        for (const snapshot of [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)]) {
            const row = ctx.db.BracketMatch.id.find(snapshot.id); // re-read: earlier settlements may have changed it
            if (!row) continue;
            const slot = row.team1Id === teamId ? 1 : row.team2Id === teamId ? 2 : 0;
            if (slot === 0) continue;
            if (row.state.tag === 'Ready') {
                const opponent = slot === 1 ? row.team2Id : row.team1Id;
                deleteCalendarEventForBracketMatch(ctx, row.id); // D-22
                applyBracketResult(ctx, row.id, opponent, 'Dq', matchGames(ctx, row), actorId);
                voidMatchLobbies(ctx, row.id, actorId, keepLobbyId); // S10g (audit #2)
                changed = true;
            } else if (row.state.tag === 'Pending') {
                setSlotBye(ctx, row.id, slot, actorId);
                settle(ctx, tournamentId, actorId);
                changed = true;
            }
        }
    }
}

/**
 * S10g (audit #8): a DQ needs a tournament that has a field and is not finished: Registration through InProgress
 * (Draft has no enrolment; Completed and Cancelled keep their final records).
 */
function ensureDqStage(tournament: any): void {
    const stage = tournament.stage.tag;
    if (stage === 'Draft' || stage === 'Completed' || stage === 'Cancelled') {
        throw new SenderError(`Tournament is ${stage}; participants can be disqualified from Registration through InProgress only.`);
    }
}

/** Disqualifies `userId` in `tournament` (see the header). Throws when the player is not enrolled or already out. */
export function disqualifyParticipant(
    ctx: any,
    tournament: any,
    userId: number,
    reason: string,
    dqWholeTeam: boolean,
    actorId: number,
): void {
    ensureDqStage(tournament);
    const tournamentId = tournament.id;
    const enrolled = findEnrolled(ctx, tournamentId, userId);
    if (!enrolled) {
        throw new SenderError('Participant not found in this tournament.');
    }
    if (enrolled.status.tag === 'Disqualified') {
        throw new SenderError('Participant is already disqualified.');
    }

    updateEnrolled(ctx, enrolled, { status: unit('Disqualified') }, actorId);
    console.log(`[TOURNAMENT] Participant #${userId} disqualified from tournament #${tournamentId}${dqWholeTeam ? ' with the whole team' : ''}: ${reason}`);

    const ttm = findMembership(ctx, tournamentId, userId);
    if (!ttm) return; // not on a team: nothing more to do

    const teamId = ttm.teamId;
    const team = ctx.db.TournamentTeam.id.find(teamId);

    // Live lobby of this team (D-25, D-26)
    let activeLobby: any = undefined;
    if (team) {
        for (const bm of ctx.db.BracketMatch.tournament_id.filter(tournamentId)) {
            if (bm.team1Id !== teamId && bm.team2Id !== teamId) continue;
            for (const lobby of ctx.db.Lobby.bracket_match_id.filter(bm.id)) {
                if (lobby.bracketMatchId === bm.id && ACTIVE_LOBBY_STAGES.has(lobby.stage.tag)) {
                    activeLobby = { lobby, bracketMatch: bm };
                    break;
                }
            }
            if (activeLobby) break;
        }
    }

    // Members leaving the team: the DQ'd player, or every member with dqWholeTeam (their enrolments too)
    const leaving = dqWholeTeam ? [...ctx.db.TournamentTeamMember.team_id.filter(teamId)] : [ttm];
    for (const member of leaving) {
        if (member.userId !== userId) {
            const other = findEnrolled(ctx, tournamentId, member.userId);
            if (other && other.status.tag !== 'Disqualified') {
                updateEnrolled(ctx, other, { status: unit('Disqualified') }, actorId);
            }
        }
        if (!dqWholeTeam && team && team.captainUserId === member.userId) {
            transferTournamentCaptain(ctx, teamId, member.userId, actorId); // D-21
        }
        ctx.db.TournamentTeamMember.delete(member);
    }

    const isTeamOut = [...ctx.db.TournamentTeamMember.team_id.filter(teamId)].length === 0;

    if (isTeamOut && team) {
        const current = ctx.db.TournamentTeam.id.find(teamId)!;
        ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, current, { status: unit('Disqualified') }, actorId));

        if (tournament.stage.tag === 'Seeding' && tournament.bracketGeneratedAt !== undefined) {
            const fresh = ctx.db.Tournament.id.find(tournamentId);
            ctx.db.Tournament.id.update(updateWithAudit(ctx, fresh, { lastSeedChangeAt: ctx.timestamp }, actorId));
        }
        if (tournament.stage.tag === 'InProgress') {
            settleDisqualifiedTeam(ctx, tournamentId, teamId, actorId, activeLobby?.lobby.id);
        }

        if (activeLobby) {
            const { lobby, bracketMatch } = activeLobby;
            // DQ during active draft/scoring: force-concede (D-25); the bracket is already settled
            // above, so the concede's hand-off is skipped (match no longer Ready).
            const losingTeamSide = teamSideOf(bracketMatch, teamId)!; // A70(1): the colour the DQ'd team plays
            performConcede(ctx, lobby, losingTeamSide, actorId, unit('RefereeDecision'), undefined);
            // A67(4): the concede's record is Validated after the Dq decision, so the stored tally is
            // rewritten from the records (decidedBy stays Dq).
            writeMatchGames(ctx, bracketMatch.id, actorId);
        }
    } else {
        // A26 / A26a(3): before generation the team may drop below teamSize (Ready -> Forming); once the bracket
        // is generated a team that still has members keeps its status and plays with stand-ins.
        if (tournament.bracketGeneratedAt === undefined) refreshTeamStatus(ctx, tournament, teamId, actorId);
        // A68(6): no kick from a live lobby; the game plays on and the DQ takes effect from the next lobby.
    }
}

/**
 * A94(2) (S10g): the tournament part of the user-deletion cascade (performUserDeletion, before any other row of the user
 * goes; actor = the deleting user, an admin or SYSTEM_USER_ID). Completed and Cancelled tournaments keep their rows.
 * In every other tournament the user's enrolment is settled first: before the bracket exists the user is withdrawn
 * (removeEnrolment, the enrolment path of withdraw_from_tournament: team membership with captain transfer, the solo or
 * emptied team, account locks, requests, invites, the remembered waitlist accounts); once it exists the user is
 * disqualified (disqualifyParticipant, the dq_participant path: bracket settlement and lobby handling of a team left
 * empty). A Disqualified enrolment is already settled. Then, in every tournament: the user's pending team requests,
 * assistant rows, stand-in rows, account locks and remembered waitlist accounts are deleted (the user's HSR accounts
 * are deleted by the cascade right after).
 */
export function settleTournamentTiesForDeletion(ctx: any, userId: number, actorId: number): void {
    for (const enrolled of [...ctx.db.TournamentEnrolled.user_id.filter(userId)]) {
        const tournament = ctx.db.Tournament.id.find(enrolled.tournamentId);
        if (!tournament) continue;
        const stage = tournament.stage.tag;
        if (stage === 'Completed' || stage === 'Cancelled' || enrolled.status.tag === 'Disqualified') continue;
        if (tournament.bracketGeneratedAt === undefined) {
            removeEnrolment(ctx, tournament, enrolled, actorId);
        } else {
            disqualifyParticipant(ctx, tournament, userId, 'account deleted', false, actorId);
        }
    }
    for (const req of [...ctx.db.TournamentTeamRequest.user_id.filter(userId)]) ctx.db.TournamentTeamRequest.delete(req);
    for (const a of [...ctx.db.TournamentAssistant.user_id.filter(userId)]) ctx.db.TournamentAssistant.delete(a);
    for (const s of [...ctx.db.TournamentStandIn.user_id.filter(userId)]) ctx.db.TournamentStandIn.delete(s);
    for (const tpa of [...ctx.db.TournamentPlayerAccount.by_user.filter(userId)]) ctx.db.TournamentPlayerAccount.delete(tpa);
    for (const w of [...ctx.db.TournamentWaitlistAccount.by_user.filter(userId)]) ctx.db.TournamentWaitlistAccount.delete(w);
}
