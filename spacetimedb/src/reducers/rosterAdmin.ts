import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { ensureAdmin } from '../helpers/ensurePermissions';
import { auditInsert, auditUpdate } from '../helpers/auditColumns';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { validateUid, deriveRegion, recalcDuplicateUid } from '../helpers/rosterHelpers';
import { updateAccountRating } from '../helpers/accountRating';

// ─── admin_create_hsr_account ─────────────────────────────────────────────────
// Admin proxy: creates an HSR account on behalf of any target user.

export const admin_create_hsr_account = spacetimedb.reducer(
    { targetUserId: t.u32(), uid: t.string(), displayLabel: t.string() },
    (ctx, { targetUserId, uid, displayLabel }) => {
        const admin = ensureAdmin(ctx);

        const targetUser = ctx.db.User.id.find(targetUserId);
        if (!targetUser) throw new SenderError('Target user not found');

        validateUid(uid);
        const region = deriveRegion(uid);

        const existing = [...ctx.db.HsrAccount.user_id.filter(targetUserId)];
        if (existing.length >= 5) {
            throw new SenderError('Maximum 5 HSR accounts per user');
        }

        const label = displayLabel.trim() || 'Account ' + (existing.length + 1);
        const isFirst = existing.length === 0;

        ctx.db.HsrAccount.insert(insertWithAudit(ctx, {
            id: 0,
            userId: targetUserId,
            uid,
            region,
            displayLabel: label,
            isActive: isFirst,
            isRosterPublic: false,
            isRatingPublic: false,
            isDuplicateUid: false,
            accountRating: 0,
        }, admin.id));

        recalcDuplicateUid(ctx, uid, admin.id);
    }
);

// ─── admin_update_hsr_account ─────────────────────────────────────────────────
// Admin proxy: updates display label and visibility on any account (no ownership check).

export const admin_update_hsr_account = spacetimedb.reducer(
    { hsrAccountId: t.u32(), displayLabel: t.string(), isRosterPublic: t.bool(), isRatingPublic: t.bool() },
    (ctx, { hsrAccountId, displayLabel, isRosterPublic, isRatingPublic }) => {
        const admin = ensureAdmin(ctx);

        const account = ctx.db.HsrAccount.id.find(hsrAccountId);
        if (!account) throw new SenderError('HSR account not found');

        const trimmed = displayLabel.trim();
        if (!trimmed) throw new SenderError('Display label cannot be empty');

        ctx.db.HsrAccount.id.update(updateWithAudit(ctx, account, {
            displayLabel: trimmed,
            isRosterPublic,
            isRatingPublic,
        }, admin.id));
    }
);

// ─── admin_delete_hsr_account ─────────────────────────────────────────────────
// Admin proxy: deletes any account with cascade and auto-activate logic.

export const admin_delete_hsr_account = spacetimedb.reducer(
    { hsrAccountId: t.u32() },
    (ctx, { hsrAccountId }) => {
        const admin = ensureAdmin(ctx);

        const account = ctx.db.HsrAccount.id.find(hsrAccountId);
        if (!account) throw new SenderError('HSR account not found');

        // D-24: Block deletion if account is currently selected in an active lobby
        const activeLma = [...ctx.db.LobbyMemberAccount.by_account.filter(hsrAccountId)];
        if (activeLma.length > 0) {
            throw new SenderError('Cannot delete an account that is selected in an active lobby. Leave the lobby first.');
        }

        // D-24, D-25: Block if account is locked in an active tournament (admin blocked equally per D-25)
        const tpaEntries = [...ctx.db.TournamentPlayerAccount.by_user.filter(account.userId)]
            .filter((e: any) => e.hsrAccountId === hsrAccountId);
        for (const tpa of tpaEntries) {
            const tournament = ctx.db.Tournament.id.find(tpa.tournamentId);
            if (tournament && tournament.stage.tag !== 'Completed' && tournament.stage.tag !== 'Cancelled') {
                throw new SenderError('Cannot delete an account locked in an active tournament. Wait for the tournament to complete or be cancelled.');
            }
        }

        const uid = account.uid;
        const accountUserId = account.userId;

        // Cascade: delete all characters for this account
        const characters = [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(hsrAccountId)];
        for (const char of characters) {
            ctx.db.HsrAccountCharacter.delete(char);
        }

        ctx.db.HsrAccount.id.delete(hsrAccountId);

        // Auto-activate oldest remaining if this was the active account
        if (account.isActive) {
            const remaining = [...ctx.db.HsrAccount.user_id.filter(accountUserId)];
            if (remaining.length > 0) {
                remaining.sort((a: any, b: any) =>
                    Number(a.createdDate.microsSinceUnixEpoch - b.createdDate.microsSinceUnixEpoch)
                );
                ctx.db.HsrAccount.id.update(updateWithAudit(ctx, remaining[0], {
                    isActive: true,
                }, admin.id));
            }
        }

        recalcDuplicateUid(ctx, uid, admin.id);
    }
);

// ─── admin_batch_upsert_characters ────────────────────────────────────────────
// Admin proxy: atomically upserts characters on any account (no ownership check).

export const admin_batch_upsert_characters = spacetimedb.reducer(
    { hsrAccountId: t.u32(), charactersJson: t.string() },
    (ctx, { hsrAccountId, charactersJson }) => {
        const admin = ensureAdmin(ctx);

        const account = ctx.db.HsrAccount.id.find(hsrAccountId);
        if (!account) throw new SenderError('HSR account not found');

        const items: Array<{ characterName: string; eidolonLevel: number }> = JSON.parse(charactersJson);
        if (!Array.isArray(items) || items.length === 0) {
            throw new SenderError('charactersJson must be a non-empty JSON array');
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

        // Phase 2 — Upsert all
        for (const item of items) {
            const existing = [...ctx.db.HsrAccountCharacter.by_account_and_character.filter([hsrAccountId, item.characterName])][0];
            if (existing) {
                ctx.db.HsrAccountCharacter.delete(existing);
            }
            ctx.db.HsrAccountCharacter.insert({
                hsrAccountId,
                characterName: item.characterName,
                eidolonLevel: item.eidolonLevel,
                ...(existing ? auditUpdate(ctx, existing, admin.id) : auditInsert(ctx, admin.id)),
            } as any);
        }

        updateAccountRating(ctx, hsrAccountId, admin.id);
    }
);

// ─── admin_batch_remove_characters ───────────────────────────────────────────
// Admin proxy: atomically removes characters from any account (no ownership check).

export const admin_batch_remove_characters = spacetimedb.reducer(
    { hsrAccountId: t.u32(), characterNamesJson: t.string() },
    (ctx, { hsrAccountId, characterNamesJson }) => {
        const admin = ensureAdmin(ctx);

        const account = ctx.db.HsrAccount.id.find(hsrAccountId);
        if (!account) throw new SenderError('HSR account not found');

        const names: string[] = JSON.parse(characterNamesJson);
        if (!Array.isArray(names) || names.length === 0) {
            throw new SenderError('characterNamesJson must be a non-empty JSON array');
        }

        // Validate ALL names exist before deleting ANY
        for (const name of names) {
            const existing = [...ctx.db.HsrAccountCharacter.by_account_and_character.filter([hsrAccountId, name])][0];
            if (!existing) {
                throw new SenderError(`Character "${name}" not found on this account`);
            }
        }

        // All validated — now delete
        for (const name of names) {
            const row = [...ctx.db.HsrAccountCharacter.by_account_and_character.filter([hsrAccountId, name])][0];
            ctx.db.HsrAccountCharacter.delete(row!);
        }

        updateAccountRating(ctx, hsrAccountId, admin.id);
    }
);

// ─── admin_upsert_archetype ───────────────────────────────────────────────────
// Creates a new archetype or updates description if name already exists.
// Note: update uses id.update() (not name.update()) — unique index lacks update().

export const admin_upsert_archetype = spacetimedb.reducer(
    { name: t.string(), description: t.string() },
    (ctx, { name, description }) => {
        const admin = ensureAdmin(ctx);

        const trimmedName = name.trim();
        if (!trimmedName) throw new SenderError('Archetype name cannot be empty');

        const existing = ctx.db.Archetype.name.find(trimmedName);
        if (existing) {
            ctx.db.Archetype.id.update(updateWithAudit(ctx, existing, {
                description,
            }, admin.id));
        } else {
            ctx.db.Archetype.insert(insertWithAudit(ctx, {
                id: 0,
                name: trimmedName,
                description,
            }, admin.id));
        }
    }
);

// ─── admin_delete_archetype ───────────────────────────────────────────────────
// Deletes an archetype with cascade to all HsrCharacterArchetype junction rows.

export const admin_delete_archetype = spacetimedb.reducer(
    { archetypeId: t.u32() },
    (ctx, { archetypeId }) => {
        ensureAdmin(ctx);

        const archetype = ctx.db.Archetype.id.find(archetypeId);
        if (!archetype) throw new SenderError('Archetype not found');

        // Cascade: delete all junction rows for this archetype
        const junctions = [...ctx.db.HsrCharacterArchetype.archetype_id.filter(archetypeId)];
        for (const j of junctions) {
            ctx.db.HsrCharacterArchetype.delete(j);
        }

        ctx.db.Archetype.id.delete(archetypeId);
    }
);

// ─── admin_assign_character_archetypes ───────────────────────────────────────
// Assigns multiple archetypes to a character (many-to-many, idempotent on existing).

export const admin_assign_character_archetypes = spacetimedb.reducer(
    { characterName: t.string(), archetypeIdsJson: t.string() },
    (ctx, { characterName, archetypeIdsJson }) => {
        const admin = ensureAdmin(ctx);

        if (!ctx.db.HsrCharacter.name.find(characterName)) {
            throw new SenderError('Character not found');
        }

        const archetypeIds: number[] = JSON.parse(archetypeIdsJson);

        // Validate ALL archetypes exist before writing ANY
        for (const archId of archetypeIds) {
            if (!ctx.db.Archetype.id.find(archId)) {
                throw new SenderError(`Archetype #${archId} not found`);
            }
        }

        // Insert (skip if already assigned — idempotent)
        for (const archId of archetypeIds) {
            const existing = [...ctx.db.HsrCharacterArchetype.by_character_and_archetype.filter([characterName, archId])][0];
            if (!existing) {
                ctx.db.HsrCharacterArchetype.insert(insertWithAudit(ctx, {
                    characterName,
                    archetypeId: archId,
                }, admin.id));
            }
        }
    }
);

// ─── admin_remove_character_archetypes ───────────────────────────────────────
// Removes multiple archetype assignments from a character.

export const admin_remove_character_archetypes = spacetimedb.reducer(
    { characterName: t.string(), archetypeIdsJson: t.string() },
    (ctx, { characterName, archetypeIdsJson }) => {
        ensureAdmin(ctx);

        const archetypeIds: number[] = JSON.parse(archetypeIdsJson);

        // Validate ALL assignments exist before deleting ANY
        for (const archId of archetypeIds) {
            const existing = [...ctx.db.HsrCharacterArchetype.by_character_and_archetype.filter([characterName, archId])][0];
            if (!existing) {
                throw new SenderError(
                    `Character "${characterName}" is not assigned to archetype #${archId}`
                );
            }
        }

        // All validated — now delete
        for (const archId of archetypeIds) {
            const row = [...ctx.db.HsrCharacterArchetype.by_character_and_archetype.filter([characterName, archId])][0];
            ctx.db.HsrCharacterArchetype.delete(row!);
        }
    }
);
