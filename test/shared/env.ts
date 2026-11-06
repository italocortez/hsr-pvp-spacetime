/**
 * Backend environment for the live test harness (ACCESS-SECURITY-OPS §C.2, task T-S2).
 *
 * Target: STDB_TARGET (set to `test` by `npm run test:integration`; nothing else parses, and the
 * harness refuses prod). Secrets: `.env.test.local`, written by `npm run stdb:bootstrap:test`; the
 * file is re-read on every call because globalSetup's bootstrap rotates the delegate token.
 * `.env.local` and the legacy SPACETIMEDB_* keys are not read.
 */

import { envFilePath, readEnvFile } from '../../scripts/stdb/_env';
import { type BackendEnv, parseTarget, resolveBackendEnv } from '../../shared/stdb-targets';

export function backendEnv(): BackendEnv {
    const target = parseTarget(process.env.STDB_TARGET);
    if (target !== 'test') {
        throw new Error(
            `[test env] STDB_TARGET="${target}": the live suite runs against test only.`,
        );
    }
    // The file wins over the shell: a token exported for another database must never be used here.
    Object.assign(process.env, readEnvFile(envFilePath(target)));
    return resolveBackendEnv(target, process.env);
}

/** Delegate token from .env.test.local ('' when bootstrap has not run). */
export function serverToken(): string {
    return backendEnv().serverToken ?? '';
}
