// Fixtures: achievements, their criteria and awards.
// From S10 (s10-c1-fixtures.ts; createAchievement first copied from s9b-views).
//
// Not a test file. State is built through the module's reducers; `test.db` is read only outside `tx` bodies.
// Nothing reaches maincloud.
import { M, tx, type Actor, type Harness } from './harness';

/** create_achievement as `who`; returns the new id (optional maxAwards). */
export function createAchievement(test: Harness, who: Actor | 'internal', name: string, isManualOnly: boolean, maxAwards?: number): number {
    tx(test, who, (ctx) => M.create_achievement(ctx, { name, description: name, rarity: { tag: 'Rare' } as any, isManualOnly, maxAwards }));
    return test.db.Achievement.name.find(name)!.id;
}

/** add_achievement_criteria as `who` (PlayerStat.matchesPlayed >= threshold unless overridden). */
export function addCriteria(
    test: Harness,
    who: Actor | 'internal',
    achievementId: number,
    over: Partial<{ statTable: string; statField: string; thresholdValue: number; filterGameMode: string }> = {},
) {
    tx(test, who, (ctx) => M.add_achievement_criteria(ctx, {
        achievementId,
        statTable: over.statTable ?? 'PlayerStat',
        statField: over.statField ?? 'matchesPlayed',
        operator: { tag: 'GreaterOrEqual' } as any,
        thresholdValue: over.thresholdValue ?? 1,
        filterGameMode: over.filterGameMode,
        filterCharacterName: undefined,
        filterMatchType: undefined,
    }));
}

export const criteriaOf = (test: Harness, achievementId: number) => [...test.db.AchievementCriteria.by_achievement.filter(achievementId)];
export const awardsOf = (test: Harness, achievementId: number) => [...test.db.UserAchievement.by_achievement.filter(achievementId)];

export function award(test: Harness, who: Actor | 'internal', achievementId: number, targetUserId: number) {
    tx(test, who, (ctx) => M.manual_award_achievement(ctx, { achievementId, targetUserId }));
}
