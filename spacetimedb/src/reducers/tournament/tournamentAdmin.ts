import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { ensureModerator } from '@module/helpers/identity/ensurePermissions';
import { ensureTournamentPermission } from '@module/helpers/tournament/tournamentPermissions';
import { ensureGroupMatchOpen, recordGameSettled, rollbackBracketResult, tallyWinner } from '@module/helpers/tournament/bracketResults';
import { recordWinnerTeamId, voidTournamentLobby } from '@module/helpers/tournament/tournamentResults';
import { disqualifyParticipant } from '@module/helpers/tournament/disqualification';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { removeUserStandIns } from '@module/helpers/tournament/standIns';

// Valid override status tags
const VALID_OVERRIDE_STATUSES = ['Validated', 'Rejected'];

// ─── dq_participant ───────────────────────────────────────────────────────────
// Disqualifies a tournament participant (A25 `participants`; A26, A26a(2), A23, A68(6), D-21, D-25, D-26). The body
// is disqualifyParticipant (helpers/tournament/disqualification.ts), shared with the user-deletion cascade (A94(2)).
// S10g: Registration through InProgress only (audit #8: no DQ in Draft, Completed or Cancelled); the unsettled lobbies
// of every match the DQ settles are voided (audit #2, A68(6)).

export const dq_participant = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        userId: t.u32(),
        reason: t.string(),
        dqWholeTeam: t.bool().optional(),
    },
    (ctx, { tournamentId, userId, reason, dqWholeTeam }) => {
        const { user, tournament } = ensureTournamentPermission(ctx, tournamentId, 'participants');
        disqualifyParticipant(ctx, tournament, userId, reason, dqWholeTeam ?? false, user.id);
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
//     re-apply through the single writer). S10g: a group match is refused once the elimination bracket exists
//     (audit #5), and so is a match decided by DQ, or by staff for a team the tally does not give (audit #4: such a
//     decision cannot be re-derived from the tally; "roll the match back first").
//   - Validated(winner): the record becomes Validated (Completed, settledAt) for that side; the lobby stays parked.
//     The derived tally is recomputed and the decide check re-runs (recordGameSettled, decidedBy Staff): the match
//     is decided when a side reaches ceil(bestOf / 2).
//   - Rejected: the lobby is voided (record kept as Rejected for audit, lobby hard-deleted so a replay lobby can be
//     made, A24(3)), then the tally is recomputed without the record (recordGameSettled).
// Standalone records keep the old behaviour (status / winner / end reason written on the record only), behind the
// same status rule (S10f, results audit #8: not Voided; Submitted / Disputed / Validated) and a present lobby in
// AwaitingResult.

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
            ensureGroupMatchOpen(ctx, bracketMatch); // S10g (audit #5)
            // A67(4), TD-13/14: a decided match is reverted (no game voided) before any of its games is overridden;
            // recordGameSettled below re-decides it from the new tally.
            // S10g (audit #4): only a decision the tally gives can be re-derived that way. A DQ decision, or a staff
            // decision the tally does not give (resolve_bracket_match), is refused: the match is rolled back first.
            if (bracketMatch.state.tag === 'Decided') {
                const tag = bracketMatch.decidedBy?.tag;
                const fromTally = tallyWinner(ctx, bracketMatch) === bracketMatch.winnerTeamId;
                if (tag === 'Dq' || (tag === 'Staff' && !fromTally)) {
                    throw new SenderError('This match was decided by staff or a disqualification; roll the match back first (rollback_bracket_match).');
                }
                rollbackBracketResult(ctx, bracketMatch.id, actingUserId, false, false);
            }
        } else {
            // Results audit #8 (S10f): a standalone record gets the same status rule as the tournament branch (not
            // Voided; Submitted, Disputed or Validated, so a Pending record of a match still being played is refused),
            // and its lobby must be present and parked in AwaitingResult (the stage the game close moves it to; a live
            // draft is never overridden).
            if (matchResult.status.tag === 'Voided') throw new SenderError('This result was voided.');
            if (!['Submitted', 'Disputed', 'Validated'].includes(matchResult.status.tag)) {
                throw new SenderError(`Only a Submitted, Disputed or Validated result can be overridden (this one is ${matchResult.status.tag}).`);
            }
            const lobby = ctx.db.Lobby.id.find(matchResult.lobbyId);
            if (!lobby) throw new SenderError('The match lobby no longer exists.');
            if (lobby.stage.tag !== 'AwaitingResult') {
                throw new SenderError('Only the result of a match waiting for its result (AwaitingResult) can be overridden.');
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
            staffOverrideReason: reason, // S11a (L49): its own column; the player's disputeReason is kept
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
// the organizer, whose flags then change nothing because the organizer already holds every permission). A113(6): a
// guest target is refused.

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
        // A113(6) (S10m): staff are verified users (the approve_stand_in rule).
        if (targetUser.isGuest) {
            throw new SenderError('A tournament assistant must be a verified user.');
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
        // S10v review F3 (A135(2)): staff never stand in; the new assistant's approvals in the tournament go.
        removeUserStandIns(ctx, tournamentId, userId, callerUser.id);
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
