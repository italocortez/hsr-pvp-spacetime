/**
 * Phase 12.3 — MatchResultParticipant.accountRatingSnapshot capture tests.
 *
 * Covers MMR-RACE-01 at the capture site (start_draft). Three scenarios:
 *   1. Non-tournament single LMA:
 *      snapshot == that account's HsrAccount.accountRating.
 *   2. Tournament multi-account (maxAccountsPerPlayer: 2):
 *      snapshot == max(accountRating) across the caller's LMA rows.
 *   3. Casual no-LMA default-0:
 *      snapshot == 0 when a participant has zero LMA rows at capture time
 *      (only reachable when the user has no HsrAccount at all, so the
 *      lobbyLifecycle.ts:322 auto-seed short-circuits).
 *
 * File extension note: the plan originally suggested `mmr-snapshot.unit.test.ts`,
 * but the project reserves `.unit.test.ts` for pure-math unit tests (see
 * `test/vitest.config.ts`: `include: ['test/backend/**\/*.unit.test.ts']` and
 * `test/vitest.integration.config.ts`: `!test/backend/**\/*.unit.test.ts`).
 * This is an integration test that spins up verified harnesses and exercises
 * reducers, so we use `.test.ts` to land under the integration runner.
 *
 * This file is written via the explicit Plan 12.3-06 test-writing task
 * (C10 exception). Pre-existing tests are never touched by this file.
 *
 * Contract: docs/match-results/contract.md — MMR snapshot capture (Phase 12.3,
 * decisions D-A-01, D-B-01, D-B-02).
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
import { characterBatch, KNOWN_CHARACTERS } from '../../shared/fixtures';

// ─── Helpers ────────────────────────────────────────────────────────────────

const defaultLobbyArgs = (overrides: Record<string, unknown> = {}) =>
    sharedDefaultLobbyArgs({ matchType: { tag: 'Ranked' as const, value: {} }, ...overrides });

/** Read HsrAccount.accountRating for a specific account id via private table query. */
async function readAccountRating(accountId: number): Promise<number> {
    const rows = await queryPrivateTable(
        `SELECT id, account_rating FROM hsr_account WHERE id = ${accountId}`
    );
    if (rows.length === 0) return 0;
    return Number(rows[0].account_rating);
}

/** Look up the HsrAccount row id for a user/uid pair via private table query. */
async function findAccountIdByUid(userId: number, uid: string): Promise<number> {
    const rows = await queryPrivateTable(
        `SELECT id, uid FROM hsr_account WHERE user_id = ${userId}`
    );
    const row = rows.find((r) => r.uid.replace(/"/g, '') === uid);
    if (!row) throw new Error(`No HsrAccount with uid=${uid} for user ${userId}`);
    return Number(row.id);
}

/**
 * Drive a known accountRating onto a specific HsrAccount by upserting a batch
 * of characters with a chosen eidolon level. The roster module recomputes
 * accountRating at the end of batch_upsert_characters (D-D-02).
 */
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

/** Iterate the MRP cache and return the row for (matchResultId, userId), if any. */
function findMrp(h: TestHarness, matchResultId: number, userId: number) {
    return [...h.conn.db.MatchResultParticipant.iter()].find(
        (p) => p.matchResultId === matchResultId && p.userId === userId
    );
}

/** Create a casual lobby → have blue/red join → confirm → start_draft.
 *  Returns {lobbyId, matchResultId}.
 *  This helper DOES NOT call ensureHsrAccount — callers are responsible for
 *  roster setup because Scenario 3 needs blue/red to have no accounts. */
async function runLobbyToStartDraft(
    host: TestHarness,
    blue: TestHarness,
    red: TestHarness,
    lobbyOverrides: Record<string, unknown> = {},
): Promise<{ lobbyId: number; matchResultId: number }> {
    await host.call.createLobby(defaultLobbyArgs(lobbyOverrides));
    await host.sync(1500);
    const lobby = [...host.conn.db.Lobby.iter()]
        .filter((l) => l.hostUserId === host.userId)
        .at(-1)!;
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

    await host.call.startDraft({ lobbyId });
    await host.sync(1500);
    await blue.sync(1500);
    await red.sync(1500);

    const mr = [...host.conn.db.MatchResultRecord.iter()].find((r) => r.lobbyId === lobbyId);
    if (!mr) throw new Error(`No MatchResultRecord for lobby ${lobbyId}`);
    return { lobbyId, matchResultId: mr.id };
}

/** Cleanup helper — concede after start_draft so the lobby is disposed. */
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
    } catch { /* already finalized */ }
    try {
        await blue.call.leaveLobby({ lobbyId });
        await blue.sync();
    } catch { /* ok */ }
    try {
        await red.call.leaveLobby({ lobbyId });
        await red.sync();
    } catch { /* ok */ }
    try {
        await host.call.closeLobby({ lobbyId });
        await host.sync();
    } catch { /* ok */ }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasServerToken())('Phase 12.3: MMR accountRatingSnapshot capture', () => {

    // ─── Scenario 1: Non-tournament single LMA ──────────────────────────

    describe('non-tournament single LMA', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();
        }, 60000);

        afterAll(async () => {
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('snapshot equals the single LMA account accountRating for each participant', async () => {
            // Blue and red each create a single HSR account with a non-zero rating.
            await blue.call.createHsrAccount({ uid: '812030001', displayLabel: 'Blue LMA' });
            await blue.sync(1500);
            await red.call.createHsrAccount({ uid: '812030002', displayLabel: 'Red LMA' });
            await red.sync(1500);

            const blueAccountId = await findAccountIdByUid(blue.userId, '812030001');
            const redAccountId = await findAccountIdByUid(red.userId, '812030002');

            // Drive ratings by upserting a full KNOWN_CHARACTERS roster. Eidolon 2
            // vs eidolon 5 gives two clearly different accountRating values so
            // the test catches wire swaps (blue vs red) as well as zero defaults.
            await seedRosterForRating(blue, blueAccountId, 2);
            await seedRosterForRating(red, redAccountId, 5);

            const blueRating = await readAccountRating(blueAccountId);
            const redRating = await readAccountRating(redAccountId);
            // Sanity: batch_upsert actually produced non-zero ratings so the
            // test is meaningful. If this fails, the AccountRatingConfig seed
            // or KNOWN_CHARACTERS mapping has drifted and the whole test is
            // invalid — report, do NOT auto-fix.
            expect(blueRating).toBeGreaterThan(0);
            expect(redRating).toBeGreaterThan(0);
            expect(blueRating).not.toBe(redRating);

            const { lobbyId, matchResultId } = await runLobbyToStartDraft(host, blue, red);

            const blueMrp = findMrp(host, matchResultId, blue.userId);
            const redMrp = findMrp(host, matchResultId, red.userId);
            expect(blueMrp).toBeDefined();
            expect(redMrp).toBeDefined();
            expect(blueMrp!.accountRatingSnapshot).toBe(blueRating);
            expect(redMrp!.accountRatingSnapshot).toBe(redRating);

            await concedeAndClose(host, blue, red, lobbyId);

            // Clean up the HsrAccounts so later scenarios aren't polluted.
            try { await blue.call.deleteHsrAccount({ hsrAccountId: blueAccountId }); } catch { /* ok */ }
            try { await red.call.deleteHsrAccount({ hsrAccountId: redAccountId }); } catch { /* ok */ }
            await blue.sync();
            await red.sync();
        }, 180000);
    });

    // ─── Scenario 2: Tournament multi-account (max) ─────────────────────

    describe('tournament multi-account max aggregation', () => {
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

            // Player1 needs TWO accounts BEFORE registering (TPA snapshot locks
            // the accounts that exist at registration time). Drive different
            // ratings via roster size/eidolon.
            await player1.call.createHsrAccount({ uid: '812030101', displayLabel: 'P1 Low' });
            await player1.sync(1500);
            await player1.call.createHsrAccount({ uid: '812030102', displayLabel: 'P1 High' });
            await player1.sync(1500);
            p1LowId = await findAccountIdByUid(player1.userId, '812030101');
            p1HighId = await findAccountIdByUid(player1.userId, '812030102');

            // LOW rating: single E0 character. HIGH rating: full roster at E6.
            // The horizontal+vertical scoring produces a strictly larger rating
            // for the E6 full roster.
            await player1.call.batchUpsertCharacters({
                hsrAccountId: p1LowId,
                charactersJson: characterBatch([{ characterName: KNOWN_CHARACTERS[0], eidolonLevel: 0 }]),
            });
            await player1.sync(1500);
            await seedRosterForRating(player1, p1HighId, 6);

            // Player2 just needs one account to pass registration.
            await player2.call.createHsrAccount({ uid: '812030103', displayLabel: 'P2 Main' });
            await player2.sync(1500);
            p2AccountId = await findAccountIdByUid(player2.userId, '812030103');
            await seedRosterForRating(player2, p2AccountId, 3);

            // Promote TO user to TournamentHost so createTournament succeeds.
            const toRecord = [...toUser.conn.db.User.iter()].find((u) => u.id === toUser.userId);
            if (!toRecord) throw new Error('TO user not in cache');
            await promoteUser(toRecord.username, 'TournamentHost');
            await toUser.sync(1500);

            // Create tournament with max 2 accounts per player and MMR enabled
            // (so the snapshot path is exercised). Then walk the full lifecycle.
            await toUser.call.createTournament(createTournamentArgs({
                name: `MMR snap test ${Date.now()}`,
                maxAccountsPerPlayer: 2,
                countTowardsMmr: true,
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

            // Pick a bracket match that both players are assigned to.
            const bracketMatches = [...toUser.conn.db.BracketMatch.iter()]
                .filter((bm) => bm.tournamentId === tournamentId);
            if (bracketMatches.length === 0) throw new Error('No bracket matches generated');
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

            // Both players join. player1 ends up on Blue, player2 on Red.
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

            // Player1 selects BOTH accounts (additive under tournament path).
            // LobbyMemberAccount is private → use SQL to check what's already
            // selected, so we only call select for the other one(s).
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

            await toUser.call.startDraft({ lobbyId });
            await toUser.sync(1500);
            await player1.sync(1500);
            await player2.sync(1500);

            const mr = [...toUser.conn.db.MatchResultRecord.iter()].find((r) => r.lobbyId === lobbyId);
            if (!mr) throw new Error('No MatchResultRecord for tournament lobby');
            matchResultId = mr.id;
        }, 240000);

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

        it('snapshot equals max(accountRating) across the LMA rows (additive path)', async () => {
            // Confirm player1 has both LMA rows.
            const lmaRowsP1 = await queryPrivateTable(
                `SELECT hsr_account_id FROM lobby_member_account WHERE lobby_id = ${lobbyId} AND user_id = ${player1.userId}`
            );
            const selectedIds = lmaRowsP1.map((r) => Number(r.hsr_account_id)).sort();
            expect(selectedIds).toContain(p1LowId);
            expect(selectedIds).toContain(p1HighId);

            const lowRating = await readAccountRating(p1LowId);
            const highRating = await readAccountRating(p1HighId);
            // Sanity: HIGH must actually be strictly greater than LOW so the
            // max rule is meaningfully tested.
            expect(highRating).toBeGreaterThan(lowRating);

            const p1Mrp = findMrp(toUser, matchResultId, player1.userId);
            expect(p1Mrp).toBeDefined();
            expect(p1Mrp!.accountRatingSnapshot).toBe(Math.max(lowRating, highRating));
            expect(p1Mrp!.accountRatingSnapshot).toBe(highRating);
        }, 60000);
    });

    // ─── Scenario 3: Casual no-LMA default 0 ────────────────────────────

    describe('casual no-LMA default 0', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();

            // Intentionally DO NOT create any HsrAccount for blue/red. The
            // lobby-lifecycle join path auto-seeds an LMA only when the joining
            // user has an active HsrAccount (lobbyLifecycle.ts:322-323). With
            // zero accounts, no LMA is created → snapshot defaults to 0.
        }, 60000);

        afterAll(async () => {
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('snapshot defaults to 0 when a casual participant has zero LMA rows', async () => {
            // Must be Casual explicitly — Ranked would be rejected by the D-08
            // LMA gate at start_draft:59-73.
            const { lobbyId, matchResultId } = await runLobbyToStartDraft(host, blue, red, {
                matchType: { tag: 'Casual' as const, value: {} },
            });

            // Confirm no LMA rows exist for blue/red (sanity — if auto-seed
            // changes, the test invariant is wrong, not the production code).
            const blueLma = await queryPrivateTable(
                `SELECT hsr_account_id FROM lobby_member_account WHERE lobby_id = ${lobbyId} AND user_id = ${blue.userId}`
            );
            const redLma = await queryPrivateTable(
                `SELECT hsr_account_id FROM lobby_member_account WHERE lobby_id = ${lobbyId} AND user_id = ${red.userId}`
            );
            expect(blueLma.length).toBe(0);
            expect(redLma.length).toBe(0);

            const blueMrp = findMrp(host, matchResultId, blue.userId);
            const redMrp = findMrp(host, matchResultId, red.userId);
            expect(blueMrp).toBeDefined();
            expect(redMrp).toBeDefined();
            expect(blueMrp!.accountRatingSnapshot).toBe(0);
            expect(redMrp!.accountRatingSnapshot).toBe(0);

            await concedeAndClose(host, blue, red, lobbyId);
        }, 180000);
    });
});
