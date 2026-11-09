/**
 * Live residue (T-S10, ACCESS-SECURITY-OPS §D.5): external calls to the scheduled reducers are rejected by the
 * engine. Re-created from test/backend/scheduled-reducer-isInternal-rejection.test.ts and extended to all five
 * scheduled reducers exported by spacetimedb/src/index.ts: run_user_deletion, run_lobby_gc, run_identity_gc,
 * run_referee_transfer_check (A22a), run_tournament_finalize (A24(7)).
 *
 * Defense layer: the engine answers "no such reducer" to an external WebSocket call naming a scheduled reducer,
 * before any module code runs. No application-level `ctx.senderAuth.isInternal` guard exists or is expected
 * (spacetimedb skill "AuthCtx applicability"; S4 log finding 11: the guards stay off until this sensor has been
 * re-run against a module built with SDK 2.14, where `isInternal` means `sender === databaseIdentity`). `/Forbidden/`
 * is kept in the regex only for the day such a guard is added. Any other rejection text (an argument decoding
 * error, say) fails the test on purpose: it would mean the engine accepted the call and dispatched it.
 *
 * The call: the scheduled reducers have no typed accessor in the generated bindings, so the sensor uses the SDK's
 * untyped `DbConnectionImpl.callReducer(reducerName, argsBuffer)`: exactly what an attacker would send. Confirmed
 * present and public on SDK 2.14.1 (`node_modules/spacetimedb/dist/sdk/db_connection_impl.d.ts`:
 * `callReducer(reducerName: string, argsBuffer: Uint8Array, reducerArgs?: object): Promise<void>`), so no cast
 * is needed. An empty args buffer is fine: the engine rejects the name before decoding.
 *
 * Caller: one guest (`createTestHarness`, no server-token round trip; the rejection does not depend on the caller).
 *
 * Estimated runtime: ~10 s (one connection, five calls).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestHarness, expectReducerError, type TestHarness } from '../shared/connection';

const SCHEDULED_REDUCERS = [
    'run_user_deletion',
    'run_lobby_gc',
    'run_identity_gc',
    'run_referee_transfer_check',
    'run_tournament_finalize',
] as const;

describe('Scheduled reducers reject external invocation (engine-level "no such reducer"; T-16.4-02-01)', () => {
    let caller: TestHarness;

    beforeAll(async () => {
        caller = await createTestHarness();
    });

    afterAll(async () => {
        await caller?.disconnect().catch(() => {});
    });

    it.each(SCHEDULED_REDUCERS)(
        '%s is unreachable to an external WebSocket caller (§D.5 isInternal sensor)',
        async (reducerName) => {
            const errMsg = await expectReducerError(caller.conn.callReducer(reducerName, new Uint8Array(0)));
            expect(errMsg).toMatch(/no such reducer|Forbidden/i);
        },
        30_000,
    );
});
