/**
 * Phase 12.3 — BetweenGames monotonic-upward snapshot hook tests.
 *
 * Covers MMR-RACE-01 at the hook site (select_match_account post-insert
 * block added by Plan 12.3-03). Three scenarios:
 *
 *   1. HIGH -> LOW swap:  snapshot stays at HIGH  (Math.max rule)
 *   2. LOW  -> HIGH swap: snapshot raises to HIGH (Math.max rule)
 *   3. deselect_match_account: snapshot does NOT change (D-B-03 — deselect
 *      intentionally does not run the hook because removal cannot lower max).
 *
 * All scenarios reach BetweenGames by playing a best-of-3 casual match:
 *   start_draft -> Drafting -> completeDraft (auto -> Equipping) ->
 *   confirmLineup x2 -> advanceStage (-> Scoring) -> recordGameScores ->
 *   confirmMatchScores x2 -> advanceStage (-> BetweenGames because seriesBestOf > 1).
 *
 * Casual matchType is chosen so the D-08 LMA gate at start_draft:59-73 is
 * bypassed — scenarios 1 and 2 still manipulate the snapshot via the
 * HsrAccount.accountRating value that the hook reads at select time.
 *
 * File-extension note: same reasoning as mmr-snapshot.test.ts — `.test.ts`
 * so the integration runner picks the file up (`.unit.test.ts` is reserved
 * for pure-math unit tests by the unit config include pattern).
 *
 * Written via the explicit Plan 12.3-06 test-writing task (C10 exception).
 *
 * Contract: docs/lobby/contract.md — account selection (Phase 12.3,
 * decisions D-B-03, D-B-04, D-B-05).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    hasServerToken,
    queryPrivateTable,
    type TestHarness,
} from '../../shared/connection';
import { defaultLobbyArgs as sharedDefaultLobbyArgs } from '../../shared/helpers/lobbies';
import { createTournamentArgs } from '../../shared/helpers/tournaments';
import { promoteUser } from '../../shared/helpers/promoteUser';
import { completeDraft, completeTournamentDraft, advanceToScoring } from '../../shared/helpers/drafts';
import { gameScoreArgs } from '../../shared/helpers/scores';
import { characterBatch, KNOWN_CHARACTERS } from '../../shared/fixtures';

// ─── Helpers ────────────────────────────────────────────────────────────────

const defaultLobbyArgs = (overrides: Record<string, unknown> = {}) =>
    sharedDefaultLobbyArgs({ matchType: { tag: 'Casual' as const, value: {} }, ...overrides });

async function readAccountRating(accountId: number): Promise<number> {
    const rows = await queryPrivateTable(
        `SELECT id, account_rating FROM hsr_account WHERE id = ${accountId}`
    );
    if (rows.length === 0) return 0;
    return Number(rows[0].account_rating);
}

async function findAccountIdByUid(userId: number, uid: string): Promise<number> {
    const rows = await queryPrivateTable(
        `SELECT id, uid FROM hsr_account WHERE user_id = ${userId}`
    );
    const row = rows.find((r) => r.uid.replace(/"/g, '') === uid);
    if (!row) throw new Error(`No HsrAccount with uid=${uid} for user ${userId}`);
    return Number(row.id);
}

async function seedRosterForRating(
    h: TestHarness,
    hsrAccountId: number,
    eidolonLevel: number,
): Promise<void> {
    await h.call.batchUpsertCharacters({
        hsrAccountId,
        charactersJson: characterBatch(
            KNOWN_CHARACTERS.map((name) => ({ characterName: name, eidolonLevel }))
        ),
    });
    await h.sync(1500);
}

async function seedSingleCharacter(
    h: TestHarness,
    hsrAccountId: number,
): Promise<void> {
    await h.call.batchUpsertCharacters({
        hsrAccountId,
        charactersJson: characterBatch([{ characterName: KNOWN_CHARACTERS[0], eidolonLevel: 0 }]),
    });
    await h.sync(1500);
}

function findMrp(h: TestHarness, matchResultId: number, userId: number) {
    return [...h.conn.db.MatchResultParticipant.iter()].find(
        (p) => p.matchResultId === matchResultId && p.userId === userId
    );
}

/**
 * Drive a Casual best-of-3 lobby from Waiting -> BetweenGames.
 *
 *  1. host creates lobby (bestOf:3, matchType:Casual)
 *  2. blue and red join, take team slots, confirmReady
 *  3. host startDraft -> Drafting
 *  4. completeDraft -> Equipping (auto)
 *  5. advanceToScoring -> Scoring
 *  6. host recordGameScores(game 1, Blue wins)
 *  7. blue/red confirmMatchScores
 *  8. host advanceStage -> BetweenGames (seriesBestOf > 1 + game 1 recorded)
 *
 * Returns { lobbyId, matchResultId }. Caller is responsible for roster setup
 * BEFORE calling this helper (accounts + selected LMA must exist as needed).
 */
async function runToBetweenGames(
    host: TestHarness,
    blue: TestHarness,
    red: TestHarness,
    overrides: Record<string, unknown> = {},
): Promise<{ lobbyId: number; matchResultId: number }> {
    await host.call.createLobby(defaultLobbyArgs({ bestOf: 3, ...overrides }));
    await host.sync(1500);
    const lobby = [...host.conn.db.Lobby.iter()]
        .filter((l) => l.hostUserId === host.userId)
        .at(-1)!;
    const lobbyId = lobby.id;

    await blue.call.joinLobby({ lobbyId, joinCode: '', password: '' });
    await blue.sync(1000);
    await blue.call.setTeamSlot({
        lobbyId,
        targetUserId: blue.userId,
        lobbySlot: { tag: 'BluePlayer' as const },
    });
    await blue.sync();

    await red.call.joinLobby({ lobbyId, joinCode: '', password: '' });
    await red.sync(1000);
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

    await host.call.startDraft({ lobbyId });
    await host.sync(1500);
    await blue.sync(1500);
    await red.sync(1500);

    await completeDraft(blue, red, lobbyId);
    await host.sync(1500);
    await advanceToScoring(host, blue, red, lobbyId);

    const mr = [...host.conn.db.MatchResultRecord.iter()].find((r) => r.lobbyId === lobbyId);
    if (!mr) throw new Error(`No MatchResultRecord for lobby ${lobbyId}`);

    await host.call.recordGameScores(gameScoreArgs({
        matchResultId: mr.id,
        gameNumber: 1,
        winnerTeamSide: 'Blue',
        teamBlueCyclesUsed: 7,
        teamRedCyclesUsed: 10,
    }));
    await host.sync(1000);

    await blue.call.confirmMatchScores({ matchResultId: mr.id });
    await blue.sync(500);
    await red.call.confirmMatchScores({ matchResultId: mr.id });
    await red.sync(500);
    await host.sync(1000);

    // advance_stage from Scoring: seriesBestOf>1 -> BetweenGames (since neither
    // side has hit the winsNeeded = ceil(3/2) = 2 threshold yet).
    await host.call.advanceStage({ lobbyId });
    await host.sync(1500);
    await blue.sync(1500);
    await red.sync(1500);

    const lobbyNow = [...host.conn.db.Lobby.iter()].find((l) => l.id === lobbyId);
    if (!lobbyNow || lobbyNow.stage.tag !== 'BetweenGames') {
        throw new Error(
            `Expected lobby ${lobbyId} to be in BetweenGames after game 1, got ` +
            `${lobbyNow?.stage.tag ?? 'missing'}`
        );
    }

    return { lobbyId, matchResultId: mr.id };
}

async function concedeAndClose(
    host: TestHarness,
    blue: TestHarness,
    red: TestHarness,
    lobbyId: number,
): Promise<void> {
    try {
        await blue.call.concedeMatch({ lobbyId, losingTeamSide: 0 });
        await blue.sync(1000);
        await red.sync(1000);
        await host.sync(1000);
    } catch { /* ok */ }
    try { await blue.call.leaveLobby({ lobbyId }); } catch { /* ok */ }
    try { await red.call.leaveLobby({ lobbyId }); } catch { /* ok */ }
    try { await host.call.closeLobby({ lobbyId }); } catch { /* ok */ }
    await host.sync();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasServerToken())('Phase 12.3: BetweenGames monotonic-upward snapshot hook', () => {

    // ─── Scenario 1: HIGH -> LOW swap does NOT lower snapshot ──────────

    describe('HIGH -> LOW swap keeps snapshot at HIGH', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;
        let blueHighId: number;
        let blueLowId: number;
        let redAccountId: number;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();

            // Blue gets TWO accounts so we can swap mid-series. Drive
            // different ratings via roster size/eidolon.
            await blue.call.createHsrAccount({ uid: '812060001', displayLabel: 'Blue High' });
            await blue.sync(1500);
            await blue.call.createHsrAccount({ uid: '812060002', displayLabel: 'Blue Low' });
            await blue.sync(1500);
            blueHighId = await findAccountIdByUid(blue.userId, '812060001');
            blueLowId = await findAccountIdByUid(blue.userId, '812060002');

            await seedRosterForRating(blue, blueHighId, 6);   // HIGH: full E6 roster
            await seedSingleCharacter(blue, blueLowId);        // LOW: single E0 char

            // set_active -> blueHigh so the join-auto-seed picks it. Note the
            // second createHsrAccount would have auto-activated the second
            // account, so we need to explicitly set blueHigh active.
            await blue.call.setActiveHsrAccount({ hsrAccountId: blueHighId });
            await blue.sync(1000);

            // Red needs a single account so join auto-seed works too (the
            // non-tournament join seeds from the user's active account).
            await red.call.createHsrAccount({ uid: '812060003', displayLabel: 'Red Main' });
            await red.sync(1500);
            redAccountId = await findAccountIdByUid(red.userId, '812060003');
            await seedRosterForRating(red, redAccountId, 3);
        }, 180000);

        afterAll(async () => {
            try { await blue.call.deleteHsrAccount({ hsrAccountId: blueHighId }); } catch { /* ok */ }
            try { await blue.call.deleteHsrAccount({ hsrAccountId: blueLowId }); } catch { /* ok */ }
            try { await red.call.deleteHsrAccount({ hsrAccountId: redAccountId }); } catch { /* ok */ }
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('select_match_account on blueLow during BetweenGames leaves snapshot at blueHigh rating', async () => {
            const { lobbyId, matchResultId } = await runToBetweenGames(host, blue, red);

            // At start_draft, blue's active LMA was blueHigh (auto-seeded on
            // join). The snapshot should equal blueHigh's accountRating.
            const highRating = await readAccountRating(blueHighId);
            const lowRating = await readAccountRating(blueLowId);
            expect(highRating).toBeGreaterThan(lowRating);

            const mrpBefore = findMrp(host, matchResultId, blue.userId);
            expect(mrpBefore).toBeDefined();
            expect(mrpBefore!.accountRatingSnapshot).toBe(highRating);

            // Swap to blueLow in BetweenGames. Non-tournament replace path
            // deletes the existing LMA then inserts the new one — the Plan
            // 03 hook runs AFTER the insert.
            await blue.call.selectMatchAccount({ lobbyId, hsrAccountId: blueLowId });
            await blue.sync(1500);
            await host.sync(1500);

            // Snapshot MUST still equal highRating (Math.max rule).
            const mrpAfter = findMrp(host, matchResultId, blue.userId);
            expect(mrpAfter).toBeDefined();
            expect(mrpAfter!.accountRatingSnapshot).toBe(highRating);
            // Defensive: verify the LMA row actually changed so we know the
            // select reducer executed and we're not just seeing a no-op cache.
            const lmaNow = await queryPrivateTable(
                `SELECT hsr_account_id FROM lobby_member_account WHERE lobby_id = ${lobbyId} AND user_id = ${blue.userId}`
            );
            const selectedIds = lmaNow.map((r) => Number(r.hsr_account_id));
            expect(selectedIds).toContain(blueLowId);
            expect(selectedIds).not.toContain(blueHighId);

            await concedeAndClose(host, blue, red, lobbyId);
        }, 300000);
    });

    // ─── Scenario 2: LOW -> HIGH swap RAISES snapshot ──────────────────

    describe('LOW -> HIGH swap raises snapshot to HIGH', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;
        let blueHighId: number;
        let blueLowId: number;
        let redAccountId: number;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();

            await blue.call.createHsrAccount({ uid: '812060011', displayLabel: 'Blue High' });
            await blue.sync(1500);
            await blue.call.createHsrAccount({ uid: '812060012', displayLabel: 'Blue Low' });
            await blue.sync(1500);
            blueHighId = await findAccountIdByUid(blue.userId, '812060011');
            blueLowId = await findAccountIdByUid(blue.userId, '812060012');

            await seedRosterForRating(blue, blueHighId, 6);
            await seedSingleCharacter(blue, blueLowId);

            // Start with blueLow as ACTIVE so the auto-seed at join picks it.
            await blue.call.setActiveHsrAccount({ hsrAccountId: blueLowId });
            await blue.sync(1000);

            await red.call.createHsrAccount({ uid: '812060013', displayLabel: 'Red Main' });
            await red.sync(1500);
            redAccountId = await findAccountIdByUid(red.userId, '812060013');
            await seedRosterForRating(red, redAccountId, 3);
        }, 180000);

        afterAll(async () => {
            try { await blue.call.deleteHsrAccount({ hsrAccountId: blueHighId }); } catch { /* ok */ }
            try { await blue.call.deleteHsrAccount({ hsrAccountId: blueLowId }); } catch { /* ok */ }
            try { await red.call.deleteHsrAccount({ hsrAccountId: redAccountId }); } catch { /* ok */ }
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('select_match_account on blueHigh during BetweenGames raises snapshot', async () => {
            const { lobbyId, matchResultId } = await runToBetweenGames(host, blue, red);

            const highRating = await readAccountRating(blueHighId);
            const lowRating = await readAccountRating(blueLowId);
            expect(highRating).toBeGreaterThan(lowRating);

            const mrpBefore = findMrp(host, matchResultId, blue.userId);
            expect(mrpBefore).toBeDefined();
            expect(mrpBefore!.accountRatingSnapshot).toBe(lowRating);

            // Swap to blueHigh in BetweenGames. Math.max(lowRating, highRating)
            // = highRating — the hook MUST update the MRP row.
            await blue.call.selectMatchAccount({ lobbyId, hsrAccountId: blueHighId });
            await blue.sync(1500);
            await host.sync(1500);

            const mrpAfter = findMrp(host, matchResultId, blue.userId);
            expect(mrpAfter).toBeDefined();
            expect(mrpAfter!.accountRatingSnapshot).toBe(highRating);

            await concedeAndClose(host, blue, red, lobbyId);
        }, 300000);
    });

    // ─── Scenario 3: deselect_match_account does NOT modify snapshot ───

    describe('deselect_match_account does not lower snapshot', () => {
        let toUser: TestHarness;
        let player1: TestHarness;
        let player2: TestHarness;

        let tournamentId: number;
        let lobbyId: number;
        let matchResultId: number;

        let p1LowId: number;
        let p1HighId: number;
        let p2AccountId: number;

        beforeAll(async () => {
            toUser = await createVerifiedTestHarness();
            player1 = await createVerifiedTestHarness();
            player2 = await createVerifiedTestHarness();
            await toUser.sync();
            await player1.sync();
            await player2.sync();

            // Player1 needs TWO accounts — the tournament additive path lets
            // us have BOTH in the LMA simultaneously. Deselecting the HIGH one
            // leaves LOW but the snapshot should stay at HIGH.
            await player1.call.createHsrAccount({ uid: '812060021', displayLabel: 'P1 Low' });
            await player1.sync(1500);
            await player1.call.createHsrAccount({ uid: '812060022', displayLabel: 'P1 High' });
            await player1.sync(1500);
            p1LowId = await findAccountIdByUid(player1.userId, '812060021');
            p1HighId = await findAccountIdByUid(player1.userId, '812060022');

            await seedSingleCharacter(player1, p1LowId);
            await seedRosterForRating(player1, p1HighId, 6);

            await player2.call.createHsrAccount({ uid: '812060023', displayLabel: 'P2 Main' });
            await player2.sync(1500);
            p2AccountId = await findAccountIdByUid(player2.userId, '812060023');
            await seedRosterForRating(player2, p2AccountId, 3);

            const toRecord = [...toUser.conn.db.User.iter()].find((u) => u.id === toUser.userId);
            if (!toRecord) throw new Error('TO user not in cache');
            await promoteUser(toRecord.username, 'TournamentHost');
            await toUser.sync(1500);

            // Casual countTowardsMmr:false + defaultBestOf:3 so we reach
            // BetweenGames without triggering the ranked LMA gate.
            await toUser.call.createTournament(createTournamentArgs({
                name: `deselect no-op ${Date.now()}`,
                maxAccountsPerPlayer: 2,
                countTowardsMmr: false,
                defaultBestOf: 3,
                maxParticipants: 4,
            }));
            await toUser.sync(1500);
            const tournaments = [...toUser.conn.db.Tournament.iter()]
                .filter((t) => t.organizerId === toUser.userId);
            tournamentId = tournaments.at(-1)!.id;

            await toUser.call.advanceTournamentStage({ tournamentId, nextStage: 'Registration' });
            await toUser.sync(1500);
            await player1.call.registerForTournament({ tournamentId });
            await player1.sync(1500);
            await player2.call.registerForTournament({ tournamentId });
            await player2.sync(1500);
            await toUser.sync(1500);
            await toUser.call.advanceTournamentStage({ tournamentId, nextStage: 'Seeding' });
            await toUser.sync(1500);
            await toUser.call.seedBracket({ tournamentId, mode: 'random' });
            await toUser.sync(1500);
            await toUser.call.generateBracket({ tournamentId });
            await toUser.sync(1500);
            await toUser.call.advanceTournamentStage({ tournamentId, nextStage: 'InProgress' });
            await toUser.sync(1500);

            const bracketMatches = [...toUser.conn.db.BracketMatch.iter()]
                .filter((bm) => bm.tournamentId === tournamentId);
            if (bracketMatches.length === 0) throw new Error('No bracket matches');
            const bracketMatchId = bracketMatches[0].id;

            await toUser.call.createTournamentLobby({ bracketMatchId, joinCode: '' });
            await toUser.sync(1500);
            const lobby = [...toUser.conn.db.Lobby.iter()].find((l) => {
                const bm = (l as any).bracketMatchId;
                if (bm === null || bm === undefined) return false;
                if (typeof bm === 'object' && 'value' in bm) return (bm as any).value === bracketMatchId;
                return bm === bracketMatchId;
            });
            if (!lobby) throw new Error('Tournament lobby not found');
            lobbyId = lobby.id;

            await player1.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await player1.sync(1500);
            await player2.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await player2.sync(1500);
            await toUser.call.setTeamSlot({
                lobbyId,
                targetUserId: player1.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await toUser.sync(1500);
            await toUser.call.setTeamSlot({
                lobbyId,
                targetUserId: player2.userId,
                lobbySlot: { tag: 'RedPlayer' as const },
            });
            await toUser.sync(1500);
            await player1.sync(1500);
            await player2.sync(1500);

            // Ensure player1 has BOTH accounts selected before start_draft.
            const lmaRowsP1 = await queryPrivateTable(
                `SELECT hsr_account_id FROM lobby_member_account WHERE lobby_id = ${lobbyId} AND user_id = ${player1.userId}`
            );
            const alreadySelected = new Set(lmaRowsP1.map((r) => Number(r.hsr_account_id)));
            if (!alreadySelected.has(p1LowId)) {
                await player1.call.selectMatchAccount({ lobbyId, hsrAccountId: p1LowId });
                await player1.sync(1500);
            }
            if (!alreadySelected.has(p1HighId)) {
                await player1.call.selectMatchAccount({ lobbyId, hsrAccountId: p1HighId });
                await player1.sync(1500);
            }

            await player1.call.confirmReady({ lobbyId });
            await player1.sync();
            await player2.call.confirmReady({ lobbyId });
            await player2.sync();
            await toUser.sync();

            // Drive the tournament lobby to BetweenGames the same way
            // runToBetweenGames does, but using the tournament lobby created
            // above (cannot reuse the helper because it creates its own lobby).
            await toUser.call.startDraft({ lobbyId });
            await toUser.sync(1500);
            await player1.sync(1500);
            await player2.sync(1500);

            // Tournament lobbies default to BanMode=Four — use the tournament
            // draft helper (4 bans + 16 picks) rather than completeDraft (16 picks,
            // BanMode=None). Using completeDraft here produces "Current turn is
            // not a Pick." because the draft starts with the first ban phase.
            await completeTournamentDraft(player1, player2, lobbyId);
            await toUser.sync(1500);
            await advanceToScoring(toUser, player1, player2, lobbyId);

            const mr = [...toUser.conn.db.MatchResultRecord.iter()].find((r) => r.lobbyId === lobbyId);
            if (!mr) throw new Error('No MatchResultRecord for tournament lobby');
            matchResultId = mr.id;

            await toUser.call.recordGameScores(gameScoreArgs({
                matchResultId: mr.id,
                gameNumber: 1,
                winnerTeamSide: 'Blue',
                teamBlueCyclesUsed: 7,
                teamRedCyclesUsed: 10,
            }));
            await toUser.sync(1000);

            await player1.call.confirmMatchScores({ matchResultId: mr.id });
            await player1.sync(500);
            await player2.call.confirmMatchScores({ matchResultId: mr.id });
            await player2.sync(500);
            await toUser.sync(1000);

            await toUser.call.advanceStage({ lobbyId });
            await toUser.sync(1500);
            await player1.sync(1500);
            await player2.sync(1500);

            const lobbyNow = [...toUser.conn.db.Lobby.iter()].find((l) => l.id === lobbyId);
            if (!lobbyNow || lobbyNow.stage.tag !== 'BetweenGames') {
                throw new Error(
                    `Expected BetweenGames after game 1, got ${lobbyNow?.stage.tag ?? 'missing'}`
                );
            }
        }, 300000);

        afterAll(async () => {
            try { await player1.call.concedeMatch({ lobbyId, losingTeamSide: 0 }); } catch { /* ok */ }
            await player1.sync(1000);
            await player2.sync(1000);
            await toUser.sync(1000);
            try { await player1.call.leaveLobby({ lobbyId }); } catch { /* ok */ }
            try { await player2.call.leaveLobby({ lobbyId }); } catch { /* ok */ }
            try { await toUser.call.closeLobby({ lobbyId }); } catch { /* ok */ }
            try { await toUser.call.cancelTournament({ tournamentId }); } catch { /* ok */ }

            try { await player1.call.deleteHsrAccount({ hsrAccountId: p1LowId }); } catch { /* ok */ }
            try { await player1.call.deleteHsrAccount({ hsrAccountId: p1HighId }); } catch { /* ok */ }
            try { await player2.call.deleteHsrAccount({ hsrAccountId: p2AccountId }); } catch { /* ok */ }

            await toUser?.disconnect();
            await player1?.disconnect();
            await player2?.disconnect();
        });

        it('deselect_match_account on blueHigh in BetweenGames leaves snapshot at max', async () => {
            // Baseline: snapshot was captured at start_draft as max(low, high) = high.
            const lowRating = await readAccountRating(p1LowId);
            const highRating = await readAccountRating(p1HighId);
            expect(highRating).toBeGreaterThan(lowRating);

            const mrpBefore = findMrp(toUser, matchResultId, player1.userId);
            expect(mrpBefore).toBeDefined();
            expect(mrpBefore!.accountRatingSnapshot).toBe(highRating);

            // Deselect the HIGH account in BetweenGames. Per D-B-03 the deselect
            // reducer does NOT run the monotonic hook, so snapshot stays at HIGH
            // even though the currently-selected LMA rows no longer include it.
            await player1.call.deselectMatchAccount({ lobbyId, hsrAccountId: p1HighId });
            await player1.sync(1500);
            await toUser.sync(1500);

            // Verify the LMA row actually disappeared (so we know deselect ran).
            const lmaNow = await queryPrivateTable(
                `SELECT hsr_account_id FROM lobby_member_account WHERE lobby_id = ${lobbyId} AND user_id = ${player1.userId}`
            );
            const selectedIds = lmaNow.map((r) => Number(r.hsr_account_id));
            expect(selectedIds).not.toContain(p1HighId);
            expect(selectedIds).toContain(p1LowId);

            // Snapshot is unchanged — D-B-03 "deselect never lowers max".
            const mrpAfter = findMrp(toUser, matchResultId, player1.userId);
            expect(mrpAfter).toBeDefined();
            expect(mrpAfter!.accountRatingSnapshot).toBe(highRating);
        }, 60000);
    });
});
