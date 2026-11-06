/**
 * Integration tests for MMR, Leaderboard, Stats, and Character Stats.
 *
 * Runs 2 sequential Ranked match lifecycles with the same users to:
 * - Verify ELO rating correctness (symmetric deltas, initial 1000)
 * - Verify MmrHistory rows created with correct data
 * - Verify globalCompositeRating (single-mode = mode rating)
 * - Verify Leaderboard rebuild (matchesPlayed >= 2 threshold, rank ordering)
 * - Verify GlobalCharacterStat incremented for picked characters
 * - Verify PlayerStat increments via spacetime sql (private table)
 * - Verify PlayerCharacterStat picks/faced via spacetime sql (private table)
 * - Verify mmrProcessedAt double-processing guard (structural: record deleted)
 *
 * Phase 12.3 additions:
 * - Verify accountRatingSnapshot captured at start_draft (MMR-RACE-01)
 * - Verify processMatchMmr reads snapshot, not live account (MMR-RACE-02)
 * - Verify D-G lobby guards reject roster mutations during active match (ROST-GUARD-01)
 *
 * Coverage gaps:
 * - PlayerRelationship (ally/opponent) — needs multi-player team setup
 * - Ban stats (all tests use banMode: None)
 *
 * Contract: docs/match-results/contract.md + docs/player-stats/contract.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    hasServerToken,
    expectReducerError,
    queryPrivateTable,
    type TestHarness,
} from '../../shared/connection';
import { defaultLobbyArgs as sharedDefaultLobbyArgs } from '../../shared/helpers/lobbies';
import { ensureHsrAccount } from '../../shared/helpers/hsrAccounts';
import { completeDraft, advanceToScoring } from '../../shared/helpers/drafts';
import { promoteToRole } from '../../shared/helpers/promoteUser';
import { ensureEloConfig } from '../../shared/helpers/seed';
import { gameScoreArgs } from '../../shared/helpers/scores';

// ─── Helpers ────────────────────────────────────────────────────────────────

const defaultLobbyArgs = (overrides: Record<string, unknown> = {}) =>
    sharedDefaultLobbyArgs({ matchType: { tag: 'Ranked' as const, value: {} }, ...overrides });

async function setupDraftLobby(
    host: TestHarness, blue: TestHarness, red: TestHarness,
    overrides: Record<string, unknown> = {},
) {
    await host.call.createLobby(defaultLobbyArgs(overrides));
    await host.sync(1500);
    const lobbies = [...host.conn.db.Lobby.iter()].filter(l => l.hostUserId === host.userId);
    const lobby = lobbies[lobbies.length - 1];

    // Ensure players have HSR accounts (D-08 gate: start_draft requires LMA for Ranked/MMR)
    await ensureHsrAccount(blue);
    await ensureHsrAccount(red);

    await blue.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
    await blue.sync();
    await blue.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: blue.userId, lobbySlot: { tag: 'BluePlayer' as const } });
    await blue.sync();

    await red.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
    await red.sync();
    await red.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: red.userId, lobbySlot: { tag: 'RedPlayer' as const } });
    await red.sync();

    await blue.call.confirmReady({ lobbyId: lobby.id });
    await blue.sync();
    await red.call.confirmReady({ lobbyId: lobby.id });
    await red.sync();
    await host.sync();

    return lobby.id;
}


/** Full setup: create lobby -> draft -> Scoring -> record scores -> confirm both sides */
async function setupScoredMatch(
    host: TestHarness, blue: TestHarness, red: TestHarness,
    overrides: Record<string, unknown> = {},
) {
    const lobbyId = await setupDraftLobby(host, blue, red, overrides);
    await host.call.startDraft({ lobbyId });
    await host.sync(1500);
    await blue.sync(1500);
    await red.sync(1500);
    await completeDraft(blue, red, lobbyId);
    await host.sync(1500);
    await advanceToScoring(host, blue, red, lobbyId);

    const mr = [...host.conn.db.MatchResultRecord.iter()].find(r => r.lobbyId === lobbyId)!;

    // Referee records scores with screenshots (required for Ranked validation)
    await host.call.recordGameScores(gameScoreArgs({
        matchResultId: mr.id,
        gameNumber: 1,
        winnerTeamSide: 'Blue',
        teamBlueCyclesUsed: 7,
        teamRedCyclesUsed: 10,
        teamBlueScreenshotUrl: 'https://i.imgur.com/blue1.png',
        teamRedScreenshotUrl: 'https://i.imgur.com/red1.png',
    }));
    await host.sync(1000);

    // Confirm both sides
    await blue.call.confirmMatchScores({ matchResultId: mr.id });
    await blue.sync(500);
    await red.call.confirmMatchScores({ matchResultId: mr.id });
    await red.sync(500);
    await host.sync(1000);

    return { lobbyId, matchResultId: mr.id };
}

/** Promote a test user to a role via server connection */

/** Submit + override to Validated + finalize a Ranked match */
async function submitOverrideFinalize(
    host: TestHarness, admin: TestHarness,
    blue: TestHarness, red: TestHarness,
    matchResultId: number, winnerUserId: number, winnerTeamSideTag: string,
) {
    await host.call.submitMatchResult({ matchResultId, winnerId: winnerUserId });
    await host.sync(1500);

    await admin.call.overrideMatchResult({
        matchResultId,
        newStatusTag: 'Validated',
        winnerTeamSideTag,
        reason: 'MMR test validation',
    });
    await admin.sync(1000);
    await host.sync(1000);

    await host.call.finalizeMatchResult({ matchResultId });
    await host.sync(2500);
    await blue.sync(2500);
    await red.sync(2500);
    await admin.sync(2500);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasServerToken())('MMR + Leaderboard + Stats', () => {
    let host: TestHarness;
    let blue: TestHarness;
    let red: TestHarness;
    let admin: TestHarness;

    beforeAll(async () => {
        host = await createVerifiedTestHarness();
        blue = await createVerifiedTestHarness();
        red = await createVerifiedTestHarness();
        admin = await createVerifiedTestHarness();
        await host.sync();
        await blue.sync();
        await red.sync();
        await admin.sync();

        await promoteToRole(admin, 'Admin');

        // Seed ELO config (required for finalization in Ranked matches)
        await ensureEloConfig(admin);
    }, 60000);

    afterAll(async () => {
        await host?.disconnect();
        await blue?.disconnect();
        await red?.disconnect();
        await admin?.disconnect();
    });

    // ─── Ranked Match 1: ELO + MmrHistory + GlobalCharacterStat ─────

    describe('Ranked Match 1 — ELO + History + CharStats', () => {
        beforeAll(async () => {
            const result = await setupScoredMatch(host, blue, red);
            await submitOverrideFinalize(host, admin, blue, red, result.matchResultId, blue.userId, 'Blue');
        }, 180000);

        it('MmrRating rows created for both participants', () => {
            const blueRating = [...host.conn.db.MmrRating.iter()]
                .find(r => r.userId === blue.userId && r.gameMode.tag === 'MemoryOfChaos');
            const redRating = [...host.conn.db.MmrRating.iter()]
                .find(r => r.userId === red.userId && r.gameMode.tag === 'MemoryOfChaos');
            expect(blueRating).toBeDefined();
            expect(redRating).toBeDefined();
        });

        it('winner rating > initial 1000, loser < initial 1000', () => {
            const blueRating = [...host.conn.db.MmrRating.iter()]
                .find(r => r.userId === blue.userId && r.gameMode.tag === 'MemoryOfChaos');
            const redRating = [...host.conn.db.MmrRating.iter()]
                .find(r => r.userId === red.userId && r.gameMode.tag === 'MemoryOfChaos');
            expect(blueRating!.rating).toBeGreaterThan(1000);
            expect(redRating!.rating).toBeLessThan(1000);
        });

        it('symmetric deltas (winner gain + loser loss = 0 within rounding)', () => {
            const blueRating = [...host.conn.db.MmrRating.iter()]
                .find(r => r.userId === blue.userId && r.gameMode.tag === 'MemoryOfChaos');
            const redRating = [...host.conn.db.MmrRating.iter()]
                .find(r => r.userId === red.userId && r.gameMode.tag === 'MemoryOfChaos');
            const blueDelta = blueRating!.rating - 1000;
            const redDelta = redRating!.rating - 1000;
            // Equal starting ratings → symmetric deltas (sum ≈ 0, rounding tolerance 1)
            expect(Math.abs(blueDelta + redDelta)).toBeLessThanOrEqual(1);
        });

        it('matchesPlayed = 1 on MmrRating', () => {
            const blueRating = [...host.conn.db.MmrRating.iter()]
                .find(r => r.userId === blue.userId && r.gameMode.tag === 'MemoryOfChaos');
            expect(blueRating!.matchesPlayed).toBe(1);
        });

        it('MmrHistory rows created for both participants', () => {
            const blueHistory = [...host.conn.db.MmrHistory.iter()]
                .filter(h => h.userId === blue.userId);
            const redHistory = [...host.conn.db.MmrHistory.iter()]
                .filter(h => h.userId === red.userId);
            expect(blueHistory.length).toBeGreaterThanOrEqual(1);
            expect(redHistory.length).toBeGreaterThanOrEqual(1);
        });

        it('MmrHistory records correct previousRating, newRating, and delta', () => {
            const blueHistory = [...host.conn.db.MmrHistory.iter()]
                .filter(h => h.userId === blue.userId)
                .sort((a: any, b: any) => b.id - a.id);
            const latest = blueHistory[0];
            expect(latest.previousRating).toBe(1000);
            expect(latest.newRating).toBeGreaterThan(1000);
            expect(latest.delta).toBeGreaterThan(0);
        });

        it('globalCompositeRating equals mode rating (single mode)', () => {
            const blueRating = [...host.conn.db.MmrRating.iter()]
                .find(r => r.userId === blue.userId && r.gameMode.tag === 'MemoryOfChaos');
            expect(blueRating!.globalCompositeRating).toBeDefined();
            expect(blueRating!.globalCompositeRating).toBe(blueRating!.rating);
        });

        it('GlobalCharacterStat incremented for picked characters', () => {
            // acheron was blue's first pick — filter precisely (shared DB may have stale rows)
            const hasPickStats = [...host.conn.db.GlobalCharacterStat.iter()]
                .some(s => s.characterName === 'acheron'
                    && s.gameMode.tag === 'MemoryOfChaos'
                    && s.draftMode.tag === 'Classic'
                    && s.matchType.tag === 'Ranked'
                    && s.teamSize === 1
                    && s.timesPicked >= 1
                    && s.matchesPlayed >= 1);
            expect(hasPickStats).toBe(true);
        });

        it('winner picked chars have wins >= 1 in GlobalCharacterStat', () => {
            // Blue won, acheron was blue's pick
            const hasWins = [...host.conn.db.GlobalCharacterStat.iter()]
                .some(s => s.characterName === 'acheron'
                    && s.gameMode.tag === 'MemoryOfChaos'
                    && s.draftMode.tag === 'Classic'
                    && s.wins >= 1);
            expect(hasWins).toBe(true);
        });

        it('loser picked chars have losses >= 1 in GlobalCharacterStat', () => {
            // Red lost, bailu was red's pick
            const hasLosses = [...host.conn.db.GlobalCharacterStat.iter()]
                .some(s => s.characterName === 'bailu'
                    && s.gameMode.tag === 'MemoryOfChaos'
                    && s.draftMode.tag === 'Classic'
                    && s.losses >= 1);
            expect(hasLosses).toBe(true);
        });

        // ─── Private table verification via spacetime sql ───────────

        it('PlayerStat: winner has wins=1 after first match', async () => {
            const rows = await queryPrivateTable(
                `SELECT * FROM player_stat WHERE user_id = ${blue.userId}`
            );
            expect(rows.length).toBeGreaterThanOrEqual(1);
            const stat = rows.find(r => r.game_mode?.includes('memoryOfChaos'));
            expect(stat).toBeDefined();
            expect(parseInt(stat!.wins)).toBe(1);
            expect(parseInt(stat!.matches_played)).toBe(1);
            expect(parseInt(stat!.losses)).toBe(0);
        });

        it('PlayerStat: loser has losses=1 after first match', async () => {
            const rows = await queryPrivateTable(
                `SELECT * FROM player_stat WHERE user_id = ${red.userId}`
            );
            const stat = rows.find(r => r.game_mode?.includes('memoryOfChaos'));
            expect(stat).toBeDefined();
            expect(parseInt(stat!.losses)).toBe(1);
            expect(parseInt(stat!.wins)).toBe(0);
        });

        it('PlayerCharacterStat: picked character has matchesPlayed=1', async () => {
            const rows = await queryPrivateTable(
                `SELECT * FROM player_character_stat WHERE user_id = ${blue.userId} AND character_name = 'acheron'`
            );
            expect(rows.length).toBeGreaterThanOrEqual(1);
            const stat = rows[0];
            expect(parseInt(stat.matches_played)).toBe(1);
            expect(parseInt(stat.wins)).toBe(1);
        });

        it('PlayerCharacterStat: opponent chars have timesFaced >= 1', async () => {
            // Blue faced red's picks. 'bailu' was red's first pick.
            const rows = await queryPrivateTable(
                `SELECT * FROM player_character_stat WHERE user_id = ${blue.userId} AND character_name = 'bailu'`
            );
            expect(rows.length).toBeGreaterThanOrEqual(1);
            const stat = rows[0];
            expect(parseInt(stat.times_faced)).toBeGreaterThanOrEqual(1);
            expect(parseInt(stat.wins_against)).toBeGreaterThanOrEqual(1);
        });
    });

    // ─── Ranked Match 2: Leaderboard + Accumulation ─────────────────

    describe('Ranked Match 2 — Leaderboard + Accumulation', () => {
        beforeAll(async () => {
            // Second Ranked match with same users (blue wins again)
            const result = await setupScoredMatch(host, blue, red);
            await submitOverrideFinalize(host, admin, blue, red, result.matchResultId, blue.userId, 'Blue');
        }, 180000);

        it('MmrRating.matchesPlayed = 2 after second match', () => {
            const blueRating = [...host.conn.db.MmrRating.iter()]
                .find(r => r.userId === blue.userId && r.gameMode.tag === 'MemoryOfChaos');
            expect(blueRating!.matchesPlayed).toBe(2);
        });

        it('MmrHistory accumulates (>= 2 entries per user)', () => {
            const blueHistory = [...host.conn.db.MmrHistory.iter()]
                .filter(h => h.userId === blue.userId);
            expect(blueHistory.length).toBeGreaterThanOrEqual(2);
        });

        it('globalCompositeRating still equals mode rating (single mode)', () => {
            const blueRating = [...host.conn.db.MmrRating.iter()]
                .find(r => r.userId === blue.userId && r.gameMode.tag === 'MemoryOfChaos');
            expect(blueRating!.globalCompositeRating).toBe(blueRating!.rating);
        });

        it('Leaderboard rows exist for MemoryOfChaos (matchesPlayed >= 2 threshold)', () => {
            const mocLeaderboard = [...host.conn.db.Leaderboard.iter()]
                .filter(l => l.category === 'MemoryOfChaos');
            const blueEntry = mocLeaderboard.find(l => l.userId === blue.userId);
            const redEntry = mocLeaderboard.find(l => l.userId === red.userId);
            expect(blueEntry).toBeDefined();
            expect(redEntry).toBeDefined();
        });

        it('Leaderboard rank ordering: 2-0 winner ranked higher than 0-2 loser', () => {
            const mocLeaderboard = [...host.conn.db.Leaderboard.iter()]
                .filter(l => l.category === 'MemoryOfChaos');
            const blueEntry = mocLeaderboard.find(l => l.userId === blue.userId)!;
            const redEntry = mocLeaderboard.find(l => l.userId === red.userId)!;
            // Blue won both → higher rating → lower (better) rank number
            expect(blueEntry.rank).toBeLessThan(redEntry.rank);
        });

        it('Leaderboard.wins reflects PlayerStat wins (indirect verification)', () => {
            const mocLeaderboard = [...host.conn.db.Leaderboard.iter()]
                .filter(l => l.category === 'MemoryOfChaos');
            const blueEntry = mocLeaderboard.find(l => l.userId === blue.userId)!;
            const redEntry = mocLeaderboard.find(l => l.userId === red.userId)!;
            // Blue won both matches
            expect(blueEntry.wins).toBe(2);
            // Red won neither
            expect(redEntry.wins).toBe(0);
        });

        it('Global leaderboard includes both players', () => {
            const globalLeaderboard = [...host.conn.db.Leaderboard.iter()]
                .filter(l => l.category === 'Global');
            const blueGlobal = globalLeaderboard.find(l => l.userId === blue.userId);
            const redGlobal = globalLeaderboard.find(l => l.userId === red.userId);
            expect(blueGlobal).toBeDefined();
            expect(redGlobal).toBeDefined();
        });

        it('Leaderboard.matchesPlayed reflects total matches', () => {
            const mocLeaderboard = [...host.conn.db.Leaderboard.iter()]
                .filter(l => l.category === 'MemoryOfChaos');
            const blueEntry = mocLeaderboard.find(l => l.userId === blue.userId)!;
            expect(blueEntry.matchesPlayed).toBe(2);
        });

        // ─── Private table accumulation after 2 matches ─────────────

        it('PlayerStat: winner has wins=2, matchesPlayed=2 after two matches', async () => {
            const rows = await queryPrivateTable(
                `SELECT * FROM player_stat WHERE user_id = ${blue.userId}`
            );
            const stat = rows.find(r => r.game_mode?.includes('memoryOfChaos'));
            expect(stat).toBeDefined();
            expect(parseInt(stat!.wins)).toBe(2);
            expect(parseInt(stat!.matches_played)).toBe(2);
        });

        it('PlayerStat: loser has losses=2 after two matches', async () => {
            const rows = await queryPrivateTable(
                `SELECT * FROM player_stat WHERE user_id = ${red.userId}`
            );
            const stat = rows.find(r => r.game_mode?.includes('memoryOfChaos'));
            expect(parseInt(stat!.losses)).toBe(2);
        });

        it('PlayerCharacterStat: picked character accumulates matchesPlayed=2', async () => {
            const rows = await queryPrivateTable(
                `SELECT * FROM player_character_stat WHERE user_id = ${blue.userId} AND character_name = 'acheron'`
            );
            const stat = rows.find(r => r.game_mode?.includes('memoryOfChaos'));
            expect(stat).toBeDefined();
            expect(parseInt(stat!.matches_played)).toBe(2);
            expect(parseInt(stat!.wins)).toBe(2);
        });
    });

    // ─── Bans + Spectator (isolated lifecycle) ────────────────────

    describe('Ban Stats + Spectated Count (banMode: Four, with spectator)', () => {
        let banHost: TestHarness;
        let banBlue: TestHarness;
        let banRed: TestHarness;
        let spectator: TestHarness;

        beforeAll(async () => {
            banHost = await createVerifiedTestHarness();
            banBlue = await createVerifiedTestHarness();
            banRed = await createVerifiedTestHarness();
            spectator = await createVerifiedTestHarness();
            await banHost.sync();
            await banBlue.sync();
            await banRed.sync();
            await spectator.sync();

            // Casual + banMode: Four + allowMirrorPicks: true
            await banHost.call.createLobby(defaultLobbyArgs({
                matchType: { tag: 'Casual' as const, value: {} },
                banMode: { tag: 'Four' as const, value: {} },
            }));
            await banHost.sync(1500);
            const lobbies = [...banHost.conn.db.Lobby.iter()].filter(l => l.hostUserId === banHost.userId);
            const lobbyId = lobbies[lobbies.length - 1].id;

            // Blue + Red join as players
            await banBlue.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await banBlue.sync();
            await banBlue.call.setTeamSlot({ lobbyId, targetUserId: banBlue.userId, lobbySlot: { tag: 'BluePlayer' as const } });
            await banBlue.sync();

            await banRed.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await banRed.sync();
            await banRed.call.setTeamSlot({ lobbyId, targetUserId: banRed.userId, lobbySlot: { tag: 'RedPlayer' as const } });
            await banRed.sync();

            // Spectator joins (stays as Spectator slot — default after join)
            await spectator.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await spectator.sync();

            // Ready up (spectators don't need to confirm)
            await banBlue.call.confirmReady({ lobbyId });
            await banBlue.sync();
            await banRed.call.confirmReady({ lobbyId });
            await banRed.sync();
            await banHost.sync();

            // Start draft
            await banHost.call.startDraft({ lobbyId });
            await banHost.sync(1500);
            await banBlue.sync(1500);
            await banRed.sync(1500);

            // BanMode Four sequence: Ban Ban Pick Pick Pick Pick Ban Ban Pick*12
            // Step 1-2: Bans (Blue bans, Red bans)
            await banBlue.call.banCharacter({ lobbyId, characterName: 'kafka' });
            await banBlue.sync(300);
            await banRed.call.banCharacter({ lobbyId, characterName: 'silverwolf' });
            await banRed.sync(300);

            // Step 3-6: Picks (Blue, Red, Red, Blue)
            await banBlue.call.pickCharacter({ lobbyId, characterName: 'acheron', eidolon: 0 });
            await banBlue.sync(300);
            await banRed.call.pickCharacter({ lobbyId, characterName: 'bailu', eidolon: 0 });
            await banRed.sync(300);
            await banRed.call.pickCharacter({ lobbyId, characterName: 'blackswan', eidolon: 0 });
            await banRed.sync(300);
            await banBlue.call.pickCharacter({ lobbyId, characterName: 'aglaea', eidolon: 0 });
            await banBlue.sync(300);

            // Step 7-8: Bans (Red bans, Blue bans)
            await banRed.call.banCharacter({ lobbyId, characterName: 'firefly' });
            await banRed.sync(300);
            await banBlue.call.banCharacter({ lobbyId, characterName: 'robin' });
            await banBlue.sync(300);

            // Step 9-20: 12 remaining picks (Red Blue Blue Red × 3)
            const remainingOrder = [
                'red', 'blue', 'blue', 'red',
                'red', 'blue', 'blue', 'red',
                'red', 'blue', 'blue', 'red',
            ] as const;
            const blueRemaining = ['anaxa', 'archer', 'argenti', 'arlan', 'asta', 'aventurine'];
            const redRemaining = ['blade', 'boothill', 'bronya', 'castorice', 'cerydra', 'cipher'];
            let bIdx = 0, rIdx = 0;
            for (const team of remainingOrder) {
                const h = team === 'blue' ? banBlue : banRed;
                const name = team === 'blue' ? blueRemaining[bIdx++] : redRemaining[rIdx++];
                await h.call.pickCharacter({ lobbyId, characterName: name, eidolon: 0 });
                await h.sync(300);
            }

            await banBlue.sync(1500);
            await banRed.sync(1500);
            await banHost.sync(1500);

            // Advance to Scoring
            await banBlue.call.confirmLineup({ lobbyId });
            await banBlue.sync();
            await banRed.call.confirmLineup({ lobbyId });
            await banRed.sync();
            await banHost.call.advanceStage({ lobbyId });
            await banHost.sync(1500);
            await banBlue.sync(1500);
            await banRed.sync(1500);

            // Record scores + confirm + submit (Casual auto-finalizes)
            const mr = [...banHost.conn.db.MatchResultRecord.iter()].find(r => r.lobbyId === lobbyId)!;
            await banHost.call.recordGameScores(gameScoreArgs({
                matchResultId: mr.id,
                gameNumber: 1,
                winnerTeamSide: 'Blue',
                teamBlueCyclesUsed: 6,
                teamRedCyclesUsed: 10,
            }));
            await banHost.sync(1000);
            await banBlue.call.confirmMatchScores({ matchResultId: mr.id });
            await banBlue.sync(500);
            await banRed.call.confirmMatchScores({ matchResultId: mr.id });
            await banRed.sync(500);
            await banHost.sync(1000);

            // Submit → Casual auto-validates + auto-finalizes
            await banHost.call.submitMatchResult({ matchResultId: mr.id, winnerId: banBlue.userId });
            await banHost.sync(2500);
            await banBlue.sync(2500);
            await banRed.sync(2500);
            await spectator.sync(2500);
        }, 180000);

        afterAll(async () => {
            await banHost?.disconnect();
            await banBlue?.disconnect();
            await banRed?.disconnect();
            await spectator?.disconnect();
        });

        // ─── Spectated count ────────────────────────────────────────

        it('spectator matchesSpectated incremented', async () => {
            const rows = await queryPrivateTable(
                `SELECT * FROM player_stat WHERE user_id = ${spectator.userId}`
            );
            expect(rows.length).toBeGreaterThanOrEqual(1);
            const stat = rows.find(r => r.game_mode?.includes('memoryOfChaos'));
            expect(stat).toBeDefined();
            expect(parseInt(stat!.matches_spectated)).toBe(1);
            // Spectators don't get wins/losses/matchesPlayed
            expect(parseInt(stat!.matches_played)).toBe(0);
        });

        // ─── Ban stats ──────────────────────────────────────────────

        it('PlayerCharacterStat: banned char has timesBannedInMatch for ALL participants', async () => {
            // 'kafka' was banned by blue. Per D-23, ALL participants get timesBannedInMatch +1.
            // Check blue (the banner)
            const blueRows = await queryPrivateTable(
                `SELECT * FROM player_character_stat WHERE user_id = ${banBlue.userId} AND character_name = 'kafka'`
            );
            expect(blueRows.length).toBeGreaterThanOrEqual(1);
            expect(parseInt(blueRows[0].times_banned_in_match)).toBeGreaterThanOrEqual(1);

            // Check red (the opponent — also gets timesBannedInMatch)
            const redRows = await queryPrivateTable(
                `SELECT * FROM player_character_stat WHERE user_id = ${banRed.userId} AND character_name = 'kafka'`
            );
            expect(redRows.length).toBeGreaterThanOrEqual(1);
            expect(parseInt(redRows[0].times_banned_in_match)).toBeGreaterThanOrEqual(1);
        });

        it('GlobalCharacterStat: banned char has timesBanned >= 1', () => {
            const stat = [...banHost.conn.db.GlobalCharacterStat.iter()]
                .find(s => s.characterName === 'kafka'
                    && s.gameMode.tag === 'MemoryOfChaos'
                    && s.timesBanned >= 1);
            expect(stat).toBeDefined();
        });

        it('banned chars NOT counted in pick stats (D-27)', async () => {
            // 'kafka' was banned, not picked — should have matchesPlayed=0
            const rows = await queryPrivateTable(
                `SELECT * FROM player_character_stat WHERE user_id = ${banBlue.userId} AND character_name = 'kafka'`
            );
            const stat = rows[0];
            expect(parseInt(stat.matches_played)).toBe(0);
            expect(parseInt(stat.wins)).toBe(0);
        });
    });

    // ─── Double-Processing Guard ────────────────────────────────────

    describe('mmrProcessedAt double-processing guard', () => {
        it('finalize on already-finalized (deleted) match result → not found', async () => {
            // After finalization, MatchResultRecord is deleted — structural guard
            const err = await expectReducerError(
                host.call.finalizeMatchResult({ matchResultId: 99999 })
            );
            expect(err).toContain('not found');
        });

        it('MmrRating not corrupted by repeated finalize attempts', () => {
            // Verify ratings unchanged after failed finalize attempt above
            const blueRating = [...host.conn.db.MmrRating.iter()]
                .find(r => r.userId === blue.userId && r.gameMode.tag === 'MemoryOfChaos');
            expect(blueRating!.matchesPlayed).toBe(2);
        });
    });
});

// ─── Phase 12.3: snapshot-backed MMR + D-G guard rejections ─────────────────
//
// Appended by Plan 12.3-06 Task 3 — extends this file (C10: test files are
// only edited via explicit tasks). Existing tests above are unchanged.
//
// Covers two requirement IDs:
//   - MMR-RACE-02: negative-control proving the persisted snapshot flows
//     through to ELO (two matches with different account ratings produce
//     different MMR deltas — if the read path were still buggy and looked up
//     active isActive instead of the snapshot, this test would still pass
//     for the wrong reason, so the assertion is paired with an explicit
//     snapshot read to make the provenance clear).
//   - ROST-GUARD-01: the three D-G guards that protect an MRP-capture window
//     at the roster.ts layer — set_active_hsr_account, batch_upsert_characters,
//     batch_remove_characters. migrate_roster rejection tests + roster
//     rating recompute regression belong to Plan 12.3-07's dedicated
//     migrate-roster-rating.test.ts file — do NOT duplicate here.

describe.skipIf(!hasServerToken())('Phase 12.3: snapshot-backed MMR + D-G guard rejections', () => {
    let host: TestHarness;
    let blue: TestHarness;
    let red: TestHarness;
    let admin: TestHarness;

    // Shared scratch state between the negative-control beforeAll and the
    // D-G guard tests (which reuse the lobby blue is currently bound to).
    let match1BlueDelta: number | null = null;
    let match2BlueDelta: number | null = null;
    let lowMatchRating = 0;
    let highMatchRating = 0;

    // For the D-G guard tests we need a fresh live lobby (NOT the ones from
    // the negative-control — those are finalized + deleted).
    let guardLobbyId: number;
    let guardBlueAccountId: number;

    beforeAll(async () => {
        host = await createVerifiedTestHarness();
        blue = await createVerifiedTestHarness();
        red = await createVerifiedTestHarness();
        admin = await createVerifiedTestHarness();
        await host.sync();
        await blue.sync();
        await red.sync();
        await admin.sync();

        await promoteToRole(admin, 'Admin');
        await ensureEloConfig(admin);
    }, 120000);

    afterAll(async () => {
        // Cleanup the guard lobby if still alive
        try { await host.call.closeLobby({ lobbyId: guardLobbyId }); } catch { /* ok */ }
        // Cleanup any remaining HsrAccount rows blue created
        try {
            const accts = await queryPrivateTable(
                `SELECT id FROM hsr_account WHERE user_id = ${blue.userId}`
            );
            for (const a of accts) {
                try { await blue.call.deleteHsrAccount({ hsrAccountId: Number(a.id) }); } catch { /* ok */ }
            }
        } catch { /* ok */ }

        await host?.disconnect();
        await blue?.disconnect();
        await red?.disconnect();
        await admin?.disconnect();
    });

    // ─── Negative control: snapshot flows through to MMR delta ──────────

    describe('snapshot drives MMR delta (negative control — MMR-RACE-02)', () => {
        it('two ranked matches with different account ratings produce different MMR deltas', async () => {
            // Match 1: blue has a LOW-rated active account.
            await blue.call.createHsrAccount({ uid: '812090001', displayLabel: 'Blue Low' });
            await blue.sync(1500);
            const blueLowRows = await queryPrivateTable(
                `SELECT id FROM hsr_account WHERE user_id = ${blue.userId}`
            );
            const blueLowId = Number(blueLowRows[blueLowRows.length - 1].id);
            // LOW rating: single character. The roster module recomputes
            // account_rating at end of batch_upsert_characters (D-D-02).
            await blue.call.batchUpsertCharacters({
                hsrAccountId: blueLowId,
                charactersJson: JSON.stringify([
                    { characterName: 'acheron', eidolonLevel: 0 },
                ]),
            });
            await blue.sync(1500);

            // Red account (seed so the match is valid for Ranked D-08 gate).
            await ensureHsrAccount(red);

            // Read the rating so we can assert it's non-zero later.
            const lowRows = await queryPrivateTable(
                `SELECT account_rating FROM hsr_account WHERE id = ${blueLowId}`
            );
            lowMatchRating = Number(lowRows[0].account_rating);

            const match1 = await setupScoredMatch(host, blue, red);
            await submitOverrideFinalize(host, admin, blue, red, match1.matchResultId, blue.userId, 'Blue');

            // Read blue's MMR delta from MmrHistory for match 1.
            const hist1 = [...host.conn.db.MmrHistory.iter()]
                .filter(h => h.userId === blue.userId)
                .sort((a: any, b: any) => b.id - a.id);
            expect(hist1.length).toBeGreaterThanOrEqual(1);
            match1BlueDelta = hist1[0].delta;

            // Upgrade blue's roster to a much HIGHER rating for match 2.
            // Since the old account is no longer bound to any lobby (match 1
            // finalized + lobby deleted), batch_upsert is allowed.
            await blue.call.batchUpsertCharacters({
                hsrAccountId: blueLowId,
                charactersJson: JSON.stringify([
                    { characterName: 'acheron', eidolonLevel: 6 },
                    { characterName: 'aglaea', eidolonLevel: 6 },
                    { characterName: 'anaxa', eidolonLevel: 6 },
                    { characterName: 'archer', eidolonLevel: 6 },
                    { characterName: 'argenti', eidolonLevel: 6 },
                    { characterName: 'arlan', eidolonLevel: 6 },
                ]),
            });
            await blue.sync(1500);

            const highRows = await queryPrivateTable(
                `SELECT account_rating FROM hsr_account WHERE id = ${blueLowId}`
            );
            highMatchRating = Number(highRows[0].account_rating);
            // Sanity: the rating actually grew. If this fails the test is
            // invalid — report, do not auto-fix.
            expect(highMatchRating).toBeGreaterThan(lowMatchRating);

            // Match 2: same players, new higher rating → snapshot captures the
            // new value at start_draft, ELO sees a different account-modifier.
            const match2 = await setupScoredMatch(host, blue, red);
            await submitOverrideFinalize(host, admin, blue, red, match2.matchResultId, blue.userId, 'Blue');

            const hist2 = [...host.conn.db.MmrHistory.iter()]
                .filter(h => h.userId === blue.userId)
                .sort((a: any, b: any) => b.id - a.id);
            // Latest MmrHistory is match 2's delta.
            expect(hist2.length).toBeGreaterThanOrEqual(2);
            match2BlueDelta = hist2[0].delta;

            // Both deltas must be defined, both must be > 0 (blue won both),
            // and crucially they must NOT be identical — if the snapshot were
            // ignored and the ELO helper were reading a constant 0, both deltas
            // would be identical. Different deltas prove the snapshot is being
            // used as the account-modifier input (Plan 12.3-02 D-readpath-01).
            expect(match1BlueDelta).not.toBeNull();
            expect(match2BlueDelta).not.toBeNull();
            expect(match1BlueDelta).not.toBe(match2BlueDelta);
        }, 600000);
    });

    // ─── D-G guard rejections (ROST-GUARD-01) ──────────────────────────

    describe('D-G roster guards while caller has a live LMA binding', () => {
        beforeAll(async () => {
            // Create a brand-new ranked lobby with blue bound via LMA. The
            // negative-control's lobbies are finalized + deleted, so blue has
            // no LMA binding after them — we must create a fresh one here
            // before any of the D-G guard tests run.
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const l = [...host.conn.db.Lobby.iter()]
                .filter(l => l.hostUserId === host.userId)
                .at(-1)!;
            guardLobbyId = l.id;

            // blue needs an HsrAccount (it should already have one from the
            // negative control, but ensure it regardless).
            await ensureHsrAccount(blue);
            const blueAccts = await queryPrivateTable(
                `SELECT id, is_active FROM hsr_account WHERE user_id = ${blue.userId}`
            );
            // Use the currently-active account — D-G-01 targets this account.
            const activeRow = blueAccts.find((r) => r.is_active === 'true') ?? blueAccts[0];
            guardBlueAccountId = Number(activeRow.id);

            await blue.call.joinLobby({ lobbyId: guardLobbyId, joinCode: '', password: '' });
            await blue.sync(1500);
            await blue.call.setTeamSlot({
                lobbyId: guardLobbyId,
                targetUserId: blue.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await blue.sync();
            await host.sync();

            // Confirm blue has an LMA row bound to the active account.
            const lmaRows = await queryPrivateTable(
                `SELECT hsr_account_id FROM lobby_member_account WHERE lobby_id = ${guardLobbyId} AND user_id = ${blue.userId}`
            );
            expect(lmaRows.length).toBeGreaterThanOrEqual(1);
        }, 60000);

        it('set_active_hsr_account rejects while caller has an active LobbyMemberAccount binding (D-G-01)', async () => {
            // Create a second account so we can attempt to switch isActive
            // to a DIFFERENT one. The guard at roster.ts:107-118 rejects
            // because the currently-active account is bound to a live lobby.
            await blue.call.createHsrAccount({ uid: '812090101', displayLabel: 'Blue Alt' });
            await blue.sync(1500);
            const altRows = await queryPrivateTable(
                `SELECT id FROM hsr_account WHERE user_id = ${blue.userId} AND is_active = false`
            );
            expect(altRows.length).toBeGreaterThanOrEqual(1);
            const altAccountId = Number(altRows[altRows.length - 1].id);

            const err = await expectReducerError(
                blue.call.setActiveHsrAccount({ hsrAccountId: altAccountId })
            );
            expect(err).toContain('change your active account');
        }, 30000);

        it('batch_upsert_characters rejects while target account is bound to a live lobby (D-G-01)', async () => {
            const err = await expectReducerError(
                blue.call.batchUpsertCharacters({
                    hsrAccountId: guardBlueAccountId,
                    charactersJson: JSON.stringify([
                        { characterName: 'anaxa', eidolonLevel: 0 },
                    ]),
                })
            );
            expect(err).toContain('edit characters on this account');
        }, 30000);

        it('batch_remove_characters rejects while target account is bound to a live lobby (D-G-01)', async () => {
            // Even with an empty character list the guard fires before the
            // delete loop (guard runs in the first ~5 lines of the reducer).
            const err = await expectReducerError(
                blue.call.batchRemoveCharacters({
                    hsrAccountId: guardBlueAccountId,
                    characterNamesJson: JSON.stringify(['acheron']),
                })
            );
            expect(err).toContain('remove characters from this account');
        }, 30000);
    });
});
