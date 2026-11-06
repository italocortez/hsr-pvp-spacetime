/**
 * Phase 16.4 Plan 02 — Regression sensor for external scheduled-reducer rejection.
 *
 * The 3 scheduled reducers (`run_user_deletion`, `run_lobby_gc`, `run_identity_gc`)
 * MUST reject invocation from external WebSocket callers. This file is the live
 * regression sensor proving that property holds end-to-end.
 *
 * Threat: T-16.4-02-01 (Tampering / Elevation of Privilege).
 *
 * Defense layer (verified live 2026-05-03 against republished v2.2.0 module, and
 * re-verified after the Plan 07 hotfix that removed the application-level guards):
 *
 *   The SpacetimeDB v2.2.0 engine returns "no such reducer" for external WS calls
 *   to scheduled reducer names BEFORE any application code runs. The engine simply
 *   does not surface `run_*` reducers as externally-callable. This is the
 *   operational defense for T-16.4-02-01.
 *
 * Plan 02 originally added an application-level `if (!ctx.senderAuth.isInternal) throw`
 * guard to each reducer body as defense-in-depth. Plan 07 (2026-05-03) removed those
 * guards after diagnosing that SDK v2.2.0's `senderAuth` factory ALWAYS sets
 * `isInternal: false` (see 16.4-AUDIT-NOTES.md "v0.6 Update — Plan 07 Diagnostic
 * Reversal" for SDK source-level proof at `dist/server/index.mjs:6383-6442`). The
 * guards were rejecting legitimate engine dispatch, breaking user-deletion / lobby-GC
 * / identity-GC cascades.
 *
 * After the hotfix, the engine-level "no such reducer" rejection IS the defense, and
 * the assertion remains correct: external callers are rejected. The accepted message
 * is "no such reducer" (engine-level); the `/Forbidden/i` alternative is preserved in
 * the regex only as a future-compat hedge in case a later SpacetimeDB version exposes
 * scheduled-reducer names to external callers and the project re-adds an application
 * guard with a working internal-dispatch signal.
 *
 * Why we use the low-level `connection.callReducer(name, argsBuffer)` path:
 * Scheduled reducers (`run_*`) are NOT exposed as typed accessors in the generated
 * module bindings (see `src/module_bindings/index.ts` reducer registration list —
 * `run_user_deletion` / `run_lobby_gc` / `run_identity_gc` are intentionally absent).
 * The SDK's `DbConnectionImpl.callReducer(reducerName: string, argsBuffer: Uint8Array)`
 * method (declared at `dist/sdk/db_connection_impl.d.ts:81`) provides an untyped escape
 * hatch that constructs a raw `CallReducer` WS message — exactly the path a real
 * attacker would use to forge a scheduled-reducer call.
 *
 * Args buffer is `new Uint8Array(0)` — the engine-level "no such reducer" rejection
 * fires before BSATN deserialization, so an empty buffer is fine.
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    expectReducerError,
    hasServerToken,
    type TestHarness,
} from '../shared/connection';

describe('T-16.4-02-01: scheduled reducers reject external invocation (engine-level "no such reducer" defense)', () => {
    const harnesses: TestHarness[] = [];

    afterAll(async () => {
        for (const h of harnesses) {
            await h.disconnect().catch(() => {});
        }
    });

    it.skipIf(!hasServerToken())(
        'run_user_deletion is unreachable to external WS callers (engine returns "no such reducer")',
        async () => {
            const caller = await createVerifiedTestHarness();
            harnesses.push(caller);
            await caller.sync(2000);

            // Low-level callReducer path — bypasses typed accessors (which don't exist
            // for scheduled reducers). Empty argsBuffer is fine: the engine-level
            // "no such reducer" rejection fires before BSATN deserialization.
            const errMsg = await expectReducerError(
                (caller.conn as any).callReducer(
                    'run_user_deletion',
                    new Uint8Array(0),
                ),
            );
            // Operational defense (SpacetimeDB v2.2.0): engine returns "no such reducer"
            // for external WS calls to scheduled reducer names. The /Forbidden/i alternative
            // is a future-compat hedge in case a later SDK version exposes scheduled
            // reducers and the project re-adds a working application guard.
            // Either message proves T-16.4-02-01 is mitigated end-to-end.
            expect(errMsg).toMatch(
                /no such reducer|Forbidden/i,
            );
        },
        30000,
    );

    it.skipIf(!hasServerToken())(
        'run_lobby_gc is unreachable to external WS callers (engine returns "no such reducer")',
        async () => {
            const caller = await createVerifiedTestHarness();
            harnesses.push(caller);
            await caller.sync(2000);

            const errMsg = await expectReducerError(
                (caller.conn as any).callReducer(
                    'run_lobby_gc',
                    new Uint8Array(0),
                ),
            );
            // Same defense layer as run_user_deletion above: engine-level rejection.
            expect(errMsg).toMatch(
                /no such reducer|Forbidden/i,
            );
        },
        30000,
    );

    it.skipIf(!hasServerToken())(
        'run_identity_gc is unreachable to external WS callers (engine returns "no such reducer")',
        async () => {
            const caller = await createVerifiedTestHarness();
            harnesses.push(caller);
            await caller.sync(2000);

            const errMsg = await expectReducerError(
                (caller.conn as any).callReducer(
                    'run_identity_gc',
                    new Uint8Array(0),
                ),
            );
            // Same defense layer as run_user_deletion above: engine-level rejection.
            expect(errMsg).toMatch(
                /no such reducer|Forbidden/i,
            );
        },
        30000,
    );
});
