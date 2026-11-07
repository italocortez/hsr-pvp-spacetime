import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import { ensureTournamentHost } from '../helpers/ensurePermissions';
import { ensureTournamentAccess, validateStageTransition, validateRegistrationToSeeding, validateSeedingToInProgress, cleanupTeamRequests, cascadeCleanupTournament, removeUncheckedInParticipants } from '../helpers/tournamentHelpers';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { ensureBestOf, ensureWinnerAdvantage } from '../helpers/seriesSettings';
import { ensureCostSetCovers, ensureCostSetUsable, ensureSelectableCostSet } from '../helpers/costSetGuards';
import { seedSystemLobbyPreset } from '../helpers/systemPreset';

// Valid enum tag lists for runtime validation
const VALID_TOURNAMENT_FORMATS = ['SingleElimination', 'DoubleElimination', 'GroupOnly', 'GroupIntoSingleElim', 'GroupIntoDoubleElim'];
const VALID_GAME_MODES = ['MemoryOfChaos', 'ApocalypticShadow', 'AnomalyArbitration'];
const VALID_ROSTER_VISIBILITIES = ['OpenRoster', 'ClosedWithRating', 'ClosedNoRating'];
const VALID_DISCONNECT_POLICIES = ['Standard', 'Deferred', 'NoAction'];

function validateEnumTag(value: string, validTags: string[], fieldName: string): void {
    if (!validTags.includes(value)) {
        throw new SenderError(`Invalid ${fieldName}: "${value}". Must be one of: ${validTags.join(', ')}`);
    }
}

// ─── create_tournament ────────────────────────────────────────────────────────
// Creates a new tournament in Draft stage.
// Permission: TournamentHost or higher.

export const create_tournament = spacetimedb.reducer(
    {
        name: t.string(),
        description: t.string(),
        format: t.string(),
        teamSize: t.u8(),
        defaultGameMode: t.string(),
        maxParticipants: t.u32(),
        rosterVisibility: t.string(),
        isAnonymousDefault: t.bool(),
        disconnectPolicy: t.string(),
        costSetId: t.u32(),
        defaultBestOf: t.u8(),
        groupSize: t.u8(),
        has3rdPlaceMatch: t.bool(),
        // S8: the auto-advance argument was removed with its column (A24/A36); the create/update signatures
        // gain the A33/A36 integrity-set arguments (lineupFormat, allowMirrorPicks, checkInEnabled, groupAdvanceCount,
        // disconnectForfeitSeconds, requireResultValidation, grandFinalBestOf) in S8. lobbyPresetId: create_tournament points at
        // the system preset and update_tournament takes an optional lobbyPresetId (A33a).
        countTowardsMmr: t.bool(),
        winnerAdvantage: t.u8(),
        requireOwnership: t.bool(),
        requireVerified: t.bool(),
        requireRoster: t.bool(),
        minimumMmr: t.u32(),
        requireApproval: t.bool(),
        waitlistEnabled: t.bool(),
        scheduledStartAt: t.string(),
        registrationDeadline: t.string(),
        maxAccountsPerPlayer: t.u8(),
    },
    (ctx, {
        name,
        description,
        format,
        teamSize,
        defaultGameMode,
        maxParticipants,
        rosterVisibility,
        isAnonymousDefault,
        disconnectPolicy,
        costSetId,
        defaultBestOf,
        groupSize,
        has3rdPlaceMatch,
        countTowardsMmr,
        winnerAdvantage,
        requireOwnership,
        requireVerified,
        requireRoster,
        minimumMmr,
        requireApproval,
        waitlistEnabled,
        scheduledStartAt,
        registrationDeadline,
        maxAccountsPerPlayer,
    }) => {
        const user = ensureTournamentHost(ctx);

        // Validate name
        const trimmedName = name.trim();
        if (trimmedName.length < 1 || trimmedName.length > 100) {
            throw new SenderError('Tournament name must be 1-100 characters.');
        }

        // Validate description length
        if (description.length > 2000) {
            throw new SenderError('Description cannot exceed 2000 characters.');
        }

        // Validate teamSize
        if (teamSize !== 1 && teamSize !== 2 && teamSize !== 3) {
            throw new SenderError('teamSize must be 1, 2, or 3.');
        }

        // A28 / A38(2): bestOf ∈ {1, 3} (backlog #8). grandFinalBestOf = defaultBestOf until its own argument (A28).
        ensureBestOf(defaultBestOf);
        const grandFinalBestOf = defaultBestOf;

        // A27 / review CH-T9: winnerAdvantage < ceil(grandFinalBestOf / 2)
        ensureWinnerAdvantage(winnerAdvantage, grandFinalBestOf);

        // Validate groupSize
        if (groupSize < 3) {
            throw new SenderError('groupSize must be at least 3.');
        }

        // Validate maxAccountsPerPlayer (0 = default 1)
        if (maxAccountsPerPlayer > 10) {
            throw new SenderError('maxAccountsPerPlayer must be 0-10.');
        }

        // Validate enum tags
        validateEnumTag(format, VALID_TOURNAMENT_FORMATS, 'format');
        validateEnumTag(defaultGameMode, VALID_GAME_MODES, 'defaultGameMode');
        validateEnumTag(rosterVisibility, VALID_ROSTER_VISIBILITIES, 'rosterVisibility');
        validateEnumTag(disconnectPolicy, VALID_DISCONNECT_POLICIES, 'disconnectPolicy');

        // A33a: the tournament points at the built-in system preset (idempotent seed; init already created it).
        const lobbyPreset = seedSystemLobbyPreset(ctx);

        // Backlog #2 (R2, D-D6): selectable and covering defaultGameMode × the preset's draft mode.
        ensureCostSetUsable(ctx, costSetId, defaultGameMode, lobbyPreset.draftMode.tag);

        // Parse optional timestamps: non-empty string = BigInt microseconds since epoch
        const parsedScheduledStartAt = scheduledStartAt ? BigInt(scheduledStartAt) : undefined;
        const parsedRegistrationDeadline = registrationDeadline ? BigInt(registrationDeadline) : undefined;

        // Validate timestamps against server time
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

        ctx.db.Tournament.insert(insertWithAudit(ctx, {
            id: 0,
            name: trimmedName,
            description,
            organizerId: user.id,
            format: { tag: format, value: {} } as any,
            stage: { tag: 'Draft', value: {} } as any,
            defaultGameMode: { tag: defaultGameMode, value: {} } as any,
            maxParticipants,
            teamSize,
            isAnonymousDefault,
            isAnonymousSpectators: isAnonymousDefault,
            rosterVisibility: { tag: rosterVisibility, value: {} } as any,
            disconnectPolicy: { tag: disconnectPolicy, value: {} } as any,
            disconnectForfeitSeconds: undefined, // S8: create/update argument (A36)
            checkInEnabled: false,               // S8: create/update argument (A36)
            winnerAdvantage,
            groupAssignmentMode: { tag: 'Auto', value: {} } as any,
            groupAdvanceCount: 2,                // S8: create/update argument, 1 or 2 (A36)
            costSetId,
            seasonId: 0,                         // A36: the active season, 0 for now
            countTowardsMmr,
            requireResultValidation: countTowardsMmr, // S8: argument, forced true when countTowardsMmr (A36)
            defaultBestOf,
            grandFinalBestOf,                    // S8: its own argument, {1,3}, with winnerAdvantage < ceil(grandFinalBestOf / 2) (A27/A28)
            groupSize,
            has3rdPlaceMatch,
            requireOwnership,
            allowMirrorPicks: !countTowardsMmr,  // S8: integrity-set argument (A33); Ranked forces false (D-42)
            lineupFormat: { tag: 'Halves', value: {} } as any, // S8: integrity-set argument (A21/A33)
            lobbyPresetId: lobbyPreset.id,       // A33a: the system preset; update_tournament may swap it
            requireVerified,
            requireRoster,
            minimumMmr: minimumMmr > 0 ? minimumMmr : undefined,
            requireApproval,
            waitlistEnabled,
            maxAccountsPerPlayer: maxAccountsPerPlayer > 0 ? maxAccountsPerPlayer : 1,
            scheduledStartAt: parsedScheduledStartAt !== undefined ? new Timestamp(parsedScheduledStartAt) : undefined,
            registrationDeadline: parsedRegistrationDeadline !== undefined ? new Timestamp(parsedRegistrationDeadline) : undefined,
            lastSeedChangeAt: undefined,
            bracketGeneratedAt: undefined,
            finalizationStartedAt: undefined,
            finalizedAt: undefined,
        }, user.id));
    }
);

// ─── update_tournament ────────────────────────────────────────────────────────
// Updates tournament settings.
// Only allowed in Draft or Registration stages.

export const update_tournament = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        name: t.string(),
        description: t.string(),
        rosterVisibility: t.string(),
        isAnonymousDefault: t.bool(),
        disconnectPolicy: t.string(),
        costSetId: t.u32(),
        defaultBestOf: t.u8(),
        groupSize: t.u8(),
        has3rdPlaceMatch: t.bool(),
        winnerAdvantage: t.u8(),
        requireOwnership: t.bool(),
        requireVerified: t.bool(),
        requireRoster: t.bool(),
        minimumMmr: t.u32(),
        requireApproval: t.bool(),
        waitlistEnabled: t.bool(),
        scheduledStartAt: t.string(),
        registrationDeadline: t.string(),
        maxAccountsPerPlayer: t.u8(),
        // A33a: swap the lobby preset for one the organizer owns or the system preset (omitted = unchanged).
        lobbyPresetId: t.u32().optional(),
    },
    (ctx, {
        tournamentId,
        name,
        description,
        rosterVisibility,
        isAnonymousDefault,
        disconnectPolicy,
        costSetId,
        defaultBestOf,
        groupSize,
        has3rdPlaceMatch,
        winnerAdvantage,
        requireOwnership,
        requireVerified,
        requireRoster,
        minimumMmr,
        requireApproval,
        waitlistEnabled,
        scheduledStartAt,
        registrationDeadline,
        maxAccountsPerPlayer,
        lobbyPresetId,
    }) => {
        const { user, tournament } = ensureTournamentAccess(ctx, tournamentId);

        // Only allowed in Draft or Registration stages
        if (tournament.stage.tag !== 'Draft' && tournament.stage.tag !== 'Registration') {
            throw new SenderError('Tournament can only be updated in Draft or Registration stage.');
        }

        // Validate name
        const trimmedName = name.trim();
        if (trimmedName.length < 1 || trimmedName.length > 100) {
            throw new SenderError('Tournament name must be 1-100 characters.');
        }

        // Validate description length
        if (description.length > 2000) {
            throw new SenderError('Description cannot exceed 2000 characters.');
        }

        // A28 / A38(2): bestOf ∈ {1, 3} (backlog #8); A27 / CH-T9 against the stored grandFinalBestOf.
        ensureBestOf(defaultBestOf);
        ensureWinnerAdvantage(winnerAdvantage, tournament.grandFinalBestOf);

        // A33a: preset swap while the tournament is editable (this reducer already requires Draft or Registration).
        const nextPresetId = lobbyPresetId === undefined ? tournament.lobbyPresetId : lobbyPresetId;
        const preset = ctx.db.LobbyPreset.id.find(nextPresetId);
        if (lobbyPresetId !== undefined && lobbyPresetId !== tournament.lobbyPresetId) {
            if (!preset) {
                throw new SenderError('Lobby preset not found.');
            }
            if (!preset.isSystemPreset && preset.creatorUserId !== tournament.organizerId) {
                throw new SenderError("The tournament can only use the system preset or one of the organizer's own presets.");
            }
        }

        // Validate groupSize
        if (groupSize < 3) {
            throw new SenderError('groupSize must be at least 3.');
        }

        // Validate maxAccountsPerPlayer (0 = default 1)
        if (maxAccountsPerPlayer > 10) {
            throw new SenderError('maxAccountsPerPlayer must be 0-10.');
        }

        // Validate enum tags
        validateEnumTag(rosterVisibility, VALID_ROSTER_VISIBILITIES, 'rosterVisibility');
        validateEnumTag(disconnectPolicy, VALID_DISCONNECT_POLICIES, 'disconnectPolicy');

        // Backlog #2 (R2, D-D6): selectability when the set changes; coverage of defaultGameMode × the preset's
        // draft mode (Classic when the pointed preset is gone; S8 falls back to the system preset the same way).
        if (costSetId !== tournament.costSetId) ensureSelectableCostSet(ctx, costSetId);
        ensureCostSetCovers(ctx, costSetId, tournament.defaultGameMode.tag, preset ? preset.draftMode.tag : 'Classic');

        // Parse optional timestamps
        const parsedScheduledStartAt = scheduledStartAt ? BigInt(scheduledStartAt) : undefined;
        const parsedRegistrationDeadline = registrationDeadline ? BigInt(registrationDeadline) : undefined;

        // Validate timestamps against server time
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

        ctx.db.Tournament.id.update(updateWithAudit(ctx, tournament, {
            name: trimmedName,
            description,
            rosterVisibility: { tag: rosterVisibility, value: {} } as any,
            isAnonymousDefault,
            isAnonymousSpectators: isAnonymousDefault,
            disconnectPolicy: { tag: disconnectPolicy, value: {} } as any,
            costSetId,
            defaultBestOf,
            groupSize,
            has3rdPlaceMatch,
            winnerAdvantage,
            lobbyPresetId: nextPresetId,
            requireOwnership,
            requireVerified,
            requireRoster,
            minimumMmr: minimumMmr > 0 ? minimumMmr : undefined,
            requireApproval,
            waitlistEnabled,
            maxAccountsPerPlayer: maxAccountsPerPlayer > 0 ? maxAccountsPerPlayer : 1,
            scheduledStartAt: parsedScheduledStartAt !== undefined ? new Timestamp(parsedScheduledStartAt) : undefined,
            registrationDeadline: parsedRegistrationDeadline !== undefined ? new Timestamp(parsedRegistrationDeadline) : undefined,
        }, user.id));
    }
);

// ─── advance_tournament_stage ─────────────────────────────────────────────────
// Advances the tournament to the next stage (forward-only).
// Uses validateStageTransition to enforce stage machine rules.

export const advance_tournament_stage = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
        nextStage: t.string(),
    },
    (ctx, { tournamentId, nextStage }) => {
        const { user, tournament } = ensureTournamentAccess(ctx, tournamentId);

        validateStageTransition(tournament.stage.tag, nextStage);

        // D-37: Registration -> CheckIn (only if checkInEnabled)
        // If checkInEnabled=false, Registration->CheckIn transition is rejected by validateStageTransition
        // (CheckIn is in STAGE_ORDER only when enabled — validation handled in tournamentHelpers)

        if (tournament.stage.tag === 'Registration' && nextStage === 'Seeding') {
            validateRegistrationToSeeding(ctx, tournamentId);
            cleanupTeamRequests(ctx, tournamentId);
        }

        // D-37: CheckIn -> Seeding: auto-remove participants who did not check in
        if (tournament.stage.tag === 'CheckIn' && nextStage === 'Seeding') {
            removeUncheckedInParticipants(ctx, tournamentId, user.id);
            cleanupTeamRequests(ctx, tournamentId);
        }

        if (tournament.stage.tag === 'Seeding' && nextStage === 'InProgress') {
            validateSeedingToInProgress(ctx, tournamentId);
        }

        // D-39: Seeding -> InProgress: bulk set Active status on all eligible enrolled
        if (tournament.stage.tag === 'Seeding' && nextStage === 'InProgress') {
            const allEnrolled = [...ctx.db.TournamentEnrolled.tournament_id.filter(tournamentId)];
            for (const e of allEnrolled) {
                // Set Active for Registered or CheckedIn (non-withdrawn, non-DQ, non-waitlisted)
                if (
                    (e.status.tag === 'Registered' || e.status.tag === 'CheckedIn') &&
                    !e.isWaitlisted
                ) {
                    ctx.db.TournamentEnrolled.by_tournament_and_user.delete([tournamentId, e.userId]);
                    ctx.db.TournamentEnrolled.insert(updateWithAudit(ctx, e, {
                        status: { tag: 'Active', value: {} } as any,
                    }, user.id));
                }
            }
        }

        ctx.db.Tournament.id.update(updateWithAudit(ctx, tournament, {
            stage: { tag: nextStage, value: {} } as any,
        }, user.id));

        // S8 (A24): Completed inserts a TournamentFinalizeJob { tournamentId, cursor: 0 } and sets
        // finalizationStartedAt; the D-91 reveal is gone (A37: history is never public).
    }
);

// ─── cancel_tournament ────────────────────────────────────────────────────────
// Cancels the tournament from any non-terminal state.
// Uses validateStageTransition to block cancelling Completed/Cancelled.

export const cancel_tournament = spacetimedb.reducer(
    {
        tournamentId: t.u32(),
    },
    (ctx, { tournamentId }) => {
        const { user, tournament } = ensureTournamentAccess(ctx, tournamentId);

        validateStageTransition(tournament.stage.tag, 'Cancelled');
        cascadeCleanupTournament(ctx, tournamentId);

        ctx.db.Tournament.id.update(updateWithAudit(ctx, tournament, {
            stage: { tag: 'Cancelled', value: {} } as any,
        }, user.id));

        // S8 (A24(5)): Cancelled runs the same chunked finalization with stats counted and MMR skipped;
        // the D-91 reveal is gone (A37).
    }
);
