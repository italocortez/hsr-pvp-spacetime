import { SenderError } from 'spacetimedb/server';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';

// ─── A33a: the built-in system lobby preset ─────────────────────────────────────────────────────────────────
// Seeded by `init` (CH-S4: from compile-time constants, no data file), idempotent: exactly one LobbyPreset row with
// isSystemPreset = true, owned by SYSTEM_USER_ID. Not deletable (delete_lobby_preset rejects for everyone) and not
// editable by users (update_lobby_preset: Admin only, through ensureCanMutatePreset). Tournament.lobbyPresetId
// defaults to it (create_tournament); S8's create_tournament_lobby copies the free set from the pointed preset and
// falls back to this one.
//
// The free-set values are the tournament-lobby constants of reducers/tournament/tournamentLobby.ts (create_tournament_lobby):
// Classic, ban mode Four, NoRestriction, 60 s turns, 120 s reserve, handicaps 0, budgets 30 / 15 / minimum raise 5,
// autoRandomPick false, referee may undo / pause / set captain but not kick, player pause on, exclusive concede on.
// S14.4s: the budgets were 0 / 0 and the minimum raise 20 until S14.4s; 0 / 0 made the preset unplayable in Auction (no
// character with a price could be nominated, no priced light cone equipped). create_lobby has no default for them
// (required arguments), so the budgets take the A190 item 5 / A221 R8 values (character 30, light cone 15) and the
// raise the user's ruling of 2026-11-18 (5). refreshSystemLobbyPreset brings a row no Admin edited to these values.
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
    confirmWindowSeconds: 60, // S10t (A131): the default
    rosterDiffAdvantage: 0,
    rosterThreshold: 0,
    underThresholdAdvantage: 0,
    aboveThresholdPenalty: 0,
    deathPenalty: 0,
    characterBudget: 30, // S14.4s (A190 item 5, A221 R8); was 0
    lightconeBudget: 15, // S14.4s (A190 item 5, A221 R8); was 0
    minimumBidRaise: 5, // S14.4s (user ruling 2026-11-18); was 20
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

/** What refreshSystemLobbyPreset did: inserted the row, brought it to the constants, left an Admin's edit, or nothing to do. */
export type SystemPresetRefresh = 'inserted' | 'updated' | 'adminEdited' | 'current';

const sameValue = (a: any, b: any): boolean =>
    a !== null && typeof a === 'object' && b !== null && typeof b === 'object' ? a.tag === b.tag : a === b;

/** The keys of SYSTEM_PRESET_VALUES whose value in `row` differs from the constant. */
function staleKeys(row: any): string[] {
    return Object.keys(SYSTEM_PRESET_VALUES).filter((k) => !sameValue(row[k], (SYSTEM_PRESET_VALUES as any)[k]));
}

/**
 * S14.4s: ensures the system preset row and brings a row no Admin has edited to the current constants.
 * - absent: inserted from SYSTEM_PRESET_VALUES ('inserted');
 * - edited by an Admin (lastModifiedById is not SYSTEM_USER_ID; update_lobby_preset records the Admin's user id, never
 *   0): left as it is ('adminEdited');
 * - every column already equal to the constants: nothing written ('current');
 * - otherwise every SYSTEM_PRESET_VALUES column is written, with the same id and creation audit and SYSTEM as the
 *   modifier, so the row stays refreshable ('updated').
 * Lobbies that already copied older values are not rewritten (a tournament points at the preset by id and copies the
 * free set only when a lobby is created). Called by init, create_tournament without a preset, server_nuke_test_data and
 * server_refresh_system_preset.
 */
export function refreshSystemLobbyPreset(ctx: any): { row: any; outcome: SystemPresetRefresh } {
    const existing = findSystemLobbyPreset(ctx);
    if (!existing) {
        const row = ctx.db.LobbyPreset.insert(insertWithAudit(ctx, { id: 0 /* autoInc */, ...SYSTEM_PRESET_VALUES }, SYSTEM_USER_ID));
        return { row, outcome: 'inserted' };
    }
    if (existing.lastModifiedById !== SYSTEM_USER_ID) return { row: existing, outcome: 'adminEdited' };
    if (staleKeys(existing).length === 0) return { row: existing, outcome: 'current' };
    const row = ctx.db.LobbyPreset.id.update(updateWithAudit(ctx, existing, { ...SYSTEM_PRESET_VALUES }, SYSTEM_USER_ID));
    return { row, outcome: 'updated' };
}

/** Idempotent seed (init, create_tournament without a preset, server_nuke_test_data): refreshSystemLobbyPreset's row. */
export function seedSystemLobbyPreset(ctx: any): any {
    return refreshSystemLobbyPreset(ctx).row;
}
