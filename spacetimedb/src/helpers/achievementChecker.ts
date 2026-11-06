// ─── Achievement Checker Helper ──────────────────────────────────────────────
// Called from runFinalization (step 16.5) after all stat increments.
// Evaluates all non-manual achievements for each participant and auto-awards
// any that are newly satisfied.

import { insertWithAudit } from './auditHelpers';

// ─── getField ────────────────────────────────────────────────────────────────
// Explicit switch/case field resolution — NOT string indexing on row objects.
// String indexing fails when SpacetimeDB SDK wraps row values; explicit
// field names guarantee correct access. (Research Pitfall 4)

function getField(row: any, fieldName: string): number | undefined {
    switch (fieldName) {
        // PlayerStat fields
        case 'matchesPlayed':        return row.matchesPlayed;
        case 'wins':                 return row.wins;
        case 'losses':               return row.losses;
        case 'draws':                return row.draws;
        case 'matchesSpectated':     return row.matchesSpectated;
        // PlayerCharacterStat fields (shares matchesPlayed, wins, losses with above)
        case 'timesBannedInMatch':   return row.timesBannedInMatch;
        case 'timesFaced':           return row.timesFaced;
        case 'winsAgainst':          return row.winsAgainst;
        case 'lossesAgainst':        return row.lossesAgainst;
        // MmrRating fields
        case 'rating':               return row.rating;
        case 'globalCompositeRating': return row.globalCompositeRating;
        default:
            console.warn(`[ACHIEVEMENT] Unknown statField: ${fieldName}`);
            return undefined;
    }
}

// ─── sumField ────────────────────────────────────────────────────────────────

function sumField(rows: any[], fieldName: string): number {
    return rows.reduce((sum: number, r: any) => sum + (getField(r, fieldName) ?? 0), 0);
}

// ─── applyOperator ───────────────────────────────────────────────────────────

function applyOperator(value: number, operator: any, threshold: number): boolean {
    switch (operator.tag) {
        case 'GreaterOrEqual': return value >= threshold;
        case 'GreaterThan':    return value > threshold;
        case 'Equal':          return value === threshold;
        case 'LessThan':       return value < threshold;
        case 'LessOrEqual':    return value <= threshold;
        default:               return false;
    }
}

// ─── evaluateCriterion ───────────────────────────────────────────────────────
// Resolves the stat value for the given criterion against the user's data,
// then applies the operator. Returns false on any unknown statTable/statField.

function evaluateCriterion(ctx: any, userId: number, criterion: any): boolean {
    let resolvedValue: number;

    switch (criterion.statTable) {
        case 'PlayerStat': {
            // Load all PlayerStat rows for user; filter by optional game mode / match type
            let rows = [...ctx.db.PlayerStat.by_user.filter(userId)];
            if (criterion.filterGameMode !== undefined) {
                rows = rows.filter((r: any) => r.gameMode.tag === criterion.filterGameMode);
            }
            if (criterion.filterMatchType !== undefined) {
                rows = rows.filter((r: any) => r.matchType.tag === criterion.filterMatchType);
            }
            resolvedValue = sumField(rows, criterion.statField);
            break;
        }

        case 'PlayerCharacterStat': {
            // Load all PlayerCharacterStat rows for user; filter by optional filters
            let rows = [...ctx.db.PlayerCharacterStat.by_user.filter(userId)];
            if (criterion.filterCharacterName !== undefined) {
                rows = rows.filter((r: any) => r.characterName === criterion.filterCharacterName);
            }
            if (criterion.filterGameMode !== undefined) {
                rows = rows.filter((r: any) => r.gameMode.tag === criterion.filterGameMode);
            }
            if (criterion.filterMatchType !== undefined) {
                rows = rows.filter((r: any) => r.matchType.tag === criterion.filterMatchType);
            }
            resolvedValue = sumField(rows, criterion.statField);
            break;
        }

        case 'MmrRating': {
            // For MMR criteria, take the MAX across all rows (not sum).
            // A player with 1500 in one mode and 1200 in another qualifies for "rating >= 1500".
            const rows = [...ctx.db.MmrRating.user_id.filter(userId)];
            if (rows.length === 0) {
                resolvedValue = 0;
            } else {
                resolvedValue = Math.max(...rows.map((r: any) => getField(r, criterion.statField) ?? 0));
            }
            break;
        }

        default:
            // No silent failures per D-09 — unknown statTable always logs a warning
            console.warn(`[ACHIEVEMENT] Unknown statTable in criteria: ${criterion.statTable}`);
            return false;
    }

    return applyOperator(resolvedValue, criterion.operator, criterion.thresholdValue);
}

// ─── checkAndAwardAchievements ───────────────────────────────────────────────
// Called from runFinalization for each participant after all stat increments.
//
// @param userId       — the participant whose stats were just updated
// @param actingUserId — the user who triggered finalization (used for audit cols)

export function checkAndAwardAchievements(ctx: any, userId: number, actingUserId: number): void {
    // Achievement is admin-managed content with typically <100 rows; iter() is
    // acceptable here because it's a small, slowly-changing admin table. A btree
    // index on isManualOnly would add write overhead without meaningful benefit.
    const allAchievements = [...ctx.db.Achievement.iter()].filter((a: any) => !a.isManualOnly);

    for (const achievement of allAchievements) {
        // Per-user duplicate check: skip if user already has this achievement
        const existing = [...ctx.db.UserAchievement.by_user_achievement.filter([userId, achievement.id])];
        if (existing.length > 0) continue;

        // Global cap check: skip if global award limit has been reached
        if (achievement.maxAwards !== undefined) {
            const totalAwarded = [...ctx.db.UserAchievement.by_achievement.filter(achievement.id)].length;
            if (totalAwarded >= achievement.maxAwards) continue;
        }

        // Load criteria rows; if empty, achievement cannot be auto-awarded
        const criteriaRows = [...ctx.db.AchievementCriteria.by_achievement.filter(achievement.id)];
        if (criteriaRows.length === 0) continue;

        // AND logic: all criteria must pass
        const allPassed = criteriaRows.every((c: any) => evaluateCriterion(ctx, userId, c));
        if (!allPassed) continue;

        // Award the achievement
        ctx.db.UserAchievement.insert(insertWithAudit(ctx, {
            id: 0,
            userId,
            achievementId: achievement.id,
            awardedById: actingUserId,
        }, actingUserId));

        console.log(`[ACHIEVEMENT] Auto-awarded "${achievement.name}" to user #${userId}`);
    }
}
