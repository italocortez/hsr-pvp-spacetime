/**
 * Integration tests: D-I-04 auto-pick ownership pool — four behavioral corrections.
 *
 * Phase 12.3 Plan 07 Task 3. Owns regression coverage for:
 *   - D-I-01/02: timer_expiry_classic ownership-pool block migrated from
 *     HsrAccount.isActive to LobbyMemberAccount.by_lobby_and_user (Plan 01).
 *   - D-I-04 four behavioral corrections (now observable through the auto-pick
 *     path):
 *       (1) Non-tournament: isActive=A but LMA=B → pool is B's characters.
 *       (2) Multi-account tournament: union of ALL selected LMA accounts.
 *       (3) Stand-in: contributes their selected LMA chars, not the original
 *           captain's isActive chars.
 *       (4) Casual requireOwnership with a member missing LMA → that member
 *           contributes empty, pool is still assembled from the remaining team.
 *
 * The D-I-04 code block lives at draftClassic.ts:670-691 (post-Plan 01). The
 * auto-pick path is reached via `timer_expiry_classic` with a short turn timer
 * and `autoRandomPick=true` + `requireOwnership=true`.
 *
 * Pitfall 9 (RESEARCH.md): pre-existing draft-classic.test.ts / post-draft.test.ts
 * tests may have been passing because of the OLD isActive-based pool. Per C10,
 * Plan 07 does NOT fix those — it REPORTS them in the summary if observed.
 *
 * Scenarios that cannot be set up cleanly are marked `it.skip(...)` with
 * explanation. Manual UAT owns the gaps.
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 *
 * Contract: docs/match-session/contract.md — timer_expiry_classic auto-pick pool
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    hasServerToken,
    sleep,
    queryPrivateTable,
    type TestHarness,
} from '../../shared/connection';
import { defaultLobbyArgs } from '../../shared/helpers/lobbies';
import { defaultSettingsArgs } from '../../shared/helpers/lobbies';
import { startDraftAndSync } from '../../shared/helpers/drafts';
import { myLobbies } from '../../shared/helpers/queries';
import { promoteToRole } from '../../shared/helpers/promoteUser';
import {
    setupRegistrationTournament,
    advanceToInProgress,
    cleanupTournament,
} from '../../shared/helpers/tournaments';
import { characterBatch, nextUid, resetUidCounter } from '../../shared/fixtures';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get the MatchSession for a lobby. */
function getSession(h: TestHarness, lobbyId: number) {
    return [...h.conn.db.MatchSession.iter()].find(s => s.lobbyId === lobbyId);
}

/** Get all MatchSessionStep rows for a lobby, sorted by sequence. */
function getSteps(h: TestHarness, lobbyId: number) {
    return [...h.conn.db.MatchSessionStep.iter()]
        .filter(s => s.lobbyId === lobbyId)
        .sort((a, b) => a.sequence - b.sequence);
}

/** Create an HsrAccount for `h`, return its id. */
async function createAccount(
    h: TestHarness,
    uid: string,
    label: string,
): Promise<number> {
    await h.call.createHsrAccount({ uid, displayLabel: label });
    await h.sync(1000);
    const rows = await queryPrivateTable(
        `SELECT * FROM hsr_account WHERE user_id = ${h.userId}`
    );
    const row = rows.find(a => a.uid.replace(/"/g, '') === uid);
    if (!row) throw new Error(`Failed to create HsrAccount for uid=${uid}`);
    return Number(row.id);
}

/** Seed characters on an HsrAccount via batch_upsert_characters. */
async function seedChars(
    h: TestHarness,
    hsrAccountId: number,
    chars: string[],
): Promise<void> {
    await h.call.batchUpsertCharacters({
        hsrAccountId,
        charactersJson: characterBatch(chars.map(c => ({ characterName: c, eidolonLevel: 0 }))),
    });
    await h.sync();
}

/** Set up a 1v1 draft lobby: host + blue + red with the given overrides. */
async function setupDraftLobby(
    host: TestHarness,
    blue: TestHarness,
    red: TestHarness,
    lobbyOverrides: Record<string, unknown> = {},
): Promise<number> {
    await host.call.createLobby(defaultLobbyArgs(lobbyOverrides));
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

    return lobbyId;
}

/** Best-effort teardown: every member leaves the lobby. */
async function leaveAll(lobbyId: number, ...harnesses: TestHarness[]) {
    for (const h of harnesses) {
        try {
            await h.call.leaveLobby({ lobbyId });
            await h.sync();
        } catch { /* member may have already left */ }
    }
}

/** Trigger timer_expiry_classic after waiting out a 1-second standard turn. */
async function fireTimerExpiry(host: TestHarness, lobbyId: number): Promise<void> {
    // standardTurnSeconds=1 → wait 2.5s for server-side validation
    // (matchFinalization of draftClassic.ts:629-637 checks elapsedMs >= turnLimitMs).
    await sleep(2500);
    await host.call.timerExpiryClassic({ lobbyId });
    await host.sync(1500);
}

/**
 * Extract the first auto-pick character name from the match session steps.
 * Returns undefined if no Pick step from actorUserId=0 (system) is found.
 */
function firstAutoPickChar(h: TestHarness, lobbyId: number): string | undefined {
    const steps = getSteps(h, lobbyId);
    const autoPick = steps.find(
        s => s.action.tag === 'Pick' &&
             s.actorUserId === 0 &&
             s.payload.tag === 'Pick'
    );
    if (!autoPick) return undefined;
    return (autoPick.payload.value as any).characterName as string;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasServerToken())('Auto-Pick Ownership Pool (D-I-04)', () => {
    // Use disjoint character sets so the auto-pick assertion is unambiguous:
    //   Account A pool (isActive) = { acheron, aglaea }
    //   Account B pool (selected) = { argenti, arlan }
    // These are all drawn from KNOWN_CHARACTERS (seeded in test data).
    const A_CHARS = ['acheron', 'aglaea'] as const;
    const B_CHARS = ['argenti', 'arlan'] as const;

    // ─── Scenario 1 — Non-tournament: LMA diverges from isActive ─────────

    describe('Scenario 1 — non-tournament: isActive=A but LMA=B → auto-pick uses B', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;
        let blueAccountA: number;
        let blueAccountB: number;
        let redAccount: number;

        beforeAll(async () => {
            resetUidCounter();
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();

            // Blue: account A (isActive, first created) with A_CHARS;
            //       account B with B_CHARS.
            // Pool assertion requires `requireOwnership=true` — the D-I-04 block.
            blueAccountA = await createAccount(blue, nextUid(), 'Blue A (isActive)');
            await seedChars(blue, blueAccountA, [...A_CHARS]);
            blueAccountB = await createAccount(blue, nextUid(), 'Blue B (selected)');
            await seedChars(blue, blueAccountB, [...B_CHARS]);

            // Red needs SOMETHING to pass the autoRandomPick+requireOwnership gate.
            redAccount = await createAccount(red, nextUid(), 'Red Main');
            await seedChars(red, redAccount, ['bailu', 'blackswan']);
        }, 60000);

        afterAll(async () => {
            try { await blue.call.deleteHsrAccount({ hsrAccountId: blueAccountA }); } catch {}
            try { await blue.call.deleteHsrAccount({ hsrAccountId: blueAccountB }); } catch {}
            try { await red.call.deleteHsrAccount({ hsrAccountId: redAccount }); } catch {}
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('auto-pick for blue draws from account B (LMA), not account A (isActive)', async () => {
            // Non-tournament lobby with autoRandomPick+requireOwnership so
            // timer_expiry_classic enters the D-I-04 LMA-based ownership pool block.
            const lobbyId = await setupDraftLobby(host, blue, red, {
                matchType: { tag: 'Casual' as const, value: {} },
                requireOwnership: true,
                autoRandomPick: true,
                standardTurnSeconds: 1,
            });

            // Blue joined → auto-LMA seeded with isActive account A.
            // Swap to account B via select_match_account (replace-semantics in casual).
            await blue.call.selectMatchAccount({ lobbyId, hsrAccountId: blueAccountB });
            await blue.sync();

            // Start draft. Turn 0 is Blue Pick.
            await startDraftAndSync(host, blue, red, lobbyId);

            const sessionBefore = getSession(host, lobbyId);
            expect(sessionBefore).toBeDefined();
            expect(sessionBefore!.turnIndex).toBe(0);

            // Wait out the turn timer and fire timer_expiry_classic.
            await fireTimerExpiry(host, lobbyId);

            const picked = firstAutoPickChar(host, lobbyId);
            expect(picked).toBeDefined();
            // Correction (1): pool came from account B, NOT account A.
            expect(B_CHARS).toContain(picked!);
            expect(A_CHARS).not.toContain(picked!);

            await leaveAll(lobbyId, blue, red, host);
        }, 60000);
    });

    // ─── Scenario 2 — Multi-account tournament (LMA-union) ────────────────

    describe('Scenario 2 — tournament: union of both selected LMA accounts', () => {
        let toUser: TestHarness;
        let p1: TestHarness;
        let p2: TestHarness;
        let tournamentId: number;
        let p1AccountA: number;
        let p1AccountB: number;
        let p2Account: number;

        // Account A pool (only on A): acheron, aglaea
        // Account B pool (only on B): argenti, arlan
        // Union should be: acheron, aglaea, argenti, arlan
        const P1_A_CHARS = ['acheron', 'aglaea'] as const;
        const P1_B_CHARS = ['argenti', 'arlan'] as const;
        const P1_UNION = [...P1_A_CHARS, ...P1_B_CHARS] as const;

        beforeAll(async () => {
            resetUidCounter();
            toUser = await createVerifiedTestHarness();
            p1 = await createVerifiedTestHarness();
            p2 = await createVerifiedTestHarness();
            await toUser.sync();
            await p1.sync();
            await p2.sync();

            await promoteToRole(toUser, 'TournamentHost');
            await toUser.sync(1500);

            // P1: two accounts with disjoint character sets (before registration
            // so TPA snapshot captures both).
            p1AccountA = await createAccount(p1, nextUid(), 'P1-A');
            await seedChars(p1, p1AccountA, [...P1_A_CHARS]);
            p1AccountB = await createAccount(p1, nextUid(), 'P1-B');
            await seedChars(p1, p1AccountB, [...P1_B_CHARS]);

            // P2: one account with different chars so red pool doesn't collide.
            p2Account = await createAccount(p2, nextUid(), 'P2');
            await seedChars(p2, p2Account, ['bailu', 'blackswan']);
        }, 120000);

        afterAll(async () => {
            if (tournamentId) await cleanupTournament(toUser, tournamentId);
            try { await p1.call.deleteHsrAccount({ hsrAccountId: p1AccountA }); } catch {}
            try { await p1.call.deleteHsrAccount({ hsrAccountId: p1AccountB }); } catch {}
            try { await p2.call.deleteHsrAccount({ hsrAccountId: p2Account }); } catch {}
            await toUser?.disconnect();
            await p1?.disconnect();
            await p2?.disconnect();
        });

        it('auto-pick for p1 draws from union of both LMA accounts', async () => {
            // Tournament with requireOwnership + maxAccountsPerPlayer=2
            tournamentId = await setupRegistrationTournament(toUser, [p1, p2], {
                name: `OwnerPool Union ${Date.now()}`,
                countTowardsMmr: false,
                maxAccountsPerPlayer: 2,
                requireOwnership: true,
            });
            await advanceToInProgress(toUser, tournamentId);

            const bracketMatches = [...toUser.conn.db.BracketMatch.iter()].filter(
                bm => bm.tournamentId === tournamentId
            );
            expect(bracketMatches.length).toBeGreaterThan(0);
            const bracketMatchId = bracketMatches[0].id;

            // Create tournament lobby
            await toUser.call.createTournamentLobby({ bracketMatchId, joinCode: '' });
            await toUser.sync(1500);
            const lobby = [...toUser.conn.db.Lobby.iter()].find(l => {
                const bm = l.bracketMatchId;
                if (bm == null) return false;
                return typeof bm === 'number' ? bm === bracketMatchId : (bm as any).value === bracketMatchId;
            });
            expect(lobby).toBeDefined();
            const lobbyId = lobby!.id;

            // Enable autoRandomPick + BanMode=None via update_lobby_settings
            // (both are free fields for tournaments). BanMode=None ensures turn 0
            // is a Pick (tournament default BanMode=Four starts with bans).
            await toUser.call.updateLobbySettings(defaultSettingsArgs(lobbyId, {
                autoRandomPick: true,
                standardTurnSeconds: 1,
                banMode: { tag: 'None', value: {} },
            }));
            await toUser.sync(1000);

            // P1 joins → auto-LMA seeds with active account
            await p1.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await p1.sync(1500);

            // Set P1 to Blue BEFORE selecting accounts (Spectators cannot select)
            await toUser.call.setTeamSlot({ lobbyId, targetUserId: p1.userId, lobbySlot: { tag: 'BluePlayer' as const } });
            await toUser.sync();

            // Tournament additive path: select BOTH accounts into LMA
            const lmaBefore = await queryPrivateTable(
                `SELECT hsr_account_id FROM lobby_member_account WHERE lobby_id = ${lobbyId} AND user_id = ${p1.userId}`
            );
            const alreadySelected = new Set(lmaBefore.map(r => Number(r.hsr_account_id)));
            if (!alreadySelected.has(p1AccountA)) {
                await p1.call.selectMatchAccount({ lobbyId, hsrAccountId: p1AccountA });
                await p1.sync(1000);
            }
            if (!alreadySelected.has(p1AccountB)) {
                await p1.call.selectMatchAccount({ lobbyId, hsrAccountId: p1AccountB });
                await p1.sync(1000);
            }

            // Verify both accounts in LMA
            const lmaAfter = await queryPrivateTable(
                `SELECT hsr_account_id FROM lobby_member_account WHERE lobby_id = ${lobbyId} AND user_id = ${p1.userId}`
            );
            const lmaIds = lmaAfter.map(r => Number(r.hsr_account_id));
            expect(lmaIds).toContain(p1AccountA);
            expect(lmaIds).toContain(p1AccountB);

            // P2 as Red (P1 already Blue from earlier setTeamSlot)
            await p2.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await p2.sync(1500);
            await toUser.call.setTeamSlot({ lobbyId, targetUserId: p2.userId, lobbySlot: { tag: 'RedPlayer' as const } });
            await toUser.sync();

            await p1.call.confirmReady({ lobbyId });
            await p1.sync();
            await p2.call.confirmReady({ lobbyId });
            await p2.sync();
            await toUser.sync();

            // Start draft and wait for timer expiry
            await startDraftAndSync(toUser, p1, p2, lobbyId);
            await fireTimerExpiry(toUser, lobbyId);

            const picked = firstAutoPickChar(toUser, lobbyId);
            expect(picked).toBeDefined();
            // The auto-picked character must be from the UNION of A + B chars
            expect(P1_UNION).toContain(picked!);

            await leaveAll(lobbyId, p1, p2, toUser);
        }, 120000);
    });

    // ─── Scenario 3 — Stand-in contributes LMA chars ──────────────────────

    describe('Scenario 3 — stand-in contributes LMA chars, not original player isActive', () => {
        let toUser: TestHarness;
        let original: TestHarness;
        let standIn: TestHarness;
        let opponent: TestHarness;
        let tournamentId: number;
        let originalAccount: number;
        let standInAccount: number;
        let opponentAccount: number;

        // Original player's chars (should NOT appear in pool after replacement)
        const ORIGINAL_CHARS = ['acheron', 'aglaea'] as const;
        // Stand-in's chars (SHOULD appear in pool)
        const STANDIN_CHARS = ['argenti', 'arlan'] as const;

        beforeAll(async () => {
            resetUidCounter();
            toUser = await createVerifiedTestHarness();
            original = await createVerifiedTestHarness();
            standIn = await createVerifiedTestHarness();
            opponent = await createVerifiedTestHarness();
            await toUser.sync();
            await original.sync();
            await standIn.sync();
            await opponent.sync();

            await promoteToRole(toUser, 'TournamentHost');
            await toUser.sync(1500);

            originalAccount = await createAccount(original, nextUid(), 'Original');
            await seedChars(original, originalAccount, [...ORIGINAL_CHARS]);

            standInAccount = await createAccount(standIn, nextUid(), 'StandIn');
            await seedChars(standIn, standInAccount, [...STANDIN_CHARS]);

            opponentAccount = await createAccount(opponent, nextUid(), 'Opponent');
            await seedChars(opponent, opponentAccount, ['bailu', 'blackswan']);
        }, 120000);

        afterAll(async () => {
            if (tournamentId) await cleanupTournament(toUser, tournamentId);
            try { await original.call.deleteHsrAccount({ hsrAccountId: originalAccount }); } catch {}
            try { await standIn.call.deleteHsrAccount({ hsrAccountId: standInAccount }); } catch {}
            try { await opponent.call.deleteHsrAccount({ hsrAccountId: opponentAccount }); } catch {}
            await toUser?.disconnect();
            await original?.disconnect();
            await standIn?.disconnect();
            await opponent?.disconnect();
        });

        it('auto-pick after stand-in replacement draws from stand-in LMA, not original', async () => {
            // Create tournament with requireOwnership
            tournamentId = await setupRegistrationTournament(toUser, [original, opponent], {
                name: `StandIn Pool ${Date.now()}`,
                countTowardsMmr: false,
                requireOwnership: true,
            });
            await advanceToInProgress(toUser, tournamentId);

            const bracketMatches = [...toUser.conn.db.BracketMatch.iter()].filter(
                bm => bm.tournamentId === tournamentId
            );
            expect(bracketMatches.length).toBeGreaterThan(0);
            const bracketMatchId = bracketMatches[0].id;

            // Approve stand-in for this bracket match (D-68)
            await toUser.call.approveStandIn({ bracketMatchId, userId: standIn.userId });
            await toUser.sync(1000);

            // Create tournament lobby
            await toUser.call.createTournamentLobby({ bracketMatchId, joinCode: '' });
            await toUser.sync(1500);
            const lobby = [...toUser.conn.db.Lobby.iter()].find(l => {
                const bm = l.bracketMatchId;
                if (bm == null) return false;
                return typeof bm === 'number' ? bm === bracketMatchId : (bm as any).value === bracketMatchId;
            });
            expect(lobby).toBeDefined();
            const lobbyId = lobby!.id;

            // Enable autoRandomPick + BanMode=None (turn 0 = Pick, not Ban)
            await toUser.call.updateLobbySettings(defaultSettingsArgs(lobbyId, {
                autoRandomPick: true,
                standardTurnSeconds: 1,
                banMode: { tag: 'None', value: {} },
            }));
            await toUser.sync(1000);

            // Stand-in joins instead of original (auto-LMA seeds with stand-in's active account)
            await standIn.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await standIn.sync(1500);

            // Verify LMA has stand-in's account, not original's
            const lma = await queryPrivateTable(
                `SELECT user_id, hsr_account_id FROM lobby_member_account WHERE lobby_id = ${lobbyId} AND user_id = ${standIn.userId}`
            );
            expect(lma.length).toBeGreaterThan(0);
            expect(Number(lma[0].hsr_account_id)).toBe(standInAccount);

            // Set team slots: stand-in as Blue, opponent as Red
            await toUser.call.setTeamSlot({ lobbyId, targetUserId: standIn.userId, lobbySlot: { tag: 'BluePlayer' as const } });
            await toUser.sync();

            await opponent.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await opponent.sync(1500);
            await toUser.call.setTeamSlot({ lobbyId, targetUserId: opponent.userId, lobbySlot: { tag: 'RedPlayer' as const } });
            await toUser.sync();

            await standIn.call.confirmReady({ lobbyId });
            await standIn.sync();
            await opponent.call.confirmReady({ lobbyId });
            await opponent.sync();
            await toUser.sync();

            // Start draft and fire timer expiry
            await startDraftAndSync(toUser, standIn, opponent, lobbyId);
            await fireTimerExpiry(toUser, lobbyId);

            const picked = firstAutoPickChar(toUser, lobbyId);
            expect(picked).toBeDefined();
            // Must be from stand-in's chars, NOT original's
            expect(STANDIN_CHARS).toContain(picked!);
            expect(ORIGINAL_CHARS).not.toContain(picked!);

            await leaveAll(lobbyId, standIn, opponent, toUser);
        }, 120000);
    });

    // ─── Scenario 4 — Casual requireOwnership with missing-LMA member ─────
    //
    // Structurally unreachable: start_draft's guard at draftClassic.ts:76-96
    // rejects any player whose selected LMA accounts contribute zero characters
    // when autoRandomPick=true. A player with no HsrAccount has zero LMA rows
    // (lobbyLifecycle.ts auto-LMA seed is gated by `activeAcct` existence),
    // which triggers selectedAccounts.length === 0 → rejection at line 80.
    // The per-member loop in D-I-04 handles empty contributions gracefully
    // (set-union with empty = no-op) but this behavior is unobservable from
    // an integration test because the precondition can't be constructed.
    //
    // it('casual requireOwnership: member with no LMA contributes empty, pool still assembles', async () => {
    //     // Cannot construct: start_draft rejects zero-LMA players when autoRandomPick=true
    // });
});
