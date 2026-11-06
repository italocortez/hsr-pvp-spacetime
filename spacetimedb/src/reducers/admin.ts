import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import { ensureAdmin } from '../helpers/ensurePermissions';
import { auditUpdate } from '../helpers/auditColumns';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { Path, Element, CharRole, GameMode, DraftMode, Role } from '../types/enums';
import { computeMaxPossible, updateAccountRating } from '../helpers/accountRating';
import { hsrCharacterColumns } from '../tables/hsrCharacter';
import { hsrLightconeColumns } from '../tables/hsrLightcone';
import { hsrCharacterCostColumns } from '../tables/hsrCharacterCost';
import { hsrLightconeCostColumns } from '../tables/hsrLightconeCost';
import { hsrSynergyCostUpsertKeys } from '../tables/hsrSynergyCost';
import { archetypeColumns } from '../tables/archetype';

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
 *     "stay null" (optional columns like skelUrl/atlasUrl).
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

// ─── Generic row delete (works for any public table) ─────────────────────────

export const admin_delete_row = spacetimedb.reducer(
    { tableName: t.string(), primaryKeyJson: t.string() },
    (ctx, { tableName, primaryKeyJson }) => {
        const admin = ensureAdmin(ctx);

        switch (tableName) {
            case 'User': {
                const id = parseNumericPk(primaryKeyJson, 'User');
                const user = ctx.db.User.id.find(id);
                if (!user) throw new SenderError('Row not found');

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

                // Soft-delete: set deletedAt so the client can show a notification
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
                // Identity PKs are hex strings — must iterate (no hex→Identity conversion)
                let found = false;
                for (const row of ctx.db.UserIdentity.iter()) {
                    if (row.identity.toHexString() === primaryKeyJson) {
                        ctx.db.UserIdentity.identity.delete(row.identity);
                        found = true;
                        break;
                    }
                }
                if (!found) throw new SenderError('Row not found');
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
                const key = JSON.parse(primaryKeyJson);
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
                const key = JSON.parse(primaryKeyJson);
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
                const key = JSON.parse(primaryKeyJson);
                const row = [...ctx.db.HsrCharacterArchetype.by_character_and_archetype.filter([key.characterName, key.archetypeId])][0];
                if (!row) throw new SenderError('Row not found');
                ctx.db.HsrCharacterArchetype.delete(row);
                break;
            }
            case 'Lobby': {
                const id = parseNumericPk(primaryKeyJson, 'Lobby');
                if (!ctx.db.Lobby.id.find(id)) throw new SenderError('Row not found');
                ctx.db.Lobby.id.delete(id);
                break;
            }
            case 'LobbyMember': {
                const key = JSON.parse(primaryKeyJson);
                const row = [...ctx.db.LobbyMember.by_lobby_and_user.filter([key.lobbyId, key.userId])][0];
                if (!row) throw new SenderError('Row not found');
                ctx.db.LobbyMember.delete(row);
                break;
            }
            case 'MatchSession': {
                const id = parseNumericPk(primaryKeyJson, 'MatchSession');
                if (!ctx.db.MatchSession.lobbyId.find(id)) throw new SenderError('Row not found');
                ctx.db.MatchSession.lobbyId.delete(id);
                break;
            }
            case 'MatchSessionStep': {
                const id = parseNumericPk(primaryKeyJson, 'MatchSessionStep');
                if (!ctx.db.MatchSessionStep.id.find(id)) throw new SenderError('Row not found');
                ctx.db.MatchSessionStep.id.delete(id);
                break;
            }
            case 'MatchSessionHistory': {
                if (!ctx.db.MatchSessionHistory.id.find(Number(primaryKeyJson))) throw new SenderError('Row not found');
                ctx.db.MatchSessionHistory.id.delete(Number(primaryKeyJson));
                break;
            }
            case 'MatchSessionStepHistory': {
                // Composite PK [matchHistoryId, gameNumber, sequence] — parse JSON 3-tuple
                const stepPK = JSON.parse(primaryKeyJson);
                const stepRow = [...ctx.db.MatchSessionStepHistory.by_match_history.filter(stepPK[0])]
                    .find((r: any) => r.gameNumber === stepPK[1] && r.sequence === stepPK[2]);
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
//                                        or keep null for optional columns (skelUrl/atlasUrl).
//        - non-null value              → set the field to that value.
//
//   3. Cost tables (HsrCharacterCost, HsrLightconeCost, HsrSynergyCost) match existing rows
//      by the FULL composite tuple INCLUDING `costSetId` — distinct cost sets never collide.
//      `r.costSetId ?? 0` honors the default-cost-set sentinel.
//
//   4. Insert branch retains its default-injection logic (per D-12); partial-update only
//      kicks in when an existing row is found.
//
// Callers: `scripts/seed-data.ts`, `test/shared/seed-data.ts`, future admin UI editors.
export const admin_bulk_upsert = spacetimedb.reducer(
    { tableName: t.string(), jsonData: t.string() },
    (ctx, { tableName, jsonData }) => {
        const admin = ensureAdmin(ctx);

        const rows: any[] = JSON.parse(jsonData);
        if (!Array.isArray(rows)) throw new SenderError('jsonData must be a JSON array');

        validateKeys(rows, tableName, ctx);

        switch (tableName) {
            case 'HsrCharacter': {
                // Fields that participate in partial-update on existing rows.
                // Non-null values overwrite; null values preserve existing.
                const HSR_CHARACTER_FIELDS = [
                    'displayName', 'aliases', 'rarity', 'path', 'element', 'role',
                    'imageUrl', 'versionReleased', 'treatAsVersion',
                    'skelUrl', 'atlasUrl', 'atlasImgUrls', 'posX', 'posY', 'width',
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
                            skelUrl: r.skelUrl,
                            atlasUrl: r.atlasUrl,
                            atlasImgUrls: r.atlasImgUrls,
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
                            // Plan 02 columns — optional stays null; required defaults to 0 / [].
                            skelUrl: r.skelUrl ?? null,
                            atlasUrl: r.atlasUrl ?? null,
                            atlasImgUrls: r.atlasImgUrls ?? [],
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
                // 15.4 D-19: Existence match uses (sourceName, targetName, gameMode, draftMode, costSetId).
                // PK is auto-inc id; the tuple above is the logical unique key.
                const HSR_SYNERGY_COST_FIELDS = ['costModifier'] as const;
                for (const r of rows) {
                    validateEnumIfPresent('gameMode', r.gameMode, ctx, tableName);
                    validateEnumIfPresent('draftMode', r.draftMode, ctx, tableName);
                    const csId = r.costSetId ?? 0;

                    let existing: any = null;
                    for (const e of ctx.db.HsrSynergyCost.iter()) {
                        if (e.sourceName === r.sourceName &&
                            e.targetName === r.targetName &&
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
                            sourceName: r.sourceName,
                            targetName: r.targetName,
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

        // Validate role tag
        validateEnum('userRole', roleTag, ctx, 'User');

        // Check username uniqueness if changed
        if (username !== user.username) {
            const existing = ctx.db.User.username.find(username);
            if (existing) throw new SenderError(`Username "${username}" is already taken`);
        }

        ctx.db.User.id.update(
            updateWithAudit(ctx, user, {
                displayName,
                username,
                role: { tag: roleTag, value: {} } as any,
            }, admin.id),
        );
    }
);
