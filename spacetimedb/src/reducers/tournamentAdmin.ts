import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { ensureModerator } from '../helpers/ensurePermissions';
import { ensureTournamentPermission } from '../helpers/tournamentPermissions';
import { transferTournamentCaptain } from '../helpers/tournamentHelpers';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { deleteCalendarEventForBracketMatch } from '../helpers/calendarCascade';
import { performConcede } from './concede';
import { hardDeleteLobby } from './lobbyGc';

// Valid override status tags
const VALID_OVERRIDE_STATUSES = ['Validated', 'Rejected'];

// Active lobby stages where players are engaged in the match
const ACTIVE_LOBBY_STAGES = new Set(['Drafting', 'Equipping', 'Scoring']);

// ─── dq_participant ───────────────────────────────────────────────────────────
// Disqualifies a tournament participant.
// Per D-21, D-22, D-23, D-25, D-26, D-27:
//   - Updates TournamentEnrolled status to Disqualified.
//   - Deletes TournamentTeamMember row.
//   - Captain DQ: transfer captain to lowest-userId remaining member.
//   - Last member DQ: destroy team, auto-advance opponent.
//   - DQ during active lobby (Drafting/Equipping/Scoring): kick + force-concede on last member.
//   - DQ during Shelved/BetweenGames: remove TTM row, hard-delete lobby on last member.
// Permission: participants (A25). S8c moves the advancement onto applyBracketResult.

export const dq_participant = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        userId: t.u32(),
        reason: t.string(),
    },
    (ctx, { tournamentId, userId, reason }) => {
        const { user } = ensureTournamentPermission(ctx, tournamentId, 'participants');

        // Find the TournamentEnrolled row
        const enrolled = [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([tournamentId, userId])][0];
        if (!enrolled) {
            throw new SenderError('Participant not found in this tournament.');
        }

        // Validate participant is not already Disqualified or Withdrawn
        if (enrolled.status.tag === 'Disqualified') {
            throw new SenderError('Participant is already disqualified.');
        }
        if (enrolled.status.tag === 'Withdrawn') {
            throw new SenderError('Cannot disqualify a participant who has already withdrawn.');
        }

        // Update status to Disqualified (delete + insert for composite PK)
        ctx.db.TournamentEnrolled.delete(enrolled);
        ctx.db.TournamentEnrolled.insert(updateWithAudit(ctx, enrolled, {
            status: { tag: 'Disqualified', value: {} } as any,
        }, user.id));

        console.log(`[TOURNAMENT] Participant #${userId} disqualified from tournament #${tournamentId}: ${reason}`);

        // Find team membership via TournamentTeamMember
        const ttm = [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([tournamentId, userId])][0];
        if (!ttm) {
            // Player not on a team — nothing more to do
            return;
        }

        const teamId = ttm.teamId;
        const team = ctx.db.TournamentTeam.id.find(teamId);

        // Check for active/shelved lobby involving this team (D-25, D-26)
        let activeLobby: any = undefined;
        if (team) {
            const bracketMatches = [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)];
            for (const bm of bracketMatches) {
                if (bm.team1Id !== teamId && bm.team2Id !== teamId) continue;
                // Check if there's a lobby for this bracket match in active/shelved stages
                for (const lobby of ctx.db.Lobby.iter()) {
                    if (lobby.bracketMatchId === bm.id &&
                        (ACTIVE_LOBBY_STAGES.has(lobby.stage.tag) ||
                         lobby.stage.tag === 'BetweenGames' ||
                         lobby.stage.tag === 'Shelved')) {
                        activeLobby = { lobby, bracketMatch: bm };
                        break;
                    }
                }
                if (activeLobby) break;
            }
        }

        // Captain DQ: transfer captain first (D-21)
        if (team && team.captainUserId === userId) {
            transferTournamentCaptain(ctx, teamId, userId, user.id);
        }

        // Delete DQ'd user's TournamentTeamMember row
        ctx.db.TournamentTeamMember.delete(ttm);

        // Check if team is now empty (last member DQ'd)
        const remainingMembers = [...ctx.db.TournamentTeamMember.team_id.filter(teamId)];
        const isLastMember = remainingMembers.length === 0;

        if (isLastMember && team) {
            // Destroy the team
            ctx.db.TournamentTeam.id.delete(teamId);

            if (activeLobby) {
                const { lobby, bracketMatch } = activeLobby;
                if (ACTIVE_LOBBY_STAGES.has(lobby.stage.tag)) {
                    // DQ during active draft/scoring — force-concede (D-25)
                    // Determine which team side the DQ'd team is
                    const losingTeamSide = bracketMatch.team1Id === teamId ? 'Blue' : 'Red';
                    performConcede(
                        ctx,
                        lobby,
                        losingTeamSide,
                        user.id,
                        { tag: 'RefereeDecision', value: {} } as any,
                        undefined
                    );
                } else {
                    // DQ during Shelved or BetweenGames — hard-delete lobby (D-26)
                    hardDeleteLobby(ctx, lobby.id);
                }
            } else {
                // Auto-advance opponent in bracket if tournament is InProgress (D-27)
                // S8 (A23/A24): the inline advancement is deleted; dq_participant settles the match through
                // applyBracketResult with decidedBy Dq. The auto-advance flag was dropped (A36).
                const tournament = ctx.db.Tournament.id.find(tournamentId);
                if (tournament && tournament.stage.tag === 'InProgress') {
                    const bracketMatches = [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)];
                    const activeMatch = bracketMatches.find((m: any) =>
                        !m.winnerTeamId &&
                        (m.team1Id === teamId || m.team2Id === teamId)
                    );

                    if (activeMatch) {
                        // Delete calendar event for the active bracket match being resolved (D-22)
                        deleteCalendarEventForBracketMatch(ctx, activeMatch.id);

                        // Determine the opponent (the one who isn't DQ'd)
                        const opponentTeamId = activeMatch.team1Id === teamId
                            ? activeMatch.team2Id
                            : activeMatch.team1Id;

                        if (opponentTeamId) {
                            // Set opponent as winner
                            ctx.db.BracketMatch.id.update(updateWithAudit(ctx, activeMatch, {
                                winnerTeamId: opponentTeamId,
                                state: { tag: 'Decided', value: {} } as any,
                            }, user.id));

                            // Place opponent in next match
                            if (activeMatch.nextWinnerMatchId) {
                                const nextMatch = ctx.db.BracketMatch.id.find(activeMatch.nextWinnerMatchId);
                                if (nextMatch) {
                                    if (!nextMatch.team1Id) {
                                        ctx.db.BracketMatch.id.update(
                                            updateWithAudit(ctx, nextMatch, { team1Id: opponentTeamId }, user.id),
                                        );
                                    } else if (!nextMatch.team2Id) {
                                        ctx.db.BracketMatch.id.update(
                                            updateWithAudit(ctx, nextMatch, { team2Id: opponentTeamId }, user.id),
                                        );
                                    }
                                }
                            }

                            console.log(`[TOURNAMENT] Auto-advanced team #${opponentTeamId} after DQ of team #${teamId} in match #${activeMatch.id}`);
                        }
                    }
                }
            }
        } else if (activeLobby && ACTIVE_LOBBY_STAGES.has(activeLobby.lobby.stage.tag)) {
            // Captain DQ during active lobby but team has other members — kick DQ'd player from lobby (D-25)
            const lobbyMember = [...ctx.db.LobbyMember.lobby_id.filter(activeLobby.lobby.id)]
                .find((m: any) => m.userId === userId);
            if (lobbyMember) {
                ctx.db.LobbyMember.delete(lobbyMember);
            }
        }
    }
);

// ─── override_match_result ────────────────────────────────────────────────────
// Overrides a match result status (Validated or Rejected).
// Per D-30, D-31, D-42:
//   - Uses winnerTeamSide instead of winnerUserId.
//   - Uses matchEndReason instead of matchOutcome.
//   - Derives tournamentId from bracketMatch.tournamentId (no tournamentId column on MatchResultRecord).
// Permission: results (A25) for tournament matches; Moderator+ for non-tournament matches. S8d replaces it.

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
                        `Cannot validate Ranked match: game ${game.gameNumber} is missing screenshot(s). ` +
                        'All games must have both teamBlueScreenshotUrl and teamRedScreenshotUrl.'
                    );
                }
            }
        }

        // Update the MatchResultRecord using winnerTeamSide + matchEndReason (D-30, D-31)
        ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, matchResult, {
            status: { tag: newStatusTag, value: {} } as any,
            winnerTeamSide: newStatusTag === 'Validated' ? winnerTeamSide : undefined,
            // A31: a Validated result always has a winner (checked above). S8 (A24): override_match_result is
            // replaced by resolve_bracket_match / rollback_bracket_match through the single writer.
            matchEndReason: newStatusTag === 'Validated'
                ? { tag: 'Completed', value: {} } as any
                : matchResult.matchEndReason,
            disputeReason: reason, // Reuse disputeReason field to store override reason
        }, actingUserId));

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
