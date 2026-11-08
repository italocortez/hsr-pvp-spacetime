import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { ensureModerator } from '@module/helpers/identity/ensurePermissions';
import { ensureTournamentPermission } from '@module/helpers/tournament/tournamentPermissions';
import { findEnrolled, findMembership, refreshTeamStatus, transferTournamentCaptain, updateEnrolled } from '@module/helpers/tournament/tournamentHelpers';
import { applyBracketResult, matchGames, recordGameSettled, rollbackBracketResult, writeMatchGames } from '@module/helpers/tournament/bracketResults';
import { recordWinnerTeamId, voidTournamentLobby } from '@module/helpers/tournament/tournamentResults';
import { setSlotBye, settle } from '@module/helpers/tournament/bracketStore';
import { teamSideOf } from '@module/helpers/tournament/matchSides';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { deleteCalendarEventForBracketMatch } from '@module/helpers/calendar/calendarCascade';
import { performConcede } from '@module/reducers/results/concede';

// Valid override status tags
const VALID_OVERRIDE_STATUSES = ['Validated', 'Rejected'];

// Active lobby stages where players are engaged in the match
const ACTIVE_LOBBY_STAGES = new Set(['Drafting', 'Equipping', 'Scoring']);

// ─── dq_participant ───────────────────────────────────────────────────────────
// Disqualifies a tournament participant (A25 `participants`; A26, A26a(2), A23, D-21, D-25, D-26).
//   - The enrolment becomes Disqualified (row kept: excluded from capacity, blocks re-registration).
//   - The player leaves the team (captain transferred to the lowest remaining user id, D-21); with
//     `dqWholeTeam` every member of the player's team is disqualified and leaves it.
//   - A team left empty becomes Disqualified (the team row stays for the bracket record, TD-18). In Seeding
//     after generation that stamps lastSeedChangeAt, so the bracket must be regenerated before InProgress.
//   - InProgress: every open match of the disqualified team is settled through the single writer (A23):
//     Ready -> applyBracketResult(opponent, decidedBy Dq, the derived tally, A67(4)); Pending (opponent not known yet) -> the team's
//     slot becomes a BYE and `settle` walks the opponent over once it arrives. Repeated until the team holds
//     no open slot (a double-elimination loss routes it into the losers bracket first).
//   - Live lobby of the team: Drafting / Equipping / Scoring -> force-concede on the last member (D-25; A54: the
//     lobby's record becomes the Validated concede record, the bracket is already settled by the DQ, and the lobby
//     parks until the finalize job). A68(6): a player DQ'd from a team that plays on is not removed from the live
//     lobby (the D-25 kick is gone): the current game plays on with them, and the DQ bites from the next lobby
//     (team membership gone, allowedSlotsFor seats nobody who is not on a team).
//     A67(1): the between-games stages are gone, so the D-26 hard-delete branch is too.

/** Settles every open bracket slot of a disqualified team (see dq_participant). */
function settleDisqualifiedTeam(ctx: any, tournamentId: number, teamId: number, actorId: number): void {
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
                changed = true;
            } else if (row.state.tag === 'Pending') {
                setSlotBye(ctx, row.id, slot, actorId);
                settle(ctx, tournamentId, actorId);
                changed = true;
            }
        }
    }
}

export const dq_participant = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        userId: t.u32(),
        reason: t.string(),
        dqWholeTeam: t.bool().optional(),
    },
    (ctx, { tournamentId, userId, reason, dqWholeTeam }) => {
        const { user, tournament } = ensureTournamentPermission(ctx, tournamentId, 'participants');

        const enrolled = findEnrolled(ctx, tournamentId, userId);
        if (!enrolled) {
            throw new SenderError('Participant not found in this tournament.');
        }
        if (enrolled.status.tag === 'Disqualified') {
            throw new SenderError('Participant is already disqualified.');
        }
        if (enrolled.status.tag === 'Withdrawn') {
            throw new SenderError('Cannot disqualify a participant who has already withdrawn.');
        }

        updateEnrolled(ctx, enrolled, { status: { tag: 'Disqualified', value: {} } as any }, user.id);
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
                if (other && other.status.tag !== 'Disqualified' && other.status.tag !== 'Withdrawn') {
                    updateEnrolled(ctx, other, { status: { tag: 'Disqualified', value: {} } as any }, user.id);
                }
            }
            if (!dqWholeTeam && team && team.captainUserId === member.userId) {
                transferTournamentCaptain(ctx, teamId, member.userId, user.id); // D-21
            }
            ctx.db.TournamentTeamMember.delete(member);
        }

        const isTeamOut = [...ctx.db.TournamentTeamMember.team_id.filter(teamId)].length === 0;

        if (isTeamOut && team) {
            const current = ctx.db.TournamentTeam.id.find(teamId)!;
            ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, current, {
                status: { tag: 'Disqualified', value: {} } as any,
            }, user.id));

            if (tournament.stage.tag === 'Seeding' && tournament.bracketGeneratedAt !== undefined) {
                ctx.db.Tournament.id.update(updateWithAudit(ctx, tournament, { lastSeedChangeAt: ctx.timestamp }, user.id));
            }
            if (tournament.stage.tag === 'InProgress') {
                settleDisqualifiedTeam(ctx, tournamentId, teamId, user.id);
            }

            if (activeLobby) {
                const { lobby, bracketMatch } = activeLobby;
                // DQ during active draft/scoring: force-concede (D-25); the bracket is already settled
                // above, so the concede's hand-off is skipped (match no longer Ready).
                const losingTeamSide = teamSideOf(bracketMatch, teamId)!; // A70(1): the colour the DQ'd team plays
                performConcede(
                    ctx,
                    lobby,
                    losingTeamSide,
                    user.id,
                    { tag: 'RefereeDecision', value: {} } as any,
                    undefined
                );
                // A67(4): the concede's record is Validated after the Dq decision, so the stored tally is
                // rewritten from the records (decidedBy stays Dq).
                writeMatchGames(ctx, bracketMatch.id, user.id);
            }
        } else {
            // A26 / A26a(3): before generation the team may drop below teamSize (Ready -> Forming); once the bracket
            // is generated a team that still has members keeps its status and plays with stand-ins.
            if (tournament.bracketGeneratedAt === undefined) refreshTeamStatus(ctx, tournament, teamId, user.id);
            // A68(6): no kick from a live lobby; the game plays on and the DQ takes effect from the next lobby.
        }
    }
);

// ─── override_match_result ────────────────────────────────────────────────────
// Overrides a match result status (Validated or Rejected).
// Per D-30, D-31, D-42:
//   - Uses winnerTeamSide instead of winnerUserId.
//   - Uses matchEndReason instead of matchOutcome.
//   - Derives tournamentId from bracketMatch.tournamentId (no tournamentId column on MatchResultRecord).
// Permission: results (A25) for tournament matches; Moderator+ for non-tournament matches.
// A24(1)(3), A67(4), TD-13/14, for a tournament record, the tournament InProgress, the record Submitted / Disputed /
// Validated (not Voided), its lobby still present:
//   - A Decided bracket match is reverted first (rollbackBracketResult without voiding: every Validated game record
//     and its lobby stay; refused while a downstream match is Decided, "roll that back first"), then the record is
//     overridden and recordGameSettled re-decides the match from the new tally (TD-13/14: override = rollback +
//     re-apply through the single writer).
//   - Validated(winner): the record becomes Validated (Completed, settledAt) for that side; the lobby stays parked.
//     The derived tally is recomputed and the decide check re-runs (recordGameSettled, decidedBy Staff): the match
//     is decided when a side reaches ceil(bestOf / 2).
//   - Rejected: the lobby is voided (record kept as Rejected for audit, lobby hard-deleted so a replay lobby can be
//     made, A24(3)), then the tally is recomputed without the record (recordGameSettled).
// Standalone records keep the old behaviour (status / winner / end reason written on the record only).

export const override_match_result = spacetimedb.reducer(
    {
        matchResultId: t.u32(),
        newStatusTag: t.string(),
        winnerTeamSideTag: t.string(), // 'Blue' or 'Red' for Validated (A31: no draws); ignored for Rejected
        reason: t.string(),
    },
    (ctx, { matchResultId, newStatusTag, winnerTeamSideTag, reason }) => {
        // Validate newStatusTag before permission check
        if (!VALID_OVERRIDE_STATUSES.includes(newStatusTag)) {
            throw new SenderError(`Invalid status override: "${newStatusTag}". Must be one of: ${VALID_OVERRIDE_STATUSES.join(', ')}`);
        }

        // Find the MatchResultRecord
        const matchResult = ctx.db.MatchResultRecord.id.find(matchResultId);
        if (!matchResult) {
            throw new SenderError('Match result not found.');
        }

        // Check permission based on whether it's a tournament match (D-42: derive via bracketMatch)
        let actingUserId: number;
        if (matchResult.isTournamentControlled && matchResult.bracketMatchId !== undefined) {
            // Derive tournament from bracketMatch (no tournamentId column, per D-42)
            const bracketMatch = ctx.db.BracketMatch.id.find(matchResult.bracketMatchId);
            if (bracketMatch) {
                const { user } = ensureTournamentPermission(ctx, bracketMatch.tournamentId, 'results');
                actingUserId = user.id;
            } else {
                // Bracket match not found — fall back to moderator check
                const user = ensureModerator(ctx);
                actingUserId = user.id;
            }
        } else {
            // Non-tournament match: only Moderator/Admin can override
            const user = ensureModerator(ctx);
            actingUserId = user.id;
        }

        // For Validated: winnerTeamSideTag must be 'Blue' or 'Red' (A31: no draws, a Validated result
        // always has a winner; this is how staff resolve an A39 Disputed tie override).
        let winnerTeamSide: any = undefined;
        if (newStatusTag === 'Validated') {
            if (winnerTeamSideTag === 'Blue') {
                winnerTeamSide = { tag: 'Blue', value: {} };
            } else if (winnerTeamSideTag === 'Red') {
                winnerTeamSide = { tag: 'Red', value: {} };
            } else {
                throw new SenderError('Invalid winnerTeamSideTag: a Validated result needs "Blue" or "Red" (no draws).');
            }
        }

        // For Ranked matches being validated: require all screenshots (per D-07)
        if (newStatusTag === 'Validated' && matchResult.matchType.tag === 'Ranked') {
            const games = [...ctx.db.MatchResultGame.match_result_id.filter(matchResultId)];
            if (games.length === 0) {
                throw new SenderError('Cannot validate: no game scores have been recorded.');
            }
            for (const game of games) {
                if (!game.teamBlueScreenshotUrl || !game.teamRedScreenshotUrl) {
                    throw new SenderError(
                        'Cannot validate Ranked match: the game is missing screenshot(s). ' +
                        'The game must have both teamBlueScreenshotUrl and teamRedScreenshotUrl.'
                    );
                }
            }
        }

        // A24(1)(3): a tournament record goes through the bracket's single writer (see the header).
        const bracketMatch = matchResult.isTournamentControlled && matchResult.bracketMatchId !== undefined
            ? ctx.db.BracketMatch.id.find(matchResult.bracketMatchId)
            : undefined;
        if (bracketMatch) {
            const tournament = ctx.db.Tournament.id.find(bracketMatch.tournamentId);
            if (!tournament || tournament.stage.tag !== 'InProgress') throw new SenderError('Tournament is not in progress.');
            if (matchResult.status.tag === 'Voided') throw new SenderError('This result was voided by a rollback.');
            // S8d review: only a submitted, disputed or validated result of a parked lobby (a Pending record belongs to a
            // match still being played; a voided lobby has nothing left to finalize).
            if (!['Submitted', 'Disputed', 'Validated'].includes(matchResult.status.tag)) {
                throw new SenderError(`Only a Submitted, Disputed or Validated tournament result can be overridden (this one is ${matchResult.status.tag}).`);
            }
            if (!ctx.db.Lobby.id.find(matchResult.lobbyId)) {
                throw new SenderError('The match lobby no longer exists; use resolve_bracket_match.');
            }
            // A67(4), TD-13/14: a decided match is reverted (no game voided) before any of its games is overridden;
            // recordGameSettled below re-decides it from the new tally.
            if (bracketMatch.state.tag === 'Decided') {
                rollbackBracketResult(ctx, bracketMatch.id, actingUserId, false, false);
            }
        }

        // Update the MatchResultRecord using winnerTeamSide + matchEndReason (D-30, D-31)
        ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, matchResult, {
            status: { tag: newStatusTag, value: {} } as any,
            winnerTeamSide: newStatusTag === 'Validated' ? winnerTeamSide : undefined,
            // A31: a Validated result always has a winner (checked above).
            matchEndReason: newStatusTag === 'Validated'
                ? { tag: 'Completed', value: {} } as any
                : matchResult.matchEndReason,
            disputeReason: reason, // Reuse disputeReason field to store override reason
            ...(newStatusTag === 'Validated' ? { settledAt: ctx.timestamp } : {}),
        }, actingUserId));

        if (bracketMatch) {
            const updated = ctx.db.MatchResultRecord.id.find(matchResultId)!;
            if (newStatusTag === 'Validated') {
                if (recordWinnerTeamId(bracketMatch, updated) === undefined) throw new SenderError('The bracket match has no team on that side.');
            } else {
                if (ctx.db.Lobby.id.find(updated.lobbyId)) voidTournamentLobby(ctx, updated.lobbyId, actingUserId);
                // voidTournamentLobby marks the record Voided; keep the Rejected status the caller asked for.
                const kept = ctx.db.MatchResultRecord.id.find(matchResultId);
                if (kept && kept.status.tag !== 'Rejected') {
                    ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, kept, { status: { tag: 'Rejected', value: {} } as any }, actingUserId));
                }
            }
            // A67(4): recompute the derived tally and re-run the decide check (a Ready match only).
            recordGameSettled(ctx, ctx.db.MatchResultRecord.id.find(matchResultId)!, 'Staff', actingUserId);
        }

        console.log(`[MATCH] Match result #${matchResultId} overridden to "${newStatusTag}" by user #${actingUserId}: ${reason}`);
    }
);

// ─── assign_tournament_assistant ─────────────────────────────────────────────
// Assigns or updates a tournament assistant with the three A25 flags. Permission: owner (A25; assistants never
// manage assistants). Kept semantics: an existing row for the user is updated in place (upsert, pre-S8b
// behaviour); the caller cannot assign themself (so an organizer cannot list themself; a Moderator may still list
// the organizer, whose flags then change nothing because the organizer already holds every permission).

export const assign_tournament_assistant = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        userId: t.u32(),
        canManageParticipants: t.bool(),
        canManageBracket: t.bool(),
        canResolveResults: t.bool(),
    },
    (ctx, { tournamentId, userId, canManageParticipants, canManageBracket, canResolveResults }) => {
        const { user: callerUser } = ensureTournamentPermission(ctx, tournamentId, 'owner');
        const flags = { canManageParticipants, canManageBracket, canResolveResults };

        // Validate the target user exists
        const targetUser = ctx.db.User.id.find(userId);
        if (!targetUser) {
            throw new SenderError('Target user not found.');
        }

        // Cannot assign yourself as an assistant
        if (userId === callerUser.id) {
            throw new SenderError('You cannot assign yourself as a tournament assistant.');
        }

        // Check if assistant row already exists (upsert pattern)
        const existing = [...ctx.db.TournamentAssistant.by_tournament_and_user.filter([tournamentId, userId])][0];

        if (existing) {
            // Delete + re-insert with updated permissions
            ctx.db.TournamentAssistant.delete(existing);
            ctx.db.TournamentAssistant.insert(updateWithAudit(ctx, existing, flags, callerUser.id));
            console.log(`[TOURNAMENT] Updated assistant #${userId} permissions for tournament #${tournamentId}`);
        } else {
            // Insert new assistant row
            ctx.db.TournamentAssistant.insert(insertWithAudit(ctx, {
                id: 0,
                tournamentId,
                userId,
                ...flags,
            }, callerUser.id));
            console.log(`[TOURNAMENT] Assigned user #${userId} as assistant for tournament #${tournamentId}`);
        }
    }
);

// ─── remove_tournament_assistant ─────────────────────────────────────────────
// Removes a tournament assistant. Permission: owner (A25).

export const remove_tournament_assistant = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        userId: t.u32(),
    },
    (ctx, { tournamentId, userId }) => {
        const { user: callerUser } = ensureTournamentPermission(ctx, tournamentId, 'owner');

        // Find the assistant row
        const assistant = [...ctx.db.TournamentAssistant.by_tournament_and_user.filter([tournamentId, userId])][0];
        if (!assistant) {
            throw new SenderError('Tournament assistant not found.');
        }

        // Delete the assistant row
        ctx.db.TournamentAssistant.delete(assistant);

        console.log(`[TOURNAMENT] Removed assistant #${userId} from tournament #${tournamentId} by user #${callerUser.id}`);
    }
);

// ─── mod_promote_to_host ──────────────────────────────────────────────────────
// Promotes a User-role account to TournamentHost.
// Permission: Moderator or Admin only.
// Constraint: can only promote from User role (not TournamentHost or higher).

export const mod_promote_to_host = spacetimedb.reducer(
    {
        userId: t.u32(),
    },
    (ctx, { userId }) => {
        const moderator = ensureModerator(ctx);

        // Find the target user
        const targetUser = ctx.db.User.id.find(userId);
        if (!targetUser) {
            throw new SenderError('Target user not found.');
        }

        // Cannot promote yourself
        if (userId === moderator.id) {
            throw new SenderError('You cannot change your own role via this reducer.');
        }

        // Validate target role is User (promoting User → TournamentHost only)
        if (targetUser.role.tag !== 'User') {
            throw new SenderError(
                `Can only promote users with the "User" role to TournamentHost. Current role: ${targetUser.role.tag}`
            );
        }

        // Update user role to TournamentHost
        ctx.db.User.id.update(updateWithAudit(ctx, targetUser, {
            role: { tag: 'TournamentHost', value: {} } as any,
        }, moderator.id));

        console.log(`[ADMIN] User #${userId} promoted to TournamentHost by moderator #${moderator.id}`);
    }
);

// ─── mod_demote_from_host ─────────────────────────────────────────────────────
// Demotes a TournamentHost back to User.
// Permission: Moderator or Admin only.
// Constraint: can only demote from TournamentHost role (not other roles).

export const mod_demote_from_host = spacetimedb.reducer(
    {
        userId: t.u32(),
    },
    (ctx, { userId }) => {
        const moderator = ensureModerator(ctx);

        // Find the target user
        const targetUser = ctx.db.User.id.find(userId);
        if (!targetUser) {
            throw new SenderError('Target user not found.');
        }

        // Cannot demote yourself
        if (userId === moderator.id) {
            throw new SenderError('You cannot change your own role via this reducer.');
        }

        // Validate target role is TournamentHost (demoting TournamentHost → User only)
        if (targetUser.role.tag !== 'TournamentHost') {
            throw new SenderError(
                `Can only demote users with the "TournamentHost" role to User. Current role: ${targetUser.role.tag}`
            );
        }

        // Update user role to User
        ctx.db.User.id.update(updateWithAudit(ctx, targetUser, {
            role: { tag: 'User', value: {} } as any,
        }, moderator.id));

        console.log(`[ADMIN] User #${userId} demoted from TournamentHost to User by moderator #${moderator.id}`);
    }
);
