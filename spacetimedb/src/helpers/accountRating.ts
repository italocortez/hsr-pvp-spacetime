import { updateWithAudit } from './auditHelpers';

/**
 * Matrix-based account rating formula (Phase 11).
 *
 * Measures account quality across two dimensions:
 *   Vertical (40%): eidolon depth × age-weighted score per owned character
 *   Horizontal (60%): archetype coverage breadth
 *
 * Normalized by maxPossible (theoretical max for a hypothetical account
 * owning all HsrCharacter rows at E6), scaled to 0–config.scale (default 1000).
 *
 * Replaces the TEMPORARY Phase 5 formula (5 * (1 + eidolonLevel), capped at 1000).
 */
export function computeAccountRating(ctx: any, hsrAccountId: number): number {
    const config = ctx.db.AccountRatingConfig.id.find(1);
    if (!config) return 0;

    const allChars = [...ctx.db.HsrCharacter.iter()];
    if (allChars.length === 0) return 0;

    // Dynamic max_version (D-16): recomputed each call to stay current as chars are added
    const maxVersion = Math.max(...allChars.map((c: any) => c.versionReleased));
    if (maxVersion === 0) return 0;

    // Role exponent map (D-14)
    const roleExponent: Record<string, number> = {
        Dps: config.roleExponentDps,
        Support: config.roleExponentSupport,
        Sustain: config.roleExponentSustain,
    };

    // Pre-compute age weight per character in the game (D-13)
    // Formula: sqrt(effective / maxVersion) ^ role_exponent
    // where effective = floor(version) + frac(version) * compression
    const ageWeightMap = new Map<string, number>();
    for (const c of allChars) {
        const version = c.treatAsVersion > 0 ? c.treatAsVersion : c.versionReleased;
        const major = Math.floor(version);
        const frac = version - major;
        const effective = major + frac * config.compression;
        const baseWeight = Math.sqrt(effective / maxVersion);
        const exp = roleExponent[c.role.tag] ?? 1.0;
        ageWeightMap.set(c.name, Math.pow(baseWeight, exp));
    }

    // Player's owned characters
    const owned = [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(hsrAccountId)];
    if (owned.length === 0) return 0;

    // Vertical score (D-17 to D-20): average eidolon depth weighted by character age
    // per_char = ((1 + eidolonLevel) / 7) * age_weight
    // vertical = mean(per_char for all owned characters)
    let verticalSum = 0;
    for (const oc of owned) {
        const aw = ageWeightMap.get(oc.characterName) ?? 0;
        verticalSum += ((1 + oc.eidolonLevel) / 7) * aw;
    }
    const vertical = verticalSum / owned.length;

    // Horizontal score (D-21 to D-24): archetype coverage breadth
    // per_archetype = min(sum(age_weight for owned chars in arch) / threshold, 1.0)
    // horizontal = mean(per_archetype for ALL archetypes)
    const allArchetypes = [...ctx.db.Archetype.iter()];
    let horizontal = 0;

    if (allArchetypes.length > 0) {
        const ownedNames = new Set(owned.map((o: any) => o.characterName));
        let horizontalSum = 0;
        for (const arch of allArchetypes) {
            const junctions = [...ctx.db.HsrCharacterArchetype.archetype_id.filter(arch.id)];
            const archSize = junctions.length;
            const threshold = Math.min(config.archetypeThreshold, archSize);
            if (threshold === 0) continue;
            let ownershipSum = 0;
            for (const j of junctions) {
                if (ownedNames.has(j.characterName)) {
                    ownershipSum += ageWeightMap.get(j.characterName) ?? 0;
                }
            }
            horizontalSum += Math.min(ownershipSum / threshold, 1.0);
        }
        horizontal = horizontalSum / allArchetypes.length;
    }

    // Combined + normalize (D-26)
    const combined = vertical * config.verticalWeight + horizontal * config.horizontalWeight;

    // Use cached maxPossible from config if set; otherwise compute on-the-fly
    const mp = config.maxPossible > 0
        ? config.maxPossible
        : computeMaxPossible(ctx, config, ageWeightMap, allChars);

    if (mp <= 0) return 0;
    return Math.round((combined / mp) * config.scale);
}

/**
 * Computes the theoretical maximum combined score for the current character pool.
 *
 * Hypothetical: every HsrCharacter owned at E6. Used as the normalization
 * denominator so the best possible real account approaches config.scale (1000).
 *
 * Called by computeAccountRating when config.maxPossible is not yet seeded (=0),
 * and by admin_recalculate_all_ratings to update the cached value.
 */
export function computeMaxPossible(
    ctx: any,
    config: any,
    ageWeightMap: Map<string, number>,
    allChars: any[]
): number {
    if (allChars.length === 0) return 0;

    // Vertical: all chars at E6 → (1+6)/7 = 1.0 per char; mean across all
    let verticalSum = 0;
    for (const c of allChars) {
        verticalSum += 1.0 * (ageWeightMap.get(c.name) ?? 0);
    }
    const vertical = verticalSum / allChars.length;

    // Horizontal: all chars owned at max possible
    const allArchetypes = [...ctx.db.Archetype.iter()];
    let horizontal = 0;
    if (allArchetypes.length > 0) {
        let horizontalSum = 0;
        for (const arch of allArchetypes) {
            const junctions = [...ctx.db.HsrCharacterArchetype.archetype_id.filter(arch.id)];
            const archSize = junctions.length;
            const threshold = Math.min(config.archetypeThreshold, archSize);
            if (threshold === 0) continue;
            let ownershipSum = 0;
            for (const j of junctions) {
                ownershipSum += ageWeightMap.get(j.characterName) ?? 0;
            }
            horizontalSum += Math.min(ownershipSum / threshold, 1.0);
        }
        horizontal = horizontalSum / allArchetypes.length;
    }

    return vertical * config.verticalWeight + horizontal * config.horizontalWeight;
}

/**
 * Computes and persists account rating on the HsrAccount row if it changed.
 */
export function updateAccountRating(ctx: any, hsrAccountId: number, actingUserId: number): void {
    const newRating = computeAccountRating(ctx, hsrAccountId);
    const account = ctx.db.HsrAccount.id.find(hsrAccountId);
    if (!account) return;

    if (account.accountRating !== newRating) {
        ctx.db.HsrAccount.id.update(
            updateWithAudit(ctx, account, { accountRating: newRating }, actingUserId),
        );
    }
}
