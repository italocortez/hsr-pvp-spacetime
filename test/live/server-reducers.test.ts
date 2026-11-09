/**
 * Live residue (T-S10, ACCESS-SECURITY-OPS §D.5, D-C1): the module environment gate. The four test-only reducers
 * (server_set_datetime, server_set_online, server_set_mmr, server_nuke_test_data) start with
 * `requireTestDatabase(ctx)` (ctx.env.STDB_TARGET must be 'test', spacetimedb/src/reducers/identity/server.ts) and
 * then `requireServer(ctx)`. The in-memory harness cannot set the published module's environment, so the gate is
 * checked here, on test1 (published with STDB_TARGET=test by scripts/stdb/publish.ts).
 *
 *   - accepted with the delegate token: set_datetime / set_online / set_mmr on a throwaway guest;
 *     server_nuke_test_data is called with a wrong confirmation, which passes both gates and rejects on the
 *     confirmation check, proving the gate admits the call without wiping test1 mid-suite;
 *   - rejected for a plain client: "Forbidden: caller is not a registered server identity." (the env gate passes on
 *     test1, so the server-identity gate is the one that answers);
 *   - todo: the real nuke (order-unsafe in a sequential suite) and the prod-side rejection (untestable from test1).
 *
 * Estimated runtime: ~20 s (one guest, five short server-token connections).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { expectReducerError, hasServerToken } from '../shared/connection';
import { type LiveUser, closeAll, connectGuest, withServer } from './_helpers';

const NOT_SERVER = /Forbidden: caller is not a registered server identity/;

describe('Env-gated server_* reducers on test1 (§D.5, D-C1)', () => {
    let target: LiveUser;

    beforeAll(async () => {
        target = await connectGuest();
    });

    afterAll(() => closeAll([target]));

    describe('accepted with the server token', () => {
        it.skipIf(!hasServerToken())('server_set_datetime: user_identity.lastSeenAt backdated one day', async () => {
            const dayAgoMicros = (BigInt(Date.now()) - 86_400_000n) * 1000n;
            await withServer((s) =>
                s.reducers.serverSetDatetime({
                    tableName: 'user_identity',
                    primaryKey: target.identity,
                    field: 'lastSeenAt',
                    timestampMicros: dayAgoMicros.toString(),
                }),
            );
        }, 30_000);

        it.skipIf(!hasServerToken())('server_set_online: the throwaway user forced offline', async () => {
            await withServer((s) => s.reducers.serverSetOnline({ userId: target.userId, isOnline: false }));
        }, 30_000);

        it.skipIf(!hasServerToken())('server_set_mmr: MemoryOfChaos rating set', async () => {
            await withServer((s) =>
                s.reducers.serverSetMmr({ userId: target.userId, gameMode: 'MemoryOfChaos', rating: 1234 }),
            );
        }, 30_000);

        it.skipIf(!hasServerToken())(
            'server_nuke_test_data: both gates pass; a wrong confirmation is the only rejection (nothing wiped)',
            async () => {
                const msg = await expectReducerError(
                    withServer((s) => s.reducers.serverNukeTestData({ confirmation: 'not-the-phrase' })),
                );
                expect(msg).toMatch(/requires confirmation="NUKE_TEST_DATA"/);
                expect(msg).not.toMatch(/Not a test database|Forbidden/);
            },
            30_000,
        );

        it.todo(
            'server_nuke_test_data with "NUKE_TEST_DATA" is accepted: not run, the wipe would delete the rows of the files ' +
                'that run after this one (vitest does not guarantee file order); globalSetup\'s clear-publish is the reset',
        );
    });

    describe('rejected for a plain client ("server identity" gate)', () => {
        it('server_set_datetime', async () => {
            const msg = await expectReducerError(
                target.conn.reducers.serverSetDatetime({
                    tableName: 'user_identity',
                    primaryKey: target.identity,
                    field: 'lastSeenAt',
                    timestampMicros: '0',
                }),
            );
            expect(msg).toMatch(NOT_SERVER);
        }, 30_000);

        it('server_set_online', async () => {
            const msg = await expectReducerError(
                target.conn.reducers.serverSetOnline({ userId: target.userId, isOnline: true }),
            );
            expect(msg).toMatch(NOT_SERVER);
        }, 30_000);

        it('server_set_mmr', async () => {
            const msg = await expectReducerError(
                target.conn.reducers.serverSetMmr({ userId: target.userId, gameMode: 'MemoryOfChaos', rating: 9999 }),
            );
            expect(msg).toMatch(NOT_SERVER);
        }, 30_000);

        it('server_nuke_test_data', async () => {
            // A wrong phrase on purpose: if the server gate ever failed open, the call rejects on the phrase
            // (and fails this test) instead of wiping test1.
            const msg = await expectReducerError(
                target.conn.reducers.serverNukeTestData({ confirmation: 'not-the-phrase' }),
            );
            expect(msg).toMatch(NOT_SERVER);
        }, 30_000);
    });

    it.todo(
        'prod-side rejection ("Not a test database." when STDB_TARGET = prod): cannot be tested from test1, which is ' +
            'published with STDB_TARGET=test; checked at the prod release (ACCESS-SECURITY-OPS §C.5)',
    );
});
