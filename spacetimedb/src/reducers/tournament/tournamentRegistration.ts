import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { ensureTournamentPermission } from '@module/helpers/tournament/tournamentPermissions';
import {
    capacityCount,
    createSoloTeam,
    ensureBeforeGeneration,
    ensureNotEnrolled,
    findEnrolled,
    findMembership,
    hasPlayedTournamentGame,
    lockAccountsAtPromotion,
    lockPlayerAccounts,
    normalizeAlias,
    refreshTeamOf,
    rememberWaitlistAccounts,
    removeEnrolment,
    soloTeamName,
    updateEnrolled,
} from '@module/helpers/tournament/tournamentHelpers';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { consumeTournamentAllowance } from '@module/helpers/lobby/abuseControls';

const unit = (tag: string) => ({ tag, value: {} }) as any;

/**
 * A36b: the player's MmrRating for the tournament's game mode in the active season, else EloConfig.initialRating.
 * S10g (audit #6): the active season is resolved the way the rating writer does (finalizationHelpers: the Season row
 * with isActive, else 0); Tournament.seasonId (always 0) is not read.
 */
function ensureMinimumMmr(ctx: any, tournament: any, user: any): void {
    if (!tournament.minimumMmr) return;
    if (user.isGuest) throw new SenderError('Guests cannot join a tournament with a minimum MMR.');
    const activeSeason = [...ctx.db.Season.is_active.filter(true)][0];
    const seasonId = activeSeason ? activeSeason.id : 0;
    const row = [...ctx.db.MmrRating.by_user_mode_season.filter([user.id, tournament.defaultGameMode, seasonId])][0];
    let rating: number;
    if (row) {
        rating = row.rating;
    } else {
        // Read the config row the way finalizationHelpers.processMatchMmr does.
        const config = ctx.db.EloConfigTable.id.find(1);
        if (!config) throw new SenderError('ELO config not initialized. Call admin_seed_elo_config first.');
        rating = config.initialRating;
    }
    if (rating < tournament.minimumMmr) {
        throw new SenderError(`This tournament needs an MMR of at least ${tournament.minimumMmr} (yours: ${rating}).`);
    }
}

// ─── register_for_tournament ──────────────────────────────────────────────────
// Registers the caller. Registration stage only (A26a). requireVerified, requireRoster, minimumMmr (A36b);
// capacity = rows neither waitlisted nor Disqualified (A26a, C-a11); full + waitlistEnabled → waitlisted;
// requireApproval → pending (approvedByToAt unset) until approve_participant; a Disqualified row blocks
// re-registration (A26a(2)). Account locks at registration for non-waitlisted players, at promotion for waitlisted
// ones (A26a(4)). Solo tournaments (teamSize = 1) auto-create the player's team (named per A36a).
// Optional: hsrAccountIds (the accounts to lock; omitted = all), anonymousAlias (anonymous tournaments only),
// allowRandomTeamAssignment (A36a opt-in for random team formation at registration close).
// A104 (S10g): a waitlisted registrant's hsrAccountIds are remembered (TournamentWaitlistAccount) and locked at
// promotion. Audit #13 (S10g): counted by consumeTournamentAllowance (10 tournament entry writes a minute).

export const register_for_tournament = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        hsrAccountIds: t.array(t.u32()).optional(),
        anonymousAlias: t.string().optional(),
        allowRandomTeamAssignment: t.bool().optional(),
    },
    (ctx, { tournamentId, hsrAccountIds, anonymousAlias, allowRandomTeamAssignment }) => {
        const user = getAuthenticatedUser(ctx);

        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        if (tournament.stage.tag !== 'Registration') {
            throw new SenderError('Tournament is not accepting registrations.');
        }

        ensureNotEnrolled(findEnrolled(ctx, tournamentId, user.id), true);

        if (tournament.requireVerified && user.isGuest) {
            throw new SenderError('This tournament requires a verified account. Link your Discord first.');
        }
        if (tournament.requireRoster) {
            const hasActiveAccount = [...ctx.db.HsrAccount.user_id.filter(user.id)].some((a: any) => a.isActive);
            if (!hasActiveAccount) {
                throw new SenderError('This tournament requires an active HSR account in your roster.');
            }
        }
        ensureMinimumMmr(ctx, tournament, user);

        let alias: string | undefined;
        if (anonymousAlias !== undefined) {
            if (!tournament.isAnonymousDefault) throw new SenderError('Aliases are only used in anonymous tournaments.');
            alias = normalizeAlias(anonymousAlias);
        }

        let isWaitlisted = false;
        if (capacityCount(ctx, tournamentId) >= tournament.maxParticipants) {
            if (tournament.waitlistEnabled) {
                isWaitlisted = true;
            } else {
                throw new SenderError('Tournament is full.');
            }
        }

        ctx.db.TournamentEnrolled.insert(insertWithAudit(ctx, {
            tournamentId,
            userId: user.id,
            status: unit('Registered'),
            anonymousAlias: alias,
            isWaitlisted,
            allowRandomTeamAssignment: allowRandomTeamAssignment ?? false,
            approvedByToAt: tournament.requireApproval ? undefined : ctx.timestamp,
        }, user.id));

        if (tournament.teamSize === 1) {
            createSoloTeam(ctx, tournament, user.id, soloTeamName(ctx, tournament, user.displayName, alias), user.id);
        }

        if (!isWaitlisted) {
            lockPlayerAccounts(ctx, tournamentId, user.id, hsrAccountIds, user.id);
        } else if (hsrAccountIds !== undefined) {
            rememberWaitlistAccounts(ctx, tournamentId, user.id, hsrAccountIds, user.id); // A104: applied at promotion
        }
        consumeTournamentAllowance(ctx, user.id); // S10g (audit #13)
    }
);

// ─── withdraw_from_tournament ─────────────────────────────────────────────────
// A26a(1)(3): self-withdrawal in Registration and CheckIn only; deletes the enrolment with its team membership
// (captain transfer, the team deleted when empty), account locks, requests and calendar invites. From Seeding on:
// staff disqualify or the team plays with a stand-in. A Disqualified participant cannot withdraw (review T23).

export const withdraw_from_tournament = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
    },
    (ctx, { tournamentId }) => {
        const user = getAuthenticatedUser(ctx);

        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        if (tournament.stage.tag !== 'Registration' && tournament.stage.tag !== 'CheckIn') {
            throw new SenderError('Registration is closed; ask staff.');
        }

        const enrolled = findEnrolled(ctx, tournamentId, user.id);
        if (!enrolled) throw new SenderError('You are not registered for this tournament.');
        if (enrolled.status.tag === 'Disqualified') {
            throw new SenderError('You were disqualified from this tournament.');
        }

        removeEnrolment(ctx, tournament, enrolled, user.id);
    }
);

// ─── approve_participant ──────────────────────────────────────────────────────
// Approves a pending participant (sets approvedByToAt). Permission: participants (A25).

export const approve_participant = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        userId: t.u32(),
    },
    (ctx, { tournamentId, userId }) => {
        const { user, tournament } = ensureTournamentPermission(ctx, tournamentId, 'participants');

        const enrolled = findEnrolled(ctx, tournamentId, userId);
        if (!enrolled) throw new SenderError('Participant not found.');
        if (enrolled.approvedByToAt !== undefined) {
            throw new SenderError('Participant is already approved.');
        }

        updateEnrolled(ctx, enrolled, { approvedByToAt: ctx.timestamp }, user.id);
        refreshTeamOf(ctx, tournament, userId, user.id); // A26: the team may now be Ready
    }
);

// ─── reject_participant ───────────────────────────────────────────────────────
// Rejects a participant who awaits approval or sits on the waitlist: the enrolment is deleted like a withdrawal
// (A26a(1)), so the player may register again. Before the bracket is generated (D.8.6 window).
// Permission: participants (A25). Approved, active participants are disqualified instead (dq_participant).

export const reject_participant = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        userId: t.u32(),
    },
    (ctx, { tournamentId, userId }) => {
        const { user, tournament } = ensureTournamentPermission(ctx, tournamentId, 'participants');
        ensureBeforeGeneration(tournament);

        const enrolled = findEnrolled(ctx, tournamentId, userId);
        if (!enrolled) throw new SenderError('Participant not found.');
        if (enrolled.approvedByToAt !== undefined && !enrolled.isWaitlisted) {
            throw new SenderError('Participant is already approved; disqualify them instead.');
        }

        removeEnrolment(ctx, tournament, enrolled, user.id);
        console.log(`[TOURNAMENT] Participant #${userId} rejected from tournament #${tournamentId} by #${user.id}`);
    }
);

// ─── waitlist_promote ─────────────────────────────────────────────────────────
// D.8.6: Registration through Seeding until the bracket is generated; needs a free spot (capacity = rows neither
// waitlisted nor Disqualified); implies approval; creates the account locks now (A26a(4)): the accounts the player
// chose while waitlisted (A104, S10g), or all of them when they named none.
// Permission: participants (A25).

export const waitlist_promote = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        userId: t.u32(),
    },
    (ctx, { tournamentId, userId }) => {
        const { user, tournament } = ensureTournamentPermission(ctx, tournamentId, 'participants');
        ensureBeforeGeneration(tournament);

        const enrolled = findEnrolled(ctx, tournamentId, userId);
        if (!enrolled) throw new SenderError('Participant not found.');
        if (!enrolled.isWaitlisted) {
            throw new SenderError('Participant is not on the waitlist.');
        }
        if (capacityCount(ctx, tournamentId) >= tournament.maxParticipants) {
            throw new SenderError('No free spot: the tournament is full.');
        }

        updateEnrolled(ctx, enrolled, {
            isWaitlisted: false,
            approvedByToAt: enrolled.approvedByToAt ?? ctx.timestamp, // promotion implies approval (A26)
        }, user.id);
        lockAccountsAtPromotion(ctx, tournamentId, userId, user.id); // A104: the remembered choice, else every account
        refreshTeamOf(ctx, tournament, userId, user.id);
    }
);

// ─── add_participant ──────────────────────────────────────────────────────────
// Review §5.4 / 03-CONTEXT.md:60: staff add a verified player before the bracket is generated (D.8.6 window):
// an approved, non-waitlisted enrolment, inside the capacity; a Disqualified row blocks it (A26a(2)). Solo
// tournaments get the auto team; the player's accounts are locked. Permission: participants (A25).

export const add_participant = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        userId: t.u32(),
    },
    (ctx, { tournamentId, userId }) => {
        const { user, tournament } = ensureTournamentPermission(ctx, tournamentId, 'participants');
        ensureBeforeGeneration(tournament);

        const target = ctx.db.User.id.find(userId);
        if (!target || target.deletedAt) throw new SenderError('Target user not found.');
        if (target.isGuest) throw new SenderError('Only verified players can be added to a tournament.');
        ensureNotEnrolled(findEnrolled(ctx, tournamentId, userId), false);
        if (capacityCount(ctx, tournamentId) >= tournament.maxParticipants) {
            throw new SenderError('No free spot: the tournament is full.');
        }

        ctx.db.TournamentEnrolled.insert(insertWithAudit(ctx, {
            tournamentId,
            userId,
            status: unit('Registered'),
            anonymousAlias: undefined,
            isWaitlisted: false,
            allowRandomTeamAssignment: false,
            approvedByToAt: ctx.timestamp,
        }, user.id));
        if (tournament.teamSize === 1) {
            createSoloTeam(ctx, tournament, userId, soloTeamName(ctx, tournament, target.displayName, undefined), user.id);
        }
        lockPlayerAccounts(ctx, tournamentId, userId, undefined, user.id);
        console.log(`[TOURNAMENT] User #${userId} added to tournament #${tournamentId} by #${user.id}`);
    }
);

// ─── set_anonymous_alias ──────────────────────────────────────────────────────
// A36a: the enrolled player sets their alias (1–32 characters) while the tournament is anonymous and before
// Seeding. In a solo tournament the player's team takes the alias as its name. Audit #13 (S10g): counted by
// consumeTournamentAllowance.

export const set_anonymous_alias = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        alias: t.string(),
    },
    (ctx, { tournamentId, alias }) => {
        const user = getAuthenticatedUser(ctx);
        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        if (!tournament.isAnonymousDefault) throw new SenderError('Aliases are only used in anonymous tournaments.');
        if (tournament.stage.tag !== 'Registration' && tournament.stage.tag !== 'CheckIn') {
            throw new SenderError('Aliases can only be set before Seeding.');
        }
        const enrolled = findEnrolled(ctx, tournamentId, user.id);
        if (!enrolled) throw new SenderError('You are not registered for this tournament.');

        const trimmed = normalizeAlias(alias);
        consumeTournamentAllowance(ctx, user.id); // S10g (audit #13)
        updateEnrolled(ctx, enrolled, { anonymousAlias: trimmed }, user.id);

        if (tournament.teamSize === 1) {
            const ttm = findMembership(ctx, tournamentId, user.id);
            const team = ttm ? ctx.db.TournamentTeam.id.find(ttm.teamId) : undefined;
            if (team) {
                const name = soloTeamName(ctx, tournament, user.displayName, trimmed, team.id); // unique (" (2)" …)
                if (team.name !== name) ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { name }, user.id));
            }
        }
    }
);

// ─── lock_tournament_accounts ─────────────────────────────────────────────────
// A104 (S10g; tournament audit #7): a registered player (any enrolment that is not Disqualified: approved, awaiting
// approval or waitlisted) adds account locks for the tournament until their first game of it has started
// (hasPlayedTournamentGame, S10g review F3: the caller's own game: a result-record participant of one of the
// tournament's bracket matches, or a player seat in such a lobby past Waiting; a game the team played without them
// does not count). Registration through InProgress. Locks are only added, never removed. The accounts must be the
// caller's own. A waitlisted player's accounts are always remembered (TournamentWaitlistAccount, first call included,
// review F5) and locked at promotion; once promotion is impossible (bracket generated or InProgress) a waitlisted
// caller is refused. Counted by consumeTournamentAllowance (audit #13).

export const lock_tournament_accounts = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        hsrAccountIds: t.array(t.u32()),
    },
    (ctx, { tournamentId, hsrAccountIds }) => {
        const user = getAuthenticatedUser(ctx);
        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        const stage = tournament.stage.tag;
        if (stage !== 'Registration' && stage !== 'CheckIn' && stage !== 'Seeding' && stage !== 'InProgress') {
            throw new SenderError('Accounts can be locked from Registration until the tournament ends.');
        }
        if (hsrAccountIds.length === 0) throw new SenderError('Name at least one account to lock.');
        const enrolled = findEnrolled(ctx, tournamentId, user.id);
        if (!enrolled) throw new SenderError('You are not registered for this tournament.');
        if (enrolled.status.tag === 'Disqualified') throw new SenderError('You were disqualified from this tournament.');
        // S10g review F5: a waitlisted player can only be promoted while waitlist_promote works (ensureBeforeGeneration:
        // Registration through Seeding, bracket not generated); after that a remembered choice would never be applied.
        if (enrolled.isWaitlisted && (stage === 'InProgress' || tournament.bracketGeneratedAt !== undefined)) {
            throw new SenderError('The bracket has been generated; waitlisted players can no longer be promoted, so accounts cannot be locked.');
        }
        if (hasPlayedTournamentGame(ctx, tournamentId, user.id)) {
            throw new SenderError('Your first game of this tournament has started; accounts can no longer be locked.');
        }

        if (!enrolled.isWaitlisted) {
            lockPlayerAccounts(ctx, tournamentId, user.id, hsrAccountIds, user.id);
        } else {
            // S10g review F5: always remembered (first call included), applied by lockAccountsAtPromotion.
            rememberWaitlistAccounts(ctx, tournamentId, user.id, hsrAccountIds, user.id);
        }
        consumeTournamentAllowance(ctx, user.id);
    }
);
