import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { transferTournamentCaptain } from '../helpers/tournamentHelpers';
import { insertWithAudit } from '../helpers/auditHelpers';

// ─── create_tournament_team ───────────────────────────────────────────────────
// Creates a tournament-scoped team for the calling user (captain).
// Per D-20: reads TournamentEnrolled to verify registration, inserts TournamentTeamMember.

export const create_tournament_team = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        teamName: t.string(),
    },
    (ctx, { tournamentId, teamName }) => {
        const user = getAuthenticatedUser(ctx);

        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        if (tournament.stage.tag !== 'Registration') {
            throw new SenderError('Teams can only be created during the Registration stage.');
        }

        // Validate team name
        const trimmedName = teamName.trim();
        if (trimmedName.length < 1 || trimmedName.length > 50) {
            throw new SenderError('Team name must be 1-50 characters.');
        }

        // Can't create teams in solo tournaments
        if (tournament.teamSize <= 1) {
            throw new SenderError('Cannot create teams in a solo tournament.');
        }

        // Player must be registered in the tournament (TournamentEnrolled)
        const enrolled = [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([tournamentId, user.id])][0];
        if (!enrolled) {
            throw new SenderError('You must be registered in the tournament before creating a team.');
        }

        // Player must not already be on a team (no TournamentTeamMember row for this tournament)
        const existingMembership = [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([tournamentId, user.id])][0];
        if (existingMembership) {
            throw new SenderError('You are already on a team in this tournament.');
        }

        // Insert the team row
        const newTeam = ctx.db.TournamentTeam.insert(insertWithAudit(ctx, {
            id: 0,
            tournamentId,
            name: trimmedName,
            captainUserId: user.id,
            seedNumber: undefined,
        }, user.id));

        const teamId = newTeam.id;

        // Insert TournamentTeamMember row for the captain (D-20)
        ctx.db.TournamentTeamMember.insert(insertWithAudit(ctx, {
            teamId,
            userId: user.id,
            tournamentId,
        }, user.id));
    }
);

// ─── request_join_team ────────────────────────────────────────────────────────
// Submits a request to join an existing tournament team.

export const request_join_team = spacetimedb.reducer(
    {
        teamId: t.u32(),
    },
    (ctx, { teamId }) => {
        const user = getAuthenticatedUser(ctx);

        const team = ctx.db.TournamentTeam.id.find(teamId);
        if (!team) throw new SenderError('Team not found.');

        const tournament = ctx.db.Tournament.id.find(team.tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        if (tournament.stage.tag !== 'Registration') {
            throw new SenderError('Teams can only be joined during the Registration stage.');
        }

        // User must be registered in the same tournament (TournamentEnrolled)
        const enrolled = [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([team.tournamentId, user.id])][0];
        if (!enrolled) {
            throw new SenderError('You must be registered in the tournament before joining a team.');
        }

        // User must not already be on a team (no TournamentTeamMember for this tournament)
        const existingMembership = [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([team.tournamentId, user.id])][0];
        if (existingMembership) {
            throw new SenderError('You are already on a team in this tournament.');
        }

        // No existing pending request from this user to this team
        const existingRequest = [...ctx.db.TournamentTeamRequest.by_team_and_user.filter([teamId, user.id])][0];
        if (existingRequest) {
            throw new SenderError('You already have a pending request to join this team.');
        }

        ctx.db.TournamentTeamRequest.insert(insertWithAudit(ctx, {
            teamId,
            userId: user.id,
        }, user.id));
    }
);

// ─── accept_team_request ──────────────────────────────────────────────────────
// Captain accepts a join request, adding the player to the team.
// Per D-20: inserts TournamentTeamMember for the accepted user.

export const accept_team_request = spacetimedb.reducer(
    {
        teamId: t.u32(),
        userId: t.u32(),
    },
    (ctx, { teamId, userId }) => {
        const caller = getAuthenticatedUser(ctx);

        const team = ctx.db.TournamentTeam.id.find(teamId);
        if (!team) throw new SenderError('Team not found.');
        if (team.captainUserId !== caller.id) {
            throw new SenderError('Only the team captain can accept join requests.');
        }

        const request = [...ctx.db.TournamentTeamRequest.by_team_and_user.filter([teamId, userId])][0];
        if (!request) throw new SenderError('Join request not found.');

        // Check current team member count via TournamentTeamMember
        const tournament = ctx.db.Tournament.id.find(team.tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        const memberCount = [...ctx.db.TournamentTeamMember.team_id.filter(teamId)].length;
        if (memberCount >= tournament.teamSize) {
            throw new SenderError('Team is already full.');
        }

        // Delete the accepted request row (transactional — existence = pending)
        ctx.db.TournamentTeamRequest.delete(request);

        // Clean up user's other pending requests to other teams in this tournament
        const otherTeams = [...ctx.db.TournamentTeam.tournament_id.filter(team.tournamentId)];
        for (const otherTeam of otherTeams) {
            if (otherTeam.id === teamId) continue;
            const otherReq = [...ctx.db.TournamentTeamRequest.by_team_and_user.filter([otherTeam.id, userId])][0];
            if (otherReq) ctx.db.TournamentTeamRequest.delete(otherReq);
        }

        // Insert TournamentTeamMember row for the accepted user (D-20)
        ctx.db.TournamentTeamMember.insert(insertWithAudit(ctx, {
            teamId,
            userId,
            tournamentId: team.tournamentId,
        }, caller.id));
    }
);

// ─── reject_team_request ──────────────────────────────────────────────────────
// Captain rejects a join request, deleting the request row.

export const reject_team_request = spacetimedb.reducer(
    {
        teamId: t.u32(),
        userId: t.u32(),
    },
    (ctx, { teamId, userId }) => {
        const caller = getAuthenticatedUser(ctx);

        const team = ctx.db.TournamentTeam.id.find(teamId);
        if (!team) throw new SenderError('Team not found.');
        if (team.captainUserId !== caller.id) {
            throw new SenderError('Only the team captain can reject join requests.');
        }

        const request = [...ctx.db.TournamentTeamRequest.by_team_and_user.filter([teamId, userId])][0];
        if (!request) throw new SenderError('Join request not found.');

        // Delete the request row (transactional — existence = pending)
        ctx.db.TournamentTeamRequest.delete(request);
    }
);

// ─── leave_tournament_team ────────────────────────────────────────────────────
// Leaves a tournament team.
// Per D-20, D-22, D-23, D-24:
//   - Deletes TournamentTeamMember row.
//   - If captain: transfer captain to next lowest userId member.
//   - If last member after delete: destroy team (enrolled members stay enrolled, teamless).

export const leave_tournament_team = spacetimedb.reducer(
    {
        teamId: t.u32(),
    },
    (ctx, { teamId }) => {
        const user = getAuthenticatedUser(ctx);

        const team = ctx.db.TournamentTeam.id.find(teamId);
        if (!team) throw new SenderError('Team not found.');

        // Verify user is a member of this team via TournamentTeamMember
        const ttm = [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([team.tournamentId, user.id])][0];
        if (!ttm || ttm.teamId !== teamId) {
            throw new SenderError('You are not a member of this team.');
        }

        if (team.captainUserId === user.id) {
            // Captain leaving: attempt captain-transfer first
            const transferred = transferTournamentCaptain(ctx, teamId, user.id, user.id);
            // Delete the captain's TTM row
            ctx.db.TournamentTeamMember.delete(ttm);

            if (!transferred) {
                // No other members — destroy the team (D-24 enrolled stay enrolled)
                for (const req of [...ctx.db.TournamentTeamRequest.team_id.filter(teamId)]) {
                    ctx.db.TournamentTeamRequest.delete(req);
                }
                ctx.db.TournamentTeam.id.delete(teamId);
            }
        } else {
            // Non-captain leaving: delete TTM row only (user stays enrolled, D-24)
            ctx.db.TournamentTeamMember.delete(ttm);
        }
    }
);

// ─── disband_tournament_team ──────────────────────────────────────────────────
// Captain disbands the team: deletes all TournamentTeamMember rows, pending requests, and team.
// All former members stay enrolled and teamless per D-24.
// Only allowed in Registration stage.

export const disband_tournament_team = spacetimedb.reducer(
    {
        teamId: t.u32(),
    },
    (ctx, { teamId }) => {
        const user = getAuthenticatedUser(ctx);

        const team = ctx.db.TournamentTeam.id.find(teamId);
        if (!team) throw new SenderError('Team not found.');
        if (team.captainUserId !== user.id) {
            throw new SenderError('Only the team captain can disband the team.');
        }

        const tournament = ctx.db.Tournament.id.find(team.tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        if (tournament.stage.tag !== 'Registration') {
            throw new SenderError('Teams can only be disbanded during the Registration stage.');
        }

        // Delete ALL TournamentTeamMember rows for this team (members stay enrolled, D-24)
        for (const member of [...ctx.db.TournamentTeamMember.team_id.filter(teamId)]) {
            ctx.db.TournamentTeamMember.delete(member);
        }

        // Delete all requests for this team
        for (const req of [...ctx.db.TournamentTeamRequest.team_id.filter(teamId)]) {
            ctx.db.TournamentTeamRequest.delete(req);
        }

        // Delete the team row
        ctx.db.TournamentTeam.id.delete(teamId);
    }
);
