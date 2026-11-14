// T-M5a3-fix: scripts/stdb/_delegate.ts bootstrapLinker, the Linker step of bootstrap. By default it keeps the linker the
// env file names (registered again: restored after a wipe, "Already registered." means kept), so a deployed auth function
// keeps its token; it mints only when the file has no linker or with --rotate-linker. Fakes only: the script is not run
// and nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    bootstrapLinker,
    describeLinkerAction,
    planLinkerAction,
    type LinkerBootstrap,
} from '../../../scripts/stdb/_delegate';

const OLD_TOKEN = 'old.linker.token-SECRET';
const NEW_TOKEN = 'new.linker.token-SECRET';
const WITH_LINKER = { STDB_LINK_IDENTITY: 'old-hex', STDB_LINK_TOKEN: OLD_TOKEN };

/** Fake owner reducers, mint and env writer; `register` decides what server_register_linker answers. */
function fakes(env: Record<string, string | undefined>, rotate: boolean, register: 'ok' | 'already' | 'other' = 'ok') {
    const calls: string[] = [];
    const logs: string[] = [];
    const writes: Array<Record<string, string>> = [];
    const b: LinkerBootstrap = {
        env,
        rotate,
        label: 'vercel-link-test',
        reducers: {
            serverRegisterLinker: async ({ identityHex, label }) => {
                calls.push(`serverRegisterLinker ${identityHex} ${label}`);
                if (register === 'already') throw new Error('Already registered.');
                if (register === 'other') throw new Error('Forbidden: caller is not the database owner.');
            },
            serverRevokeLinker: async ({ identityHex }) => {
                calls.push(`serverRevokeLinker ${identityHex}`);
            },
        },
        mint: async () => {
            calls.push('mint');
            return { token: NEW_TOKEN, identityHex: 'new-hex' };
        },
        writeEnv: (values) => {
            calls.push(`write ${Object.keys(values).join(',')}`);
            writes.push(values);
        },
        log: (line) => logs.push(line),
    };
    return { b, calls, logs, writes };
}

describe('T-M5a3-fix: bootstrap keeps the deployed linker unless told to rotate', () => {
    it('plans keep with both keys, mint with none or half of them, rotate only with the flag and a linker', () => {
        expect(planLinkerAction(WITH_LINKER, false)).toBe('keep');
        expect(planLinkerAction(WITH_LINKER, true)).toBe('rotate');
        expect(planLinkerAction({}, false)).toBe('mint');
        expect(planLinkerAction({}, true)).toBe('mint');
        expect(planLinkerAction({ STDB_LINK_IDENTITY: 'old-hex' }, false)).toBe('mint');
        expect(planLinkerAction({ STDB_LINK_TOKEN: OLD_TOKEN }, false)).toBe('mint');
    });

    it('keep, still registered: server_register_linker of the same identity answers "Already registered." and nothing else happens', async () => {
        const { b, calls, logs, writes } = fakes(WITH_LINKER, false, 'already');
        await expect(bootstrapLinker(b)).resolves.toBe('keep');
        expect(calls).toEqual(['serverRegisterLinker old-hex vercel-link-test']);
        expect(writes).toEqual([]);
        expect(logs).toEqual(['[bootstrap] kept the registered linker old-hex; STDB_LINK_TOKEN unchanged']);
    });

    it('keep after a wipe: the same identity is registered again, no mint, no write, no revoke', async () => {
        const { b, calls, logs, writes } = fakes(WITH_LINKER, false, 'ok');
        await expect(bootstrapLinker(b)).resolves.toBe('keep');
        expect(calls).toEqual(['serverRegisterLinker old-hex vercel-link-test']);
        expect(writes).toEqual([]);
        expect(logs[0]).toContain('registered again (restored after a wipe)');
    });

    it('keep: any other refusal of the registration is thrown, not taken as kept', async () => {
        const { b } = fakes(WITH_LINKER, false, 'other');
        await expect(bootstrapLinker(b)).rejects.toThrow('Forbidden');
    });

    it('mint when the file has no linker: register, write STDB_LINK_TOKEN and STDB_LINK_IDENTITY, nothing to revoke', async () => {
        const { b, calls, writes } = fakes({}, false);
        await expect(bootstrapLinker(b)).resolves.toBe('mint');
        expect(calls).toEqual([
            'mint',
            'serverRegisterLinker new-hex vercel-link-test',
            'write STDB_LINK_TOKEN,STDB_LINK_IDENTITY',
        ]);
        expect(writes).toEqual([{ STDB_LINK_TOKEN: NEW_TOKEN, STDB_LINK_IDENTITY: 'new-hex' }]);
    });

    it('rotate (--rotate-linker): mint, register, write, then server_revoke_linker of the previous identity', async () => {
        const { b, calls, logs } = fakes(WITH_LINKER, true);
        await expect(bootstrapLinker(b)).resolves.toBe('rotate');
        expect(calls).toEqual([
            'mint',
            'serverRegisterLinker new-hex vercel-link-test',
            'write STDB_LINK_TOKEN,STDB_LINK_IDENTITY',
            'serverRevokeLinker old-hex',
        ]);
        expect(logs.at(-1)).toContain('Vercel function secret and redeploy');
    });

    it('a half-written file (identity, no token) mints and revokes the identity it named', async () => {
        const { b, calls } = fakes({ STDB_LINK_IDENTITY: 'old-hex' }, false);
        await expect(bootstrapLinker(b)).resolves.toBe('mint');
        expect(calls.at(-1)).toBe('serverRevokeLinker old-hex');
    });

    it('no log line and no dry-run line carries a token, whatever the action', async () => {
        for (const [env, rotate, register] of [
            [WITH_LINKER, false, 'already'],
            [WITH_LINKER, false, 'ok'],
            [{}, false, 'ok'],
            [WITH_LINKER, true, 'ok'],
        ] as const) {
            const { b, logs } = fakes(env, rotate, register);
            await bootstrapLinker(b);
            for (const line of logs) {
                expect(line).not.toContain(OLD_TOKEN);
                expect(line).not.toContain(NEW_TOKEN);
            }
        }
        for (const action of ['keep', 'mint', 'rotate'] as const) {
            const line = describeLinkerAction(action, 'vercel-link-test', '.env.test.local');
            expect(line).toMatch(/^\[dry-run\] /);
            expect(line).toContain('STDB_LINK_');
            expect(line).not.toContain('SECRET');
        }
    });

    it('the dry-run says which of the three will happen', () => {
        expect(describeLinkerAction('keep', 'vercel-link-test', '.env.test.local')).toContain('keep the linker');
        expect(describeLinkerAction('mint', 'vercel-link-test', '.env.test.local')).toContain('no linker in');
        expect(describeLinkerAction('rotate', 'vercel-link-test', '.env.test.local')).toContain('--rotate-linker');
    });
});
