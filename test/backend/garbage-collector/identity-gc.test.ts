/**
 * Integration tests: Identity & Lobby GC — admin triggers, auth guards, GcResult audit,
 * and GC guard logic (skip guests, skip online, preserve newest, TTL deletion).
 *
 * Uses server_set_datetime to age identities past 90-day TTL for time-dependent tests.
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local
 *
 * Contract: docs/smoke/contract.md — GC (D-06, D-07, D-08, D-11)
 * Phase: 12.1 (Identity Garbage Collection)
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
    createTestHarness,
    createVerifiedTestHarness,
    hasServerToken,
    expectReducerError,
    queryPrivateTable,
    getTestDiscordId,
    type TestHarness,
} from '../../shared/connection';
import { promoteToRole } from '../../shared/helpers/promoteUser';
import { DbConnection } from '@/src/module_bindings';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getUri(): string {
    return process.env.SPACETIMEDB_URI || 'wss://maincloud.spacetimedb.com';
}
function getDb(): string {
    return process.env.SPACETIMEDB_DB || process.env.SPACETIMEDB_DB_NAME || process.env.PUBLIC_SPACETIMEDB_DB_NAME || 'hsrpvp-spacetimedb-nextjs-test1';
}
function getServerToken(): string {
    return process.env.SPACETIMEDB_SERVER_TOKEN || '';
}

/** Call server_set_datetime via server-token connection. */
function setDatetime(tableName: string, primaryKey: string, field: string, timestampMicros: bigint): Promise<void> {
    const token = getServerToken();
    if (!token) throw new Error('SPACETIMEDB_SERVER_TOKEN required for setDatetime');
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('setDatetime timeout')), 10000);
        DbConnection.builder()
            .withUri(getUri())
            .withDatabaseName(getDb())
            .withToken(token)
            .withConfirmedReads(false)
            .onConnect((conn) => {
                conn.reducers.serverSetDatetime({
                    tableName,
                    primaryKey,
                    field,
                    timestampMicros: timestampMicros.toString(),
                });
                setTimeout(() => {
                    clearTimeout(timeout);
                    conn.disconnect();
                    resolve();
                }, 1000);
            })
            .onConnectError((_ctx, err) => {
                clearTimeout(timeout);
                reject(err);
            })
            .build();
    });
}

/** Link a second identity to an existing user's discord ID via server_link_provider. */
function linkIdentityToDiscord(identityHex: string, discordId: string, discordName: string): Promise<void> {
    const token = getServerToken();
    if (!token) throw new Error('SPACETIMEDB_SERVER_TOKEN required');
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('linkIdentity timeout')), 10000);
        DbConnection.builder()
            .withUri(getUri())
            .withDatabaseName(getDb())
            .withToken(token)
            .withConfirmedReads(false)
            .onConnect((conn) => {
                conn.reducers.serverLinkProvider({
                    callerIdentityHex: identityHex,
                    provider: 'discord',
                    providerId: discordId,
                    providerName: discordName,
                });
                setTimeout(() => {
                    clearTimeout(timeout);
                    conn.disconnect();
                    resolve();
                }, 1000);
            })
            .onConnectError((_ctx, err) => {
                clearTimeout(timeout);
                reject(err);
            })
            .build();
    });
}

/** 91 days in microseconds — just past the 90-day GC TTL. */
const NINETY_ONE_DAYS_AGO_MICROS = () =>
    BigInt(Date.now() - 91 * 24 * 60 * 60 * 1000) * 1000n;

/** Force a user's isOnline flag via server-token connection.
 *  Maincloud disconnect detection can take 30-60s — too slow for tests. */
function setOnline(userId: number, isOnline: boolean): Promise<void> {
    const token = getServerToken();
    if (!token) throw new Error('SPACETIMEDB_SERVER_TOKEN required for setOnline');
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('setOnline timeout')), 10000);
        DbConnection.builder()
            .withUri(getUri())
            .withDatabaseName(getDb())
            .withToken(token)
            .withConfirmedReads(false)
            .onConnect((conn) => {
                conn.reducers.serverSetOnline({ userId, isOnline });
                setTimeout(() => {
                    clearTimeout(timeout);
                    conn.disconnect();
                    resolve();
                }, 1000);
            })
            .onConnectError((_ctx, err) => {
                clearTimeout(timeout);
                reject(err);
            })
            .build();
    });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Identity & Lobby GC', () => {
    const harnesses: TestHarness[] = [];

    afterAll(async () => {
        for (const h of harnesses) {
            await h.disconnect().catch(() => {});
        }
    });

    // ── Auth Guards ──────────────────────────────────────────────────────────

    describe('Auth Guards', () => {
        it.skipIf(!hasServerToken())('admin_gc_identities rejects non-moderator', async () => {
            const h = await createVerifiedTestHarness();
            harnesses.push(h);

            const err = await expectReducerError(h.call.adminGcIdentities({}));
            expect(err).toContain('Moderator');
        }, 20000);

        it.skipIf(!hasServerToken())('admin_gc_lobbies rejects non-moderator', async () => {
            const h = await createVerifiedTestHarness();
            harnesses.push(h);

            const err = await expectReducerError(h.call.adminGcLobbies({}));
            expect(err).toContain('Moderator');
        }, 20000);
    });

    // ── GcResult Audit ──────────────────────────────────────────────────────

    describe('GcResult Audit', () => {
        it.skipIf(!hasServerToken())('admin_gc_identities writes GcResult with gcType=identity', async () => {
            const mod = await createVerifiedTestHarness();
            harnesses.push(mod);
            await promoteToRole(mod, 'Moderator');
            await mod.sync(1500);

            // Count existing gc_result rows before
            const before = await queryPrivateTable(
                `SELECT * FROM gc_result WHERE gc_type = 'identity'`
            );

            await mod.call.adminGcIdentities({});
            await mod.sync(2000);

            const after = await queryPrivateTable(
                `SELECT * FROM gc_result WHERE gc_type = 'identity'`
            );
            expect(after.length).toBeGreaterThan(before.length);

            // Verify the newest row has correct fields
            const newest = after[after.length - 1];
            expect(newest.gc_type).toContain('identity');
            expect(parseInt(newest.items_scanned)).toBeGreaterThanOrEqual(0);
        }, 30000);

        it.skipIf(!hasServerToken())('admin_gc_lobbies writes GcResult with gcType=lobby', async () => {
            const mod = await createVerifiedTestHarness();
            harnesses.push(mod);
            await promoteToRole(mod, 'Moderator');
            await mod.sync(1500);

            const before = await queryPrivateTable(
                `SELECT * FROM gc_result WHERE gc_type = 'lobby'`
            );

            await mod.call.adminGcLobbies({});
            await mod.sync(2000);

            const after = await queryPrivateTable(
                `SELECT * FROM gc_result WHERE gc_type = 'lobby'`
            );
            expect(after.length).toBeGreaterThan(before.length);

            const newest = after[after.length - 1];
            expect(newest.gc_type).toContain('lobby');
        }, 30000);
    });

    // ── GC Guard Logic ──────────────────────────────────────────────────────

    describe('GC Guard Logic', () => {
        it.skipIf(!hasServerToken())('skips guest user identities (D-06)', async () => {
            // Create a guest user (not verified)
            const guest = await createTestHarness();
            harnesses.push(guest);
            await guest.sync(2000);

            // Age the guest's identity past 90-day TTL
            await setDatetime('user_identity', guest.identity, 'lastSeenAt', NINETY_ONE_DAYS_AGO_MICROS());
            await guest.sync(1000);

            // Run GC as moderator
            const mod = await createVerifiedTestHarness();
            harnesses.push(mod);
            await promoteToRole(mod, 'Moderator');
            await mod.sync(1500);
            await mod.call.adminGcIdentities({});
            await mod.sync(2000);

            // Guest identity should still exist (D-06: skip guests)
            const rows = await queryPrivateTable(
                `SELECT * FROM user_identity WHERE identity = X'${guest.identity}'`
            );
            expect(rows.length).toBe(1);
        }, 45000);

        it.skipIf(!hasServerToken())('skips online user identities (D-08)', async () => {
            // Create a verified user — stays connected (isOnline = true)
            const online = await createVerifiedTestHarness();
            harnesses.push(online);
            await online.sync(2000);

            // Age the identity past TTL while user is still connected
            await setDatetime('user_identity', online.identity, 'lastSeenAt', NINETY_ONE_DAYS_AGO_MICROS());

            // Run GC as moderator
            const mod = await createVerifiedTestHarness();
            harnesses.push(mod);
            await promoteToRole(mod, 'Moderator');
            await mod.sync(1500);
            await mod.call.adminGcIdentities({});
            await mod.sync(2000);

            // Online user's identity should survive (D-08: skip online)
            const rows = await queryPrivateTable(
                `SELECT * FROM user_identity WHERE identity = X'${online.identity}'`
            );
            expect(rows.length).toBe(1);
        }, 45000);

        it.skipIf(!hasServerToken())('deletes stale identity and preserves newest (D-07, D-11)', async () => {
            // Create first verified user — this gives us identity1 + discord account
            const userA = await createVerifiedTestHarness();
            harnesses.push(userA);
            await userA.sync(2000);

            const identity1 = userA.identity;
            const discordId = await getTestDiscordId(userA.userId);

            // Create a second connection — this gives us identity2 as a new guest
            const userB = await createVerifiedTestHarness();
            harnesses.push(userB);
            await userB.sync(2000);
            const identity2 = userB.identity;

            // Re-link identity2 to the same discord account as userA
            // This re-points identity2 to userA's user record (Case 1b in server_link_provider)
            await linkIdentityToDiscord(identity2, discordId, `TestRelink_${Date.now()}`);
            await userA.sync(1500);

            // Verify both identities now point to the same user
            const rows = await queryPrivateTable(
                `SELECT identity, user_id FROM user_identity WHERE user_id = ${userA.userId}`
            );
            expect(rows.length).toBeGreaterThanOrEqual(2);

            // Age identity1 past 90-day TTL (make it the stale one)
            await setDatetime('user_identity', identity1, 'lastSeenAt', NINETY_ONE_DAYS_AGO_MICROS());

            // Force user offline via server reducer (maincloud disconnect detection
            // is too slow for tests — can take 30-60s to fire clientDisconnected)
            await setOnline(userA.userId, false);

            // Disconnect harnesses (cleanup only — isOnline already set above)
            await userA.disconnect();
            await userB.disconnect();
            harnesses.splice(harnesses.indexOf(userA), 1);
            harnesses.splice(harnesses.indexOf(userB), 1);

            // Run GC as moderator
            const mod = await createVerifiedTestHarness();
            harnesses.push(mod);
            await promoteToRole(mod, 'Moderator');
            await mod.sync(1500);
            await mod.call.adminGcIdentities({});
            await mod.sync(2000);

            // identity1 (stale, past TTL) should be deleted
            const staleRows = await queryPrivateTable(
                `SELECT * FROM user_identity WHERE identity = X'${identity1}'`
            );
            expect(staleRows.length).toBe(0);

            // identity2 (newest, preserved by D-07) should survive
            const newestRows = await queryPrivateTable(
                `SELECT * FROM user_identity WHERE identity = X'${identity2}'`
            );
            expect(newestRows.length).toBe(1);
        }, 90000);
    });

    // ── Seed Idempotency ────────────────────────────────────────────────────

    describe('Seed Idempotency', () => {
        it.skipIf(!hasServerToken())('seed_identity_gc_job is idempotent', async () => {
            // Check current row count
            const before = await queryPrivateTable(
                'SELECT * FROM identity_gc_job'
            );
            expect(before.length).toBeGreaterThanOrEqual(1);

            // Calling seed again via server token should be a no-op (row already exists)
            const seedResult = await new Promise<string>((resolve) => {
                const token = getServerToken();
                DbConnection.builder()
                    .withUri(getUri())
                    .withDatabaseName(getDb())
                    .withToken(token)
                    .withConfirmedReads(false)
                    .onConnect((conn) => {
                        conn.reducers.seedIdentityGcJob({});
                        setTimeout(() => {
                            conn.disconnect();
                            resolve('ok');
                        }, 1500);
                    })
                    .onConnectError((_ctx, err) => {
                        resolve(`error: ${err}`);
                    })
                    .build();
            });
            expect(seedResult).toBe('ok');

            // Row count should not have increased
            const after = await queryPrivateTable(
                'SELECT * FROM identity_gc_job'
            );
            expect(after.length).toBe(before.length);
        }, 30000);
    });
});
