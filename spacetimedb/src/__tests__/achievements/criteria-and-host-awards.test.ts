// Achievements: criteria field and filter checks; a tournament host awards only manual achievements.
// Decisions: A122
// Contracts: docs/achievements/contract.md
// From S10r (s10r-triage-fixes.test.ts).
import { describe, expect, it } from 'vitest';
import { M, ensureCharacterRef, expectReject, newHarness, tx } from '../fixtures/harness';
import {
    host,
    moderator,
    openTournament,
    register,
    verified,
} from '../fixtures/tournament-builders';
import { createAchievement } from '../fixtures/achievement-auth-cost-builders';

const HOST_AWARD_TEXT = 'Tournament hosts can only award manual achievements without an award limit.';

// ════════════════════════════════════════════════════════════════════════════
// L42: achievement criteria fields and tags
// ════════════════════════════════════════════════════════════════════════════

describe('A122(12), L42: add_achievement_criteria rejects unknown fields and unknown filter tags', () => {
    const criteria = (achievementId: number, over: Record<string, unknown>) => (ctx: any) => M.add_achievement_criteria(ctx, {
        achievementId, statTable: 'PlayerStat', statField: 'matchesPlayed', operator: { tag: 'LessThan' } as any, thresholdValue: 1,
        filterGameMode: undefined, filterCharacterName: undefined, filterMatchType: undefined, ...over,
    } as any);

    it('A122(12) L42: a field the table does not carry, a mistyped game mode and a mistyped match type are rejected; nothing is stored', () => {
        const test = newHarness();
        const id = createAchievement(test, 'internal', 'auto', false);
        expectReject(test, 'internal', criteria(id, { statField: 'timesFaced' }), /Invalid statField "timesFaced" for PlayerStat/);
        expectReject(test, 'internal', criteria(id, { statTable: 'MmrRating', statField: 'ratng' }), /Invalid statField "ratng" for MmrRating/);
        expectReject(test, 'internal', criteria(id, { filterGameMode: 'MemoryOfChoas' }), /Invalid filterGameMode "MemoryOfChoas"/);
        expectReject(test, 'internal', criteria(id, { filterMatchType: 'ranked' }), /Invalid filterMatchType "ranked"/);
        expect([...test.db.AchievementCriteria.by_achievement.filter(id)]).toHaveLength(0);
    });

    it('A122(12) L42 (review F4): a character filter that names no character is rejected', () => {
        const test = newHarness();
        const id = createAchievement(test, 'internal', 'auto', false);
        expectReject(test, 'internal', criteria(id, { statTable: 'PlayerCharacterStat', statField: 'wins', filterCharacterName: 'Kafak' }),
            'Invalid filterCharacterName "Kafak". No such character.');
        expect([...test.db.AchievementCriteria.by_achievement.filter(id)]).toHaveLength(0);
    });

    it('A122(12) L42 (review F4): an existing character is accepted as a filter; an empty name is stored as no filter', () => {
        const test = newHarness();
        ensureCharacterRef(test, 'Kafka');
        const id = createAchievement(test, 'internal', 'auto', false);
        tx(test, 'internal', criteria(id, { statTable: 'PlayerCharacterStat', statField: 'wins', filterCharacterName: 'Kafka' }));
        tx(test, 'internal', criteria(id, { statTable: 'PlayerCharacterStat', statField: 'losses', filterCharacterName: '' }));
        const rows = [...test.db.AchievementCriteria.by_achievement.filter(id)].sort((a, b) => a.id - b.id);
        expect(rows.map((r) => r.filterCharacterName)).toEqual(['Kafka', undefined]);
    });

    it('A122(12) L42: valid fields per table and real GameMode / MatchType tags are accepted', () => {
        const test = newHarness();
        const id = createAchievement(test, 'internal', 'auto', false);
        tx(test, 'internal', criteria(id, { statField: 'wins', filterGameMode: 'MemoryOfChaos', filterMatchType: 'Ranked' }));
        tx(test, 'internal', criteria(id, { statTable: 'PlayerCharacterStat', statField: 'timesFaced' }));
        tx(test, 'internal', criteria(id, { statTable: 'MmrRating', statField: 'rating' }));
        expect([...test.db.AchievementCriteria.by_achievement.filter(id)]).toHaveLength(3);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L46: hosts award only manual achievements
// ════════════════════════════════════════════════════════════════════════════

describe('A122(13), L46: a tournament host awards only manual achievements', () => {
    function hostWithPlayer() {
        const test = newHarness();
        const org = host(test, 'org');
        const tid = openTournament(test, org, { teamSize: 1 });
        const p = verified(test, 'player');
        register(test, p, tid);
        return { test, org, p };
    }

    it('A122(13) L46: an automatic achievement and a capped manual one are refused to the host', () => {
        const { test, org, p } = hostWithPlayer();
        const auto = createAchievement(test, 'internal', 'auto', false);
        const capped = createAchievement(test, 'internal', 'capped', true, 5);
        expectReject(test, org, (ctx) => M.manual_award_achievement(ctx, { achievementId: auto, targetUserId: p.userId }), HOST_AWARD_TEXT);
        expectReject(test, org, (ctx) => M.manual_award_achievement(ctx, { achievementId: capped, targetUserId: p.userId }), HOST_AWARD_TEXT);
        expect([...test.db.UserAchievement.by_user.filter(p.userId)]).toHaveLength(0);
    });

    it('A122(13) L46: the host awards an uncapped manual achievement; a Moderator still awards an automatic and a capped one', () => {
        const { test, org, p } = hostWithPlayer();
        const manual = createAchievement(test, 'internal', 'manual', true);
        const auto = createAchievement(test, 'internal', 'auto', false);
        const capped = createAchievement(test, 'internal', 'capped', true, 5);
        tx(test, org, (ctx) => M.manual_award_achievement(ctx, { achievementId: manual, targetUserId: p.userId }));
        const mod = moderator(test);
        tx(test, mod, (ctx) => M.manual_award_achievement(ctx, { achievementId: auto, targetUserId: p.userId }));
        tx(test, mod, (ctx) => M.manual_award_achievement(ctx, { achievementId: capped, targetUserId: p.userId }));
        expect([...test.db.UserAchievement.by_user.filter(p.userId)]).toHaveLength(3);
    });
});
