import { SenderError } from 'spacetimedb/server';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { insertWithAudit } from '@module/helpers/admin/auditHelpers';

// ─── A33a: the built-in system lobby preset ─────────────────────────────────────────────────────────────────
// Seeded by `init` (CH-S4: from compile-time constants, no data file), idempotent: exactly one LobbyPreset row with
// isSystemPreset = true, owned by SYSTEM_USER_ID. Not deletable (delete_lobby_preset rejects for everyone) and not
// editable by users (update_lobby_preset: Admin only, through ensureCanMutatePreset). Tournament.lobbyPresetId
// defaults to it (create_tournament); S8's create_tournament_lobby copies the free set from the pointed preset and
// falls back to this one.
//
// The free-set values are the tournament-lobby constants of reducers/tournamentLobby.ts (create_tournament_lobby):
// Classic, ban mode Four, NoRestriction, 60 s turns, 120 s reserve, handicaps 0, budgets 0 / 0 / minimum raise 20,
// autoRandomPick false, referee may undo / pause / set captain but not kick, player pause on, exclusive concede on.
// Integrity-set columns (teamSize, gameMode, matchType, anonymity, rosterVisibility, requireOwnership, costSetId,
// disconnect policy, allowMirrorPicks, lineupFormat) come from the tournament in a tournament lobby; the values below
// only fill the columns. A67(2): no series fields.

export const SYSTEM_PRESET_NAME = 'Tournament default';

export const SYSTEM_PRESET_VALUES = {
    name: SYSTEM_PRESET_NAME,
    isSystemPreset: true,
    creatorUserId: SYSTEM_USER_ID,
    // Integrity-set placeholders (overridden by the tournament in a tournament lobby):
    teamSize: 1,
    gameMode: { tag: 'MemoryOfChaos' as const },
    matchType: { tag: 'Casual' as const },
    isPublic: true,
    isAnonymousPlayers: false,
    isAnonymousSpectators: false,
    rosterVisibility: { tag: 'OpenRoster' as const },
    requireOwnership: false,
    costSetId: 0,
    disconnectPolicy: { tag: 'Standard' as const },
    disconnectForfeitSeconds: undefined,
    allowMirrorPicks: false,
    lineupFormat: { tag: 'Halves' as const },
    // Free set: tournamentLobby.ts create_tournament_lobby constants.
    draftMode: { tag: 'Classic' as const },
    banMode: { tag: 'Four' as const },
    banRestriction: { tag: 'NoRestriction' as const },
    standardTurnSeconds: 60,
    reserveBankSeconds: 120,
    rosterDiffAdvantage: 0,
    rosterThreshold: 0,
    underThresholdAdvantage: 0,
    aboveThresholdPenalty: 0,
    deathPenalty: 0,
    characterBudget: 0,
    lightconeBudget: 0,
    minimumBidRaise: 20,
    autoRandomPick: false,
    refereeCanUndo: true,
    refereeCanPause: true,
    refereeCanSetCaptain: true,
    refereeCanKick: false,
    allowPlayerPause: true,
    refereeExclusiveConcede: true,
    hideMmr: false,
    maxSpectators: 12, // A68(8): the upper bound, today's hard cap
};

/** The system preset row, or undefined while it is absent. */
export function findSystemLobbyPreset(ctx: any): any {
    // creator_user_id index: SYSTEM_USER_ID owns only the system preset.
    return [...ctx.db.LobbyPreset.creator_user_id.filter(SYSTEM_USER_ID)].find((p: any) => p.isSystemPreset);
}

/**
 * A33a (S8b): the preset a tournament may point at: the system preset or one the organizer owns. Returns the row.
 * create_tournament and update_tournament call it when the argument names a preset; a preset deleted later is
 * a dangling id that create_tournament_lobby resolves to the system preset (S8d).
 */
export function ensureTournamentPreset(ctx: any, presetId: number, organizerId: number): any {
    const preset = ctx.db.LobbyPreset.id.find(presetId);
    if (!preset) throw new SenderError('Lobby preset not found.');
    if (!preset.isSystemPreset && preset.creatorUserId !== organizerId) {
        throw new SenderError("The tournament can only use the system preset or one of the organizer's own presets.");
    }
    return preset;
}

/** Idempotent seed (init, and server_nuke_test_data after it clears LobbyPreset). Returns the row. */
export function seedSystemLobbyPreset(ctx: any): any {
    const existing = findSystemLobbyPreset(ctx);
    if (existing) return existing;
    return ctx.db.LobbyPreset.insert(insertWithAudit(ctx, {
        id: 0, // autoInc
        ...SYSTEM_PRESET_VALUES,
    }, SYSTEM_USER_ID));
}
