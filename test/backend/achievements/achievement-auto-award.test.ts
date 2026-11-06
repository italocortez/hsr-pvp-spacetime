/**
 * Integration test: Achievement auto-award via finalization pipeline (step 16.5).
 *
 * Creates an achievement with matchesPlayed >= 1 criteria, runs a Casual match
 * through auto-finalization, verifies UserAchievement row auto-inserted.
 *
 * Contract: docs/achievements/contract.md — Auto-Award via Finalization Pipeline
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    hasServerToken,
    type TestHarness,
} from '../../shared/connection';
import { promoteUser } from '../../shared/helpers/promoteUser';
import { defaultLobbyArgs } from '../../shared/helpers/lobbies';
import { getUsername } from '../../shared/helpers/users';
import { completeDraft } from '../../shared/helpers/drafts';
import { gameScoreArgs } from '../../shared/helpers/scores';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Complete a Classic draft with no bans (16 picks: Blue, Red alternating) */

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasServerToken())('Achievement Auto-Award via Finalization', () => {
    let admin: TestHarness;
    let host: TestHarness;
    let blue: TestHarness;
    let red: TestHarness;

    let testAchievementId: number;

    beforeAll(async () => {
        admin = await createVerifiedTestHarness();
        host = await createVerifiedTestHarness();
        blue = await createVerifiedTestHarness();
        red = await createVerifiedTestHarness();

        await admin.sync();
        await host.sync();
        await blue.sync();
        await red.sync();

        await promoteUser(getUsername(admin), 'Admin');
        await admin.sync(1500);

        // Create a low-threshold achievement: matchesPlayed >= 1
        const achName = `AutoAward Test ${Date.now()}`;
        await admin.call.createAchievement({
            name: achName,
            description: 'Auto-award test: matchesPlayed >= 1',
            rarity: { tag: 'Rare' },
            isManualOnly: false,
            maxAwards: undefined,
        });
        await admin.sync(1500);

        // Find the achievement
        const ach = [...admin.conn.db.Achievement.iter()].find(a => a.name === achName);
        if (!ach) throw new Error('Test achievement not created');
        testAchievementId = ach.id;

        // Add criteria: PlayerStat.matchesPlayed >= 1
        await admin.call.addAchievementCriteria({
            achievementId: testAchievementId,
            statTable: 'PlayerStat',
            statField: 'matchesPlayed',
            operator: { tag: 'GreaterOrEqual' },
            thresholdValue: 1,
            filterGameMode: undefined,
            filterCharacterName: undefined,
            filterMatchType: undefined,
        });
        await admin.sync(1500);
    }, 60000);

    afterAll(async () => {
        // Clean up the test achievement
        try {
            await admin.call.deleteAchievement({ achievementId: testAchievementId });
            await admin.sync(500);
        } catch (_) { /* may already be deleted */ }

        await admin?.disconnect();
        await host?.disconnect();
        await blue?.disconnect();
        await red?.disconnect();
    });

    it('finalization auto-awards achievement when criteria met', async () => {
        // Verify no UserAchievement exists yet for this achievement
        const awardsBefore = [...admin.conn.db.UserAchievement.iter()].filter(
            ua => ua.achievementId === testAchievementId
        );
        expect(awardsBefore.length).toBe(0);

        // ── Run a full Casual match lifecycle (auto-finalizes on submit) ──

        // 1. Create lobby
        await host.call.createLobby(defaultLobbyArgs());
        await host.sync(1500);
        const lobbies = [...host.conn.db.Lobby.iter()].filter(l => l.hostUserId === host.userId);
        const lobbyId = lobbies[lobbies.length - 1].id;

        // 2. Players join + set slots
        await blue.call.joinLobby({ lobbyId, joinCode: '', password: '' });
        await blue.sync();
        await blue.call.setTeamSlot({
            lobbyId, targetUserId: blue.userId,
            lobbySlot: { tag: 'BluePlayer' as const },
        });
        await blue.sync();

        await red.call.joinLobby({ lobbyId, joinCode: '', password: '' });
        await red.sync();
        await red.call.setTeamSlot({
            lobbyId, targetUserId: red.userId,
            lobbySlot: { tag: 'RedPlayer' as const },
        });
        await red.sync();

        // 3. Confirm ready + start draft
        await blue.call.confirmReady({ lobbyId });
        await blue.sync();
        await red.call.confirmReady({ lobbyId });
        await red.sync();
        await host.sync();
        await host.call.startDraft({ lobbyId });
        await host.sync(1500);
        await blue.sync(1500);
        await red.sync(1500);

        // 4. Complete draft (16 picks, no bans)
        await completeDraft(blue, red, lobbyId);
        await host.sync(1500);

        // 5. Confirm lineups + advance to scoring
        await blue.call.confirmLineup({ lobbyId });
        await blue.sync();
        await red.call.confirmLineup({ lobbyId });
        await red.sync();
        await host.call.advanceStage({ lobbyId });
        await host.sync(1500);
        await blue.sync(1500);
        await red.sync(1500);

        // 6. Record scores + confirm both sides
        const mr = [...host.conn.db.MatchResultRecord.iter()].find(r => r.lobbyId === lobbyId);
        expect(mr).toBeDefined();

        await host.call.recordGameScores(gameScoreArgs({
            matchResultId: mr!.id,
            gameNumber: 1,
            winnerTeamSide: 'Blue',
            teamBlueCyclesUsed: 7,
            teamRedCyclesUsed: 10,
        }));
        await host.sync(1000);

        await blue.call.confirmMatchScores({ matchResultId: mr!.id });
        await blue.sync(500);
        await red.call.confirmMatchScores({ matchResultId: mr!.id });
        await red.sync(500);
        await host.sync(1000);

        // 7. Submit → Casual auto-validates + auto-finalizes
        //    This triggers finalization step 16.5: checkAndAwardAchievements
        await host.call.submitMatchResult({
            matchResultId: mr!.id,
            winnerId: blue.userId,
        });
        await host.sync(2500);
        await blue.sync(2500);
        await red.sync(2500);
        await admin.sync(2500);

        // 8. Verify UserAchievement rows auto-inserted
        const awardsAfter = [...admin.conn.db.UserAchievement.iter()].filter(
            ua => ua.achievementId === testAchievementId
        );

        // Both participants should have been awarded (matchesPlayed >= 1 for both)
        const blueAward = awardsAfter.find(ua => ua.userId === blue.userId);
        const redAward = awardsAfter.find(ua => ua.userId === red.userId);

        expect(blueAward).toBeDefined();
        expect(redAward).toBeDefined();
    }, 180000);
});
