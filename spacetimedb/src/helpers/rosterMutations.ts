import { SenderError } from 'spacetimedb/server';
import { auditInsert, auditUpdate } from './auditColumns';
import { updateAccountRating } from './accountRating';

/**
 * Atomic batch upsert of HsrAccountCharacter rows on a given account, followed by
 * a full accountRating recompute via `updateAccountRating`.
 *
 * Contract (Phase 12.3 D-D-01, Pitfall 5 helper boundary):
 *   - Caller MUST have validated auth and ownership of `accountId`. The helper
 *     does NOT re-auth or check `account.userId === actingUserId`.
 *   - `items` must be non-empty. Caller passes a parsed array; helper validates
 *     each entry against the HsrCharacter whitelist and eidolon range.
 *   - Two-phase write: validate ALL items, then write ALL items (matches the
 *     atomic validate-then-write pattern established in Phase 2 — all-or-nothing).
 *   - Final step: `updateAccountRating(ctx, accountId, actingUserId)` — this is
 *     the defining difference from a naked loop, and the thing `migrate_roster`
 *     was previously missing (D-D-04 bug fix).
 *
 * @param ctx SpacetimeDB reducer context
 * @param accountId HsrAccount.id (pre-validated as belonging to actingUserId)
 * @param items Array of `{ characterName, eidolonLevel }` — validated against HsrCharacter + 0..6 range
 * @param actingUserId User performing the mutation (for audit columns)
 */
export function applyBatchUpsert(
    ctx: any,
    accountId: number,
    items: Array<{ characterName: string; eidolonLevel: number }>,
    actingUserId: number
): void {
    if (!Array.isArray(items) || items.length === 0) {
        throw new SenderError('applyBatchUpsert: items must be a non-empty array');
    }

    // Phase 1 — Validate ALL before writing ANY
    for (const item of items) {
        if (!ctx.db.HsrCharacter.name.find(item.characterName)) {
            throw new SenderError(`Invalid character: "${item.characterName}"`);
        }
        if (item.eidolonLevel === undefined || item.eidolonLevel < 0 || item.eidolonLevel > 6) {
            throw new SenderError(`Invalid eidolon level for "${item.characterName}": must be 0-6`);
        }
    }

    // Phase 2 — Upsert all (composite PK: delete then insert)
    for (const item of items) {
        const existing = [...ctx.db.HsrAccountCharacter.by_account_and_character.filter([accountId, item.characterName])][0] ?? null;
        if (existing) {
            ctx.db.HsrAccountCharacter.delete(existing);
        }
        ctx.db.HsrAccountCharacter.insert({
            hsrAccountId: accountId,
            characterName: item.characterName,
            eidolonLevel: item.eidolonLevel,
            ...(existing ? auditUpdate(ctx, existing, actingUserId) : auditInsert(ctx, actingUserId)),
        } as any);
    }

    // D-D-01 (Phase 12.3): recompute the account-level rating after mutation.
    // This is what migrate_roster was missing pre-12.3 (D-D-04 latent bug).
    updateAccountRating(ctx, accountId, actingUserId);
}

/**
 * Atomic batch removal of HsrAccountCharacter rows on a given account by
 * character name, followed by a full accountRating recompute.
 *
 * Contract: identical to applyBatchUpsert (pre-validated auth + ownership,
 * non-empty names array). Validates ALL names exist before deleting ANY.
 *
 * @param ctx SpacetimeDB reducer context
 * @param accountId HsrAccount.id (pre-validated as belonging to actingUserId)
 * @param names Array of character names to remove — must all exist on the account
 * @param actingUserId User performing the mutation (for audit columns)
 */
export function applyBatchRemove(
    ctx: any,
    accountId: number,
    names: string[],
    actingUserId: number
): void {
    if (!Array.isArray(names) || names.length === 0) {
        throw new SenderError('applyBatchRemove: names must be a non-empty array');
    }

    // Composite PK lookup: filter by indexed hsrAccountId, then match characterName
    const accountChars = [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(accountId)];

    // Validate ALL names exist before deleting ANY (all-or-nothing)
    for (const name of names) {
        const existing = accountChars.find(row => row.characterName === name) ?? null;
        if (!existing) {
            throw new SenderError(`Character "${name}" not found on this account`);
        }
    }

    // All validated — now delete
    for (const name of names) {
        const row = accountChars.find(row => row.characterName === name)!;
        ctx.db.HsrAccountCharacter.delete(row);
    }

    // D-D-01: recompute rating after removals (D-D-04 latent bug fix)
    updateAccountRating(ctx, accountId, actingUserId);
}
