// T-S10 (batch C1): the achievement management reducers in memory, ported from the live
// test/backend/achievements/achievement-management.test.ts. Spec: docs/achievements/contract.md (each `it` cites the
// reducer section, acceptance scenario or edge case it covers; D-20..D-25 are the reducer-header decision ids, A43 the
// awarder rule). Roles are written straight onto the User row (setUserRole); the owner identity ('internal') is the
// SYSTEM Admin. The auto-award pipeline stays with s9b-views. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { M, expectReject, guest, newHarness, tx, type Actor, type Harness } from './s4-fixtures';
import { host as tournamentHost, moderator, openTournament, register, setUserRole, verified } from './s8-fixtures';
import { addCriteria, award, awardsOf, createAchievement, criteriaOf } from './s10-c1-fixtures';

const MOD_ONLY = 'Forbidden: Requires Moderator or Admin privileges.';
const ADMIN_ONLY = 'Forbidden: Requires Admin privileges.';
const AWARD_FORBIDDEN = 'Forbidden: Requires Moderator, Admin, or Tournament Host privileges.';
const LOCKED = 'Cannot modify criteria: players have already earned this achievement.';

function admin(test: Harness, name = 'boss'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Admin');
    return a;
}

const displayed = (test: Harness, a: Actor) => test.db.User.id.find(a.userId)!.displayedAchievementId;

describe('create_achievement (contract § create_achievement; D-20 Moderator+)', () => {
    it('an Admin creates an achievement: every field stored, audit columns carry the Admin (scenario "Admin Creates Achievement")', () => {
        const test = newHarness();
        const boss = admin(test);
        tx(test, boss, (ctx) => M.create_achievement(ctx, {
            name: 'Veteran', description: 'Play 100 matches', rarity: { tag: 'Epic' } as any, isManualOnly: false, maxAwards: 10,
        }));
        const row = test.db.Achievement.name.find('Veteran')!;
        expect(row).toMatchObject({ name: 'Veteran', description: 'Play 100 matches', isManualOnly: false, maxAwards: 10 });
        expect(row.rarity.tag).toBe('Epic');
        expect([row.createdById, row.lastModifiedById]).toEqual([boss.userId, boss.userId]);
    });

    it('a Moderator creates one too, with no cap (maxAwards omitted = unlimited) (scenario "Moderator Creates and Manages")', () => {
        const test = newHarness();
        const mod = moderator(test);
        const id = createAchievement(test, mod, 'Unlimited', true);
        expect(test.db.Achievement.id.find(id)!.maxAwards).toBeUndefined();
    });

    it('a regular User and a guest are rejected with the Moderator+ message (scenario "Permission Guards")', () => {
        const test = newHarness();
        const user = verified(test, 'plain');
        const g = guest(test, 'g');
        for (const who of [user, g]) {
            expectReject(test, who, (ctx) => M.create_achievement(ctx, {
                name: 'Nope', description: '', rarity: { tag: 'Rare' } as any, isManualOnly: true, maxAwards: undefined,
            }), MOD_ONLY);
        }
        expect(test.db.Achievement.name.find('Nope')).toBeFalsy();
    });

    it('a duplicate name is rejected (scenario "Duplicate Name Rejected")', () => {
        const test = newHarness();
        const mod = moderator(test);
        createAchievement(test, mod, 'Veteran', false);
        expectReject(test, mod, (ctx) => M.create_achievement(ctx, {
            name: 'Veteran', description: 'again', rarity: { tag: 'Rare' } as any, isManualOnly: false, maxAwards: undefined,
        }), 'Achievement with this name already exists.');
    });

    it('an empty or whitespace-only name is rejected (edge case "Empty achievement name", trim check)', () => {
        const test = newHarness();
        const mod = moderator(test);
        for (const name of ['', '   ']) {
            expectReject(test, mod, (ctx) => M.create_achievement(ctx, {
                name, description: 'x', rarity: { tag: 'Rare' } as any, isManualOnly: false, maxAwards: undefined,
            }), 'Achievement name must not be empty.');
        }
        expect([...test.db.Achievement.iter()]).toHaveLength(0);
    });
});

describe('update_achievement (contract § update_achievement; D-24)', () => {
    it('updates name, description and rarity; an omitted name / description keeps the stored value', () => {
        const test = newHarness();
        const mod = moderator(test);
        const id = createAchievement(test, mod, 'Old name', false);
        tx(test, mod, (ctx) => M.update_achievement(ctx, { achievementId: id, name: 'New name', description: 'New text', rarity: { tag: 'Legendary' } as any }));
        let row = test.db.Achievement.id.find(id)!;
        expect(row).toMatchObject({ name: 'New name', description: 'New text' });
        expect(row.rarity.tag).toBe('Legendary');

        tx(test, mod, (ctx) => M.update_achievement(ctx, { achievementId: id, name: undefined, description: undefined, rarity: { tag: 'Epic' } as any }));
        row = test.db.Achievement.id.find(id)!;
        expect(row).toMatchObject({ name: 'New name', description: 'New text' });
        expect(row.rarity.tag).toBe('Epic');
    });

    it('a name held by another achievement and an unknown id are rejected with the contract texts', () => {
        const test = newHarness();
        const mod = moderator(test);
        createAchievement(test, mod, 'Taken', false);
        const id = createAchievement(test, mod, 'Mine', false);
        expectReject(test, mod, (ctx) => M.update_achievement(ctx, { achievementId: id, name: 'Taken', description: undefined, rarity: { tag: 'Rare' } as any }),
            'Achievement with this name already exists.');
        expectReject(test, mod, (ctx) => M.update_achievement(ctx, { achievementId: 4040, name: 'x', description: undefined, rarity: { tag: 'Rare' } as any }),
            'Achievement #4040 not found.');
        expect(test.db.Achievement.id.find(id)!.name).toBe('Mine');
    });

    it('a regular User cannot update (scenario "Permission Guards")', () => {
        const test = newHarness();
        const mod = moderator(test);
        const user = verified(test, 'plain');
        const id = createAchievement(test, mod, 'Fixed', false);
        expectReject(test, user, (ctx) => M.update_achievement(ctx, { achievementId: id, name: 'Hacked', description: undefined, rarity: { tag: 'Rare' } as any }), MOD_ONLY);
    });
});

describe('add / remove_achievement_criteria (contract §§ add_achievement_criteria, remove_achievement_criteria; D-25)', () => {
    it('a criteria row is inserted linked to its achievement, with every field (scenario "Admin Creates Achievement with Criteria")', () => {
        const test = newHarness();
        const boss = admin(test);
        const id = createAchievement(test, boss, 'MMR Elite', false);
        tx(test, boss, (ctx) => M.add_achievement_criteria(ctx, {
            achievementId: id, statTable: 'MmrRating', statField: 'rating', operator: { tag: 'GreaterThan' } as any,
            thresholdValue: 1800, filterGameMode: 'MemoryOfChaos', filterCharacterName: undefined, filterMatchType: 'Ranked',
        }));
        const [c] = criteriaOf(test, id);
        expect(c).toMatchObject({ achievementId: id, statTable: 'MmrRating', statField: 'rating', thresholdValue: 1800, filterGameMode: 'MemoryOfChaos', filterMatchType: 'Ranked' });
        expect(c.filterCharacterName).toBeUndefined();
        expect(c.operator.tag).toBe('GreaterThan');
        expect(c.createdById).toBe(boss.userId);
    });

    it('an invalid statTable and an unknown achievement are rejected; nothing is inserted', () => {
        const test = newHarness();
        const mod = moderator(test);
        const id = createAchievement(test, mod, 'Checked', false);
        expect(() => addCriteria(test, mod, id, { statTable: 'MatchResult' }))
            .toThrow('Invalid statTable "MatchResult". Must be one of: PlayerStat, PlayerCharacterStat, MmrRating.');
        expect(() => addCriteria(test, mod, 4040)).toThrow('Achievement #4040 not found.');
        expect(criteriaOf(test, id)).toHaveLength(0);
    });

    it('a Moderator removes a criteria row; an unknown criteria id is rejected (scenario "Moderator Creates and Manages")', () => {
        const test = newHarness();
        const mod = moderator(test);
        const id = createAchievement(test, mod, 'Removable', false);
        addCriteria(test, mod, id);
        addCriteria(test, mod, id, { statField: 'wins', thresholdValue: 5 });
        const [first, second] = criteriaOf(test, id);
        tx(test, mod, (ctx) => M.remove_achievement_criteria(ctx, { criteriaId: first.id }));
        expect(criteriaOf(test, id).map((c) => c.id)).toEqual([second.id]);
        expectReject(test, mod, (ctx) => M.remove_achievement_criteria(ctx, { criteriaId: first.id }), `AchievementCriteria #${first.id} not found.`);
    });

    it('a regular User can neither add nor remove criteria (scenario "Permission Guards")', () => {
        const test = newHarness();
        const mod = moderator(test);
        const user = verified(test, 'plain');
        const id = createAchievement(test, mod, 'Guarded', false);
        addCriteria(test, mod, id);
        const criteriaId = criteriaOf(test, id)[0].id;
        expect(() => addCriteria(test, user, id)).toThrow(MOD_ONLY);
        expectReject(test, user, (ctx) => M.remove_achievement_criteria(ctx, { criteriaId }), MOD_ONLY);
        expect(criteriaOf(test, id)).toHaveLength(1);
    });

    it('criteria lock: once a player earned the achievement, add and remove are both rejected (scenario "Criteria Lock After Award")', () => {
        const test = newHarness();
        const boss = admin(test);
        const winner = verified(test, 'winner');
        const id = createAchievement(test, boss, 'Locked', false);
        addCriteria(test, boss, id);
        award(test, boss, id, winner.userId);
        const criteriaId = criteriaOf(test, id)[0].id;
        expect(() => addCriteria(test, boss, id, { statField: 'wins' })).toThrow(LOCKED);
        expectReject(test, boss, (ctx) => M.remove_achievement_criteria(ctx, { criteriaId }), LOCKED);
        expect(criteriaOf(test, id)).toHaveLength(1);
    });
});

describe('manual_award_achievement (contract § manual_award_achievement; D-21, A43)', () => {
    it('a Moderator awards: one UserAchievement row with awardedById = the Moderator (A43) and the Moderator as audit actor', () => {
        const test = newHarness();
        const mod = moderator(test);
        const winner = verified(test, 'winner');
        const id = createAchievement(test, mod, 'Hand picked', true);
        award(test, mod, id, winner.userId);
        const rows = awardsOf(test, id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ userId: winner.userId, achievementId: id, awardedById: mod.userId, createdById: mod.userId });
    });

    it('a second award of the same achievement to the same user is rejected (scenario "Manual Award with Duplicate Prevention")', () => {
        const test = newHarness();
        const boss = admin(test);
        const winner = verified(test, 'winner');
        const id = createAchievement(test, boss, 'Once', true);
        award(test, boss, id, winner.userId);
        expect(() => award(test, boss, id, winner.userId)).toThrow('User has already earned this achievement.');
        expect(awardsOf(test, id)).toHaveLength(1);
    });

    it('a regular User and a guest are rejected (contract error "Caller lacks permission")', () => {
        const test = newHarness();
        const mod = moderator(test);
        const user = verified(test, 'plain');
        const g = guest(test, 'g');
        const target = verified(test, 'target');
        const id = createAchievement(test, mod, 'Staff only', true);
        expect(() => award(test, user, id, target.userId)).toThrow(AWARD_FORBIDDEN);
        expect(() => award(test, g, id, target.userId)).toThrow(AWARD_FORBIDDEN);
        expect(awardsOf(test, id)).toHaveLength(0);
    });

    it('the global cap: maxAwards = 1 rejects the second user with the limit message; maxAwards = 0 blocks every award (scenario "Global Cap Enforcement"; edge case maxAwards=0)', () => {
        const test = newHarness();
        const boss = admin(test);
        const a = verified(test, 'first');
        const b = verified(test, 'second');
        const one = createAchievement(test, boss, 'First ever', true, 1);
        award(test, boss, one, a.userId);
        expect(() => award(test, boss, one, b.userId)).toThrow('Achievement "First ever" has reached its global award limit (1).');
        const zero = createAchievement(test, boss, 'Nobody', true, 0);
        expect(() => award(test, boss, zero, a.userId)).toThrow('Achievement "Nobody" has reached its global award limit (0).');
        expect([awardsOf(test, one).length, awardsOf(test, zero).length]).toEqual([1, 0]);
    });

    it('an unknown achievement and an unknown target user are rejected with the contract texts', () => {
        const test = newHarness();
        const boss = admin(test);
        const winner = verified(test, 'winner');
        const id = createAchievement(test, boss, 'Real', true);
        expect(() => award(test, boss, 4040, winner.userId)).toThrow('Achievement #4040 not found.');
        expect(() => award(test, boss, id, 999_999)).toThrow('User #999999 not found.');
        expect(awardsOf(test, id)).toHaveLength(0);
    });

    it('a Tournament Host awards a participant of their own tournament (awardedById = the host) and is rejected for anyone else (D-21 TO scope)', () => {
        const test = newHarness();
        const mod = moderator(test);
        const org = tournamentHost(test, 'org');
        const tid = openTournament(test, org);
        const player = verified(test, 'player');
        const outsider = verified(test, 'outsider');
        register(test, player, tid);
        const id = createAchievement(test, mod, 'Cup winner', true);
        award(test, org, id, player.userId);
        expect(awardsOf(test, id)).toEqual([expect.objectContaining({ userId: player.userId, awardedById: org.userId })]);
        expect(() => award(test, org, id, outsider.userId)).toThrow('Forbidden: Target user is not a participant in your tournaments.');
    });
});

describe('set_displayed_achievement (contract § set_displayed_achievement; D-22)', () => {
    it('a user sets an earned title, then clears it with achievementId 0 (scenario "Set and Clear Display Title")', () => {
        const test = newHarness();
        const mod = moderator(test);
        const winner = verified(test, 'winner');
        const id = createAchievement(test, mod, 'Shown', true);
        award(test, mod, id, winner.userId);
        tx(test, winner, (ctx) => M.set_displayed_achievement(ctx, { targetUserId: undefined, achievementId: id }));
        expect(displayed(test, winner)).toBe(id);
        tx(test, winner, (ctx) => M.set_displayed_achievement(ctx, { targetUserId: 0, achievementId: 0 }));
        expect(displayed(test, winner)).toBeUndefined();
    });

    it('an unearned or unknown achievement is rejected; the title is unchanged', () => {
        const test = newHarness();
        const mod = moderator(test);
        const user = verified(test, 'plain');
        const id = createAchievement(test, mod, 'Not mine', true);
        expectReject(test, user, (ctx) => M.set_displayed_achievement(ctx, { targetUserId: undefined, achievementId: id }), 'User has not earned this achievement.');
        expectReject(test, user, (ctx) => M.set_displayed_achievement(ctx, { targetUserId: undefined, achievementId: 4040 }), 'Achievement #4040 not found.');
        expect(displayed(test, user)).toBeUndefined();
    });

    it('a Moderator cannot set another user\'s title; a guest cannot set their own (scenarios "Moderator Cannot Set Other User\'s Title", "Permission Guards")', () => {
        const test = newHarness();
        const mod = moderator(test);
        const winner = verified(test, 'winner');
        const g = guest(test, 'g');
        const id = createAchievement(test, mod, 'Theirs', true);
        award(test, mod, id, winner.userId);
        award(test, mod, id, g.userId);
        expectReject(test, mod, (ctx) => M.set_displayed_achievement(ctx, { targetUserId: winner.userId, achievementId: id }),
            'Forbidden: Only admins can set titles for other users.');
        expectReject(test, g, (ctx) => M.set_displayed_achievement(ctx, { targetUserId: undefined, achievementId: id }),
            'Guests cannot set displayed achievements.');
        expect([displayed(test, winner), displayed(test, g)]).toEqual([undefined, undefined]);
    });

    it('an Admin sets and clears another user\'s earned title (D-22: Admin sets for any user)', () => {
        const test = newHarness();
        const boss = admin(test);
        const winner = verified(test, 'winner');
        const id = createAchievement(test, boss, 'Granted', true);
        award(test, boss, id, winner.userId);
        tx(test, boss, (ctx) => M.set_displayed_achievement(ctx, { targetUserId: winner.userId, achievementId: id }));
        expect(displayed(test, winner)).toBe(id);
        expect(test.db.User.id.find(winner.userId)!.lastModifiedById).toBe(boss.userId);
        tx(test, boss, (ctx) => M.set_displayed_achievement(ctx, { targetUserId: winner.userId, achievementId: undefined }));
        expect(displayed(test, winner)).toBeUndefined();
    });
});

describe('delete_achievement (contract § delete_achievement; D-23 Admin only)', () => {
    it('a Moderator is rejected with the Admin-only message (scenario "Moderator Cannot Delete Achievement")', () => {
        const test = newHarness();
        const mod = moderator(test);
        const id = createAchievement(test, mod, 'Kept', false);
        expectReject(test, mod, (ctx) => M.delete_achievement(ctx, { achievementId: id }), ADMIN_ONLY);
        expect(test.db.Achievement.id.find(id)).toBeTruthy();
    });

    it('an Admin deletes with the full cascade: criteria, awards, displayed titles cleared; other achievements untouched (scenario "Cascade Delete")', () => {
        const test = newHarness();
        const boss = admin(test);
        const a = verified(test, 'a');
        const b = verified(test, 'b');
        const doomed = createAchievement(test, boss, 'Doomed', false);
        const kept = createAchievement(test, boss, 'Kept', false);
        addCriteria(test, boss, doomed);
        addCriteria(test, boss, kept);
        award(test, boss, doomed, a.userId);
        award(test, boss, doomed, b.userId);
        award(test, boss, kept, b.userId);
        tx(test, a, (ctx) => M.set_displayed_achievement(ctx, { targetUserId: undefined, achievementId: doomed }));
        tx(test, b, (ctx) => M.set_displayed_achievement(ctx, { targetUserId: undefined, achievementId: kept }));

        tx(test, boss, (ctx) => M.delete_achievement(ctx, { achievementId: doomed }));

        expect(test.db.Achievement.id.find(doomed)).toBeFalsy();
        expect(criteriaOf(test, doomed)).toHaveLength(0);
        expect(awardsOf(test, doomed)).toHaveLength(0);
        expect(displayed(test, a)).toBeUndefined();
        expect(displayed(test, b)).toBe(kept);
        expect([criteriaOf(test, kept).length, awardsOf(test, kept).length]).toEqual([1, 1]);
        expectReject(test, boss, (ctx) => M.delete_achievement(ctx, { achievementId: doomed }), `Achievement #${doomed} not found.`);
    });
});
