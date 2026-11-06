import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { DraftMode, BanMode, GameMode, MatchType, RosterVisibility, DisconnectPolicy } from '../types/enums';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';

// ─── Shared permission check for preset edit/delete ──────────────────────────
// Per D-31b permission hierarchy:
// - Admins can edit/delete any preset including system presets.
// - Moderators can edit/delete their own presets, other moderator presets, and TO presets (NOT system presets).
// - TOs can only edit/delete their own presets.

function ensureCanMutatePreset(ctx: any, preset: any, user: any): void {
    const isAdmin = isRoleAtLeast(user.role, 'Admin');
    const isModerator = isRoleAtLeast(user.role, 'Moderator') && !isAdmin;
    const isOwner = preset.creatorUserId === user.id;

    if (preset.isSystemPreset) {
        // Only admins can touch system presets
        if (!isAdmin) {
            throw new SenderError('Only admins can modify or delete system presets.');
        }
        return;
    }

    if (isAdmin) {
        // Admin can edit/delete anything
        return;
    }

    if (isOwner) {
        // Any eligible creator can edit/delete their own preset
        return;
    }

    if (isModerator) {
        // Moderators can edit other moderator presets and TO presets
        const creator = ctx.db.User.id.find(preset.creatorUserId);
        if (creator) {
            const creatorLevel = isRoleAtLeast(creator.role, 'Moderator')
                || isRoleAtLeast(creator.role, 'TournamentHost');
            if (creatorLevel) {
                return;
            }
        }
        throw new SenderError('Moderators can only modify presets created by moderators, TOs, or themselves.');
    }

    throw new SenderError('You do not have permission to modify this preset.');
}

// ─── create_lobby_preset ──────────────────────────────────────────────────────
// Creates a new lobby preset with given config.
// Per D-31b: Admins, moderators, and TOs (TournamentHost+) can create presets.

export const create_lobby_preset = spacetimedb.reducer(
    {
        name: t.string(),
        teamSize: t.u8(),
        draftMode: DraftMode,
        banMode: BanMode,
        gameMode: GameMode,
        matchType: MatchType,
        standardTurnSeconds: t.u32(),
        reserveBankSeconds: t.u32(),
        characterBudget: t.f32(),
        lightconeBudget: t.f32(),
        minimumBidRaise: t.f32(),
        rosterDiffAdvantage: t.f32(),
        rosterThreshold: t.f32(),
        underThresholdAdvantage: t.f32(),
        aboveThresholdPenalty: t.f32(),
        deathPenalty: t.f32(),
        isPublic: t.bool(),
        isAnonymousPlayers: t.bool(),
        isAnonymousSpectators: t.bool(),
        rosterVisibility: RosterVisibility,
        requireOwnership: t.bool(),
        costSetId: t.u32(),
        disconnectPolicy: DisconnectPolicy,
        disconnectForfeitSeconds: t.u32(),
        allowMirrorPicks: t.bool(),
        autoRandomPick: t.bool(),
        refereeCanUndo: t.bool(),
        refereeCanPause: t.bool(),
        refereeCanSetCaptain: t.bool(),
        refereeCanKick: t.bool(),
        allowPlayerPause: t.bool(),
        refereeExclusiveConcede: t.bool(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);

        // D-31b: TournamentHost+ can create presets
        if (!isRoleAtLeast(user.role, 'TournamentHost')) {
            throw new SenderError('Only Tournament Hosts, Moderators, and Admins can create lobby presets.');
        }

        // Validate name length: 1–50 characters
        if (args.name.length < 1 || args.name.length > 50) {
            throw new SenderError('Preset name must be between 1 and 50 characters.');
        }

        // Resolve disconnectForfeitSeconds — 0 sentinel means "not set"
        const disconnectForfeitSeconds = args.disconnectForfeitSeconds > 0
            ? args.disconnectForfeitSeconds
            : undefined;

        ctx.db.LobbyPreset.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            name: args.name,
            isSystemPreset: false,
            creatorUserId: user.id,
            teamSize: args.teamSize,
            draftMode: args.draftMode,
            banMode: args.banMode,
            gameMode: args.gameMode,
            matchType: args.matchType,
            standardTurnSeconds: args.standardTurnSeconds,
            reserveBankSeconds: args.reserveBankSeconds,
            characterBudget: args.characterBudget,
            lightconeBudget: args.lightconeBudget,
            minimumBidRaise: args.minimumBidRaise,
            rosterDiffAdvantage: args.rosterDiffAdvantage,
            rosterThreshold: args.rosterThreshold,
            underThresholdAdvantage: args.underThresholdAdvantage,
            aboveThresholdPenalty: args.aboveThresholdPenalty,
            deathPenalty: args.deathPenalty,
            isPublic: args.isPublic,
            isAnonymousPlayers: args.isAnonymousPlayers,
            isAnonymousSpectators: args.isAnonymousSpectators,
            rosterVisibility: args.rosterVisibility,
            requireOwnership: args.requireOwnership,
            costSetId: args.costSetId,
            disconnectPolicy: args.disconnectPolicy,
            disconnectForfeitSeconds,
            allowMirrorPicks: args.allowMirrorPicks,
            autoRandomPick: args.autoRandomPick,
            refereeCanUndo: args.refereeCanUndo,
            refereeCanPause: args.refereeCanPause,
            refereeCanSetCaptain: args.refereeCanSetCaptain,
            refereeCanKick: args.refereeCanKick,
            allowPlayerPause: args.allowPlayerPause,
            refereeExclusiveConcede: args.refereeExclusiveConcede,
        }, user.id));

        console.log(`[PRESET] Lobby preset "${args.name}" created by user #${user.id}`);
    }
);

// ─── update_lobby_preset ──────────────────────────────────────────────────────
// Updates an existing lobby preset.
// Per D-31b permission hierarchy: see ensureCanMutatePreset.

export const update_lobby_preset = spacetimedb.reducer(
    {
        presetId: t.u32(),
        name: t.string(),
        teamSize: t.u8(),
        draftMode: DraftMode,
        banMode: BanMode,
        gameMode: GameMode,
        matchType: MatchType,
        standardTurnSeconds: t.u32(),
        reserveBankSeconds: t.u32(),
        characterBudget: t.f32(),
        lightconeBudget: t.f32(),
        minimumBidRaise: t.f32(),
        rosterDiffAdvantage: t.f32(),
        rosterThreshold: t.f32(),
        underThresholdAdvantage: t.f32(),
        aboveThresholdPenalty: t.f32(),
        deathPenalty: t.f32(),
        isPublic: t.bool(),
        isAnonymousPlayers: t.bool(),
        isAnonymousSpectators: t.bool(),
        rosterVisibility: RosterVisibility,
        requireOwnership: t.bool(),
        costSetId: t.u32(),
        disconnectPolicy: DisconnectPolicy,
        disconnectForfeitSeconds: t.u32(),
        allowMirrorPicks: t.bool(),
        autoRandomPick: t.bool(),
        refereeCanUndo: t.bool(),
        refereeCanPause: t.bool(),
        refereeCanSetCaptain: t.bool(),
        refereeCanKick: t.bool(),
        allowPlayerPause: t.bool(),
        refereeExclusiveConcede: t.bool(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);

        const preset = ctx.db.LobbyPreset.id.find(args.presetId);
        if (!preset) {
            throw new SenderError('Lobby preset not found.');
        }

        // D-31b: permission check
        ensureCanMutatePreset(ctx, preset, user);

        // Validate name length: 1–50 characters
        if (args.name.length < 1 || args.name.length > 50) {
            throw new SenderError('Preset name must be between 1 and 50 characters.');
        }

        // Resolve disconnectForfeitSeconds — 0 sentinel means "not set"
        const disconnectForfeitSeconds = args.disconnectForfeitSeconds > 0
            ? args.disconnectForfeitSeconds
            : undefined;

        ctx.db.LobbyPreset.id.update(updateWithAudit(ctx, preset, {
            name: args.name,
            teamSize: args.teamSize,
            draftMode: args.draftMode,
            banMode: args.banMode,
            gameMode: args.gameMode,
            matchType: args.matchType,
            standardTurnSeconds: args.standardTurnSeconds,
            reserveBankSeconds: args.reserveBankSeconds,
            characterBudget: args.characterBudget,
            lightconeBudget: args.lightconeBudget,
            minimumBidRaise: args.minimumBidRaise,
            rosterDiffAdvantage: args.rosterDiffAdvantage,
            rosterThreshold: args.rosterThreshold,
            underThresholdAdvantage: args.underThresholdAdvantage,
            aboveThresholdPenalty: args.aboveThresholdPenalty,
            deathPenalty: args.deathPenalty,
            isPublic: args.isPublic,
            isAnonymousPlayers: args.isAnonymousPlayers,
            isAnonymousSpectators: args.isAnonymousSpectators,
            rosterVisibility: args.rosterVisibility,
            requireOwnership: args.requireOwnership,
            costSetId: args.costSetId,
            disconnectPolicy: args.disconnectPolicy,
            disconnectForfeitSeconds,
            allowMirrorPicks: args.allowMirrorPicks,
            autoRandomPick: args.autoRandomPick,
            refereeCanUndo: args.refereeCanUndo,
            refereeCanPause: args.refereeCanPause,
            refereeCanSetCaptain: args.refereeCanSetCaptain,
            refereeCanKick: args.refereeCanKick,
            allowPlayerPause: args.allowPlayerPause,
            refereeExclusiveConcede: args.refereeExclusiveConcede,
        }, user.id));

        console.log(`[PRESET] Lobby preset #${args.presetId} updated by user #${user.id}`);
    }
);

// ─── delete_lobby_preset ──────────────────────────────────────────────────────
// Deletes a lobby preset.
// Per D-31b permission hierarchy: see ensureCanMutatePreset.

export const delete_lobby_preset = spacetimedb.reducer(
    {
        presetId: t.u32(),
    },
    (ctx, args) => {
        const user = getAuthenticatedUser(ctx);

        const preset = ctx.db.LobbyPreset.id.find(args.presetId);
        if (!preset) {
            throw new SenderError('Lobby preset not found.');
        }

        // D-31b: permission check
        ensureCanMutatePreset(ctx, preset, user);

        ctx.db.LobbyPreset.id.delete(args.presetId);

        console.log(`[PRESET] Lobby preset #${args.presetId} deleted by user #${user.id}`);
    }
);
