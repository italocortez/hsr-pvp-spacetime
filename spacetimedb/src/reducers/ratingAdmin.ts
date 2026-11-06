import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { ensureAdmin } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { computeMaxPossible, updateAccountRating } from '../helpers/accountRating';

// ─── Private helper: build the age-weight map from char pool ─────────────────
// Extracted to avoid duplication across the 3 reducers in this file.

function buildAgeWeightMap(allChars: any[], config: any): Map<string, number> {
    const maxVersion = Math.max(...allChars.map((c: any) => c.versionReleased));
    if (maxVersion === 0) return new Map();
    const roleExponent: Record<string, number> = {
        Dps: config.roleExponentDps,
        Support: config.roleExponentSupport,
        Sustain: config.roleExponentSustain,
    };
    const map = new Map<string, number>();
    for (const c of allChars) {
        const version = c.treatAsVersion > 0 ? c.treatAsVersion : c.versionReleased;
        const major = Math.floor(version);
        const frac = version - major;
        const effective = major + frac * config.compression;
        const baseWeight = Math.sqrt(effective / maxVersion);
        const exp = roleExponent[c.role.tag] ?? 1.0;
        map.set(c.name, Math.pow(baseWeight, exp));
    }
    return map;
}

// ─── admin_seed_rating_config ─────────────────────────────────────────────────
// Creates the initial AccountRatingConfig row with default values (sentinel PK id=1).
// Computes initial maxPossible from current character pool.
// Permission: Admin only.

export const admin_seed_rating_config = spacetimedb.reducer(
    {},
    (ctx) => {
        const user = ensureAdmin(ctx);

        // Check if row already exists
        const existing = ctx.db.AccountRatingConfig.id.find(1);
        if (existing) {
            throw new SenderError('Rating config already seeded. Use admin_update_rating_config to modify.');
        }

        // Compute initial maxPossible from current character pool
        const allChars = [...ctx.db.HsrCharacter.iter()];
        let maxPossible = 0;

        if (allChars.length > 0) {
            const defaultConfig = {
                verticalWeight: 0.4,
                horizontalWeight: 0.6,
                compression: 0.2,
                roleExponentDps: 2.0,
                roleExponentSupport: 1.3,
                roleExponentSustain: 1.0,
                archetypeThreshold: 3.0,
                scale: 1000.0,
            };
            const ageWeightMap = buildAgeWeightMap(allChars, defaultConfig);
            maxPossible = computeMaxPossible(ctx, defaultConfig, ageWeightMap, allChars);
        }

        ctx.db.AccountRatingConfig.insert(insertWithAudit(ctx, {
            id: 1,
            verticalWeight: 0.4,
            horizontalWeight: 0.6,
            compression: 0.2,
            roleExponentDps: 2.0,
            roleExponentSupport: 1.3,
            roleExponentSustain: 1.0,
            archetypeThreshold: 3.0,
            scale: 1000.0,
            maxPossible,
        }, user.id));

        console.log(`[RATING] AccountRatingConfig seeded with defaults by admin #${user.id}, maxPossible=${maxPossible.toFixed(4)}`);
    }
);

// ─── admin_update_rating_config ───────────────────────────────────────────────
// Updates AccountRatingConfig fields. All config fields are optional — only
// provided fields are changed. maxPossible is NOT a manual arg; it is
// auto-recomputed after every update (per D-11b).
// Permission: Admin only.

export const admin_update_rating_config = spacetimedb.reducer(
    {
        verticalWeight: t.f64().optional(),
        horizontalWeight: t.f64().optional(),
        compression: t.f64().optional(),
        roleExponentDps: t.f64().optional(),
        roleExponentSupport: t.f64().optional(),
        roleExponentSustain: t.f64().optional(),
        archetypeThreshold: t.f64().optional(),
        scale: t.f64().optional(),
    },
    (ctx, args) => {
        const user = ensureAdmin(ctx);

        const existing = ctx.db.AccountRatingConfig.id.find(1);
        if (!existing) {
            throw new SenderError('Rating config not initialized. Call admin_seed_rating_config first.');
        }

        // Build changes object and validate each provided f64
        const changes: Record<string, any> = {};
        const changedFields: string[] = [];

        const f64Fields: Array<[string, number | undefined]> = [
            ['verticalWeight', args.verticalWeight],
            ['horizontalWeight', args.horizontalWeight],
            ['compression', args.compression],
            ['roleExponentDps', args.roleExponentDps],
            ['roleExponentSupport', args.roleExponentSupport],
            ['roleExponentSustain', args.roleExponentSustain],
            ['archetypeThreshold', args.archetypeThreshold],
            ['scale', args.scale],
        ];

        for (const [field, value] of f64Fields) {
            if (value !== undefined) {
                if (!Number.isFinite(value) || value < 0) {
                    throw new SenderError(`Invalid value for ${field}: must be a finite positive number`);
                }
                changes[field] = value;
                changedFields.push(field);
            }
        }

        if (changedFields.length === 0) {
            throw new SenderError('No fields provided to update.');
        }

        // Merge changes with existing config to form updated config for maxPossible computation
        const updatedConfig = { ...existing, ...changes };

        // Recompute maxPossible using the updated config values
        const allChars = [...ctx.db.HsrCharacter.iter()];
        let maxPossible = existing.maxPossible;
        if (allChars.length > 0) {
            const ageWeightMap = buildAgeWeightMap(allChars, updatedConfig);
            maxPossible = computeMaxPossible(ctx, updatedConfig, ageWeightMap, allChars);
        }

        ctx.db.AccountRatingConfig.id.update(updateWithAudit(ctx, existing, {
            ...changes,
            maxPossible,
        }, user.id));

        console.log(`[RATING] AccountRatingConfig updated by admin #${user.id}: ${changedFields.join(', ')}, maxPossible recomputed=${maxPossible.toFixed(4)}`);
    }
);

// ─── admin_recalculate_all_ratings ────────────────────────────────────────────
// Recomputes maxPossible from current character pool, then iterates all
// HsrAccount rows and recomputes each account's rating using the current config.
// Use after bulk archetype edits or manual config changes (per D-32).
// Permission: Admin only.

export const admin_recalculate_all_ratings = spacetimedb.reducer(
    {},
    (ctx) => {
        const user = ensureAdmin(ctx);

        const config = ctx.db.AccountRatingConfig.id.find(1);
        if (!config) {
            throw new SenderError('Rating config not initialized. Call admin_seed_rating_config first.');
        }

        // Recompute maxPossible first and update config if it changed
        const allChars = [...ctx.db.HsrCharacter.iter()];
        if (allChars.length > 0) {
            const ageWeightMap = buildAgeWeightMap(allChars, config);
            const newMaxPossible = computeMaxPossible(ctx, config, ageWeightMap, allChars);
            if (Math.abs(newMaxPossible - config.maxPossible) > 0.0001) {
                ctx.db.AccountRatingConfig.id.update(updateWithAudit(ctx, config, {
                    maxPossible: newMaxPossible,
                }, user.id));
                console.log(`[RATING] maxPossible updated: ${config.maxPossible.toFixed(4)} -> ${newMaxPossible.toFixed(4)}`);
            }
        }

        // Iterate all HsrAccount rows and recompute ratings
        const accounts = [...ctx.db.HsrAccount.iter()];
        for (const account of accounts) {
            updateAccountRating(ctx, account.id, user.id);
        }

        console.log(`[RATING] Recalculated ratings for ${accounts.length} accounts by admin #${user.id}`);
    }
);
