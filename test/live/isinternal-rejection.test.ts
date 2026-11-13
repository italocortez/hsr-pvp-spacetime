/**
 * Live residue (T-S10, ACCESS-SECURITY-OPS §D.5; T-S11a review M2): external calls to the scheduled reducers are
 * refused. Re-created from test/backend/scheduled-reducer-isInternal-rejection.test.ts and extended to all five
 * scheduled reducers exported by spacetimedb/src/index.ts: run_user_deletion, run_lobby_gc, run_identity_gc,
 * run_referee_transfer_check (A22a), run_tournament_finalize (A24(7)).
 *
 * Two defense layers:
 *   - the engine: on older hosts it answers "no such reducer" to an external WebSocket call naming a scheduled
 *     reducer, before any module code runs;
 *   - the module (S11a, triage L11): each scheduled reducer calls `ensureScheduler` first
 *     (spacetimedb/src/helpers/admin/schedulerGuard.ts), which refuses any sender that is not the database
 *     (`ctx.senderAuth.isInternal`, SDK 2.14: `sender === databaseIdentity`) with
 *     "Forbidden: <name> is a scheduled reducer and runs only from the scheduler.".
 *
 * Two calls per reducer:
 *   1. The empty-buffer sensor (unchanged since T-S10): an empty args buffer passes only while the engine refuses the
 *      name before decoding. Any other text (an argument decoding error, say) fails it on purpose: it would mean the
 *      engine now dispatches the name, and only call 2 can then reach the module guard.
 *   2. A correctly encoded job row (review M2): the argument is a one-field product `{ arg: <job row> }` serialized
 *      with the job-row type of the generated bindings (`web/src/module_bindings/types.ts`; private tables keep their
 *      row types there). The ids point at no row (u32 max), so even an accepted call would find nothing to delete.
 *      Either layer's refusal is a pass; the assertion message and the log name the layer that refused. The test fails
 *      only when the call is accepted. A refusal with neither text passes with a warning (it would point at the
 *      encoding, not at the guard).
 *
 * The call: the scheduled reducers have no typed accessor in the generated bindings, so the sensor uses the SDK's
 * untyped `DbConnectionImpl.callReducer(reducerName, argsBuffer)`: exactly what an attacker would send. Confirmed
 * present and public on SDK 2.14.1 (`node_modules/spacetimedb/dist/sdk/db_connection_impl.d.ts`:
 * `callReducer(reducerName: string, argsBuffer: Uint8Array, reducerArgs?: object): Promise<void>`), so no cast
 * is needed.
 *
 * Caller: one guest (`createTestHarness`, no server-token round trip; the refusal does not depend on the caller).
 *
 * Estimated runtime: ~10 s (one connection, ten calls).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BinaryWriter, ScheduleAt, Timestamp, t } from 'spacetimedb';
import {
    IdentityGcJob,
    LobbyGcJob,
    RefereeTransferCheck,
    TournamentFinalizeJob,
    UserDeletionJob,
} from '@bindings/types';
import { createTestHarness, expectReducerError, type TestHarness } from '../shared/connection';

const SCHEDULED_REDUCERS = [
    'run_user_deletion',
    'run_lobby_gc',
    'run_identity_gc',
    'run_referee_transfer_check',
    'run_tournament_finalize',
] as const;
type ScheduledReducer = (typeof SCHEDULED_REDUCERS)[number];

/** An id no row holds: an accepted call would find nothing. */
const NO_ROW_ID = 0xffff_ffff;

/** BSATN of the reducer's argument product `{ arg: row }`, built from the generated job-row type. */
function encodeArg<T>(rowType: { serialize(writer: BinaryWriter, value: T): void }, row: T): Uint8Array {
    const args = t.object('ScheduledReducerArgs', { arg: rowType as any });
    const writer = new BinaryWriter(64);
    args.serialize(writer, { arg: row });
    return writer.getBuffer();
}

/** A valid job-row argument per scheduled reducer (scheduled one hour out). */
function validArgs(reducerName: ScheduledReducer): Uint8Array {
    const nowMicros = BigInt(Date.now()) * 1000n;
    const scheduledAt = ScheduleAt.time(nowMicros + 3_600_000_000n);
    const scheduledId = 0n;
    switch (reducerName) {
        case 'run_user_deletion': {
            const at = new Timestamp(nowMicros);
            return encodeArg(UserDeletionJob, {
                scheduledId, scheduledAt, userId: NO_ROW_ID,
                createdById: 0, createdDate: at, lastModifiedById: 0, lastModifiedDate: at,
            });
        }
        case 'run_lobby_gc':
            return encodeArg(LobbyGcJob, { scheduledId, scheduledAt });
        case 'run_identity_gc':
            return encodeArg(IdentityGcJob, { scheduledId, scheduledAt });
        case 'run_referee_transfer_check':
            return encodeArg(RefereeTransferCheck, { scheduledId, scheduledAt, lobbyId: NO_ROW_ID, userId: NO_ROW_ID });
        case 'run_tournament_finalize':
            return encodeArg(TournamentFinalizeJob, { scheduledId, scheduledAt, tournamentId: NO_ROW_ID });
    }
}

/** Which layer a refusal text comes from. */
function refusingLayer(reducerName: string, errMsg: string): 'engine' | 'module guard' | 'unrecognized' {
    if (/no such reducer/i.test(errMsg)) return 'engine';
    if (new RegExp(`Forbidden: ${reducerName} is a scheduled reducer`).test(errMsg)) return 'module guard';
    return 'unrecognized';
}

describe('Scheduled reducers reject external invocation (engine "no such reducer" or module guard "Forbidden"; T-16.4-02-01, S11a M2)', () => {
    let caller: TestHarness;

    beforeAll(async () => {
        caller = await createTestHarness();
    });

    afterAll(async () => {
        await caller?.disconnect().catch(() => {});
    });

    it.each(SCHEDULED_REDUCERS)(
        '%s is unreachable to an external WebSocket caller with an empty argument buffer (§D.5 isInternal sensor)',
        async (reducerName) => {
            const errMsg = await expectReducerError(caller.conn.callReducer(reducerName, new Uint8Array(0)));
            expect(errMsg).toMatch(/no such reducer|Forbidden/i);
        },
        30_000,
    );

    it.each(SCHEDULED_REDUCERS)(
        '%s refuses an external WebSocket caller sending a correctly encoded job row (review M2; either layer passes)',
        async (reducerName) => {
            // expectReducerError throws when the call is accepted: the one failing outcome.
            const errMsg = await expectReducerError(caller.conn.callReducer(reducerName, validArgs(reducerName)));
            const layer = refusingLayer(reducerName, errMsg);
            console.info(`[isinternal-rejection] ${reducerName} with a valid job row: refused by ${layer}: ${errMsg}`);
            if (layer === 'unrecognized') {
                console.warn(`[isinternal-rejection] ${reducerName}: refusal text is neither the engine's nor the guard's; check the argument encoding`);
            }
            expect(errMsg, `${reducerName}: refused by ${layer} (${errMsg})`).toBeTruthy();
        },
        30_000,
    );
});
