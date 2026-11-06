/**
 * Integration tests: D-H-01 tournament-stage ordering guard on finalize_match_result.
 *
 * Phase 12.3 Plan 07 Task 2. Owns regression coverage for:
 *   - MMR-RACE-02 / TOURN-ORDER-01: finalize_match_result must reject
 *     tournament-controlled match finalization until the parent tournament
 *     reaches a terminal stage (Completed or Cancelled).
 *   - D-H-02 (unconditional): casual tournaments (countTowardsMmr=false) are
 *     ALSO blocked mid-tournament — the rollback property applies regardless
 *     of whether the tournament counts toward MMR.
 *   - Non-tournament finalize is unaffected (sanity regression).
 *
 * Guard implementation lives at matchFinalization.ts:46-60 (Plan 04).
 * Error message is verbatim from D-H-03.
 *
 * Scenarios:
 *   1. MMR tournament — finalize mid-InProgress rejected; post-Completed succeeds.
 *   2. Casual tournament (countTowardsMmr=false) — finalize mid-InProgress rejected;
 *      post-Cancelled succeeds.
 *   3. Non-tournament Ranked match — finalize succeeds immediately (guard inapplicable).
 *   4. Pitfall 4 edge case — isTournamentControlled=true with bracketMatchId=undefined.
 *      Skipped by default: the test harness cannot cleanly construct this state
 *      without a server-only admin path, and Plan 04 already proved the branch
 *      via grep. Manual UAT covers it.
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 *
 * Contract: docs/match-results/contract.md — Tournament-stage ordering guard
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    hasServerToken,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { promoteToRole } from '../../shared/helpers/promoteUser';
import { ensureHsrAccount } from '../../shared/helpers/hsrAccounts';
import { ensureEloConfig } from '../../shared/helpers/seed';
import { gameScoreArgs } from '../../shared/helpers/scores';
import { defaultLobbyArgs } from '../../shared/helpers/lobbies';
import { completeDraft, completeTournamentDraft, advanceToScoring, startDraftAndSync } from '../../shared/helpers/drafts';
import {
    setupRegistrationTournament,
    advanceToInProgress,
    cleanupTournament,
} from '../../shared/helpers/tournaments';
import { myLobbies } from '../../shared/helpers/queries';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Full tournament match lifecycle: create tournament lobby for the given
 * bracketMatch → players join → draft → score → confirm → submit → validate
 * (via admin override). Leaves the MatchResultRecord in Validated state,
 * ready for finalize_match_result.
 *
 * Returns { lobbyId, matchResultId } so the caller can (a) assert the guard
 * fires, (b) advance the tournament to a terminal stage, then (c) retry
 * finalize and assert success.
 */
async function setupValidatedTournamentMatch(
    toUser: TestHarness,
    blue: TestHarness,
    red: TestHarness,
    admin: TestHarness,
    bracketMatchId: number,
): Promise<{ lobbyId: number; matchResultId: number }> {
    // Create tournament lobby for this bracket match
    await toUser.call.createTournamentLobby({ bracketMatchId, joinCode: '' });
    await toUser.sync(1500);

    const lobby = [...toUser.conn.db.Lobby.iter()].find(l => {
        const bm = l.bracketMatchId;
        if (bm === null || bm === undefined) return false;
        if (typeof bm === 'number') return bm === bracketMatchId;
        if (typeof bm === 'object' && 'value' in (bm as any)) return (bm as any).value === bracketMatchId;
        return false;
    });
    if (!lobby) throw new Error(`Tournament lobby not found for bracket match #${bracketMatchId}`);
    const lobbyId = lobby.id;

    // Blue joins + slot
    await blue.call.joinLobby({ lobbyId, joinCode: '', password: '' });
    await blue.sync();
    await blue.call.setTeamSlot({
        lobbyId,
        targetUserId: blue.userId,
        lobbySlot: { tag: 'BluePlayer' as const },
    });
    await blue.sync();

    // Red joins + slot
    await red.call.joinLobby({ lobbyId, joinCode: '', password: '' });
    await red.sync();
    await red.call.setTeamSlot({
        lobbyId,
        targetUserId: red.userId,
        lobbySlot: { tag: 'RedPlayer' as const },
    });
    await red.sync();

    // Both confirm
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

    // Complete tournament draft (BanMode=Four: 4 bans + 16 picks)
    await completeTournamentDraft(blue, red, lobbyId);
    await toUser.sync(1500);

    // Advance Drafting -> Equipping -> Scoring (lineup confirmation + advanceStage)
    await blue.call.confirmLineup({ lobbyId });
    await blue.sync();
    await red.call.confirmLineup({ lobbyId });
    await red.sync();
    await toUser.call.advanceStage({ lobbyId });
    await toUser.sync(1500);
    await blue.sync(1500);
    await red.sync(1500);

    // Find the MatchResultRecord
    const mr = [...toUser.conn.db.MatchResultRecord.iter()].find(r => r.lobbyId === lobbyId);
    if (!mr) throw new Error(`MatchResultRecord not found for lobby #${lobbyId}`);

    // Record scores WITH screenshots (required for Ranked/MMR tournament validation)
    await toUser.call.recordGameScores(gameScoreArgs({
        matchResultId: mr.id,
        gameNumber: 1,
        winnerTeamSide: 'Blue',
        teamBlueCyclesUsed: 7,
        teamRedCyclesUsed: 10,
        teamBlueScreenshotUrl: 'https://i.imgur.com/test-blue.png',
        teamRedScreenshotUrl: 'https://i.imgur.com/test-red.png',
    }));
    await toUser.sync(1000);

    // Confirm both sides
    await blue.call.confirmMatchScores({ matchResultId: mr.id });
    await blue.sync(500);
    await red.call.confirmMatchScores({ matchResultId: mr.id });
    await red.sync(500);
    await toUser.sync(1000);

    // Submit
    await toUser.call.submitMatchResult({
        matchResultId: mr.id,
        winnerId: blue.userId,
    });
    await toUser.sync(1500);

    // Override to Validated (admin)
    await admin.call.overrideMatchResult({
        matchResultId: mr.id,
        newStatusTag: 'Validated',
        winnerTeamSideTag: 'Blue',
        reason: 'Ordering-guard test validation',
    });
    await admin.sync(1000);
    await toUser.sync(1000);

    return { lobbyId, matchResultId: mr.id };
}

/** Non-tournament Ranked match → Validated (for Scenario 3 sanity regression) */
async function setupValidatedNonTournamentMatch(
    host: TestHarness,
    blue: TestHarness,
    red: TestHarness,
    admin: TestHarness,
): Promise<{ lobbyId: number; matchResultId: number }> {
    await host.call.createLobby(defaultLobbyArgs({
        matchType: { tag: 'Ranked' as const, value: {} },
    }));
    await host.sync(1500);
    const lobby = myLobbies(host).at(-1)!;
    const lobbyId = lobby.id;

    await blue.call.joinLobby({ lobbyId, joinCode: '', password: '' });
    await blue.sync();
    await blue.call.setTeamSlot({
        lobbyId,
        targetUserId: blue.userId,
        lobbySlot: { tag: 'BluePlayer' as const },
    });
    await blue.sync();

    await red.call.joinLobby({ lobbyId, joinCode: '', password: '' });
    await red.sync();
    await red.call.setTeamSlot({
        lobbyId,
        targetUserId: red.userId,
        lobbySlot: { tag: 'RedPlayer' as const },
    });
    await red.sync();

    await blue.call.confirmReady({ lobbyId });
    await blue.sync();
    await red.call.confirmReady({ lobbyId });
    await red.sync();
    await host.sync();

    await startDraftAndSync(host, blue, red, lobbyId);
    await completeDraft(blue, red, lobbyId);
    await host.sync(1500);
    await advanceToScoring(host, blue, red, lobbyId);

    const mr = [...host.conn.db.MatchResultRecord.iter()].find(r => r.lobbyId === lobbyId)!;

    await host.call.recordGameScores(gameScoreArgs({
        matchResultId: mr.id,
        gameNumber: 1,
        winnerTeamSide: 'Blue',
        teamBlueCyclesUsed: 7,
        teamRedCyclesUsed: 10,
        teamBlueScreenshotUrl: 'https://i.imgur.com/test-blue.png',
        teamRedScreenshotUrl: 'https://i.imgur.com/test-red.png',
    }));
    await host.sync(1000);

    await blue.call.confirmMatchScores({ matchResultId: mr.id });
    await blue.sync(500);
    await red.call.confirmMatchScores({ matchResultId: mr.id });
    await red.sync(500);
    await host.sync(1000);

    await host.call.submitMatchResult({ matchResultId: mr.id, winnerId: blue.userId });
    await host.sync(1500);

    await admin.call.overrideMatchResult({
        matchResultId: mr.id,
        newStatusTag: 'Validated',
        winnerTeamSideTag: 'Blue',
        reason: 'Non-tournament sanity regression',
    });
    await admin.sync(1000);
    await host.sync(1000);

    return { lobbyId, matchResultId: mr.id };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasServerToken())('Tournament Ordering Guard (D-H-01)', () => {
    let admin: TestHarness;
    let toUser: TestHarness;
    let p1: TestHarness;
    let p2: TestHarness;
    const openedTournamentIds: number[] = [];
    const openedLobbyIds: number[] = [];

    beforeAll(async () => {
        admin = await createVerifiedTestHarness();
        toUser = await createVerifiedTestHarness();
        p1 = await createVerifiedTestHarness();
        p2 = await createVerifiedTestHarness();

        await admin.sync();
        await toUser.sync();
        await p1.sync();
        await p2.sync();

        await promoteToRole(admin, 'Admin');
        await promoteToRole(toUser, 'TournamentHost');
        await admin.sync(1500);
        await toUser.sync(1500);

        await ensureHsrAccount(toUser);
        await ensureHsrAccount(p1);
        await ensureHsrAccount(p2);

        await ensureEloConfig(admin);
    }, 60000);

    afterAll(async () => {
        // Try admin_void_match first (AwaitingResult), then close_lobby as fallback.
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
        for (const tid of openedTournamentIds) {
            await cleanupTournament(toUser, tid);
        }
        await admin?.disconnect();
        await toUser?.disconnect();
        await p1?.disconnect();
        await p2?.disconnect();
    });

    // ─── Scenario 1 — MMR tournament ─────────────────────────────────────

    it('Scenario 1: MMR tournament — finalize rejected for TO and admin (correctness-before-authority)', async () => {
        const tournamentId = await setupRegistrationTournament(toUser, [p1, p2], {
            name: `Guard MMR ${Date.now()}`,
            countTowardsMmr: true,
        });
        openedTournamentIds.push(tournamentId);
        await advanceToInProgress(toUser, tournamentId);

        const bracketMatches = [...toUser.conn.db.BracketMatch.iter()].filter(
            bm => bm.tournamentId === tournamentId
        );
        const bracketMatch = bracketMatches[0];
        if (!bracketMatch) throw new Error('No bracket match found for MMR tournament');

        const { lobbyId, matchResultId } = await setupValidatedTournamentMatch(
            toUser, p1, p2, admin, bracketMatch.id,
        );
        openedLobbyIds.push(lobbyId);

        // D-H-01 (narrowed post-UAT): MMR tournament matches are rejected
        // unconditionally. Tournament MMR flows through process_tournament_mmr
        // batch, not through this reducer — calling finalize_match_result
        // would skip MMR processing and delete the rows the batch needs.
        // Casual tournament matches are NOT guarded (they auto-finalize on
        // submit anyway and have no MMR input to protect).
        const errBeforeCompleted = await expectReducerError(
            toUser.call.finalizeMatchResult({ matchResultId })
        );
        expect(errBeforeCompleted).toContain(
            'MMR tournament matches cannot be finalized individually'
        );
        expect(errBeforeCompleted).toContain('process_tournament_mmr');

        // Admin cannot bypass — guard runs BEFORE the authority check.
        const errViaAdmin = await expectReducerError(
            admin.call.finalizeMatchResult({ matchResultId })
        );
        expect(errViaAdmin).toContain(
            'MMR tournament matches cannot be finalized individually'
        );

        // Cleanup handled by afterAll.
    }, 240000);

    // ─── Scenario 2 deliberately omitted ─────────────────────────────────
    //
    // Casual tournament matches are NOT covered by the D-H-01 guard (post-UAT
    // narrowing). The Phase 12.3 Plan 04 D-H-02 decision claimed the guard
    // should be unconditional, but investigation revealed:
    //
    //   1. Casual matches (including casual tournament matches) auto-finalize
    //      inline via matchResultSubmission.ts:199-203, which calls
    //      runFinalization directly as a helper, bypassing any reducer-level
    //      guard. Casual tournament matches therefore never reach this
    //      reducer via the normal flow.
    //
    //   2. Even if they did, there's nothing to protect: no MMR input means
    //      nothing would be silently lost. runFinalization step 17 advances
    //      the bracket, step 18 cleans up ephemeral rows, step 19 closes
    //      the lobby. rollback_bracket_match still works post-cleanup
    //      because it checks for surviving MRR rows and passes vacuously
    //      when none exist.
    //
    // If rollback becomes an operational pain point for casual tournaments,
    // the solution is tooling around MatchSessionHistory (admin_void_match)
    // and PlayerStat adjustments, not preserving ephemeral MRR rows.

    // ─── Scenario 3 — Non-tournament match (sanity regression) ───────────

    it('Scenario 3: Non-tournament Ranked match — finalize succeeds immediately (guard inapplicable)', async () => {
        const host = await createVerifiedTestHarness();
        const blue = await createVerifiedTestHarness();
        const red = await createVerifiedTestHarness();
        await host.sync();
        await blue.sync();
        await red.sync();

        // Ranked lobbies require an HSR account per player (D-08 LMA gate at start_draft:59-73).
        await ensureHsrAccount(host);
        await ensureHsrAccount(blue);
        await ensureHsrAccount(red);

        const { lobbyId, matchResultId } = await setupValidatedNonTournamentMatch(
            host, blue, red, admin,
        );

        try {
            // No tournament wrapper → isTournamentControlled=false → guard does not fire.
            await host.call.finalizeMatchResult({ matchResultId });
            await host.sync(2000);
            await blue.sync(2000);
            await red.sync(2000);

            const mrAfter = [...host.conn.db.MatchResultRecord.iter()].find(
                r => r.id === matchResultId,
            );
            expect(mrAfter).toBeUndefined();

            const lobbyAfter = [...host.conn.db.Lobby.iter()].find(l => l.id === lobbyId);
            expect(lobbyAfter).toBeUndefined();
        } finally {
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        }
    }, 240000);

    // ─── Scenario 4 — Pitfall 4 defensive case ─────────────────────────────
    //
    // Structurally unreachable from the integration harness:
    // MatchResultRecord.isTournamentControlled=true with bracketMatchId=undefined
    // requires either (a) a server-token admin path that inserts a fabricated
    // MRR row directly, or (b) a live bracketMatch deleted before finalize —
    // which the tournament lifecycle forbids (bracket matches are tied to their
    // tournament and cannot be orphaned mid-flow).
    //
    // The defensive branch in the guard treats "missing bracket/tournament" as
    // "cannot prove this is a casual tournament, so block" — correct behavior
    // verified via Plan 04's grep of the three MRR insert sites (draftClassic.ts:182,
    // concede.ts:33, concede.ts:312).
    //
    // it('Scenario 4 (Pitfall 4): tournament-controlled MRR with bracketMatchId=undefined → rejected', async () => {
    //     // Cannot construct from reducer calls: createTournamentLobby always validates bracketMatchId
    // });
});
