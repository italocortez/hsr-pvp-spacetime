/**
 * Integration tests for bracket advancement reducers.
 *
 * Covers:
 * - advance_bracket_match: places winner in next slot, group standings update
 * - submit_and_advance_bracket: maps userId → teamId, auto-advances
 * - rollback_bracket_match: clears winner, removes from next slot
 * - DQ auto-advance: autoAdvanceBracket=true sets opponent as winner + advances
 * - Finalization auto-advance: step 17 (isTournamentControlled) via Casual auto-finalize
 * - Rollback after finalization: guard + no re-advance path
 * - Group phase scoring: Win=2, Draw=1, Loss=0
 *
 * Three tournaments:
 *   A: SingleElim, autoAdvanceBracket=true, Casual (countTowardsMmr=false) — DQ, finalization, rollback
 *   B: SingleElim, autoAdvanceBracket=true, Ranked (countTowardsMmr=true) — submit_and_advance_bracket
 *   C: GroupOnly, autoAdvanceBracket=true — group standings scoring
 *
 * Contract: docs/brackets/contract.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { promoteUser } from '../../shared/helpers/promoteUser';
import { defaultLobbyArgs } from '../../shared/helpers/lobbies';
import { ensureHsrAccount } from '../../shared/helpers/hsrAccounts';
import { completeTournamentDraft } from '../../shared/helpers/drafts';
import { gameScoreArgs } from '../../shared/helpers/scores';
import { cleanupTournament } from '../../shared/helpers/tournaments';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a tournament and advance it to InProgress with bracket generated */
async function setupTournament(
    toUser: TestHarness,
    players: TestHarness[],
    opts: {
        format?: string;
        autoAdvanceBracket?: boolean;
        countTowardsMmr?: boolean;
        groupSize?: number;
    } = {},
): Promise<{ tournamentId: number; bracketMatches: any[] }> {
    const format = opts.format ?? 'SingleElimination';
    const autoAdvanceBracket = opts.autoAdvanceBracket ?? true;
    const countTowardsMmr = opts.countTowardsMmr ?? false;
    const groupSize = opts.groupSize ?? 4;

    await toUser.call.createTournament({
        name: `Bracket Test ${Date.now()}`,
        description: 'Integration test tournament',
        format,
        teamSize: 1,
        defaultGameMode: 'MemoryOfChaos',
        maxParticipants: 16,
        rosterVisibility: 'OpenRoster',
        isAnonymousDefault: false,
        disconnectPolicy: 'Deferred',
        costSetId: 0,
        defaultBestOf: 1,
        groupSize,
        has3RdPlaceMatch: false,
        autoAdvanceBracket,
        countTowardsMmr,
        winnerAdvantage: 0,
        requireOwnership: false,
        requireVerified: false,
        requireRoster: false,
        minimumMmr: 0,
        requireApproval: false,
        waitlistEnabled: false,
        scheduledStartAt: '',
        registrationDeadline: '',
        maxAccountsPerPlayer: 1,
    });
    await toUser.sync(1000);

    const tournaments = [...toUser.conn.db.Tournament.iter()].filter(
        t => t.organizerId === toUser.userId
    );
    const tournament = tournaments[tournaments.length - 1];
    const tournamentId = tournament.id;

    // Draft → Registration
    await toUser.call.advanceTournamentStage({ tournamentId, nextStage: 'Registration' });
    await toUser.sync(1000);

    // Ensure all players have HSR accounts BEFORE registration (so TPA locks them)
    for (const p of players) {
        await ensureHsrAccount(p);
    }

    // Register all players
    for (const p of players) {
        await p.call.registerForTournament({ tournamentId });
        await p.sync(1000);
    }
    await toUser.sync(1000);

    // Registration → Seeding
    await toUser.call.advanceTournamentStage({ tournamentId, nextStage: 'Seeding' });
    await toUser.sync(1000);

    // Seed bracket
    await toUser.call.seedBracket({ tournamentId, mode: 'random' });
    await toUser.sync(1500);

    // Generate bracket
    await toUser.call.generateBracket({ tournamentId });
    await toUser.sync(1500);

    // Seeding → InProgress
    await toUser.call.advanceTournamentStage({ tournamentId, nextStage: 'InProgress' });
    await toUser.sync(1000);

    const bracketMatches = [...toUser.conn.db.BracketMatch.iter()].filter(
        bm => bm.tournamentId === tournamentId
    );

    return { tournamentId, bracketMatches };
}

/** Get the team ID for a player in a tournament via TournamentTeamMember */
function getTeamId(h: TestHarness, tournamentId: number, userId: number): number {
    const member = [...h.conn.db.TournamentTeamMember.iter()].find(
        m => m.tournamentId === tournamentId && m.userId === userId
    );
    return member?.teamId ?? 0;
}

/** Find bracket match by teams */
function findMatchByTeams(h: TestHarness, tournamentId: number, team1: number, team2: number) {
    return [...h.conn.db.BracketMatch.iter()].find(bm =>
        bm.tournamentId === tournamentId &&
        ((bm.team1Id === team1 && bm.team2Id === team2) ||
         (bm.team1Id === team2 && bm.team2Id === team1))
    );
}

/** Find the final match (nextWinnerMatchId === undefined for all pointers to it) */
function findFinalMatch(h: TestHarness, tournamentId: number) {
    const matches = [...h.conn.db.BracketMatch.iter()].filter(
        bm => bm.tournamentId === tournamentId
    );
    // Final is the match that no other match points to as nextWinnerMatchId is undefined
    return matches.find(m => !m.nextWinnerMatchId);
}

/**
 * Complete a Classic + Four ban draft (20 steps: 4 bans + 16 picks).
 * Tournament lobbies default to banMode=Four.
 * Sequence from draftSequences.ts:
 *   Ban: Blue, Red
 *   Pick: Blue, Red, Red, Blue
 *   Ban: Red, Blue
 *   Pick: Red, Blue, Blue, Red, Red, Blue, Blue, Red, Red, Blue, Blue, Red
 */

/** Setup lobby lifecycle: create tournament lobby → join → set slots → confirm → start draft → complete draft → score → confirm */
async function setupTournamentMatch(
    toUser: TestHarness, blue: TestHarness, red: TestHarness,
    bracketMatchId: number,
): Promise<{ lobbyId: number; matchResultId: number }> {
    // Create tournament lobby
    await toUser.call.createTournamentLobby({ bracketMatchId, joinCode: '' });
    await toUser.sync(1000);

    // Find the lobby for this bracket match
    const lobby = [...toUser.conn.db.Lobby.iter()].find(l => {
        const bm = l.bracketMatchId;
        if (bm === null || bm === undefined) return false;
        if (typeof bm === 'number') return bm === bracketMatchId;
        if (typeof bm === 'object' && 'value' in (bm as any)) return (bm as any).value === bracketMatchId;
        return false;
    });
    if (!lobby) throw new Error(`Tournament lobby not found for bracket match #${bracketMatchId}`);
    const lobbyId = lobby.id;

    // Ensure players have HSR accounts (D-08 gate: start_draft requires LMA for Ranked/MMR)
    await ensureHsrAccount(blue);
    await ensureHsrAccount(red);

    // Players join lobby
    await blue.call.joinLobby({ lobbyId, joinCode: '', password: '' });
    await blue.sync();
    await blue.call.setTeamSlot({ lobbyId, targetUserId: blue.userId, lobbySlot: { tag: 'BluePlayer' as const } });
    await blue.sync();

    await red.call.joinLobby({ lobbyId, joinCode: '', password: '' });
    await red.sync();
    await red.call.setTeamSlot({ lobbyId, targetUserId: red.userId, lobbySlot: { tag: 'RedPlayer' as const } });
    await red.sync();

    // Confirm ready
    await blue.call.confirmReady({ lobbyId });
    await blue.sync();
    await red.call.confirmReady({ lobbyId });
    await red.sync();
    await toUser.sync();

    // Start draft
    await toUser.call.startDraft({ lobbyId });
    await toUser.sync(1500);
    await blue.sync(1500);
    await red.sync(1500);

    // Complete draft — tournament lobbies use BanMode=Four (20 steps: 4 bans + 16 picks)
    await completeTournamentDraft(blue, red, lobbyId);
    await toUser.sync(1000);

    // Confirm lineups + advance to scoring
    await blue.call.confirmLineup({ lobbyId });
    await blue.sync();
    await red.call.confirmLineup({ lobbyId });
    await red.sync();
    await toUser.call.advanceStage({ lobbyId });
    await toUser.sync(1500);
    await blue.sync(1500);
    await red.sync(1500);

    // Find match result
    const mr = [...toUser.conn.db.MatchResultRecord.iter()].find(r => r.lobbyId === lobbyId);
    if (!mr) throw new Error(`MatchResultRecord not found for lobby #${lobbyId}`);

    // Record scores (referee records both sides)
    await toUser.call.recordGameScores(gameScoreArgs({
        matchResultId: mr.id,
        gameNumber: 1,
        winnerTeamSide: 'Blue',
        teamBlueCyclesUsed: 7,
        teamRedCyclesUsed: 10,
    }));
    await toUser.sync(1000);

    // Confirm both sides
    await blue.call.confirmMatchScores({ matchResultId: mr.id });
    await blue.sync(500);
    await red.call.confirmMatchScores({ matchResultId: mr.id });
    await red.sync(500);
    await toUser.sync(1000);

    return { lobbyId, matchResultId: mr.id };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Bracket Advancement', () => {
    let toUser: TestHarness;
    let admin: TestHarness;
    let p1: TestHarness;
    let p2: TestHarness;
    let p3: TestHarness;
    let p4: TestHarness;
    const openedTournamentIds: number[] = [];
    const openedLobbyIds: number[] = [];

    beforeAll(async () => {
        toUser = await createVerifiedTestHarness();
        admin = await createVerifiedTestHarness();
        p1 = await createVerifiedTestHarness();
        p2 = await createVerifiedTestHarness();
        p3 = await createVerifiedTestHarness();
        p4 = await createVerifiedTestHarness();
        await toUser.sync();
        await admin.sync();
        await p1.sync();
        await p2.sync();
        await p3.sync();
        await p4.sync();

        // Promote roles
        const toUserRecord = [...toUser.conn.db.User.iter()].find(u => u.id === toUser.userId);
        await promoteUser(toUserRecord!.username, 'TournamentHost');
        const adminRecord = [...admin.conn.db.User.iter()].find(u => u.id === admin.userId);
        await promoteUser(adminRecord!.username, 'Admin');
        await toUser.sync(1500);
        await admin.sync(1500);
    }, 60000);

    afterAll(async () => {
        // D-03: strict cleanup per resource opened.
        // Lobbies may be in AwaitingResult for Ranked flows (Tournament B) — try
        // admin_void_match first (Pitfall 3), then close_lobby as fallback.
        for (const lobbyId of openedLobbyIds) {
            try {
                await admin.call.adminVoidMatch({ lobbyId });
                await admin.sync(500);
            } catch (_) { /* not in AwaitingResult */ }
            try {
                await toUser.call.closeLobby({ lobbyId });
                await toUser.sync(500);
            } catch (_) { /* already closed */ }
        }
        // Cancel tournaments — cascade deletes bracket_match, teams, TPA per Pitfall 2
        for (const tid of openedTournamentIds) {
            await cleanupTournament(toUser, tid);
        }
        await toUser?.disconnect();
        await admin?.disconnect();
        await p1?.disconnect();
        await p2?.disconnect();
        await p3?.disconnect();
        await p4?.disconnect();
    }, 90000);

    // ═════════════════════════════════════════════════════════════════════════
    // Tournament A: SingleElim, autoAdvanceBracket=true, Casual
    // ═════════════════════════════════════════════════════════════════════════

    describe('Tournament A: SingleElim + DQ + Finalization', () => {
        let tournamentId: number;
        let semi1Id: number;
        let semi2Id: number;
        let finalId: number;
        let team1: number;
        let team2: number;
        let team3: number;
        let team4: number;

        beforeAll(async () => {
            const result = await setupTournament(toUser, [p1, p2, p3, p4], {
                format: 'SingleElimination',
                autoAdvanceBracket: true,
                countTowardsMmr: false, // Casual → auto-finalize
            });
            tournamentId = result.tournamentId;
            openedTournamentIds.push(tournamentId);

            await p1.sync(1000);
            await p2.sync(1000);
            await p3.sync(1000);
            await p4.sync(1000);

            // Resolve team IDs
            team1 = getTeamId(toUser, tournamentId, p1.userId);
            team2 = getTeamId(toUser, tournamentId, p2.userId);
            team3 = getTeamId(toUser, tournamentId, p3.userId);
            team4 = getTeamId(toUser, tournamentId, p4.userId);

            // Identify bracket matches: 4 teams → 3 matches (2 semis + 1 final)
            const matches = [...toUser.conn.db.BracketMatch.iter()].filter(
                bm => bm.tournamentId === tournamentId
            );
            expect(matches.length).toBe(3);

            // R1 matches are semis, R2 is the final
            const r1 = matches.filter(m => m.roundNumber === 1);
            const r2 = matches.filter(m => m.roundNumber === 2);
            expect(r1.length).toBe(2);
            expect(r2.length).toBe(1);
            finalId = r2[0].id;

            // Find which semi has which teams
            for (const s of r1) {
                const hasTeam1or2 = (s.team1Id === team1 || s.team2Id === team1 ||
                                     s.team1Id === team2 || s.team2Id === team2);
                const hasTeam3or4 = (s.team1Id === team3 || s.team2Id === team3 ||
                                     s.team1Id === team4 || s.team2Id === team4);
                if (hasTeam1or2) semi1Id = s.id;
                if (hasTeam3or4) semi2Id = s.id;
            }

            // Fallback: if team assignment is unexpected, assign by order
            if (!semi1Id || !semi2Id) {
                semi1Id = r1[0].id;
                semi2Id = r1[1].id;
            }
        }, 90000);

        // ─── Validation Errors ─────────────────────────────────────────────

        it('advance_bracket_match: no winner → error', async () => {
            const err = await expectReducerError(
                toUser.call.advanceBracketMatch({ bracketMatchId: semi1Id })
            );
            expect(err).toContain('No winner set');
        });

        it('rollback_bracket_match: no winner → error', async () => {
            const err = await expectReducerError(
                toUser.call.rollbackBracketMatch({ bracketMatchId: semi1Id })
            );
            expect(err).toContain('No winner to rollback');
        });

        // ─── DQ Auto-Advance ──────────────────────────────────────────────

        it('DQ player4 → participant Disqualified', async () => {
            await toUser.call.dqParticipant({
                tournamentId,
                userId: p4.userId,
                reason: 'Test DQ',
            });
            await toUser.sync(1500);

            const enrolled = [...toUser.conn.db.TournamentEnrolled.iter()].find(
                p => p.tournamentId === tournamentId && p.userId === p4.userId
            );
            expect(enrolled).toBeDefined();
            expect(enrolled!.status.tag).toBe('Disqualified');
        });

        it('DQ sets semi2 winnerTeamId to opponent team', async () => {
            const semi2 = [...toUser.conn.db.BracketMatch.iter()].find(bm => bm.id === semi2Id);
            expect(semi2).toBeDefined();
            // Opponent of team4 in semi2 is whichever team is NOT team4
            const opponentTeam = semi2!.team1Id === team4 ? semi2!.team2Id : semi2!.team1Id;
            expect(semi2!.winnerTeamId).toBe(opponentTeam);
            expect(semi2!.resultStatus.tag).toBe('Validated');
        });

        it('DQ auto-places opponent in final match slot', async () => {
            const semi2 = [...toUser.conn.db.BracketMatch.iter()].find(bm => bm.id === semi2Id);
            const opponentTeam = semi2!.team1Id === team4 ? semi2!.team2Id : semi2!.team1Id;

            const final_ = [...toUser.conn.db.BracketMatch.iter()].find(bm => bm.id === finalId);
            expect(final_).toBeDefined();
            const inFinal = final_!.team1Id === opponentTeam || final_!.team2Id === opponentTeam;
            expect(inFinal).toBe(true);
        });

        // ─── Rollback DQ Advancement ──────────────────────────────────────

        it('rollback_bracket_match clears winnerTeamId', async () => {
            await toUser.call.rollbackBracketMatch({ bracketMatchId: semi2Id });
            await toUser.sync(1500);

            const semi2 = [...toUser.conn.db.BracketMatch.iter()].find(bm => bm.id === semi2Id);
            expect(semi2).toBeDefined();
            expect(semi2!.winnerTeamId).toBeUndefined();
            expect(semi2!.resultStatus.tag).toBe('Pending');
        });

        it('rollback removes team from final slot', async () => {
            // Get the opponent team that was placed in the final by DQ
            const semi2 = [...toUser.conn.db.BracketMatch.iter()].find(bm => bm.id === semi2Id);
            const opponentTeam = semi2!.team1Id === team4 ? semi2!.team2Id : semi2!.team1Id;

            const final_ = [...toUser.conn.db.BracketMatch.iter()].find(bm => bm.id === finalId);
            expect(final_).toBeDefined();
            const opponentInFinal = final_!.team1Id === opponentTeam || final_!.team2Id === opponentTeam;
            expect(opponentInFinal).toBe(false);
        });

        it('rollback again with no winner → error', async () => {
            const err = await expectReducerError(
                toUser.call.rollbackBracketMatch({ bracketMatchId: semi2Id })
            );
            expect(err).toContain('No winner to rollback');
        });

        // ─── Finalization Auto-Advance (Step 17) ──────────────────────────

        describe('Full match lifecycle → step 17 auto-advance', () => {
            let lobbyId: number;
            let matchResultId: number;
            let historyCountBefore: number;
            let bluePlayer: TestHarness;
            let redPlayer: TestHarness;

            beforeAll(async () => {
                // Map team IDs to player harnesses
                const teamToPlayer = new Map<number, TestHarness>([
                    [team1, p1], [team2, p2], [team3, p3], [team4, p4],
                ]);

                // Determine which players are in semi1
                const semi1 = [...toUser.conn.db.BracketMatch.iter()].find(bm => bm.id === semi1Id);
                bluePlayer = teamToPlayer.get(semi1!.team1Id!)!;
                redPlayer = teamToPlayer.get(semi1!.team2Id!)!;

                // Fallback if team mapping failed (shouldn't happen)
                if (!bluePlayer || !redPlayer) {
                    bluePlayer = p1;
                    redPlayer = p2;
                }

                historyCountBefore = [...toUser.conn.db.MatchSessionHistory.iter()].length;

                const result = await setupTournamentMatch(
                    toUser, bluePlayer, redPlayer, semi1Id
                );
                lobbyId = result.lobbyId;
                matchResultId = result.matchResultId;
                openedLobbyIds.push(lobbyId);
            }, 120000);

            it('submit → Casual auto-finalize triggers step 17', async () => {
                // Submit match result (Casual = auto-validate + auto-finalize)
                await toUser.call.submitMatchResult({
                    matchResultId,
                    winnerId: bluePlayer.userId,
                });
                await toUser.sync(3000);
                await bluePlayer.sync(2000);
                await redPlayer.sync(2000);

                // MatchResultRecord should be deleted (finalized)
                const mr = [...toUser.conn.db.MatchResultRecord.iter()].find(
                    r => r.id === matchResultId
                );
                expect(mr).toBeUndefined();
            }, 60000);

            it('step 17 auto-advanced winner to final', async () => {
                const final_ = [...toUser.conn.db.BracketMatch.iter()].find(bm => bm.id === finalId);
                expect(final_).toBeDefined();

                // Get the winner's team ID
                const winnerTeamId = getTeamId(toUser, tournamentId, bluePlayer.userId);
                const inFinal = final_!.team1Id === winnerTeamId || final_!.team2Id === winnerTeamId;
                expect(inFinal).toBe(true);
            });

            it('semi1 BracketMatch has winnerTeamId set', async () => {
                const semi1 = [...toUser.conn.db.BracketMatch.iter()].find(bm => bm.id === semi1Id);
                expect(semi1).toBeDefined();
                const winnerTeamId = getTeamId(toUser, tournamentId, bluePlayer.userId);
                expect(semi1!.winnerTeamId).toBe(winnerTeamId);
            });

            it('MatchSessionHistory created', () => {
                const historyCount = [...toUser.conn.db.MatchSessionHistory.iter()].length;
                expect(historyCount).toBeGreaterThan(historyCountBefore);
            });

            it('lobby cascade-deleted after finalization', () => {
                const lobby = [...toUser.conn.db.Lobby.iter()].find(l => l.id === lobbyId);
                expect(lobby).toBeUndefined();
            });

            // ─── Rollback After Finalization ──────────────────────────────

            it('rollback after finalization succeeds (no MMR processed)', async () => {
                // During tournament, MMR is not processed per-match (batched at end)
                // So rollback should succeed even after finalization
                await toUser.call.rollbackBracketMatch({ bracketMatchId: semi1Id });
                await toUser.sync(1500);

                const semi1 = [...toUser.conn.db.BracketMatch.iter()].find(bm => bm.id === semi1Id);
                expect(semi1).toBeDefined();
                expect(semi1!.winnerTeamId).toBeUndefined();
            });

            it('rollback removes winner from final after finalization', () => {
                const final_ = [...toUser.conn.db.BracketMatch.iter()].find(bm => bm.id === finalId);
                expect(final_).toBeDefined();
                const winnerTeamId = getTeamId(toUser, tournamentId, bluePlayer.userId);
                const inFinal = final_!.team1Id === winnerTeamId || final_!.team2Id === winnerTeamId;
                expect(inFinal).toBe(false);
            });

            it('no re-advance path: MatchResultRecord deleted', () => {
                // After finalization + rollback, the MatchResultRecord is gone
                // submit_and_advance_bracket would fail since there's no record to reference
                const mr = [...toUser.conn.db.MatchResultRecord.iter()].find(
                    r => r.id === matchResultId
                );
                expect(mr).toBeUndefined();
            });
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Tournament B: SingleElim, autoAdvanceBracket=true, Ranked
    // ═════════════════════════════════════════════════════════════════════════

    describe('Tournament B: submit_and_advance_bracket', () => {
        let tournamentId: number;
        let semi1Id: number;
        let finalId: number;
        let bluePlayer: TestHarness;
        let redPlayer: TestHarness;

        beforeAll(async () => {
            const result = await setupTournament(toUser, [p1, p2, p3, p4], {
                format: 'SingleElimination',
                autoAdvanceBracket: true,
                countTowardsMmr: true, // Ranked → does NOT auto-finalize
            });
            tournamentId = result.tournamentId;
            openedTournamentIds.push(tournamentId);

            await p1.sync(1000);
            await p2.sync(1000);
            await p3.sync(1000);
            await p4.sync(1000);

            // Get bracket matches
            const matches = [...toUser.conn.db.BracketMatch.iter()].filter(
                bm => bm.tournamentId === tournamentId
            );
            const r1 = matches.filter(m => m.roundNumber === 1);
            const r2 = matches.filter(m => m.roundNumber === 2);
            semi1Id = r1[0].id;
            finalId = r2[0].id;

            // Map teams to players
            const team1 = getTeamId(toUser, tournamentId, p1.userId);
            const team2 = getTeamId(toUser, tournamentId, p2.userId);
            const team3 = getTeamId(toUser, tournamentId, p3.userId);
            const team4 = getTeamId(toUser, tournamentId, p4.userId);
            const teamToPlayer = new Map<number, TestHarness>([
                [team1, p1], [team2, p2], [team3, p3], [team4, p4],
            ]);

            const semi1 = r1[0];
            bluePlayer = teamToPlayer.get(semi1.team1Id!)!;
            redPlayer = teamToPlayer.get(semi1.team2Id!)!;
            if (!bluePlayer || !redPlayer) {
                bluePlayer = p1;
                redPlayer = p2;
            }
        }, 90000);

        it('full match → submit (Ranked stays Submitted)', async () => {
            const { matchResultId, lobbyId } = await setupTournamentMatch(
                toUser, bluePlayer, redPlayer, semi1Id
            );
            openedLobbyIds.push(lobbyId);

            // Submit with winner — Ranked does NOT auto-finalize
            await toUser.call.submitMatchResult({
                matchResultId,
                winnerId: bluePlayer.userId,
            });
            await toUser.sync(2000);

            // MatchResultRecord should still exist (Submitted status)
            const mr = [...toUser.conn.db.MatchResultRecord.iter()].find(
                r => r.id === matchResultId
            );
            expect(mr).toBeDefined();
            expect(mr!.status.tag).toBe('Submitted');
        }, 180000);

        it('submit_and_advance_bracket maps userId→teamId and advances', async () => {
            const mr = [...toUser.conn.db.MatchResultRecord.iter()].find(
                r => r.bracketMatchId === semi1Id
            );
            expect(mr).toBeDefined();

            await toUser.call.submitAndAdvanceBracket({ matchResultId: mr!.id });
            await toUser.sync(2000);

            // Check bracket match has winner set
            const updatedSemi = [...toUser.conn.db.BracketMatch.iter()].find(bm => bm.id === semi1Id);
            expect(updatedSemi).toBeDefined();
            const winnerTeamId = getTeamId(toUser, tournamentId, bluePlayer.userId);
            expect(updatedSemi!.winnerTeamId).toBe(winnerTeamId);
        }, 60000);

        it('winner auto-placed in final (autoAdvanceBracket=true)', () => {
            const final_ = [...toUser.conn.db.BracketMatch.iter()].find(bm => bm.id === finalId);
            expect(final_).toBeDefined();
            const winnerTeamId = getTeamId(toUser, tournamentId, bluePlayer.userId);
            const inFinal = final_!.team1Id === winnerTeamId || final_!.team2Id === winnerTeamId;
            expect(inFinal).toBe(true);
        });

        it('submit_and_advance_bracket: invalid match result → error', async () => {
            const err = await expectReducerError(
                toUser.call.submitAndAdvanceBracket({ matchResultId: 999999 })
            );
            expect(err).toContain('not found');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // Tournament C: GroupOnly, autoAdvanceBracket=true — Group Scoring
    // ═════════════════════════════════════════════════════════════════════════

    describe('Tournament C: Group Phase Scoring', () => {
        let tournamentId: number;
        let team1: number;
        let team2: number;
        let team3: number;
        let team4: number;

        beforeAll(async () => {
            const result = await setupTournament(toUser, [p1, p2, p3, p4], {
                format: 'GroupOnly',
                autoAdvanceBracket: true,
                countTowardsMmr: false,
                groupSize: 4, // One group of 4 → 6 round-robin matches
            });
            tournamentId = result.tournamentId;
            openedTournamentIds.push(tournamentId);

            await p1.sync(1000);
            await p2.sync(1000);
            await p3.sync(1000);
            await p4.sync(1000);

            team1 = getTeamId(toUser, tournamentId, p1.userId);
            team2 = getTeamId(toUser, tournamentId, p2.userId);
            team3 = getTeamId(toUser, tournamentId, p3.userId);
            team4 = getTeamId(toUser, tournamentId, p4.userId);
        }, 120000);

        it('group matches created with bracketSide=Group', () => {
            const matches = [...toUser.conn.db.BracketMatch.iter()].filter(
                bm => bm.tournamentId === tournamentId
            );
            expect(matches.length).toBe(6); // C(4,2) = 6
            for (const m of matches) {
                expect(m.bracketSide.tag).toBe('Group');
            }
        });

        it('GroupPhaseRecord rows initialized at zero', () => {
            const standings = [...toUser.conn.db.GroupPhaseRecord.iter()].filter(
                gs => gs.tournamentId === tournamentId
            );
            expect(standings.length).toBe(4); // One per team
            for (const s of standings) {
                expect(s.wins).toBe(0);
                expect(s.losses).toBe(0);
                expect(s.draws).toBe(0);
                expect(s.points).toBe(0);
            }
        });

        it('DQ player4 → sets winner on active group match', async () => {
            await toUser.call.dqParticipant({
                tournamentId,
                userId: p4.userId,
                reason: 'Group DQ test',
            });
            await toUser.sync(1500);

            // Find the match where team4 was a participant and is now resolved
            const resolvedMatch = [...toUser.conn.db.BracketMatch.iter()].find(
                bm => bm.tournamentId === tournamentId &&
                      bm.winnerTeamId !== undefined &&
                      (bm.team1Id === team4 || bm.team2Id === team4)
            );
            expect(resolvedMatch).toBeDefined();
            // The opponent should be the winner
            const opponentTeam = resolvedMatch!.team1Id === team4
                ? resolvedMatch!.team2Id
                : resolvedMatch!.team1Id;
            expect(resolvedMatch!.winnerTeamId).toBe(opponentTeam);
        });

        it('advance_bracket_match on resolved group match → updates standings', async () => {
            // Find the resolved match
            const resolvedMatch = [...toUser.conn.db.BracketMatch.iter()].find(
                bm => bm.tournamentId === tournamentId &&
                      bm.winnerTeamId !== undefined &&
                      (bm.team1Id === team4 || bm.team2Id === team4)
            );
            expect(resolvedMatch).toBeDefined();

            await toUser.call.advanceBracketMatch({ bracketMatchId: resolvedMatch!.id });
            await toUser.sync(1500);

            // Check standings updated
            const standings = [...toUser.conn.db.GroupPhaseRecord.iter()].filter(
                gs => gs.tournamentId === tournamentId
            );

            // Winner should have wins=1, points=2 (Win=2pts)
            const winnerTeamId = resolvedMatch!.winnerTeamId!;
            const winnerStanding = standings.find(s => s.teamId === winnerTeamId);
            expect(winnerStanding).toBeDefined();
            expect(winnerStanding!.wins).toBe(1);
            expect(winnerStanding!.points).toBe(2);

            // Loser (team4) should have losses=1, points=0 (Loss=0pts)
            const loserStanding = standings.find(s => s.teamId === team4);
            expect(loserStanding).toBeDefined();
            expect(loserStanding!.losses).toBe(1);
            expect(loserStanding!.points).toBe(0);
        });

        it('non-participating teams have unchanged standings', () => {
            const standings = [...toUser.conn.db.GroupPhaseRecord.iter()].filter(
                gs => gs.tournamentId === tournamentId
            );

            // Get the match we resolved to identify participating teams
            const resolvedMatch = [...toUser.conn.db.BracketMatch.iter()].find(
                bm => bm.tournamentId === tournamentId &&
                      bm.winnerTeamId !== undefined
            );
            const participatingTeams = [resolvedMatch!.team1Id, resolvedMatch!.team2Id];

            // Other teams should be untouched (0/0/0/0)
            const others = standings.filter(s => !participatingTeams.includes(s.teamId));
            for (const s of others) {
                expect(s.wins).toBe(0);
                expect(s.losses).toBe(0);
                expect(s.draws).toBe(0);
                expect(s.points).toBe(0);
            }
        });

        // ─── Group Draw Scoring ───────────────────────────────────────────

        it('advance_bracket_match on group draw → updates both teams with Draw=1pt', async () => {
            // Find an unresolved group match between two non-DQ'd teams
            const unresolvedMatch = [...toUser.conn.db.BracketMatch.iter()].find(
                bm => bm.tournamentId === tournamentId &&
                      bm.resultStatus.tag === 'Pending' &&
                      bm.team1Id !== team4 && bm.team2Id !== team4 && // not involving DQ'd team
                      bm.team1Id !== undefined && bm.team2Id !== undefined
            );
            expect(unresolvedMatch).toBeDefined();

            const drawTeamA = unresolvedMatch!.team1Id!;
            const drawTeamB = unresolvedMatch!.team2Id!;

            // Get standings before
            const standingsBefore = [...toUser.conn.db.GroupPhaseRecord.iter()].filter(
                gs => gs.tournamentId === tournamentId
            );
            const aBefore = standingsBefore.find(s => s.teamId === drawTeamA)!;
            const bBefore = standingsBefore.find(s => s.teamId === drawTeamB)!;

            // Call advance_bracket_match on a match with NO winnerTeamId (draw)
            await toUser.call.advanceBracketMatch({ bracketMatchId: unresolvedMatch!.id });
            await toUser.sync(1500);

            // Both teams should get draws+1 and points+1 (Draw=1pt)
            const standingsAfter = [...toUser.conn.db.GroupPhaseRecord.iter()].filter(
                gs => gs.tournamentId === tournamentId
            );

            const aAfter = standingsAfter.find(s => s.teamId === drawTeamA)!;
            expect(aAfter.draws).toBe(aBefore.draws + 1);
            expect(aAfter.points).toBe(aBefore.points + 1);

            const bAfter = standingsAfter.find(s => s.teamId === drawTeamB)!;
            expect(bAfter.draws).toBe(bBefore.draws + 1);
            expect(bAfter.points).toBe(bBefore.points + 1);
        });

        it('group draw sets resultStatus to Validated', () => {
            // Find the match we just processed as a draw
            const drawMatch = [...toUser.conn.db.BracketMatch.iter()].find(
                bm => bm.tournamentId === tournamentId &&
                      bm.resultStatus.tag === 'Validated' &&
                      bm.winnerTeamId === undefined // draw = no winner
            );
            expect(drawMatch).toBeDefined();
        });

        // Elimination bracket draw rejection: this should fail because elimination
        // matches require a winner. Accessing a SingleElim bracket match from inside
        // this describe block isn't possible with the current fixture scoping —
        // Tournament A tests cover the guard indirectly via validation errors.
        it.todo('elimination bracket rejects draw (no winner) → error');
    });
});
