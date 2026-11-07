// ─── Tournament Check-In Reducer ──────────────────────────────────────────────
// A26: check-in is team-level, done by the team captain (or `participants` staff) in one click during the CheckIn
// stage. Per-member check-in and the per-member no-show prune are gone: at CheckIn → Seeding a team that was not
// checked in becomes Withdrawn and its members stay enrolled (helpers/tournamentHelpers.ts closeRegistration).

import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { hasTournamentPermission, TOURNAMENT_PERM_MESSAGES } from '../helpers/tournamentPermissions';
import { findEnrolled, findMembership, isTeamCheckedIn, updateEnrolled } from '../helpers/tournamentHelpers';

// ─── check_in_tournament ─────────────────────────────────────────────────────
// teamId omitted: the caller's own team, and the caller must be its captain.
// teamId given: the team's captain, or staff holding the participants permission.
// Every enrolled member (Registered) of the team becomes CheckedIn.

export const check_in_tournament = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        teamId: t.u32().optional(),
    },
    (ctx, { tournamentId, teamId }) => {
        const user = getAuthenticatedUser(ctx);

        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        if (tournament.stage.tag !== 'CheckIn') {
            throw new SenderError('Tournament is not in the CheckIn stage.');
        }

        let resolvedTeamId: number;
        if (teamId === undefined) {
            const ttm = findMembership(ctx, tournamentId, user.id);
            if (!ttm) throw new SenderError('You are not on a team in this tournament.');
            resolvedTeamId = ttm.teamId;
        } else {
            resolvedTeamId = teamId;
        }
        const team = ctx.db.TournamentTeam.id.find(resolvedTeamId);
        if (!team || team.tournamentId !== tournamentId) throw new SenderError('Team not found in this tournament.');
        if (team.captainUserId !== user.id) {
            if (teamId === undefined) throw new SenderError('Only the team captain can check the team in.');
            if (!hasTournamentPermission(ctx, user, tournament, 'participants')) {
                throw new SenderError(TOURNAMENT_PERM_MESSAGES.participants);
            }
        }
        if (team.status.tag !== 'Forming' && team.status.tag !== 'Ready') {
            throw new SenderError(`Team is ${team.status.tag}.`);
        }
        if (isTeamCheckedIn(ctx, tournamentId, team.id)) {
            throw new SenderError('Team is already checked in.');
        }

        for (const m of [...ctx.db.TournamentTeamMember.team_id.filter(team.id)]) {
            const enrolled = findEnrolled(ctx, tournamentId, m.userId);
            if (enrolled && enrolled.status.tag === 'Registered') {
                updateEnrolled(ctx, enrolled, { status: { tag: 'CheckedIn', value: {} } as any }, user.id);
            }
        }

        console.log(`[CHECK_IN] Team #${team.id} checked into tournament #${tournamentId} by #${user.id}`);
    }
);
