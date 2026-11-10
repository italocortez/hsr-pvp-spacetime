import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { Identity, ScheduleAt } from 'spacetimedb';
import { hardDeleteLobby } from '@module/reducers/lobby/lobbyGc';
import { removeMemberRow } from '@module/helpers/lobby/memberRemoval';
import { isSeatedPlayer, memberHasLeft } from '@module/helpers/lobby/lobbyHelpers';
import { markMemberOffline } from '@module/helpers/lobby/disconnectHelpers';
import { hasLivePresence } from '@module/helpers/identity/presenceHelpers';
import { findLobbyResult } from '@module/helpers/results/scoringHelpers';
import { performUserDeletion } from '@module/helpers/identity/userDeletionHelper';
import { ensureAdmin } from '@module/helpers/identity/ensurePermissions';
import { checkDisplayName, checkUsername } from '@module/helpers/identity/usernames';
import { syncSoloTeamNames } from '@module/helpers/tournament/tournamentHelpers';
import { auditUpdate } from '@module/helpers/admin/auditColumns';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { Path, Element, CharRole, GameMode, DraftMode, Role } from '@module/types/enums';
import { computeMaxPossible, updateAccountRating } from '@module/helpers/stats/accountRating';
import { hsrCharacterColumns } from '@module/tables/roster/hsrCharacter';
import { hsrLightconeColumns } from '@module/tables/roster/hsrLightcone';
import { hsrCharacterCostColumns } from '@module/tables/roster/hsrCharacterCost';
import { hsrLightconeCostColumns } from '@module/tables/roster/hsrLightconeCost';
import { hsrSynergyCostUpsertKeys } from '@module/tables/roster/hsrSynergyCost';
import { archetypeColumns } from '@module/tables/roster/archetype';
import { canonicalPair } from '@shared/scoring';

// ─── Strict enum validator ───────────────────────────────────────────────────
// Enum values must match exactly (case-sensitive). No coercion.

const ENUM_VARIANTS: Record<string, string[]> = {
    path: Object.keys(Path.variants),
    element: Object.keys(Element.variants),
    role: Object.keys(CharRole.variants),
    gameMode: Object.keys(GameMode.variants),
    draftMode: Object.keys(DraftMode.variants),
    userRole: Object.keys(Role.variants),
};

function validateEnum(field: string, value: string, ctx: any, tableName: string): void {
    const variants = ENUM_VARIANTS[field];
    if (!variants) return;
    if (!variants.includes(value)) {
        const errorMsg = `Invalid ${field}: "${value}". Must be exactly one of: ${variants.join(', ')}`;
        console.error(`[ADMIN] Bulk upsert REJECTED for table "${tableName}" by ${ctx.sender.toHexString()}: ${errorMsg}`);
        throw new SenderError(errorMsg);
    }
}

// ─── Strict key validator ────────────────────────────────────────────────────
// Every row must have exactly the expected keys — no more, no less.
// Audit columns are excluded from validation (they are set server-side).

const AUDIT_KEYS = new Set(['createdById', 'createdDate', 'lastModifiedById', 'lastModifiedDate']);

const EXPECTED_KEYS: Record<string, string[]> = {
    HsrCharacter: Object.keys(hsrCharacterColumns).filter(k => !AUDIT_KEYS.has(k)),
    HsrLightcone: Object.keys(hsrLightconeColumns).filter(k => !AUDIT_KEYS.has(k)),
    HsrCharacterCost: Object.keys(hsrCharacterCostColumns).filter(k => !AUDIT_KEYS.has(k)),
    HsrLightconeCost: Object.keys(hsrLightconeCostColumns).filter(k => !AUDIT_KEYS.has(k)),
    HsrSynergyCost: hsrSynergyCostUpsertKeys,
    Archetype: Object.keys(archetypeColumns).filter(k => k !== 'id' && !AUDIT_KEYS.has(k)),
};

function validateKeys(rows: any[], tableName: string, ctx: any): void {
    const expected = EXPECTED_KEYS[tableName];
    if (!expected) return;
    const expectedSet = new Set(expected);
    const expectedSorted = [...expected].sort().join(',');

    for (let i = 0; i < rows.length; i++) {
        const actualKeys = Object.keys(rows[i]).sort();
        if (actualKeys.join(',') !== expectedSorted) {
            const actualSet = new Set(actualKeys);
            const missing = expected.filter(k => !actualSet.has(k));
            const extra = actualKeys.filter(k => !expectedSet.has(k));
            const parts: string[] = [];
            if (missing.length) parts.push(`missing: [${missing.join(', ')}]`);
            if (extra.length) parts.push(`unexpected: [${extra.join(', ')}]`);
            const errorMsg = `Row ${i} key mismatch: ${parts.join(', ')}. Expected exactly: [${expected.join(', ')}]`;
            console.error(`[ADMIN] Bulk upsert REJECTED for table "${tableName}" by ${ctx.sender.toHexString()}: ${errorMsg}`);
            throw new SenderError(errorMsg);
        }
    }
}

/**
 * Phase 15 D-08/D-10: Partial-update merge for the admin_bulk_upsert router.
 *
 * Wire convention:
 *   - Every EXPECTED_KEYS entry must appear in the incoming object (validateKeys rule
 *     upstream; mergeForUpdate asserts this defensively).
 *   - Value `null` or `undefined` on an EXISTING row = "preserve this field".
 *     JSON inputs only produce `null`; programmatic router inputs may use either —
 *     treated equivalently to match the router's own null-guards at the enum sites.
 *   - Value `null` on an INSERT row = "apply schema default" (required columns) OR
 *     "stay null" (optional columns).
 *   - Non-null/undefined value = "set to this value".
 *
 * This helper returns the merged row for UPDATE only. The insert branch stays on its
 * current default-injection path per D-12.
 */
function mergeForUpdate<T extends Record<string, any>, K extends keyof T & string>(
    existing: T,
    incoming: Partial<Record<K, unknown>>,
    fields: readonly K[]
): T {
    const merged: T = { ...existing };
    for (const f of fields) {
        // validateKeys guarantees key presence; assert defensively so a future
        // caller that bypasses validateKeys fails loudly instead of silently
        // writing `undefined` or dropping fields.
        if (!(f in incoming)) {
            throw new Error(`mergeForUpdate: missing key '${f}' — validateKeys contract broken`);
        }
        // null | undefined → preserve existing value (merged already copied from existing)
        if (incoming[f] != null) {
            // Narrow cast: incoming[f] is typed as `unknown` (via the Partial<Record<K, unknown>>
            // signature) to accept arbitrary validated input; write-through to the generic
            // row T uses T[K] here since K extends keyof T.
            merged[f] = incoming[f] as T[K];
        }
    }
    return merged;
}

/**
 * Wrap enum validation so `null` values on update (meaning "preserve") skip validation.
 * The insert branch still validates because insert paths fall back to defaults before this runs
 * (or explicitly guard the call site).
 */
function validateEnumIfPresent(field: string, value: any, ctx: any, tableName: string): void {
    if (value === null || value === undefined) return;
    validateEnum(field, value, ctx, tableName);
}

/**
 * Parse a numeric primary key from the wire string. Throws SenderError with context
 * if the input is not a valid non-negative integer (e.g. malformed admin UI input).
 */
function parseNumericPk(raw: string, tableName: string): number {
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 0) {
        throw new SenderError(`Invalid primary key for ${tableName}: '${raw}' — expected non-negative integer`);
    }
    return id;
}

/** Identity audit #4: match state of a lobby that still exists is removed with the lobby, never row by row. */
function ensureLobbyGone(ctx: any, lobbyId: number, tableName: string): void {
    if (ctx.db.Lobby.id.find(lobbyId)) {
        throw new SenderError(`Cannot delete a ${tableName} row of lobby #${lobbyId} while the lobby exists. Delete the Lobby row instead.`);
    }
}

/**
 * Identity audit #14: a malformed JSON key is a SenderError naming the table, not an opaque SyntaxError. S10e review N3:
 * valid JSON that is not an object or array (null, a number, a string) gets the same text, not a TypeError on the field
 * read (the composite keys are objects; MatchSessionStepHistory's is a 2-tuple array).
 */
function parseJsonPk(raw: string, tableName: string): any {
    let key: unknown;
    try {
        key = JSON.parse(raw);
    } catch {
        throw new SenderError(`Invalid primary key for ${tableName}: expected JSON`);
    }
    if (key === null || typeof key !== 'object') {
        throw new SenderError(`Invalid primary key for ${tableName}: expected JSON`);
    }
    return key;
}

// ─── Generic row delete (the admin panel's fixed list of tables below) ───────
// S10e (identity audit #4, #5): rows with dependants go through the module's own removal paths: a Lobby through
// hardDeleteLobby (the whole D-19 cascade), a LobbyMember through removeMemberRow (flags handed over, account lock
// released, count decremented), a UserIdentity together with its UserPresence row (a guest left with no identity is
// deleted through performUserDeletion). MatchSession / MatchSessionStep rows are deleted raw only once their lobby is
// gone (orphans); a live lobby's match state is removed with the lobby.
// S10e fix pass: a tournament lobby and a lobby whose record is Validated or processed are refused (F1, the
// admin_void_match guards); a seated player row is refused in Drafting / Equipping / Scoring / AwaitingResult (F4,
// A68(6)); a server identity or SYSTEM mapping is refused (N9); a deleted last live identity takes the user's
// memberships offline as a disconnect does (F5).

// F4: the stages in which a seated player's row is never removed (A68(6); AwaitingResult too: the record is open).
const PLAYER_LOCKED_STAGES: readonly string[] = ['Drafting', 'Equipping', 'Scoring', 'AwaitingResult'];

export const admin_delete_row = spacetimedb.reducer(
    { tableName: t.string(), primaryKeyJson: t.string() },
    (ctx, { tableName, primaryKeyJson }) => {
        const admin = ensureAdmin(ctx);

        switch (tableName) {
            case 'User': {
                const id = parseNumericPk(primaryKeyJson, 'User');
                const user = ctx.db.User.id.find(id);
                if (!user) throw new SenderError('Row not found');

                // Identity audit #9: the server identities' admin rights come from the SYSTEM user.
                if (user.username === 'SYSTEM') throw new SenderError('The SYSTEM user cannot be deleted.');

                // Already pending deletion
                if (user.deletedAt) throw new SenderError(`User #${id} is already pending deletion.`);

                // Block deletion if user is hosting an active lobby (use btree index)
                const hostedLobbies = [...ctx.db.Lobby.host_user_id.filter(id)];
                if (hostedLobbies.length > 0) {
                    throw new SenderError(
                        `Cannot delete user #${id}: they are hosting lobby "${hostedLobbies[0].joinCode}". Remove the lobby first.`
                    );
                }

                // Block deletion if user is a member of an active lobby (use btree index)
                const memberships = [...ctx.db.LobbyMember.user_id.filter(id)];
                if (memberships.length > 0) {
                    throw new SenderError(
                        `Cannot delete user #${id}: they are in active lobby #${memberships[0].lobbyId}. Remove them from the lobby first.`
                    );
                }

                // Block deletion if user is in an active match step (indexed lookup, Phase 15 WR-07)
                const firstStep = ctx.db.MatchSessionStep.by_actor_user.filter(id).next().value;
                if (firstStep) {
                    throw new SenderError(
                        `Cannot delete user #${id}: they have actions in active match (lobby #${firstStep.lobbyId}). End the match first.`
                    );
                }

                // Soft-delete: set deletedAt (no client signal: view_my_profile does not carry it). The scheduled
                // run_user_deletion (performUserDeletion) then deletes the user's UserIdentity rows, so view_my_identity
                // and view_my_profile go empty for every session of that user; the connection itself is not closed.
                ctx.db.User.id.update(
                    updateWithAudit(ctx, user, { deletedAt: ctx.timestamp }, admin.id),
                );

                // Schedule deletion cascade in 5 seconds (5_000_000 microseconds)
                const deleteAt = ctx.timestamp.microsSinceUnixEpoch + 5_000_000n;
                ctx.db.UserDeletionJob.insert(insertWithAudit(ctx, {
                    scheduledId: 0n,
                    scheduledAt: ScheduleAt.time(deleteAt),
                    userId: id,
                }, admin.id));

                console.log(`[ADMIN] User #${id} marked for deletion. Cascade scheduled in 5s.`);
                break;
            }
            case 'UserIdentity': {
                // The key is the identity hex string.
                let identity: Identity;
                try {
                    identity = Identity.fromString(primaryKeyJson);
                } catch {
                    throw new SenderError('Invalid primary key for UserIdentity: expected an identity hex string');
                }
                const row = ctx.db.UserIdentity.identity.find(identity);
                if (!row) throw new SenderError('Row not found');
                // S10e review N9 (identity audit #1 / #9): the server identities (Owner, Delegates) and every mapping
                // of the SYSTEM user stay, as identity GC keeps them: their admin rights come from the SYSTEM link.
                if (ctx.db.ServerIdentity.identity.find(identity)) {
                    throw new SenderError('A server identity mapping cannot be deleted.');
                }
                if (row.userId === ctx.db.User.username.find('SYSTEM')?.id) {
                    throw new SenderError('A mapping of the SYSTEM user cannot be deleted.');
                }
                ctx.db.UserIdentity.identity.delete(identity);
                // Identity audit #5: the presence row goes with its mapping (client_disconnected skips presence
                // without one, so a live row would read the user as online forever).
                if (ctx.db.UserPresence.identity.find(identity)) ctx.db.UserPresence.identity.delete(identity);
                // A guest with no identity left can never log in again (Guest_<hex> is taken) and no GC sees it.
                const owner = ctx.db.User.id.find(row.userId);
                if (owner?.isGuest && [...ctx.db.UserIdentity.user_id.filter(row.userId)].length === 0) {
                    performUserDeletion(ctx, row.userId, admin.id);
                } else if (!hasLivePresence(ctx, row.userId)) {
                    // S10e review F5: the deleted identity was the user's last live one, and client_disconnected will
                    // never run for it (no mapping). Take the user's memberships offline as a disconnect does
                    // (markMemberOffline: isOnline false, the live-stage stamp, the 15 s check). Rows already offline,
                    // away or abandoned keep their stamp and pending check.
                    for (const member of [...ctx.db.LobbyMember.user_id.filter(row.userId)]) {
                        if (!member.isOnline || memberHasLeft(member)) continue;
                        const lobby = ctx.db.Lobby.id.find(member.lobbyId);
                        if (!lobby) continue;
                        markMemberOffline(ctx, lobby, member, admin.id);
                    }
                }
                break;
            }
            case 'HsrCharacter': {
                if (!ctx.db.HsrCharacter.name.find(primaryKeyJson)) throw new SenderError('Row not found');
                ctx.db.HsrCharacter.name.delete(primaryKeyJson);
                break;
            }
            case 'HsrLightcone': {
                if (!ctx.db.HsrLightcone.name.find(primaryKeyJson)) throw new SenderError('Row not found');
                ctx.db.HsrLightcone.name.delete(primaryKeyJson);
                break;
            }
            case 'HsrCharacterCost': {
                // Full composite PK: (characterName, gameMode, draftMode, costSetId).
                // Tuple-filter with enum struct unsupported (RESEARCH.md A2); use iter() with full predicate.
                const key = parseJsonPk(primaryKeyJson, tableName);
                let found = false;
                for (const row of ctx.db.HsrCharacterCost.iter()) {
                    if (row.characterName === key.characterName &&
                        row.gameMode.tag === key.gameModeTag &&
                        row.draftMode.tag === key.draftModeTag &&
                        row.costSetId === key.costSetId) {
                        ctx.db.HsrCharacterCost.delete(row);
                        found = true;
                        break;
                    }
                }
                if (!found) throw new SenderError('Row not found');
                break;
            }
            case 'HsrLightconeCost': {
                // Full composite PK: (lightconeName, gameMode, draftMode, costSetId).
                const key = parseJsonPk(primaryKeyJson, tableName);
                let found = false;
                for (const row of ctx.db.HsrLightconeCost.iter()) {
                    if (row.lightconeName === key.lightconeName &&
                        row.gameMode.tag === key.gameModeTag &&
                        row.draftMode.tag === key.draftModeTag &&
                        row.costSetId === key.costSetId) {
                        ctx.db.HsrLightconeCost.delete(row);
                        found = true;
                        break;
                    }
                }
                if (!found) throw new SenderError('Row not found');
                break;
            }
            case 'HsrSynergyCost': {
                const id = parseNumericPk(primaryKeyJson, 'HsrSynergyCost');
                if (!ctx.db.HsrSynergyCost.id.find(id)) throw new SenderError('Row not found');
                ctx.db.HsrSynergyCost.id.delete(id);
                break;
            }
            case 'Archetype': {
                const id = parseNumericPk(primaryKeyJson, 'Archetype');
                if (!ctx.db.Archetype.id.find(id)) throw new SenderError('Row not found');
                // Cascade: delete all HsrCharacterArchetype rows for this archetype
                const junctions = [...ctx.db.HsrCharacterArchetype.archetype_id.filter(id)];
                for (const j of junctions) { ctx.db.HsrCharacterArchetype.delete(j); }
                ctx.db.Archetype.id.delete(id);
                break;
            }
            case 'HsrCharacterArchetype': {
                const key = parseJsonPk(primaryKeyJson, tableName);
                const row = [...ctx.db.HsrCharacterArchetype.by_character_and_archetype.filter([key.characterName, key.archetypeId])][0];
                if (!row) throw new SenderError('Row not found');
                ctx.db.HsrCharacterArchetype.delete(row);
                break;
            }
            case 'Lobby': {
                const id = parseNumericPk(primaryKeyJson, 'Lobby');
                const lobby = ctx.db.Lobby.id.find(id);
                if (!lobby) throw new SenderError('Row not found');
                // S10e review F1: the guards of admin_void_match (D.8.3, D-56). hardDeleteLobby deletes the lobby's
                // MatchResultRecord, so a tournament lobby (its records drive the bracket tally, A24 / A67(4)) and a
                // Validated or already processed record (a counted game) never go through this path.
                if (lobby.isTournamentControlled) {
                    throw new SenderError('This is a tournament lobby: use rollback_bracket_match or the tournament result reducers (results permission).');
                }
                const record = findLobbyResult(ctx, id);
                if (record && (record.status.tag === 'Validated' || record.mmrProcessedAt !== undefined)) {
                    throw new SenderError('This lobby\'s match result is Validated or already processed: use admin_void_match or override_match_result.');
                }
                hardDeleteLobby(ctx, id); // identity audit #4: the D-19 cascade, as close_lobby
                break;
            }
            case 'LobbyMember': {
                const key = parseJsonPk(primaryKeyJson, tableName);
                const row = [...ctx.db.LobbyMember.by_lobby_and_user.filter([key.lobbyId, key.userId])][0];
                if (!row) throw new SenderError('Row not found');
                // S10e review F4 (A68(6)): a seated player (not a coach, not a spectator) is never removed once the
                // draft has started; the match ends by result, concede or forfeit.
                const memberLobby = ctx.db.Lobby.id.find(row.lobbyId);
                if (memberLobby && PLAYER_LOCKED_STAGES.includes(memberLobby.stage.tag) && isSeatedPlayer(row)) {
                    throw new SenderError('Players cannot be removed once the draft has started; the match ends by result, concede or forfeit.');
                }
                // Identity audit #4: flags handed over (A68(7)), account lock released, count decremented; an emptied
                // Waiting lobby is hard-deleted.
                removeMemberRow(ctx, row.lobbyId, row.userId, admin.id);
                break;
            }
            case 'MatchSession': {
                const id = parseNumericPk(primaryKeyJson, 'MatchSession');
                if (!ctx.db.MatchSession.lobbyId.find(id)) throw new SenderError('Row not found');
                ensureLobbyGone(ctx, id, 'MatchSession');
                ctx.db.MatchSession.lobbyId.delete(id);
                break;
            }
            case 'MatchSessionStep': {
                const id = parseNumericPk(primaryKeyJson, 'MatchSessionStep');
                const step = ctx.db.MatchSessionStep.id.find(id);
                if (!step) throw new SenderError('Row not found');
                ensureLobbyGone(ctx, step.lobbyId, 'MatchSessionStep');
                ctx.db.MatchSessionStep.id.delete(id);
                break;
            }
            case 'MatchSessionHistory': {
                const id = parseNumericPk(primaryKeyJson, 'MatchSessionHistory');
                if (!ctx.db.MatchSessionHistory.id.find(id)) throw new SenderError('Row not found');
                // S10r (A122(2), L4): the match's participant, step, game and lineup history rows go with it
                // (by_match_history btree on each). MmrHistory rows are a user's rating trail and stay.
                for (const r of [...ctx.db.MatchParticipantHistory.by_match_history.filter(id)]) ctx.db.MatchParticipantHistory.delete(r);
                for (const r of [...ctx.db.MatchSessionStepHistory.by_match_history.filter(id)]) ctx.db.MatchSessionStepHistory.delete(r);
                for (const r of [...ctx.db.MatchResultGameHistory.by_match_history.filter(id)]) ctx.db.MatchResultGameHistory.delete(r);
                for (const r of [...ctx.db.MatchLineupHistory.by_match_history.filter(id)]) ctx.db.MatchLineupHistory.delete(r);
                ctx.db.MatchSessionHistory.id.delete(id);
                break;
            }
            case 'MatchSessionStepHistory': {
                // Composite PK [matchHistoryId, sequence] (A67(3)) — parse JSON 2-tuple
                const stepPK = parseJsonPk(primaryKeyJson, tableName);
                const stepRow = [...ctx.db.MatchSessionStepHistory.by_match_history.filter(stepPK[0])]
                    .find((r: any) => r.sequence === stepPK[1]);
                if (!stepRow) throw new SenderError('Row not found');
                ctx.db.MatchSessionStepHistory.delete(stepRow);
                break;
            }
            default:
                throw new SenderError(`Unknown table: ${tableName}`);
        }
    }
);

// ─── Bulk upsert for game data tables ────────────────────────────────────────
//
// Wire convention (Phase 15 D-08/D-09/D-10):
//
//   1. validateKeys (strict): every row in `jsonData` MUST contain EXACTLY the expected
//      key set for the table (no missing, no extra). Partial-update is NOT expressed by
//      omitting keys — doing so trips validateKeys.
//
//   2. Partial-update is expressed in VALUES:
//        - `null` on an EXISTING row  → preserve the existing field value (no overwrite).
//        - `null` on an INSERT row    → apply schema default for required columns,
//                                        or keep null for optional columns.
//        - non-null value              → set the field to that value.
//
//   3. Cost tables (HsrCharacterCost, HsrLightconeCost, HsrSynergyCost) match existing rows
//      by the FULL composite tuple INCLUDING `costSetId` — distinct cost sets never collide.
//      `r.costSetId ?? 0` honors the default-cost-set sentinel.
//
//   4. Insert branch retains its default-injection logic (per D-12); partial-update only
//      kicks in when an existing row is found.
//
// Callers: `scripts/stdb/seed.ts` / `bootstrap.ts`, future admin UI editors.
export const admin_bulk_upsert = spacetimedb.reducer(
    { tableName: t.string(), jsonData: t.string() },
    (ctx, { tableName, jsonData }) => {
        const admin = ensureAdmin(ctx);

        let rows: any[];
        try {
            rows = JSON.parse(jsonData);
        } catch {
            throw new SenderError('jsonData must be a JSON array'); // identity audit #14: not an opaque SyntaxError
        }
        if (!Array.isArray(rows)) throw new SenderError('jsonData must be a JSON array');

        validateKeys(rows, tableName, ctx);

        switch (tableName) {
            case 'HsrCharacter': {
                // Fields that participate in partial-update on existing rows.
                // Non-null values overwrite; null values preserve existing.
                const HSR_CHARACTER_FIELDS = [
                    'displayName', 'aliases', 'rarity', 'path', 'element', 'role',
                    'imageUrl', 'versionReleased', 'treatAsVersion',
                    'posX', 'posY', 'width', // A17: Spine columns dropped
                ] as const;
                for (const r of rows) {
                    // Enum validation: skip on null (preserve-existing path on update).
                    validateEnumIfPresent('path', r.path, ctx, tableName);
                    validateEnumIfPresent('element', r.element, ctx, tableName);
                    validateEnumIfPresent('role', r.role, ctx, tableName);
                    const existing = ctx.db.HsrCharacter.name.find(r.name);

                    if (existing) {
                        // Build the incoming row with enum-tag wrappers ONLY for non-null enum fields.
                        // mergeForUpdate then preserves existing values where incoming is null.
                        const incoming: Record<string, any> = {
                            displayName: r.displayName,
                            aliases: r.aliases,
                            rarity: r.rarity,
                            path: r.path !== null && r.path !== undefined ? { tag: r.path, value: {} } : null,
                            element: r.element !== null && r.element !== undefined ? { tag: r.element, value: {} } : null,
                            role: r.role !== null && r.role !== undefined ? { tag: r.role, value: {} } : null,
                            imageUrl: r.imageUrl,
                            versionReleased: r.versionReleased,
                            treatAsVersion: r.treatAsVersion,
                            posX: r.posX,
                            posY: r.posY,
                            width: r.width,
                        };
                        const merged = mergeForUpdate(existing, incoming, HSR_CHARACTER_FIELDS);
                        ctx.db.HsrCharacter.name.update(updateWithAudit(ctx, existing, merged, admin.id));
                    } else {
                        // Insert branch: apply schema defaults for required columns; optional stays null.
                        // Required enums must have a value on insert (validateEnum runs here unconditionally).
                        validateEnum('path', r.path, ctx, tableName);
                        validateEnum('element', r.element, ctx, tableName);
                        validateEnum('role', r.role, ctx, tableName);
                        const row = {
                            name: r.name,
                            displayName: r.displayName ?? '',
                            aliases: r.aliases ?? [],
                            rarity: r.rarity ?? 0,
                            path: { tag: r.path, value: {} },
                            element: { tag: r.element, value: {} },
                            role: { tag: r.role, value: {} },
                            imageUrl: r.imageUrl ?? '',
                            versionReleased: r.versionReleased ?? 0,
                            treatAsVersion: r.treatAsVersion ?? 0,
                            // Positioning columns default to 0 (A17: no Spine columns).
                            posX: r.posX ?? 0,
                            posY: r.posY ?? 0,
                            width: r.width ?? 0,
                        };
                        ctx.db.HsrCharacter.insert(insertWithAudit(ctx, row, admin.id));
                    }
                }

                // Auto-trigger: recompute maxPossible and recalculate all ratings if changed (D-33)
                const ratingConfig = ctx.db.AccountRatingConfig.id.find(1);
                if (ratingConfig) {
                    const allChars = [...ctx.db.HsrCharacter.iter()];
                    const maxVersion = allChars.reduce((m: number, c: any) => Math.max(m, c.versionReleased), 0);
                    if (maxVersion > 0) {
                        const roleExponent: Record<string, number> = {
                            Dps: ratingConfig.roleExponentDps,
                            Support: ratingConfig.roleExponentSupport,
                            Sustain: ratingConfig.roleExponentSustain,
                        };
                        const ageWeightMap = new Map<string, number>();
                        for (const c of allChars) {
                            const version = c.treatAsVersion > 0 ? c.treatAsVersion : c.versionReleased;
                            const major = Math.floor(version);
                            const frac = version - major;
                            const effective = major + frac * ratingConfig.compression;
                            const baseWeight = Math.sqrt(effective / maxVersion);
                            const exp = roleExponent[c.role.tag] ?? 1.0;
                            ageWeightMap.set(c.name, Math.pow(baseWeight, exp));
                        }
                        const newMaxPossible = computeMaxPossible(ctx, ratingConfig, ageWeightMap, allChars);
                        if (Math.abs(newMaxPossible - ratingConfig.maxPossible) > 0.0001) {
                            ctx.db.AccountRatingConfig.id.update(
                                updateWithAudit(ctx, ratingConfig, { maxPossible: newMaxPossible }, admin.id),
                            );
                            // Recalculate all account ratings with new maxPossible
                            const accounts = [...ctx.db.HsrAccount.iter()];
                            for (const account of accounts) {
                                updateAccountRating(ctx, account.id, admin.id);
                            }
                            console.log(`[ADMIN] HsrCharacter bulk upsert auto-triggered rating recalc: maxPossible ${ratingConfig.maxPossible.toFixed(4)} -> ${newMaxPossible.toFixed(4)}, ${accounts.length} accounts updated`);
                        }
                    }
                }
                break;
            }
            case 'HsrLightcone': {
                const HSR_LIGHTCONE_FIELDS = [
                    'displayName', 'aliases', 'path', 'rarity', 'imageUrl',
                    'posX', 'posY', 'width',
                ] as const;
                for (const r of rows) {
                    validateEnumIfPresent('path', r.path, ctx, tableName);
                    const existing = ctx.db.HsrLightcone.name.find(r.name);

                    if (existing) {
                        const incoming: Record<string, any> = {
                            displayName: r.displayName,
                            aliases: r.aliases,
                            path: r.path !== null && r.path !== undefined ? { tag: r.path, value: {} } : null,
                            rarity: r.rarity,
                            imageUrl: r.imageUrl,
                            posX: r.posX,
                            posY: r.posY,
                            width: r.width,
                        };
                        const merged = mergeForUpdate(existing, incoming, HSR_LIGHTCONE_FIELDS);
                        ctx.db.HsrLightcone.name.update(updateWithAudit(ctx, existing, merged, admin.id));
                    } else {
                        // Insert branch: required enum MUST be present on insert.
                        validateEnum('path', r.path, ctx, tableName);
                        const row = {
                            name: r.name,
                            displayName: r.displayName ?? '',
                            aliases: r.aliases ?? [],
                            path: { tag: r.path, value: {} },
                            rarity: r.rarity ?? 0,
                            imageUrl: r.imageUrl ?? '',
                            posX: r.posX ?? 0,
                            posY: r.posY ?? 0,
                            width: r.width ?? 0,
                        };
                        ctx.db.HsrLightcone.insert(insertWithAudit(ctx, row, admin.id));
                    }
                }
                break;
            }
            case 'HsrCharacterCost': {
                // 15.4 D-19: Match existing rows on the FULL composite tuple
                // (characterName, gameMode, draftMode, costSetId). Row absence = "not configured
                // for that draft mode" (15.4 D-10). One row per (name, gameMode, draftMode, costSetId).
                const HSR_CHARACTER_COST_FIELDS = ['costs'] as const;
                for (const r of rows) {
                    validateEnumIfPresent('gameMode', r.gameMode, ctx, tableName);
                    validateEnumIfPresent('draftMode', r.draftMode, ctx, tableName);
                    const csId = r.costSetId ?? 0;

                    // Tuple-filter with enum struct is unsupported (RESEARCH.md A2); use iter() fallback
                    // with extended predicate including draftMode.
                    let existing: any = null;
                    for (const e of ctx.db.HsrCharacterCost.iter()) {
                        if (e.characterName === r.characterName &&
                            e.gameMode.tag === r.gameMode &&
                            e.draftMode.tag === r.draftMode &&
                            e.costSetId === csId) {
                            existing = e;
                            break;
                        }
                    }

                    if (existing) {
                        // Partial-update: preserve existing values where incoming is null.
                        const incoming: Record<string, any> = {
                            costs: r.costs,
                        };
                        const merged = mergeForUpdate(existing, incoming, HSR_CHARACTER_COST_FIELDS);
                        // Re-insert pattern (no direct PK accessor for composite delete+insert is fine here).
                        ctx.db.HsrCharacterCost.delete(existing);
                        ctx.db.HsrCharacterCost.insert({
                            characterName: existing.characterName,
                            gameMode: existing.gameMode,
                            draftMode: existing.draftMode,
                            costs: merged.costs,
                            costSetId: csId,
                            ...auditUpdate(ctx, existing, admin.id),
                        } as any);
                    } else {
                        // Insert branch: required enums must be present.
                        validateEnum('gameMode', r.gameMode, ctx, tableName);
                        validateEnum('draftMode', r.draftMode, ctx, tableName);
                        ctx.db.HsrCharacterCost.insert(insertWithAudit(ctx, {
                            characterName: r.characterName,
                            gameMode: { tag: r.gameMode, value: {} } as any,
                            draftMode: { tag: r.draftMode, value: {} } as any,
                            costs: r.costs,
                            costSetId: csId,
                        }, admin.id));
                    }
                }
                break;
            }
            case 'HsrLightconeCost': {
                // 15.4 D-19: Full composite tuple match (lightconeName, gameMode, draftMode, costSetId).
                const HSR_LIGHTCONE_COST_FIELDS = ['costs'] as const;
                for (const r of rows) {
                    validateEnumIfPresent('gameMode', r.gameMode, ctx, tableName);
                    validateEnumIfPresent('draftMode', r.draftMode, ctx, tableName);
                    const csId = r.costSetId ?? 0;

                    let existing: any = null;
                    for (const e of ctx.db.HsrLightconeCost.iter()) {
                        if (e.lightconeName === r.lightconeName &&
                            e.gameMode.tag === r.gameMode &&
                            e.draftMode.tag === r.draftMode &&
                            e.costSetId === csId) {
                            existing = e;
                            break;
                        }
                    }

                    if (existing) {
                        const incoming: Record<string, any> = {
                            costs: r.costs,
                        };
                        const merged = mergeForUpdate(existing, incoming, HSR_LIGHTCONE_COST_FIELDS);
                        ctx.db.HsrLightconeCost.delete(existing);
                        ctx.db.HsrLightconeCost.insert({
                            lightconeName: existing.lightconeName,
                            gameMode: existing.gameMode,
                            draftMode: existing.draftMode,
                            costs: merged.costs,
                            costSetId: csId,
                            ...auditUpdate(ctx, existing, admin.id),
                        } as any);
                    } else {
                        validateEnum('gameMode', r.gameMode, ctx, tableName);
                        validateEnum('draftMode', r.draftMode, ctx, tableName);
                        ctx.db.HsrLightconeCost.insert(insertWithAudit(ctx, {
                            lightconeName: r.lightconeName,
                            gameMode: { tag: r.gameMode, value: {} } as any,
                            draftMode: { tag: r.draftMode, value: {} } as any,
                            costs: r.costs,
                            costSetId: csId,
                        }, admin.id));
                    }
                }
                break;
            }
            case 'HsrSynergyCost': {
                // 15.4 D-19: Existence match uses (characterA, characterB, gameMode, draftMode, costSetId).
                // PK is auto-inc id; the tuple above is the logical unique key.
                // A21: synergies are unordered pairs. Each row is stored in canonical (alphabetical) order, an
                // existing pair matches in either order (so it is updated, never duplicated reversed), and a payload
                // that lists the same pair twice, in either order, is rejected.
                const HSR_SYNERGY_COST_FIELDS = ['costModifier'] as const;
                const seenPairs = new Set<string>();
                for (const raw of rows) {
                    const [characterA, characterB] = canonicalPair(raw.characterA, raw.characterB);
                    // Audit 2026-11-09 (roster finding 1): both names must be HsrCharacter rows (a misspelt name never matches a group).
                    for (const name of [characterA, characterB]) {
                        if (!ctx.db.HsrCharacter.name.find(name)) throw new SenderError(`Character ${name} not found.`);
                    }
                    const r = { ...raw, characterA, characterB };
                    validateEnumIfPresent('gameMode', r.gameMode, ctx, tableName);
                    validateEnumIfPresent('draftMode', r.draftMode, ctx, tableName);
                    const csId = r.costSetId ?? 0;
                    const pairKey = `${characterA}|${characterB}|${r.gameMode}|${r.draftMode}|${csId}`;
                    if (seenPairs.has(pairKey)) {
                        throw new SenderError(`Synergy pair ${characterA} + ${characterB} is listed twice (pairs are unordered).`);
                    }
                    seenPairs.add(pairKey);

                    let existing: any = null;
                    for (const e of ctx.db.HsrSynergyCost.iter()) {
                        const [eA, eB] = canonicalPair(e.characterA, e.characterB);
                        if (eA === r.characterA &&
                            eB === r.characterB &&
                            e.gameMode.tag === r.gameMode &&
                            e.draftMode.tag === r.draftMode &&
                            e.costSetId === csId) {
                            existing = e;
                            break;
                        }
                    }
                    if (existing) {
                        const incoming: Record<string, any> = {
                            costModifier: r.costModifier,
                        };
                        const merged = mergeForUpdate(existing, incoming, HSR_SYNERGY_COST_FIELDS);
                        ctx.db.HsrSynergyCost.id.update(
                            updateWithAudit(ctx, existing, { costModifier: merged.costModifier }, admin.id),
                        );
                    } else {
                        validateEnum('gameMode', r.gameMode, ctx, tableName);
                        validateEnum('draftMode', r.draftMode, ctx, tableName);
                        const row = {
                            id: 0,
                            characterA: r.characterA,
                            characterB: r.characterB,
                            gameMode: { tag: r.gameMode, value: {} },
                            draftMode: { tag: r.draftMode, value: {} },
                            costModifier: r.costModifier,
                            costSetId: csId,
                        };
                        ctx.db.HsrSynergyCost.insert(insertWithAudit(ctx, row, admin.id));
                    }
                }
                break;
            }
            case 'Archetype': {
                for (const r of rows) {
                    const existing = ctx.db.Archetype.name.find(r.name);
                    if (existing) {
                        ctx.db.Archetype.id.update(
                            updateWithAudit(ctx, existing, { name: r.name, description: r.description }, admin.id),
                        );
                    } else {
                        ctx.db.Archetype.insert(insertWithAudit(ctx, {
                            id: 0,
                            name: r.name,
                            description: r.description,
                        }, admin.id));
                    }
                }
                break;
            }
            default:
                throw new SenderError(`Bulk upsert not supported for table: ${tableName}`);
        }
    }
);

// ─── Update user (inline edit from admin panel) ──────────────────────────────

export const admin_update_user = spacetimedb.reducer(
    { userId: t.u32(), displayName: t.string(), username: t.string(), roleTag: t.string() },
    (ctx, { userId, displayName, username, roleTag }) => {
        const admin = ensureAdmin(ctx);

        const user = ctx.db.User.id.find(userId);
        if (!user) throw new SenderError('User not found');
        // Identity audit #9: the server identities' admin rights come from the SYSTEM user (name and role).
        if (user.username === 'SYSTEM') throw new SenderError('The SYSTEM user cannot be changed.');
        // S10r (A122(1), L1): a user pending deletion (deletedAt set by an admin deletion or a ban) is not edited.
        if (user.deletedAt) throw new SenderError(`User #${userId} is pending deletion.`);

        // S10r (A122(1), L1): the same name rules as the player's own rename (trim, non-empty, 32 characters).
        const newDisplayName = checkDisplayName(displayName);
        const newUsername = checkUsername(username);

        // Validate role tag
        validateEnum('userRole', roleTag, ctx, 'User');

        // Check username uniqueness if changed
        if (newUsername !== user.username) {
            const existing = ctx.db.User.username.find(newUsername);
            if (existing) throw new SenderError(`Username "${newUsername}" is already taken`);
        }

        ctx.db.User.id.update(
            updateWithAudit(ctx, user, {
                displayName: newDisplayName,
                username: newUsername,
                role: { tag: roleTag, value: {} } as any,
            }, admin.id),
        );
        // S10r (A122(1), L1): the solo team names follow the display name, as on the player's own rename.
        syncSoloTeamNames(ctx, userId, newDisplayName, admin.id);
    }
);
