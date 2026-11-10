import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import { allowsThirdPlace, canCloseRegistration, canOpenRegistration } from '@shared/bracket';
import { ensureModerator, ensureTournamentHost } from '@module/helpers/identity/ensurePermissions';
import { ensureTournamentPermission } from '@module/helpers/tournament/tournamentPermissions';
import {
    activateTeams,
    cancelTournament,
    capacityCount,
    closeRegistration,
    enterSeeding,
    ensureGuard,
    isGroupFormat,
    validateSeedingToInProgress,
    validateStageTransition,
} from '@module/helpers/tournament/tournamentHelpers';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensureBestOf, ensureWinnerAdvantage } from '@module/helpers/tournament/seriesSettings';
import { ensureCostSetCovers, ensureCostSetUsable, ensureSelectableCostSet } from '@module/helpers/draft/costSetGuards';
import { ensureTournamentPreset, seedSystemLobbyPreset } from '@module/helpers/lobby/systemPreset';
import { ensureForfeitSecondsInRange, ensureNoActionAllowed } from '@module/helpers/lobby/disconnectHelpers';
import { assignFinalPlacements, ensureCanComplete, restartTournamentFinalization, startTournamentFinalization } from '@module/helpers/tournament/tournamentFinalization';

// Valid enum tag lists for runtime validation
const VALID_TOURNAMENT_FORMATS = ['SingleElimination', 'DoubleElimination', 'GroupOnly', 'GroupIntoSingleElim', 'GroupIntoDoubleElim'];
const VALID_GAME_MODES = ['MemoryOfChaos', 'ApocalypticShadow', 'AnomalyArbitration'];
const VALID_ROSTER_VISIBILITIES = ['OpenRoster', 'ClosedWithRating', 'ClosedNoRating'];
const VALID_DISCONNECT_POLICIES = ['Standard', 'Deferred', 'NoAction'];
const VALID_GROUP_ASSIGNMENT_MODES = ['Auto', 'Manual'];
const VALID_LINEUP_FORMATS = ['Halves', 'Thirds'];

function validateEnumTag(value: string, validTags: string[], fieldName: string): void {
    if (!validTags.includes(value)) {
        throw new SenderError(`Invalid ${fieldName}: "${value}". Must be one of: ${validTags.join(', ')}`);
    }
}

const unit = (tag: string) => ({ tag, value: {} }) as any;

/** The decided settings shared by create_tournament and update_tournament (A28, A29, A32, A33, A36). */
interface SettingsArgs {
    name: string;
    description: string;
    format: string;
    teamSize: number;
    rosterVisibility: string;
    disconnectPolicy: string;
    disconnectForfeitSeconds?: number;
    defaultBestOf: number;
    grandFinalBestOf: number;
    winnerAdvantage: number;
    groupSize: number;
    groupAdvanceCount: number;
    groupAssignmentMode: string;
    has3rdPlaceMatch: boolean;
    lineupFormat: string;
    maxAccountsPerPlayer: number;
    scheduledStartAt: string;
    registrationDeadline: string;
}

/**
 * Validates the settings and returns the normalized name and timestamps. The pure bracket module throws plain
 * `Error` on invalid sizes, so `groupSize` / `groupAdvanceCount` are checked here first (S8a review carry-over).
 */
function validateSettings(ctx: any, a: SettingsArgs) {
    const trimmedName = a.name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 100) {
        throw new SenderError('Tournament name must be 1-100 characters.');
    }
    if (a.description.length > 2000) {
        throw new SenderError('Description cannot exceed 2000 characters.');
    }
    if (a.teamSize !== 1 && a.teamSize !== 2 && a.teamSize !== 3) {
        throw new SenderError('teamSize must be 1, 2, or 3.');
    }
    validateEnumTag(a.format, VALID_TOURNAMENT_FORMATS, 'format');
    validateEnumTag(a.rosterVisibility, VALID_ROSTER_VISIBILITIES, 'rosterVisibility');
    validateEnumTag(a.disconnectPolicy, VALID_DISCONNECT_POLICIES, 'disconnectPolicy');
    // A92(3): NoAction is for casual lobbies only; A92(2): the forfeit grace is 30-600 s when set.
    ensureNoActionAllowed(a.disconnectPolicy, true);
    ensureForfeitSecondsInRange(a.disconnectForfeitSeconds);
    validateEnumTag(a.groupAssignmentMode, VALID_GROUP_ASSIGNMENT_MODES, 'groupAssignmentMode');
    validateEnumTag(a.lineupFormat, VALID_LINEUP_FORMATS, 'lineupFormat');

    // A28 / A38(2): both series lengths ∈ {1, 3}; A27 / CH-T9: winnerAdvantage < ceil(grandFinalBestOf / 2).
    ensureBestOf(a.defaultBestOf);
    ensureBestOf(a.grandFinalBestOf);
    ensureWinnerAdvantage(a.winnerAdvantage, a.grandFinalBestOf);

    // A29: a third-place match exists only in single elimination.
    if (a.has3rdPlaceMatch && !allowsThirdPlace(unit(a.format))) {
        throw new SenderError('A third-place match exists only in single elimination.');
    }
    // A32: groupSize is a minimum, at least 2 for the group formats. A36: groupAdvanceCount is 1 or 2.
    if (isGroupFormat(a.format) && a.groupSize < 2) {
        throw new SenderError('groupSize must be at least 2.');
    }
    if (a.groupAdvanceCount !== 1 && a.groupAdvanceCount !== 2) {
        throw new SenderError('groupAdvanceCount must be 1 or 2.');
    }
    // Validate maxAccountsPerPlayer (0 = default 1)
    if (a.maxAccountsPerPlayer > 10) {
        throw new SenderError('maxAccountsPerPlayer must be 0-10.');
    }

    // Parse optional timestamps: non-empty string = BigInt microseconds since epoch
    const parsedScheduledStartAt = a.scheduledStartAt ? BigInt(a.scheduledStartAt) : undefined;
    const parsedRegistrationDeadline = a.registrationDeadline ? BigInt(a.registrationDeadline) : undefined;
    const now = ctx.timestamp.microsSinceUnixEpoch;
    if (parsedScheduledStartAt !== undefined && parsedScheduledStartAt <= now) {
        throw new SenderError('scheduledStartAt must be in the future.');
    }
    if (parsedRegistrationDeadline !== undefined && parsedRegistrationDeadline <= now) {
        throw new SenderError('registrationDeadline must be in the future.');
    }
    if (parsedScheduledStartAt !== undefined && parsedRegistrationDeadline !== undefined && parsedRegistrationDeadline >= parsedScheduledStartAt) {
        throw new SenderError('registrationDeadline must be before scheduledStartAt.');
    }
    return {
        trimmedName,
        scheduledStartAt: parsedScheduledStartAt !== undefined ? new Timestamp(parsedScheduledStartAt) : undefined,
        registrationDeadline: parsedRegistrationDeadline !== undefined ? new Timestamp(parsedRegistrationDeadline) : undefined,
    };
}

// The settings arguments of create_tournament and update_tournament (the A33 integrity set and the bracket set).
const settingsParams = {
    name: t.string(),
    description: t.string(),
    format: t.string(),
    teamSize: t.u8(),
    maxParticipants: t.u32(),
    rosterVisibility: t.string(),
    isAnonymousDefault: t.bool(),
    disconnectPolicy: t.string(),
    disconnectForfeitSeconds: t.u32().optional(), // A36: one optional forfeit timer; 0 / omitted = default 60; A92(2): 30-600 when set
    costSetId: t.u32(),
    defaultBestOf: t.u8(),                         // A28: {1, 3}
    grandFinalBestOf: t.u8(),                      // A28: {1, 3}
    winnerAdvantage: t.u8(),                       // A27: < ceil(grandFinalBestOf / 2)
    groupSize: t.u8(),                             // A32: minimum group size, ≥ 2 for group formats
    groupAdvanceCount: t.u8(),                     // A36: 1 or 2
    groupAssignmentMode: t.string(),               // A36a: Auto | Manual
    has3rdPlaceMatch: t.bool(),                    // A29: single elimination only
    checkInEnabled: t.bool(),                      // A36 / A26: team-level check-in stage
    requireResultValidation: t.bool(),             // A36: forced true when countTowardsMmr
    requireOwnership: t.bool(),
    allowMirrorPicks: t.bool(),                    // A33; Ranked forces false (D-42)
    lineupFormat: t.string(),                      // A21 / A33
    lobbyPresetId: t.u32().optional(),             // A33a: system preset by default; an own preset swaps it
    requireVerified: t.bool(),
    requireRoster: t.bool(),
    minimumMmr: t.u32().optional(),                // A36b; 0 = none
    requireApproval: t.bool(),
    waitlistEnabled: t.bool(),
    scheduledStartAt: t.string(),
    registrationDeadline: t.string(),
    maxAccountsPerPlayer: t.u8(),
};

// ─── create_tournament ────────────────────────────────────────────────────────
// Creates a new tournament in Draft stage.
// Permission: TournamentHost or higher (D-B1).

export const create_tournament = spacetimedb.reducer(
    {
        ...settingsParams,
        defaultGameMode: t.string(),
        countTowardsMmr: t.bool(),
    },
    (ctx, args) => {
        const user = ensureTournamentHost(ctx);
        const v = validateSettings(ctx, args);
        validateEnumTag(args.defaultGameMode, VALID_GAME_MODES, 'defaultGameMode');

        // A33a: the system preset by default (idempotent seed; init already created it), or one of the creator's own.
        const lobbyPreset = args.lobbyPresetId === undefined
            ? seedSystemLobbyPreset(ctx)
            : ensureTournamentPreset(ctx, args.lobbyPresetId, user.id);

        // Backlog #2 (R2, D-D6): selectable and covering defaultGameMode × the preset's draft mode.
        ensureCostSetUsable(ctx, args.costSetId, args.defaultGameMode, lobbyPreset.draftMode.tag);

        ctx.db.Tournament.insert(insertWithAudit(ctx, {
            id: 0,
            name: v.trimmedName,
            description: args.description,
            organizerId: user.id,
            format: unit(args.format),
            stage: unit('Draft'),
            defaultGameMode: unit(args.defaultGameMode),
            maxParticipants: args.maxParticipants,
            teamSize: args.teamSize,
            isAnonymousDefault: args.isAnonymousDefault,
            isAnonymousSpectators: args.isAnonymousDefault,
            rosterVisibility: unit(args.rosterVisibility),
            disconnectPolicy: unit(args.disconnectPolicy),
            disconnectForfeitSeconds: args.disconnectForfeitSeconds ? args.disconnectForfeitSeconds : undefined,
            checkInEnabled: args.checkInEnabled,
            winnerAdvantage: args.winnerAdvantage,
            groupAssignmentMode: unit(args.groupAssignmentMode),
            groupAdvanceCount: args.groupAdvanceCount,
            costSetId: args.costSetId,
            seasonId: 0,                         // A36: the active season, 0 for now
            countTowardsMmr: args.countTowardsMmr,
            requireResultValidation: args.countTowardsMmr || args.requireResultValidation, // A36: forced when ranked
            defaultBestOf: args.defaultBestOf,
            grandFinalBestOf: args.grandFinalBestOf,
            groupSize: args.groupSize,
            has3rdPlaceMatch: args.has3rdPlaceMatch,
            requireOwnership: args.requireOwnership,
            allowMirrorPicks: args.countTowardsMmr ? false : args.allowMirrorPicks, // D-42: Ranked forces false
            lineupFormat: unit(args.lineupFormat),
            lobbyPresetId: lobbyPreset.id,
            requireVerified: args.requireVerified,
            requireRoster: args.requireRoster,
            minimumMmr: args.minimumMmr ? args.minimumMmr : undefined,
            requireApproval: args.requireApproval,
            waitlistEnabled: args.waitlistEnabled,
            maxAccountsPerPlayer: args.maxAccountsPerPlayer > 0 ? args.maxAccountsPerPlayer : 1,
            scheduledStartAt: v.scheduledStartAt,
            registrationDeadline: v.registrationDeadline,
            lastSeedChangeAt: undefined,
            bracketGeneratedAt: undefined,
            finalizationStartedAt: undefined,
            finalizedAt: undefined,
        }, user.id));
    }
);

// ─── update_tournament ────────────────────────────────────────────────────────
// Updates tournament settings. Permission: owner (A25).
// format / teamSize / isAnonymousDefault (A103, S10g) change in Draft only; the rest until Seeding (Draft, Registration,
// CheckIn).
// defaultGameMode and countTowardsMmr stay fixed after creation (unchanged).

export const update_tournament = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        ...settingsParams,
    },
    (ctx, args) => {
        const { user, tournament } = ensureTournamentPermission(ctx, args.tournamentId, 'owner');
        const stage = tournament.stage.tag;
        if (stage !== 'Draft' && stage !== 'Registration' && stage !== 'CheckIn') {
            throw new SenderError('Tournament settings can only change before Seeding.');
        }
        if (stage !== 'Draft' && (args.format !== tournament.format.tag || args.teamSize !== tournament.teamSize)) {
            throw new SenderError('Format and team size can only change in Draft.');
        }
        // A103 (S10g, audit #9): solo team names and the views' anonymity follow isAnonymousDefault from enrolment on.
        if (stage !== 'Draft' && args.isAnonymousDefault !== tournament.isAnonymousDefault) {
            throw new SenderError('The anonymous setting can only change in Draft.');
        }
        const v = validateSettings(ctx, args);

        // maxParticipants never below the current capacity count (non-waitlisted, non-DQ; A26a).
        const taken = capacityCount(ctx, tournament.id);
        if (args.maxParticipants < taken) {
            throw new SenderError(`maxParticipants cannot be below the ${taken} registered participant(s).`);
        }

        // A33a: preset swap while the tournament is editable (system preset or one of the organizer's own).
        const nextPresetId = args.lobbyPresetId === undefined ? tournament.lobbyPresetId : args.lobbyPresetId;
        if (args.lobbyPresetId !== undefined && args.lobbyPresetId !== tournament.lobbyPresetId) {
            ensureTournamentPreset(ctx, args.lobbyPresetId, tournament.organizerId);
        }
        const preset = ctx.db.LobbyPreset.id.find(nextPresetId);

        // Backlog #2 (R2, D-D6): selectability when the set changes; coverage of defaultGameMode × the preset's
        // draft mode (Classic when the pointed preset is gone; S8d falls back to the system preset the same way).
        if (args.costSetId !== tournament.costSetId) ensureSelectableCostSet(ctx, args.costSetId);
        ensureCostSetCovers(ctx, args.costSetId, tournament.defaultGameMode.tag, preset ? preset.draftMode.tag : 'Classic');

        ctx.db.Tournament.id.update(updateWithAudit(ctx, tournament, {
            name: v.trimmedName,
            description: args.description,
            format: unit(args.format),
            teamSize: args.teamSize,
            maxParticipants: args.maxParticipants,
            rosterVisibility: unit(args.rosterVisibility),
            isAnonymousDefault: args.isAnonymousDefault,
            isAnonymousSpectators: args.isAnonymousDefault,
            disconnectPolicy: unit(args.disconnectPolicy),
            disconnectForfeitSeconds: args.disconnectForfeitSeconds ? args.disconnectForfeitSeconds : undefined,
            costSetId: args.costSetId,
            defaultBestOf: args.defaultBestOf,
            grandFinalBestOf: args.grandFinalBestOf,
            winnerAdvantage: args.winnerAdvantage,
            groupSize: args.groupSize,
            groupAdvanceCount: args.groupAdvanceCount,
            groupAssignmentMode: unit(args.groupAssignmentMode),
            has3rdPlaceMatch: args.has3rdPlaceMatch,
            checkInEnabled: args.checkInEnabled,
            requireResultValidation: tournament.countTowardsMmr || args.requireResultValidation, // A36
            requireOwnership: args.requireOwnership,
            allowMirrorPicks: tournament.countTowardsMmr ? false : args.allowMirrorPicks,       // D-42
            lineupFormat: unit(args.lineupFormat),
            lobbyPresetId: nextPresetId,
            requireVerified: args.requireVerified,
            requireRoster: args.requireRoster,
            minimumMmr: args.minimumMmr ? args.minimumMmr : undefined,
            requireApproval: args.requireApproval,
            waitlistEnabled: args.waitlistEnabled,
            maxAccountsPerPlayer: args.maxAccountsPerPlayer > 0 ? args.maxAccountsPerPlayer : 1,
            scheduledStartAt: v.scheduledStartAt,
            registrationDeadline: v.registrationDeadline,
        }, user.id));
    }
);

// ─── advance_tournament_stage ─────────────────────────────────────────────────
// Review §5.1 stage machine. Permission: owner (A25), except Seeding → InProgress, which `bracket` may also do.
// validateStageTransition (the allowed-transitions table) runs first, then the shared guards (S8a).

export const advance_tournament_stage = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        nextStage: t.string(),
    },
    (ctx, { tournamentId, nextStage }) => {
        const found = ctx.db.Tournament.id.find(tournamentId);
        if (!found) throw new SenderError('Tournament not found.');
        const from = found.stage.tag as string;
        const perm = from === 'Seeding' && nextStage === 'InProgress' ? 'bracket' : 'owner';
        const { user, tournament } = ensureTournamentPermission(ctx, tournamentId, perm);

        validateStageTransition(from, nextStage);

        // The one cancel path (A24(6)); it starts the A24(5) finalization (stats counted, MMR skipped).
        if (nextStage === 'Cancelled') {
            cancelTournament(ctx, tournament, user.id);
            return;
        }

        if (from === 'Draft' && nextStage === 'Registration') {
            // Review §5.1: canOpenRegistration (stage, A29), plus the ctx-bound checks.
            ensureGuard(canOpenRegistration(tournament));
            ensureSelectableCostSet(ctx, tournament.costSetId);         // R2
            if (isGroupFormat(tournament.format.tag)) {
                if (tournament.groupSize < 2) throw new SenderError('groupSize must be at least 2.');
                if (tournament.groupAdvanceCount !== 1 && tournament.groupAdvanceCount !== 2) {
                    throw new SenderError('groupAdvanceCount must be 1 or 2.');
                }
            }
            ensureBestOf(tournament.defaultBestOf);                     // A28
            ensureBestOf(tournament.grandFinalBestOf);
            ensureWinnerAdvantage(tournament.winnerAdvantage, tournament.grandFinalBestOf); // A27
        }

        // Registration closes (A26a): the transition out of Registration. To CheckIn: requests deleted, random
        // teams formed (they check in like any team).
        if (from === 'Registration' && nextStage === 'CheckIn') {
            if (!tournament.checkInEnabled) {
                throw new SenderError('Check-in is disabled for this tournament: move to Seeding.');
            }
            closeRegistration(ctx, tournament, user.id);
        }

        // Entering Seeding: from Registration (check-in off) all close effects at once; from CheckIn the unchecked
        // teams are Withdrawn; then eligible teams Ready and at least two of them (canCloseRegistration).
        if (nextStage === 'Seeding') {
            const eligible = enterSeeding(ctx, tournament, user.id);
            ensureGuard(canCloseRegistration(tournament, eligible));
        }

        if (from === 'Seeding' && nextStage === 'InProgress') {
            validateSeedingToInProgress(ctx, tournament);
            activateTeams(ctx, tournament, user.id);
        }

        // A24(4) / D.8.1 (S8d): InProgress → Completed: format check + canComplete (every match settled, no tournament
        // lobby outside AwaitingResult), then the placements.
        if (nextStage === 'Completed') {
            ensureCanComplete(ctx, tournament);
            assignFinalPlacements(ctx, tournament, user.id);
        }

        ctx.db.Tournament.id.update(updateWithAudit(ctx, ctx.db.Tournament.id.find(tournamentId)!, {
            stage: unit(nextStage),
        }, user.id));

        // A24(4)(7): Completed starts the chunked finalization (finalizationStartedAt, TournamentFinalizeJob
        // { tournamentId, cursor: 0 } scheduled now); the D-91 reveal is gone (A37: history is never public).
        if (nextStage === 'Completed') startTournamentFinalization(ctx, tournamentId, user.id);
    }
);

// ─── cancel_tournament ────────────────────────────────────────────────────────
// Cancels the tournament from any non-terminal state. Permission: owner (A25).

export const cancel_tournament = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
    },
    (ctx, { tournamentId }) => {
        const { user, tournament } = ensureTournamentPermission(ctx, tournamentId, 'owner');
        // A24(5): voids the live lobbies and starts the same chunked finalization as Completed, with stats counted
        // and MMR skipped (cancelTournament); the D-91 reveal is gone (A37).
        cancelTournament(ctx, tournament, user.id);
    }
);

// ─── admin_cancel_idle_tournaments ────────────────────────────────────────────
// A24(6): the admin-panel button for abandoned tournaments. Moderator+ only. Cancels every tournament in
// Registration / CheckIn / Seeding / InProgress whose lastModifiedDate is older than `idleDays` days, through the
// cancel_tournament path; for InProgress the newest BracketMatch.lastModifiedDate counts too, so a tournament that is
// playing matches is never cancelled. Returns nothing; logs the count.

const IDLE_STAGES = ['Registration', 'CheckIn', 'Seeding', 'InProgress'];
const MICROS_PER_DAY = 86_400_000_000n;

export const admin_cancel_idle_tournaments = spacetimedb.reducer(
    {
        idleDays: t.u8(),
    },
    (ctx, { idleDays }) => {
        const moderator = ensureModerator(ctx);
        if (idleDays < 1) throw new SenderError('idleDays must be at least 1.');
        const cutoff = ctx.timestamp.microsSinceUnixEpoch - BigInt(idleDays) * MICROS_PER_DAY;
        let cancelled = 0;
        for (const stage of IDLE_STAGES) {
            for (const tournament of [...ctx.db.Tournament.stage.filter(unit(stage))]) {
                let last = tournament.lastModifiedDate.microsSinceUnixEpoch;
                if (stage === 'InProgress') {
                    for (const m of ctx.db.BracketMatch.tournament_id.filter(tournament.id)) {
                        if (m.lastModifiedDate.microsSinceUnixEpoch > last) last = m.lastModifiedDate.microsSinceUnixEpoch;
                    }
                }
                if (last < cutoff) {
                    cancelTournament(ctx, tournament, moderator.id);
                    cancelled++;
                }
            }
        }
        console.log(`[TOURNAMENT] admin_cancel_idle_tournaments(${idleDays}) by #${moderator.id}: ${cancelled} cancelled`);
    }
);

// ─── admin_restart_tournament_finalize ────────────────────────────────────────
// S8d review (A24(7), D.8.1): Moderator+ only. A finalize tick that throws rolls back with its reschedule row, so the
// job stops for good. This re-inserts the job for a Completed or Cancelled tournament whose finalizedAt is unset and
// which has no TournamentFinalizeJob row. The new row starts at cursor 0: the stopped job's cursor lived on its row
// and is gone, and the cursor is a progress counter only; the next tick reads the first surviving record in bracket
// order, which is correct because every record an earlier tick processed was finalized (and deleted) or deleted.

export const admin_restart_tournament_finalize = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
    },
    (ctx, { tournamentId }) => {
        const moderator = ensureModerator(ctx);
        const tournament = ctx.db.Tournament.id.find(tournamentId);
        if (!tournament) throw new SenderError('Tournament not found.');
        if (tournament.stage.tag !== 'Completed' && tournament.stage.tag !== 'Cancelled') {
            throw new SenderError('Only a Completed or Cancelled tournament is finalized.');
        }
        if (tournament.finalizedAt !== undefined) throw new SenderError('This tournament is already finalized.');
        if ([...ctx.db.TournamentFinalizeJob.tournament_id.filter(tournamentId)].length > 0) {
            throw new SenderError('The finalize job of this tournament is still scheduled.');
        }
        restartTournamentFinalization(ctx, tournamentId, 0);
        console.log(`[TOURNAMENT_FINALIZE] Job of tournament #${tournamentId} restarted by #${moderator.id}`);
    }
);
