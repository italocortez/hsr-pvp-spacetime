/**
 * Integration tests: migrate_roster accountRating recompute (D-D-04) + D-G lobby guards.
 *
 * Phase 12.3 Plan 07 Task 1. Owns regression coverage for:
 *   - D-D-01 through D-D-04 (Plan 05): migrate_roster now invokes applyBatchUpsert/
 *     applyBatchRemove which call updateAccountRating — previously missing, leaving
 *     source and/or target HsrAccount.accountRating stale after migration.
 *   - D-G-01 (Plan 05): migrate_roster rejects when EITHER source OR target account
 *     is bound to a live LobbyMemberAccount. Uses the existing by_account index.
 *
 * Scenarios:
 *   1. Copy mode recomputes TARGET rating (source unchanged).
 *   2. Move mode recomputes BOTH source (emptied) and target ratings.
 *   3. D-G guard: source account in lobby → reject with 'migrate characters from this account'.
 *   4. D-G guard: target account in lobby → reject with 'migrate characters to this account'.
 *   5. Empty source is a no-op (early return in migrate_roster wrapper).
 *
 * HsrAccount is a PRIVATE table since Phase 10.4 — accountRating reads go through
 * `spacetime sql` via queryPrivateTable, NOT the subscription cache.
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 *
 * Contract: docs/roster/contract.md — Migrate Roster + Lobby Guard scenarios
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    hasServerToken,
    expectReducerError,
    queryPrivateTable,
    type TestHarness,
} from '../../shared/connection';
import { nextUid, resetUidCounter, characterBatch, KNOWN_CHARACTERS } from '../../shared/fixtures';
import { defaultLobbyArgs as sharedDefaultLobbyArgs } from '../../shared/helpers/lobbies';
import { myLobbies } from '../../shared/helpers/queries';

// ─── Helpers ────────────────────────────────────────────────────────────────

const defaultLobbyArgs = (overrides: Record<string, unknown> = {}) =>
    sharedDefaultLobbyArgs({ refereeControlsShelving: true, ...overrides });

/** Query an HsrAccount row by id via spacetime sql (private table). */
async function readAccount(hsrAccountId: number): Promise<Record<string, string> | undefined> {
    const rows = await queryPrivateTable(
        `SELECT * FROM hsr_account WHERE id = ${hsrAccountId}`
    );
    return rows[0];
}

/** Read the accountRating column for an HsrAccount row. */
async function readAccountRating(hsrAccountId: number): Promise<number> {
    const row = await readAccount(hsrAccountId);
    if (!row) throw new Error(`HsrAccount #${hsrAccountId} not found`);
    return Number(row.account_rating);
}

/** Create an HsrAccount, return its id. Idempotent per uid. */
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

/** Upsert a batch of characters onto an account. */
async function seedChars(
    h: TestHarness,
    hsrAccountId: number,
    chars: Array<{ characterName: string; eidolonLevel?: number }>,
): Promise<void> {
    await h.call.batchUpsertCharacters({
        hsrAccountId,
        charactersJson: characterBatch(chars),
    });
    await h.sync();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasServerToken())('migrate_roster — D-D-04 rating recompute + D-G lobby guards', () => {
    let h: TestHarness;
    let host: TestHarness;

    beforeAll(async () => {
        resetUidCounter();
        h = await createVerifiedTestHarness();
        host = await createVerifiedTestHarness();
        await h.sync();
        await host.sync();
    }, 60000);

    afterAll(async () => {
        await h?.disconnect();
        await host?.disconnect();
    });

    // ─── Scenario 1: Copy mode recomputes target rating ──────────────────

    it('copy mode recomputes TARGET accountRating (D-D-04)', async () => {
        const sourceUid = nextUid();
        const targetUid = nextUid();
        const sourceId = await createAccount(h, sourceUid, 'Copy Src');
        const targetId = await createAccount(h, targetUid, 'Copy Tgt');

        // Seed source with a known non-trivial roster so computeAccountRating
        // produces a non-zero value.
        await seedChars(h, sourceId, [
            { characterName: KNOWN_CHARACTERS[0], eidolonLevel: 6 },
            { characterName: KNOWN_CHARACTERS[1], eidolonLevel: 4 },
            { characterName: KNOWN_CHARACTERS[2], eidolonLevel: 2 },
            { characterName: KNOWN_CHARACTERS[3], eidolonLevel: 0 },
        ]);

        const sourceRatingBefore = await readAccountRating(sourceId);
        const targetRatingBefore = await readAccountRating(targetId);

        // Empty target should have rating 0 per computeAccountRating (owned.length === 0).
        expect(targetRatingBefore).toBe(0);
        // Seeded source should have a positive rating.
        expect(sourceRatingBefore).toBeGreaterThan(0);

        // Migrate copy
        await h.call.migrateRoster({
            sourceAccountId: sourceId,
            targetAccountId: targetId,
            mode: 'copy',
        });
        await h.sync(1000);

        const sourceRatingAfter = await readAccountRating(sourceId);
        const targetRatingAfter = await readAccountRating(targetId);

        // D-D-04 regression: target was previously left at 0 because
        // migrate_roster did not call updateAccountRating. Plan 05's helper
        // delegation closes that bug.
        expect(targetRatingAfter).toBe(sourceRatingBefore);
        // Source roster unchanged in copy mode → source rating unchanged.
        expect(sourceRatingAfter).toBe(sourceRatingBefore);

        // Cleanup for next scenarios: remove both accounts' characters to isolate state.
        const sourceChars = [...KNOWN_CHARACTERS.slice(0, 4)];
        await h.call.batchRemoveCharacters({
            hsrAccountId: sourceId,
            characterNamesJson: JSON.stringify(sourceChars),
        });
        await h.sync();
        await h.call.batchRemoveCharacters({
            hsrAccountId: targetId,
            characterNamesJson: JSON.stringify(sourceChars),
        });
        await h.sync();

        // Delete the accounts so the next scenario can create fresh ones.
        await h.call.deleteHsrAccount({ hsrAccountId: sourceId });
        await h.sync();
        await h.call.deleteHsrAccount({ hsrAccountId: targetId });
        await h.sync();
    }, 60000);

    // ─── Scenario 2: Move mode recomputes both ───────────────────────────

    it('move mode recomputes BOTH source and target accountRating', async () => {
        const sourceUid = nextUid();
        const targetUid = nextUid();
        const sourceId = await createAccount(h, sourceUid, 'Move Src');
        const targetId = await createAccount(h, targetUid, 'Move Tgt');

        await seedChars(h, sourceId, [
            { characterName: KNOWN_CHARACTERS[0], eidolonLevel: 6 },
            { characterName: KNOWN_CHARACTERS[1], eidolonLevel: 5 },
            { characterName: KNOWN_CHARACTERS[2], eidolonLevel: 3 },
        ]);

        const sourceRatingBefore = await readAccountRating(sourceId);
        const targetRatingBefore = await readAccountRating(targetId);

        expect(sourceRatingBefore).toBeGreaterThan(0);
        expect(targetRatingBefore).toBe(0);

        await h.call.migrateRoster({
            sourceAccountId: sourceId,
            targetAccountId: targetId,
            mode: 'move',
        });
        await h.sync(1000);

        const sourceRatingAfter = await readAccountRating(sourceId);
        const targetRatingAfter = await readAccountRating(targetId);

        // Target now owns the source's characters → matches source's previous rating.
        expect(targetRatingAfter).toBe(sourceRatingBefore);
        // Source roster is now empty → rating recomputed to 0 (computeAccountRating:49).
        // Proves the D-D-04 fix actually recomputes the source side, not just the target.
        expect(sourceRatingAfter).toBe(0);
        expect(sourceRatingAfter).not.toBe(sourceRatingBefore);

        // Cleanup
        const movedChars = [KNOWN_CHARACTERS[0], KNOWN_CHARACTERS[1], KNOWN_CHARACTERS[2]];
        try {
            await h.call.batchRemoveCharacters({
                hsrAccountId: targetId,
                characterNamesJson: JSON.stringify(movedChars),
            });
            await h.sync();
        } catch { /* ok */ }
        await h.call.deleteHsrAccount({ hsrAccountId: sourceId });
        await h.sync();
        await h.call.deleteHsrAccount({ hsrAccountId: targetId });
        await h.sync();
    }, 60000);

    // ─── Scenario 3: D-G guard — source in lobby ─────────────────────────

    it('D-G-01 guard: rejects when SOURCE account is bound to a live lobby', async () => {
        const sourceUid = nextUid();
        const targetUid = nextUid();
        const sourceId = await createAccount(h, sourceUid, 'Guard Src Src');
        const targetId = await createAccount(h, targetUid, 'Guard Src Tgt');
        await seedChars(h, sourceId, [
            { characterName: KNOWN_CHARACTERS[0], eidolonLevel: 1 },
        ]);

        // Host creates a lobby. `h` joins → auto-LMA seeds the player's active
        // account; calling select_match_account replaces the LMA with sourceId.
        await host.call.createLobby(defaultLobbyArgs());
        await host.sync(1500);
        const lobby = myLobbies(host).at(-1)!;

        await h.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
        await h.sync();
        await host.call.setTeamSlot({
            lobbyId: lobby.id,
            targetUserId: h.userId,
            lobbySlot: { tag: 'BluePlayer' as const },
        });
        await host.sync();
        await h.sync();
        await h.call.selectMatchAccount({ lobbyId: lobby.id, hsrAccountId: sourceId });
        await h.sync();

        // Guard should fire on the source side.
        const err = await expectReducerError(
            h.call.migrateRoster({
                sourceAccountId: sourceId,
                targetAccountId: targetId,
                mode: 'copy',
            })
        );
        expect(err).toContain('migrate characters from this account');
        expect(err).toContain('Leave the lobby first');

        // Cleanup: leave, close, delete accounts.
        await h.call.leaveLobby({ lobbyId: lobby.id });
        await h.sync();
        await host.call.closeLobby({ lobbyId: lobby.id });
        await host.sync();

        // Source still has characters → delete account cascades them.
        await h.call.deleteHsrAccount({ hsrAccountId: sourceId });
        await h.sync();
        await h.call.deleteHsrAccount({ hsrAccountId: targetId });
        await h.sync();
    }, 60000);

    // ─── Scenario 4: D-G guard — target in lobby ─────────────────────────

    it('D-G-01 guard: rejects when TARGET account is bound to a live lobby', async () => {
        const sourceUid = nextUid();
        const targetUid = nextUid();
        const sourceId = await createAccount(h, sourceUid, 'Guard Tgt Src');
        const targetId = await createAccount(h, targetUid, 'Guard Tgt Tgt');
        await seedChars(h, sourceId, [
            { characterName: KNOWN_CHARACTERS[0], eidolonLevel: 1 },
        ]);

        await host.call.createLobby(defaultLobbyArgs());
        await host.sync(1500);
        const lobby = myLobbies(host).at(-1)!;

        await h.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
        await h.sync();
        await host.call.setTeamSlot({
            lobbyId: lobby.id,
            targetUserId: h.userId,
            lobbySlot: { tag: 'BluePlayer' as const },
        });
        await host.sync();
        await h.sync();
        // Select the TARGET account this time.
        await h.call.selectMatchAccount({ lobbyId: lobby.id, hsrAccountId: targetId });
        await h.sync();

        const err = await expectReducerError(
            h.call.migrateRoster({
                sourceAccountId: sourceId,
                targetAccountId: targetId,
                mode: 'copy',
            })
        );
        expect(err).toContain('migrate characters to this account');
        expect(err).toContain('Leave the lobby first');

        // Cleanup
        await h.call.leaveLobby({ lobbyId: lobby.id });
        await h.sync();
        await host.call.closeLobby({ lobbyId: lobby.id });
        await host.sync();

        await h.call.deleteHsrAccount({ hsrAccountId: sourceId });
        await h.sync();
        await h.call.deleteHsrAccount({ hsrAccountId: targetId });
        await h.sync();
    }, 60000);

    // ─── Scenario 5: empty source is a no-op ─────────────────────────────

    it('empty source account → migrate_roster returns without error and ratings unchanged', async () => {
        const sourceUid = nextUid();
        const targetUid = nextUid();
        const sourceId = await createAccount(h, sourceUid, 'Empty Src');
        const targetId = await createAccount(h, targetUid, 'Empty Tgt');

        const sourceBefore = await readAccountRating(sourceId);
        const targetBefore = await readAccountRating(targetId);
        expect(sourceBefore).toBe(0);
        expect(targetBefore).toBe(0);

        // Plan 05's migrate_roster wrapper has `if (sourceChars.length === 0) return;`
        // — no error, no rating change.
        await h.call.migrateRoster({
            sourceAccountId: sourceId,
            targetAccountId: targetId,
            mode: 'copy',
        });
        await h.sync();

        const sourceAfter = await readAccountRating(sourceId);
        const targetAfter = await readAccountRating(targetId);
        expect(sourceAfter).toBe(sourceBefore);
        expect(targetAfter).toBe(targetBefore);

        // Cleanup
        await h.call.deleteHsrAccount({ hsrAccountId: sourceId });
        await h.sync();
        await h.call.deleteHsrAccount({ hsrAccountId: targetId });
        await h.sync();
    }, 30000);
});
