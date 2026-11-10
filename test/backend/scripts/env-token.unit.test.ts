// T-S10s (DECISIONS.md A122(23), triage L99): scripts/stdb/_env.ts mergeTargetEnv. The prod server token comes only
// from .env.prod.local; the shell's STDB_SERVER_TOKEN is never used for prod. Pure records only: no real env file is
// read and nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { mergeTargetEnv } from '../../../scripts/stdb/_env';
import { resolveBackendEnv } from '../../../shared/stdb-targets';

const SHELL = { STDB_SERVER_TOKEN: 'shell-token', PATH: '/bin' };

describe('A122(23) L99: the prod server token comes only from the prod env file', () => {
    it('A122(23) L99: prod with no token in its file has no token, whatever the shell exports; a privileged script fails fast', () => {
        const merged = mergeTargetEnv('prod', SHELL, {});
        expect(merged.STDB_SERVER_TOKEN).toBeUndefined();
        expect(merged.PATH).toBe('/bin'); // the rest of the shell environment is kept
        expect(() => resolveBackendEnv('prod', merged, { requireToken: true })).toThrow(/STDB_SERVER_TOKEN is missing for target "prod"/);
    });

    it('A122(23) L99 (neighbour): prod uses the token of its own file', () => {
        const merged = mergeTargetEnv('prod', SHELL, { STDB_SERVER_TOKEN: 'file-prod' });
        expect(resolveBackendEnv('prod', merged, { requireToken: true }).serverToken).toBe('file-prod');
    });

    it('A122(23) L99: test keeps the shell value as a fallback when its file has none; its file still wins', () => {
        expect(mergeTargetEnv('test', SHELL, {}).STDB_SERVER_TOKEN).toBe('shell-token');
        expect(mergeTargetEnv('test', SHELL, { STDB_SERVER_TOKEN: 'file-test' }).STDB_SERVER_TOKEN).toBe('file-test');
    });
});
