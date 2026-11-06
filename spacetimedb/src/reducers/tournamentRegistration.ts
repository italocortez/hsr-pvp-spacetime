import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { ensureTournamentAccess, transferTournamentCaptain } from '../helpers/tournamentHelpers';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { deleteUserInvitesForTournament } from '../helpers/calendarCascade';

// ─── register_for_tournament ──────────────────────────────────────────────────
// Registers the authenticated user in a tournament.
// Handles waitlist logic, approval requirements, and all registration validations.
// Per D-20: inserts TournamentEnrolled row. No team assignment on enrollment.
// Solo tournaments (teamSize=1) auto-create TournamentTeam + TournamentTeamMember.

export const register_for_tournament = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
    },
    (ctx, { tournamentId }) => {
        const user = getAuthenticatedUser(ctx);

        // Tournament must exist and be in Registration or Seeding stage
        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        if (tournament.stage.tag !== 'Registration' && tournament.stage.tag !== 'Seeding') {
            throw new SenderError('Tournament is not accepting registrations.');
        }

        // Player must not already be registered
        const existing = [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([tournamentId, user.id])][0];
        if (existing) {
            throw new SenderError('You are already registered for this tournament.');
        }

        // Check requireVerified
        if (tournament.requireVerified && user.isGuest) {
            throw new SenderError('This tournament requires a verified account. Link your Discord first.');
        }

        // Check requireRoster
        if (tournament.requireRoster) {
            const hasActiveAccount = [...ctx.db.HsrAccount.user_id.filter(user.id)].some((a: any) => a.isActive);
            if (!hasActiveAccount) {
                throw new SenderError('This tournament requires an active HSR account in your roster.');
            }
        }

        // MMR check deferred to Phase 5 — allow all participants for now
        // if (tournament.minimumMmr && tournament.minimumMmr > 0) { ... }

        // Count active (non-waitlisted) enrolled participants
        const activeCount = [...ctx.db.TournamentEnrolled.tournament_id.filter(tournamentId)]
            .filter((p: any) => !p.isWaitlisted).length;

        let isWaitlisted = false;
        if (activeCount >= tournament.maxParticipants) {
            if (tournament.waitlistEnabled) {
                isWaitlisted = true;
            } else {
                throw new SenderError('Tournament is full.');
            }
        }

        // Determine approval timestamp
        const approvedByToAt = tournament.requireApproval ? undefined : ctx.timestamp;

        // Insert TournamentEnrolled row (enrollment only, per D-20)
        // hsrAccountId removed (D-23): TournamentPlayerAccount is the source of truth for locked accounts
        ctx.db.TournamentEnrolled.insert(insertWithAudit(ctx, {
            tournamentId,
            userId: user.id,
            status: { tag: 'Registered', value: {} } as any,
            anonymousAlias: undefined,
            isWaitlisted,
            allowRandomTeamAssignment: false,
            approvedByToAt,
        }, user.id));

        // Auto-create TournamentTeam for solo tournaments (teamSize === 1)
        // Solo players are also "teams" for bracket purposes — the team is invisible to the user
        if (tournament.teamSize === 1) {
            const newTeam = ctx.db.TournamentTeam.insert(insertWithAudit(ctx, {
                id: 0,
                tournamentId,
                name: user.displayName,
                captainUserId: user.id,
                seedNumber: undefined,
            }, user.id));

            // Insert TournamentTeamMember row for the auto-created team (D-20)
            ctx.db.TournamentTeamMember.insert(insertWithAudit(ctx, {
                teamId: newTeam.id,
                userId: user.id,
                tournamentId,
            }, user.id));
        }

        // Lock in player's HSR accounts for this tournament (per D-21)
        // All accounts are locked — during tournament matches, pick validation
        // checks against these locked accounts, not whatever account is active at match time.
        const allAccounts = [...ctx.db.HsrAccount.user_id.filter(user.id)];
        for (const account of allAccounts) {
            ctx.db.TournamentPlayerAccount.insert(insertWithAudit(ctx, {
                tournamentId,
                userId: user.id,
                hsrAccountId: account.id,
            }, user.id));
        }
    }
);

// ─── withdraw_from_tournament ─────────────────────────────────────────────────
// Sets the enrolled participant's status to Withdrawn.
// Does NOT delete the TournamentEnrolled row (kept for audit/history).
// Deletes TournamentTeamMember row and handles captain-transfer (D-22).
// Only allowed in Registration or Seeding stage.

export const withdraw_from_tournament = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
    },
    (ctx, { tournamentId }) => {
        const user = getAuthenticatedUser(ctx);

        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        if (tournament.stage.tag !== 'Registration' && tournament.stage.tag !== 'Seeding') {
            throw new SenderError('Cannot withdraw during this stage. Contact the organizer to be disqualified.');
        }

        const enrolled = [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([tournamentId, user.id])][0];
        if (!enrolled) throw new SenderError('You are not registered for this tournament.');
        if (enrolled.status.tag === 'Withdrawn') throw new SenderError('Already withdrawn.');

        // Handle TournamentTeamMember removal and captain-transfer (D-22, D-23, D-24)
        const ttm = [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([tournamentId, user.id])][0];
        if (ttm) {
            const teamId = ttm.teamId;
            const team = ctx.db.TournamentTeam.id.find(teamId);

            if (team) {
                if (team.captainUserId === user.id) {
                    // Captain withdrawal: attempt captain-transfer first (D-22)
                    const transferred = transferTournamentCaptain(ctx, teamId, user.id, user.id);
                    // Delete the withdrawing captain's TTM row
                    ctx.db.TournamentTeamMember.delete(ttm);

                    if (!transferred) {
                        // No other members — destroy the team (D-24 enrolled stay enrolled)
                        // Delete pending requests for this team
                        for (const req of [...ctx.db.TournamentTeamRequest.team_id.filter(teamId)]) {
                            ctx.db.TournamentTeamRequest.delete(req);
                        }
                        ctx.db.TournamentTeam.id.delete(teamId);
                    }
                } else {
                    // Non-captain withdrawal: delete TTM row only (D-23)
                    ctx.db.TournamentTeamMember.delete(ttm);
                }
            } else {
                // Team not found, just delete the orphaned TTM row
                ctx.db.TournamentTeamMember.delete(ttm);
            }
        }

        // Clean up user's pending team requests in this tournament
        const teams = [...ctx.db.TournamentTeam.tournament_id.filter(tournamentId)];
        for (const team of teams) {
            const req = [...ctx.db.TournamentTeamRequest.by_team_and_user.filter([team.id, user.id])][0];
            if (req) ctx.db.TournamentTeamRequest.delete(req);
        }

        // Delete the withdrawing player's calendar invites for this tournament's scheduled matches (D-24)
        deleteUserInvitesForTournament(ctx, user.id, tournamentId);

        // Re-read enrolled row after potential TTM operations
        const current = [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([tournamentId, user.id])][0];
        if (!current) throw new SenderError('Enrolled record not found.');

        // Delete + re-insert pattern for composite PK table — update status to Withdrawn
        ctx.db.TournamentEnrolled.delete(current);
        ctx.db.TournamentEnrolled.insert(updateWithAudit(ctx, current, {
            status: { tag: 'Withdrawn', value: {} } as any,
        }, user.id));

        // Clean up locked accounts on withdrawal
        const lockedAccounts = [...ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([tournamentId, user.id])];
        for (const la of lockedAccounts) {
            ctx.db.TournamentPlayerAccount.delete(la);
        }
    }
);

// ─── approve_participant ──────────────────────────────────────────────────────
// Approves a pending tournament participant (sets approvedByToAt).
// Permission: TO/Assistant/Mod+

export const approve_participant = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        userId: t.u32(),
    },
    (ctx, { tournamentId, userId }) => {
        const { user } = ensureTournamentAccess(ctx, tournamentId);

        const enrolled = [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([tournamentId, userId])][0];
        if (!enrolled) throw new SenderError('Participant not found.');
        if (enrolled.approvedByToAt !== undefined) {
            throw new SenderError('Participant is already approved.');
        }

        // Delete + re-insert pattern for composite PK table
        ctx.db.TournamentEnrolled.delete(enrolled);
        ctx.db.TournamentEnrolled.insert(updateWithAudit(ctx, enrolled, {
            approvedByToAt: ctx.timestamp,
        }, user.id));
    }
);

// ─── waitlist_promote ─────────────────────────────────────────────────────────
// Moves a waitlisted participant into the active participant list.
// Permission: TO/Assistant/Mod+

export const waitlist_promote = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        userId: t.u32(),
    },
    (ctx, { tournamentId, userId }) => {
        const { user } = ensureTournamentAccess(ctx, tournamentId);

        const enrolled = [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([tournamentId, userId])][0];
        if (!enrolled) throw new SenderError('Participant not found.');
        if (!enrolled.isWaitlisted) {
            throw new SenderError('Participant is not on the waitlist.');
        }

        // Delete + re-insert pattern for composite PK table
        // Promoting from waitlist implies approval — TO explicitly chose this person
        ctx.db.TournamentEnrolled.delete(enrolled);
        ctx.db.TournamentEnrolled.insert(updateWithAudit(ctx, enrolled, {
            isWaitlisted: false,
            approvedByToAt: enrolled.approvedByToAt ?? ctx.timestamp,
        }, user.id));
    }
);
