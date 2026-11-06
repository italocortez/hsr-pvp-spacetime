/**
 * Integration tests for achievement management reducers.
 *
 * Tests CRUD, criteria management, manual award, title display,
 * permission guards, criteria lock, global cap, and cascade delete
 * against a live SpacetimeDB instance.
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createTestHarness,
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { promoteUser } from '../../shared/helpers/promoteUser';

// Unique suffix per test run to avoid name conflicts from leftover data
const RUN = Math.random().toString(36).slice(2, 8);
const N = (base: string) => `${base}_${RUN}`;

describe('Achievement Management', () => {
    let admin: TestHarness;
    let mod: TestHarness;
    let user: TestHarness;
    let guest: TestHarness;
    const createdAchievementIds: number[] = [];

    beforeAll(async () => {
        admin = await createVerifiedTestHarness();
        mod = await createVerifiedTestHarness();
        user = await createVerifiedTestHarness();
        guest = await createTestHarness();
        await admin.sync();
        await mod.sync();
        await user.sync();
        await guest.sync();

        const adminUser = [...admin.conn.db.User.iter()].find(u => u.id === admin.userId);
        const modUser = [...mod.conn.db.User.iter()].find(u => u.id === mod.userId);
        await promoteUser(adminUser!.username, 'Admin');
        await promoteUser(modUser!.username, 'Moderator');
        await admin.sync();
        await mod.sync();
    }, 30000);

    afterAll(async () => {
        // D-03: strict cleanup per resource opened
        for (const id of createdAchievementIds) {
            try {
                await admin.call.deleteAchievement({ achievementId: id });
                await admin.sync(300);
            } catch (_) { /* already deleted or cascade test */ }
        }
        await admin?.disconnect();
        await mod?.disconnect();
        await user?.disconnect();
        await guest?.disconnect();
    });

    // ─── Create Achievement ─────────────────────────────────────────────────

    describe('create_achievement', () => {
        it('admin creates achievement with correct fields', async () => {
            await admin.call.createAchievement({
                name: N('Test Create Admin'),
                description: 'Created by admin',
                rarity: { tag: 'Rare' },
                isManualOnly: false,
                maxAwards: undefined,
            });
            await admin.sync();

            const row = [...admin.conn.db.Achievement.iter()].find(a => a.name === N('Test Create Admin'));
            expect(row).toBeDefined();
            createdAchievementIds.push(row!.id);
            expect(row!.description).toBe('Created by admin');
            expect(row!.rarity.tag).toBe('Rare');
            expect(row!.isManualOnly).toBe(false);
        });

        it('moderator creates achievement (Moderator+ permission)', async () => {
            await mod.call.createAchievement({
                name: N('Test Create Mod'),
                description: 'Created by moderator',
                rarity: { tag: 'Epic' },
                isManualOnly: true,
                maxAwards: 5,
            });
            await mod.sync();

            const row = [...mod.conn.db.Achievement.iter()].find(a => a.name === N('Test Create Mod'));
            expect(row).toBeDefined();
            createdAchievementIds.push(row!.id);
            expect(row!.isManualOnly).toBe(true);
            expect(row!.maxAwards).toBe(5);
        });

        it('regular user rejected', async () => {
            const err = await expectReducerError(user.call.createAchievement({
                name: 'Nope',
                description: 'Should fail',
                rarity: { tag: 'Rare' },
                isManualOnly: false,
                maxAwards: undefined,
            }));
            expect(err).toContain('Forbidden');
        });

        it('guest rejected', async () => {
            const err = await expectReducerError(guest.call.createAchievement({
                name: 'Nope',
                description: 'Should fail',
                rarity: { tag: 'Rare' },
                isManualOnly: false,
                maxAwards: undefined,
            }));
            expect(err).toContain('Forbidden');
        });

        it('duplicate name rejected', async () => {
            const err = await expectReducerError(admin.call.createAchievement({
                name: N('Test Create Admin'),
                description: 'Duplicate',
                rarity: { tag: 'Epic' },
                isManualOnly: false,
                maxAwards: undefined,
            }));
            expect(err).toContain('already exists');
        });

        it('empty name rejected', async () => {
            const err = await expectReducerError(admin.call.createAchievement({
                name: '',
                description: 'Empty name',
                rarity: { tag: 'Rare' },
                isManualOnly: false,
                maxAwards: undefined,
            }));
            expect(err).toContain('must not be empty');
        });
    });

    // ─── Update Achievement ─────────────────────────────────────────────────

    describe('update_achievement', () => {
        let achievementId: number;

        beforeAll(async () => {
            await admin.call.createAchievement({
                name: N('Test Update Target'),
                description: 'Will be updated',
                rarity: { tag: 'Rare' },
                isManualOnly: false,
                maxAwards: undefined,
            });
            await admin.sync();
            const row = [...admin.conn.db.Achievement.iter()].find(a => a.name === N('Test Update Target'));
            achievementId = row!.id;
            createdAchievementIds.push(achievementId);
        });

        it('updates name and rarity', async () => {
            await admin.call.updateAchievement({
                achievementId,
                name: N('Test Updated Name'),
                description: 'Updated desc',
                rarity: { tag: 'Epic' },
            });
            await admin.sync();

            const row = admin.conn.db.Achievement.id.find(achievementId);
            expect(row!.name).toBe(N('Test Updated Name'));
            expect(row!.description).toBe('Updated desc');
            expect(row!.rarity.tag).toBe('Epic');
        });

        it('conflicting name rejected', async () => {
            const err = await expectReducerError(admin.call.updateAchievement({
                achievementId,
                name: N('Test Create Admin'),  // Already exists
                description: undefined,
                rarity: { tag: 'Rare' },
            }));
            expect(err).toContain('already exists');
        });
    });

    // ─── Add/Remove Criteria ─────────────────────────────────────────────────

    describe('criteria management', () => {
        let achievementId: number;

        beforeAll(async () => {
            await admin.call.createAchievement({
                name: N('Test Criteria Target'),
                description: 'For criteria tests',
                rarity: { tag: 'Rare' },
                isManualOnly: false,
                maxAwards: undefined,
            });
            await admin.sync();
            const row = [...admin.conn.db.Achievement.iter()].find(a => a.name === N('Test Criteria Target'));
            achievementId = row!.id;
            createdAchievementIds.push(achievementId);
        });

        it('adds criteria row with correct FK', async () => {
            await admin.call.addAchievementCriteria({
                achievementId,
                statTable: 'PlayerStat',
                statField: 'wins',
                operator: { tag: 'GreaterOrEqual' },
                thresholdValue: 10,
                filterGameMode: undefined,
                filterCharacterName: undefined,
                filterMatchType: undefined,
            });
            await admin.sync();

            const criteria = [...admin.conn.db.AchievementCriteria.iter()]
                .filter(c => c.achievementId === achievementId);
            expect(criteria.length).toBe(1);
            expect(criteria[0].statTable).toBe('PlayerStat');
            expect(criteria[0].statField).toBe('wins');
            expect(criteria[0].thresholdValue).toBe(10);
        });

        it('invalid statTable rejected', async () => {
            const err = await expectReducerError(admin.call.addAchievementCriteria({
                achievementId,
                statTable: 'FakeTable',
                statField: 'wins',
                operator: { tag: 'GreaterOrEqual' },
                thresholdValue: 5,
                filterGameMode: undefined,
                filterCharacterName: undefined,
                filterMatchType: undefined,
            }));
            expect(err).toContain('Invalid statTable');
        });

        it('removes criteria row', async () => {
            const criteria = [...admin.conn.db.AchievementCriteria.iter()]
                .filter(c => c.achievementId === achievementId);
            expect(criteria.length).toBeGreaterThan(0);

            await admin.call.removeAchievementCriteria({ criteriaId: criteria[0].id });
            await admin.sync();

            const after = [...admin.conn.db.AchievementCriteria.iter()]
                .filter(c => c.achievementId === achievementId);
            expect(after.length).toBe(0);
        });
    });

    // ─── Manual Award ────────────────────────────────────────────────────────

    describe('manual_award_achievement', () => {
        let achievementId: number;

        beforeAll(async () => {
            await admin.call.createAchievement({
                name: N('Test Award Target'),
                description: 'For award tests',
                rarity: { tag: 'Rare' },
                isManualOnly: true,
                maxAwards: undefined,
            });
            await admin.sync();
            const row = [...admin.conn.db.Achievement.iter()].find(a => a.name === N('Test Award Target'));
            achievementId = row!.id;
            createdAchievementIds.push(achievementId);
        });

        it('creates UserAchievement row', async () => {
            await admin.call.manualAwardAchievement({
                achievementId,
                targetUserId: user.userId,
            });
            await admin.sync();

            const awards = [...admin.conn.db.UserAchievement.iter()]
                .filter(ua => ua.achievementId === achievementId && ua.userId === user.userId);
            expect(awards.length).toBe(1);
            expect(awards[0].awardedById).toBe(admin.userId);
        });

        it('duplicate award rejected', async () => {
            const err = await expectReducerError(admin.call.manualAwardAchievement({
                achievementId,
                targetUserId: user.userId,
            }));
            expect(err).toContain('already earned');
        });

        it('regular user rejected', async () => {
            const err = await expectReducerError(user.call.manualAwardAchievement({
                achievementId,
                targetUserId: admin.userId,
            }));
            expect(err).toContain('Forbidden');
        });
    });

    // ─── Criteria Lock ───────────────────────────────────────────────────────

    describe('criteria lock after award', () => {
        let achievementId: number;

        beforeAll(async () => {
            await admin.call.createAchievement({
                name: N('Test Lock Target'),
                description: 'For criteria lock tests',
                rarity: { tag: 'Rare' },
                isManualOnly: false,
                maxAwards: undefined,
            });
            await admin.sync();
            const row = [...admin.conn.db.Achievement.iter()].find(a => a.name === N('Test Lock Target'));
            achievementId = row!.id;
            createdAchievementIds.push(achievementId);

            // Add criteria then award to trigger lock
            await admin.call.addAchievementCriteria({
                achievementId,
                statTable: 'PlayerStat',
                statField: 'wins',
                operator: { tag: 'GreaterOrEqual' },
                thresholdValue: 100,
                filterGameMode: undefined,
                filterCharacterName: undefined,
                filterMatchType: undefined,
            });
            await admin.sync();
            await admin.call.manualAwardAchievement({
                achievementId,
                targetUserId: user.userId,
            });
            await admin.sync();
        });

        it('add criteria rejected after award', async () => {
            const err = await expectReducerError(admin.call.addAchievementCriteria({
                achievementId,
                statTable: 'MmrRating',
                statField: 'rating',
                operator: { tag: 'GreaterThan' },
                thresholdValue: 1000,
                filterGameMode: undefined,
                filterCharacterName: undefined,
                filterMatchType: undefined,
            }));
            expect(err).toContain('Cannot modify criteria');
        });

        it('remove criteria rejected after award', async () => {
            const criteria = [...admin.conn.db.AchievementCriteria.iter()]
                .filter(c => c.achievementId === achievementId);
            expect(criteria.length).toBeGreaterThan(0);

            const err = await expectReducerError(admin.call.removeAchievementCriteria({
                criteriaId: criteria[0].id,
            }));
            expect(err).toContain('Cannot modify criteria');
        });
    });

    // ─── Global Cap ──────────────────────────────────────────────────────────

    describe('global cap enforcement', () => {
        let cappedId: number;

        beforeAll(async () => {
            await admin.call.createAchievement({
                name: N('Test Capped'),
                description: 'maxAwards=1',
                rarity: { tag: 'Legendary' },
                isManualOnly: true,
                maxAwards: 1,
            });
            await admin.sync();
            const row = [...admin.conn.db.Achievement.iter()].find(a => a.name === N('Test Capped'));
            cappedId = row!.id;
            createdAchievementIds.push(cappedId);

            // Award to user (fills the cap)
            await admin.call.manualAwardAchievement({
                achievementId: cappedId,
                targetUserId: user.userId,
            });
            await admin.sync();
        });

        it('second award rejected at cap', async () => {
            const err = await expectReducerError(admin.call.manualAwardAchievement({
                achievementId: cappedId,
                targetUserId: mod.userId,
            }));
            expect(err).toContain('global award limit');
        });
    });

    // ─── Set Displayed Achievement ───────────────────────────────────────────

    describe('set_displayed_achievement', () => {
        let earnedAchievementId: number;

        beforeAll(async () => {
            // user already earned "Test Award Target" from manual_award tests
            await user.sync();
            const awards = [...user.conn.db.UserAchievement.iter()]
                .filter(ua => ua.userId === user.userId);
            expect(awards.length).toBeGreaterThan(0);
            earnedAchievementId = awards[0].achievementId;
        });

        it('user sets own displayed achievement', async () => {
            await user.call.setDisplayedAchievement({
                targetUserId: undefined,
                achievementId: earnedAchievementId,
            });
            await user.sync();

            const userRow = user.conn.db.User.id.find(user.userId);
            expect(userRow!.displayedAchievementId).toBe(earnedAchievementId);
        });

        it('user clears displayed achievement', async () => {
            await user.call.setDisplayedAchievement({
                targetUserId: undefined,
                achievementId: 0,
            });
            await user.sync();

            const userRow = user.conn.db.User.id.find(user.userId);
            expect(userRow!.displayedAchievementId).toBeUndefined();
        });

        it('unearned achievement rejected', async () => {
            // Find an achievement the user hasn't earned
            const allAch = [...user.conn.db.Achievement.iter()];
            const userAwards = [...user.conn.db.UserAchievement.iter()]
                .filter(ua => ua.userId === user.userId)
                .map(ua => ua.achievementId);
            const unearned = allAch.find(a => !userAwards.includes(a.id));
            expect(unearned).toBeDefined();

            const err = await expectReducerError(user.call.setDisplayedAchievement({
                targetUserId: undefined,
                achievementId: unearned!.id,
            }));
            expect(err).toContain('not earned');
        });

        it('moderator cannot set other user title', async () => {
            const err = await expectReducerError(mod.call.setDisplayedAchievement({
                targetUserId: user.userId,
                achievementId: earnedAchievementId,
            }));
            expect(err).toContain('Only admins');
        });

        it('guest rejected', async () => {
            const err = await expectReducerError(guest.call.setDisplayedAchievement({
                targetUserId: undefined,
                achievementId: 1,
            }));
            expect(err).toContain('Guests cannot');
        });
    });

    // ─── Delete with Cascade ─────────────────────────────────────────────────

    describe('delete_achievement (cascade)', () => {
        let cascadeId: number;

        beforeAll(async () => {
            // Create achievement with criteria
            await admin.call.createAchievement({
                name: N('Test Cascade Delete'),
                description: 'Will be cascade deleted',
                rarity: { tag: 'Epic' },
                isManualOnly: true,
                maxAwards: undefined,
            });
            await admin.sync();
            const row = [...admin.conn.db.Achievement.iter()].find(a => a.name === N('Test Cascade Delete'));
            cascadeId = row!.id;
            createdAchievementIds.push(cascadeId);

            // Add criteria
            await admin.call.addAchievementCriteria({
                achievementId: cascadeId,
                statTable: 'PlayerStat',
                statField: 'wins',
                operator: { tag: 'GreaterOrEqual' },
                thresholdValue: 5,
                filterGameMode: undefined,
                filterCharacterName: undefined,
                filterMatchType: undefined,
            });
            await admin.sync();

            // Award to user
            await admin.call.manualAwardAchievement({
                achievementId: cascadeId,
                targetUserId: user.userId,
            });
            await admin.sync();

            // User sets as displayed
            await user.call.setDisplayedAchievement({
                targetUserId: undefined,
                achievementId: cascadeId,
            });
            await user.sync();
        });

        it('moderator cannot delete (Admin only)', async () => {
            const err = await expectReducerError(mod.call.deleteAchievement({
                achievementId: cascadeId,
            }));
            expect(err).toContain('Requires Admin');
        });

        it('admin deletes with full cascade', async () => {
            // Verify pre-delete state
            const preCriteria = [...admin.conn.db.AchievementCriteria.iter()]
                .filter(c => c.achievementId === cascadeId);
            expect(preCriteria.length).toBeGreaterThan(0);

            const preAwards = [...admin.conn.db.UserAchievement.iter()]
                .filter(ua => ua.achievementId === cascadeId);
            expect(preAwards.length).toBeGreaterThan(0);

            // Delete
            await admin.call.deleteAchievement({ achievementId: cascadeId });
            await admin.sync();
            await user.sync();

            // Achievement gone (.find() returns null when not found)
            const achievement = admin.conn.db.Achievement.id.find(cascadeId);
            expect(achievement).toBeNull();

            // Criteria gone
            const postCriteria = [...admin.conn.db.AchievementCriteria.iter()]
                .filter(c => c.achievementId === cascadeId);
            expect(postCriteria.length).toBe(0);

            // Awards gone
            const postAwards = [...admin.conn.db.UserAchievement.iter()]
                .filter(ua => ua.achievementId === cascadeId);
            expect(postAwards.length).toBe(0);

            // User's displayed achievement cleared
            const userRow = user.conn.db.User.id.find(user.userId);
            expect(userRow!.displayedAchievementId).toBeUndefined();
        });
    });
});
