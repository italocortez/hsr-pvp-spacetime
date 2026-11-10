import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { groupCount } from '@shared/bracket';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { ensureTournamentPermission } from '@module/helpers/tournament/tournamentPermissions';
import {
    deleteTeam,
    ensureBeforeGeneration,
    deleteUserTeamRequests,
    findEnrolled,
    findMembership,
    isActingCaptain,
    isGroupFormat,
    normalizeTeamName,
    refreshTeamStatus,
    removeTeamMember,
} from '@module/helpers/tournament/tournamentHelpers';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { consumeTournamentAllowance } from '@module/helpers/lobby/abuseControls';

// Team edits by participants stop when registration closes (A26a): every reducer below except rename (Registration
// or CheckIn) and the staff group assignment (Seeding) runs in Registration only. Participants never set the team
// status (A26): Forming ↔ Ready follows refreshTeamStatus.

function loadTeam(ctx: any, teamId: number): { team: any; tournament: any } {
    const team = ctx.db.TournamentTeam.id.find(teamId);
    if (!team) throw new SenderError('Team not found.');
    const tournament = ctx.db.Tournament.id.find(team.tournamentId);
    if (!tournament) throw new SenderError('Tournament not found.');
    return { team, tournament };
}

function ensureRegistration(tournament: any, what: string): void {
    if (tournament.stage.tag !== 'Registration') {
        throw new SenderError(`Teams can only ${what} during the Registration stage.`);
    }
}

/**
 * Review T13: the player must be enrolled, not Disqualified, approved when the tournament requires approval, and
 * teamless. Waitlisted players may create or join a team (A26a(4)); the team stays Forming until they are promoted.
 */
function ensureCanJoinATeam(ctx: any, tournament: any, userId: number, self: boolean): void {
    const enrolled = findEnrolled(ctx, tournament.id, userId);
    if (!enrolled) {
        throw new SenderError(self ? 'You must be registered in the tournament first.' : 'The player is no longer registered.');
    }
    if (enrolled.status.tag === 'Disqualified') {
        throw new SenderError(self ? 'You were disqualified from this tournament.' : 'The player was disqualified.');
    }
    if (tournament.requireApproval && enrolled.approvedByToAt === undefined) {
        throw new SenderError(self ? 'Your registration awaits approval.' : 'The player awaits approval.');
    }
    if (findMembership(ctx, tournament.id, userId)) {
        throw new SenderError(self ? 'You are already on a team in this tournament.' : 'The player is already on a team.');
    }
}

// ─── create_tournament_team ───────────────────────────────────────────────────
// Registration only; team tournaments only; the creator is enrolled, approved (when required) and teamless
// (T13; waitlisted allowed, A26a(4)) and becomes captain. Name: 1–40 characters, unique (A36a). Status Forming.
// The creator's pending requests to other teams are deleted (T13).

export const create_tournament_team = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        teamName: t.string(),
    },
    (ctx, { tournamentId, teamName }) => {
        const user = getAuthenticatedUser(ctx);

        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        ensureRegistration(tournament, 'be created');
        if (tournament.teamSize <= 1) {
            throw new SenderError('Cannot create teams in a solo tournament.');
        }
        ensureCanJoinATeam(ctx, tournament, user.id, true);
        const name = normalizeTeamName(ctx, tournamentId, teamName);

        const newTeam = ctx.db.TournamentTeam.insert(insertWithAudit(ctx, {
            id: 0,
            tournamentId,
            name,
            captainUserId: user.id,
            status: { tag: 'Forming', value: {} } as any,
            seedNumber: undefined,
            groupId: undefined,
            finalPlacement: undefined,
        }, user.id));

        ctx.db.TournamentTeamMember.insert(insertWithAudit(ctx, {
            teamId: newTeam.id,
            userId: user.id,
            tournamentId,
        }, user.id));
        deleteUserTeamRequests(ctx, tournamentId, user.id);
        refreshTeamStatus(ctx, tournament, newTeam.id, user.id);
    }
);

// ─── request_join_team ────────────────────────────────────────────────────────
// Registration only; the team is Forming (a Ready team is full, any other status is closed); the requester may
// join a team (T13); one pending request per team.

export const request_join_team = spacetimedb.reducer(
    {
        teamId: t.u32(),
    },
    (ctx, { teamId }) => {
        const user = getAuthenticatedUser(ctx);
        const { team, tournament } = loadTeam(ctx, teamId);
        ensureRegistration(tournament, 'be joined');
        if (team.status.tag !== 'Forming') {
            throw new SenderError(team.status.tag === 'Ready' ? 'Team is already full.' : `Team is ${team.status.tag}.`);
        }
        if ([...ctx.db.TournamentTeamMember.team_id.filter(teamId)].length >= tournament.teamSize) {
            throw new SenderError('Team is already full.');
        }
        ensureCanJoinATeam(ctx, tournament, user.id, true);

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
// Captain only; Registration only (T13); the requester must still be able to join (enrolled, not DQ, approved,
// teamless: T13) and the team must have room. The requester's other pending requests are deleted.

export const accept_team_request = spacetimedb.reducer(
    {
        teamId: t.u32(),
        userId: t.u32(),
    },
    (ctx, { teamId, userId }) => {
        const caller = getAuthenticatedUser(ctx);
        const { team, tournament } = loadTeam(ctx, teamId);
        if (!isActingCaptain(ctx, team, caller.id)) { // S10g review F4
            throw new SenderError('Only the team captain can accept join requests.');
        }
        ensureRegistration(tournament, 'be joined');

        const request = [...ctx.db.TournamentTeamRequest.by_team_and_user.filter([teamId, userId])][0];
        if (!request) throw new SenderError('Join request not found.');

        if (team.status.tag !== 'Forming' ||
            [...ctx.db.TournamentTeamMember.team_id.filter(teamId)].length >= tournament.teamSize) {
            throw new SenderError('Team is already full.');
        }
        ensureCanJoinATeam(ctx, tournament, userId, false);

        deleteUserTeamRequests(ctx, team.tournamentId, userId); // this request and the others in the tournament
        ctx.db.TournamentTeamMember.insert(insertWithAudit(ctx, {
            teamId,
            userId,
            tournamentId: team.tournamentId,
        }, caller.id));
        refreshTeamStatus(ctx, tournament, teamId, caller.id);
    }
);

// ─── reject_team_request ──────────────────────────────────────────────────────
// Captain only; Registration only. Deletes the request row.

export const reject_team_request = spacetimedb.reducer(
    {
        teamId: t.u32(),
        userId: t.u32(),
    },
    (ctx, { teamId, userId }) => {
        const caller = getAuthenticatedUser(ctx);
        const { team, tournament } = loadTeam(ctx, teamId);
        if (!isActingCaptain(ctx, team, caller.id)) { // S10g review F4
            throw new SenderError('Only the team captain can reject join requests.');
        }
        ensureRegistration(tournament, 'be edited');

        const request = [...ctx.db.TournamentTeamRequest.by_team_and_user.filter([teamId, userId])][0];
        if (!request) throw new SenderError('Join request not found.');
        ctx.db.TournamentTeamRequest.delete(request);
    }
);

// ─── leave_tournament_team ────────────────────────────────────────────────────
// Registration only (review T10). A captain hands the captaincy to the lowest-userId member
// (transferTournamentCaptain); the last member leaving deletes the team; the player stays enrolled (D-24).
// Not in solo tournaments: the solo team is the player's entry (withdraw instead).

export const leave_tournament_team = spacetimedb.reducer(
    {
        teamId: t.u32(),
    },
    (ctx, { teamId }) => {
        const user = getAuthenticatedUser(ctx);
        const { team, tournament } = loadTeam(ctx, teamId);
        ensureRegistration(tournament, 'be left');
        if (tournament.teamSize <= 1) {
            throw new SenderError('A solo team cannot be left; withdraw from the tournament instead.');
        }

        const ttm = findMembership(ctx, team.tournamentId, user.id);
        if (!ttm || ttm.teamId !== teamId) {
            throw new SenderError('You are not a member of this team.');
        }
        removeTeamMember(ctx, tournament, ttm, user.id);
    }
);

// ─── disband_tournament_team ──────────────────────────────────────────────────
// Captain only; Registration only (a team is never deleted after registration closes, TD-18). Deletes the
// members, the pending requests and the team; every former member stays enrolled and teamless (D-24).

export const disband_tournament_team = spacetimedb.reducer(
    {
        teamId: t.u32(),
    },
    (ctx, { teamId }) => {
        const user = getAuthenticatedUser(ctx);
        const { team, tournament } = loadTeam(ctx, teamId);
        if (!isActingCaptain(ctx, team, user.id)) {
            throw new SenderError('Only the team captain can disband the team.');
        }
        ensureRegistration(tournament, 'be disbanded');
        if (tournament.teamSize <= 1) {
            throw new SenderError('A solo team cannot be disbanded; withdraw from the tournament instead.');
        }
        deleteTeam(ctx, teamId);
    }
);

// ─── withdraw_tournament_team ─────────────────────────────────────────────────
// A26: the captain withdraws the whole team (status Withdrawn) in Registration or CheckIn; the members stay
// enrolled and on the team row; its pending requests are deleted.

export const withdraw_tournament_team = spacetimedb.reducer(
    {
        teamId: t.u32(),
    },
    (ctx, { teamId }) => {
        const user = getAuthenticatedUser(ctx);
        const { team, tournament } = loadTeam(ctx, teamId);
        if (!isActingCaptain(ctx, team, user.id)) { // S10g review F4
            throw new SenderError('Only the team captain can withdraw the team.');
        }
        if (tournament.stage.tag !== 'Registration' && tournament.stage.tag !== 'CheckIn') {
            throw new SenderError('Registration is closed; ask staff.');
        }
        if (team.status.tag !== 'Forming' && team.status.tag !== 'Ready') {
            throw new SenderError(`Team is ${team.status.tag}.`);
        }
        for (const req of [...ctx.db.TournamentTeamRequest.team_id.filter(teamId)]) {
            ctx.db.TournamentTeamRequest.delete(req);
        }
        ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, {
            status: { tag: 'Withdrawn', value: {} } as any,
        }, user.id));
    }
);

// ─── add_team_member ──────────────────────────────────────────────────────────
// A26a: staff move an enrolled player into a short team, from Registration until the bracket is generated.
// `participants` permission (A25). The player is enrolled, not Disqualified, approved when required, not
// waitlisted and teamless; the team is Forming or Ready with room. The status follows refreshTeamStatus.

export const add_team_member = spacetimedb.reducer(
    {
        teamId: t.u32(),
        userId: t.u32(),
    },
    (ctx, { teamId, userId }) => {
        const found = ctx.db.TournamentTeam.id.find(teamId);
        if (!found) throw new SenderError('Team not found.');
        const { user, tournament } = ensureTournamentPermission(ctx, found.tournamentId, 'participants');
        ensureBeforeGeneration(tournament);
        if (found.status.tag !== 'Forming' && found.status.tag !== 'Ready') {
            throw new SenderError(`Team is ${found.status.tag}.`);
        }
        if ([...ctx.db.TournamentTeamMember.team_id.filter(teamId)].length >= tournament.teamSize) {
            throw new SenderError('Team is already full.');
        }
        ensureCanJoinATeam(ctx, tournament, userId, false);
        if (findEnrolled(ctx, tournament.id, userId).isWaitlisted) {
            throw new SenderError('The player is on the waitlist; promote them first.');
        }

        deleteUserTeamRequests(ctx, tournament.id, userId);
        ctx.db.TournamentTeamMember.insert(insertWithAudit(ctx, {
            teamId,
            userId,
            tournamentId: tournament.id,
        }, user.id));
        refreshTeamStatus(ctx, tournament, teamId, user.id);
    }
);

// ─── rename_tournament_team ───────────────────────────────────────────────────
// A36a: the captain renames the team in Registration or CheckIn (1–40 characters, unique case-insensitive).
// A solo team is named after its player (display name, or the alias in an anonymous tournament: set_anonymous_alias).
// S10g: a rename that changes the name is counted by consumeTournamentAllowance (audit #13); the captain must still be
// a member of the team (audit #15, also for disband_tournament_team).

export const rename_tournament_team = spacetimedb.reducer(
    {
        teamId: t.u32(),
        name: t.string(),
    },
    (ctx, { teamId, name }) => {
        const user = getAuthenticatedUser(ctx);
        const { team, tournament } = loadTeam(ctx, teamId);
        if (!isActingCaptain(ctx, team, user.id)) {
            throw new SenderError('Only the team captain can rename the team.');
        }
        if (tournament.stage.tag !== 'Registration' && tournament.stage.tag !== 'CheckIn') {
            throw new SenderError('Teams can only be renamed during Registration or CheckIn.');
        }
        if (tournament.teamSize <= 1) {
            throw new SenderError('A solo team is named after its player.');
        }
        const trimmed = normalizeTeamName(ctx, team.tournamentId, name, teamId);
        if (trimmed !== team.name) {
            consumeTournamentAllowance(ctx, user.id); // S10g (audit #13)
            ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { name: trimmed }, user.id));
        }
    }
);

// ─── Manual groups (A36a, A32) ────────────────────────────────────────────────
// `bracket` permission (A25), Seeding, a group format with groupAssignmentMode = Manual. Writes
// TournamentTeam.groupId (0-based group index, as insertGroupBracket). The size rules (every group ≥ groupSize,
// sizes within one, groupCount groups) are checked by generate_bracket (S8c); here only
// groupIndex < groupCount(readyTeamCount, groupSize). A change stamps lastSeedChangeAt, so the bracket must be
// regenerated before InProgress.

function ensureManualGroups(ctx: any, tournamentId: number): { user: any; tournament: any } {
    const { user, tournament } = ensureTournamentPermission(ctx, tournamentId, 'bracket');
    if (tournament.stage.tag !== 'Seeding') {
        throw new SenderError('Groups can only be assigned during Seeding.');
    }
    if (!isGroupFormat(tournament.format.tag)) {
        throw new SenderError('This tournament has no group stage.');
    }
    if (tournament.groupAssignmentMode.tag !== 'Manual') {
        throw new SenderError('Group assignment is automatic for this tournament.');
    }
    return { user, tournament };
}

export const assign_team_group = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        teamId: t.u32(),
        groupIndex: t.u32(),
    },
    (ctx, { tournamentId, teamId, groupIndex }) => {
        const { user, tournament } = ensureManualGroups(ctx, tournamentId);
        const team = ctx.db.TournamentTeam.id.find(teamId);
        if (!team || team.tournamentId !== tournamentId) throw new SenderError('Team not found in this tournament.');
        if (team.status.tag !== 'Ready') throw new SenderError(`Team is ${team.status.tag}; only Ready teams are grouped.`);

        // groupCount throws a plain Error below 1 (S8a review carry-over): validate first.
        if (tournament.groupSize < 2) throw new SenderError('groupSize must be at least 2.');
        const readyCount = [...ctx.db.TournamentTeam.tournament_id.filter(tournamentId)]
            .filter((t: any) => t.status.tag === 'Ready').length;
        const count = groupCount(readyCount, tournament.groupSize);
        if (groupIndex >= count) {
            throw new SenderError(`groupIndex must be below ${count} (${readyCount} Ready teams, groupSize ${tournament.groupSize}).`);
        }

        if (team.groupId !== groupIndex) {
            ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { groupId: groupIndex }, user.id));
            ctx.db.Tournament.id.update(updateWithAudit(ctx, tournament, { lastSeedChangeAt: ctx.timestamp }, user.id));
        }
    }
);

export const clear_team_groups = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
    },
    (ctx, { tournamentId }) => {
        const { user, tournament } = ensureManualGroups(ctx, tournamentId);
        let cleared = 0;
        for (const team of [...ctx.db.TournamentTeam.tournament_id.filter(tournamentId)]) {
            if (team.groupId !== undefined) {
                ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { groupId: undefined }, user.id));
                cleared++;
            }
        }
        if (cleared > 0) {
            ctx.db.Tournament.id.update(updateWithAudit(ctx, tournament, { lastSeedChangeAt: ctx.timestamp }, user.id));
        }
    }
);
