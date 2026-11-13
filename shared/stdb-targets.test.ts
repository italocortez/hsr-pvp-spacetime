import { describe, expect, it } from 'vitest';
import {
    assertNameMatchesTarget,
    assertNoForbiddenProdFlags,
    assertWipeAllowed,
    ENV_KEYS,
    EnvConfigError,
    envFileFor,
    parseTarget,
    publishArgs,
    readArgs,
    resolveBackendEnv,
    resolveBrowserEnv,
    STDB_DATABASES,
} from './stdb-targets';

describe('parseTarget', () => {
    it('accepts exactly test and prod', () => {
        expect(parseTarget('test')).toBe('test');
        expect(parseTarget('prod')).toBe('prod');
    });
    it('fails fast on missing or unknown values (no silent fallback to test1)', () => {
        expect(() => parseTarget(undefined)).toThrow(EnvConfigError);
        expect(() => parseTarget('')).toThrow(/required/);
        expect(() => parseTarget('production')).toThrow(/not a target/);
        expect(() => parseTarget('TEST')).toThrow(EnvConfigError);
    });
});

describe('database-name invariants', () => {
    it('committed names match their target marker', () => {
        expect(STDB_DATABASES.test).toContain('-test');
        expect(STDB_DATABASES.prod).not.toContain('-test');
        expect(() => assertNameMatchesTarget('test', STDB_DATABASES.test)).not.toThrow();
        expect(() => assertNameMatchesTarget('prod', STDB_DATABASES.prod)).not.toThrow();
    });
    it('rejects a test name presented as prod and vice versa', () => {
        expect(() => assertNameMatchesTarget('prod', 'hsr-spacetimedb-test1')).toThrow(/-test/);
        expect(() => assertNameMatchesTarget('test', 'hsr-spacetimedb-prod')).toThrow(/no "-test"/);
    });
    it('rejects the released old names', () => {
        expect(() => assertNameMatchesTarget('test', 'hsrpvp-spacetimedb-nextjs-test1')).toThrow(
            /not the committed/,
        );
        expect(() =>
            assertNameMatchesTarget('prod', 'hsrpvp-spacetimedb-nextjs-production'),
        ).toThrow(/not the committed/);
    });
});

describe('resolveBackendEnv', () => {
    it('resolves test with its own secret file', () => {
        const r = resolveBackendEnv(
            'test',
            { STDB_SERVER_TOKEN: 'tok-test' },
            { requireToken: true },
        );
        expect(r.dbName).toBe('hsr-spacetimedb-test1');
        expect(r.host).toBe('wss://maincloud.spacetimedb.com');
        expect(r.server).toBe('maincloud');
        expect(r.serverToken).toBe('tok-test');
        expect(r.envFile).toBe('.env.test.local');
    });
    it('resolves prod from a different file with the same key name', () => {
        const r = resolveBackendEnv(
            'prod',
            { STDB_SERVER_TOKEN: 'tok-prod' },
            { requireToken: true },
        );
        expect(r.dbName).toBe('hsr-spacetimedb-prod');
        expect(r.envFile).toBe('.env.prod.local');
        expect(envFileFor('prod')).not.toBe(envFileFor('test'));
    });
    it('fails fast when a privileged script lacks the token', () => {
        expect(() => resolveBackendEnv('prod', {}, { requireToken: true })).toThrow(
            /STDB_SERVER_TOKEN is missing for target "prod"/,
        );
        expect(() =>
            resolveBackendEnv('test', { STDB_SERVER_TOKEN: '' }, { requireToken: true }),
        ).toThrow(EnvConfigError);
    });
    it('read-only callers may omit the token', () => {
        const r = resolveBackendEnv('test', {});
        expect(r.serverToken).toBeUndefined();
    });
    it('ignores legacy keys entirely (no seven-name sprawl)', () => {
        const r = resolveBackendEnv('test', {
            PUBLIC_SPACETIMEDB_DB_NAME: 'hsrpvp-spacetimedb-nextjs-test1',
            NEXT_PUBLIC_SPACETIMEDB_DB_NAME: 'something-else',
            SPACETIMEDB_DB: 'another',
            STDB_SERVER_TOKEN: 't',
        });
        expect(r.dbName).toBe('hsr-spacetimedb-test1');
    });
});

describe('resolveBrowserEnv (Vite)', () => {
    it('reads only VITE_STDB_TARGET and derives everything else', () => {
        const r = resolveBrowserEnv({ [ENV_KEYS.viteTarget]: 'prod' });
        expect(r.dbName).toBe('hsr-spacetimedb-prod');
        expect(r.tokenStorageKey).toBe(
            'wss://maincloud.spacetimedb.com/hsr-spacetimedb-prod/auth_token',
        );
    });
    it('Preview and Production deployments differ only by the target value', () => {
        const preview = resolveBrowserEnv({ VITE_STDB_TARGET: 'test' });
        const production = resolveBrowserEnv({ VITE_STDB_TARGET: 'prod' });
        expect(preview.dbName).not.toBe(production.dbName);
        expect(preview.tokenStorageKey).not.toBe(production.tokenStorageKey);
    });
    it('a build without the variable fails instead of connecting to test1', () => {
        expect(() => resolveBrowserEnv({})).toThrow(/VITE_STDB_TARGET is required/);
    });
});

describe('publishArgs', () => {
    const modulePath = 'spacetimedb';
    it('test: explicit name, --no-config, wipe allowed with the 2.14.1 flag spelling', () => {
        const cmd = publishArgs('test', { modulePath, clearDatabase: true });
        expect(cmd.args).toEqual([
            'publish',
            'hsr-spacetimedb-test1',
            '--server',
            'maincloud',
            '--no-config',
            '--module-path',
            'spacetimedb',
            '--yes=remote',
            '--delete-data=always',
            '--yes=delete-data',
        ]);
        expect(cmd.args).not.toContain('--clear-database');
    });
    it('test: every publish skips the non-local prompt with --yes=remote (no terminal needed)', () => {
        expect(publishArgs('test', { modulePath }).args).toEqual([
            'publish',
            'hsr-spacetimedb-test1',
            '--server',
            'maincloud',
            '--no-config',
            '--module-path',
            'spacetimedb',
            '--yes=remote',
        ]);
        expect(publishArgs('test', { modulePath, clearDatabase: true }).args).toContain(
            '--yes=remote',
        );
        expect(publishArgs('test', { modulePath, yesMigrate: true }).args).toEqual([
            'publish',
            'hsr-spacetimedb-test1',
            '--server',
            'maincloud',
            '--no-config',
            '--module-path',
            'spacetimedb',
            '--yes=remote',
            '--yes=migrate',
        ]);
    });
    it('prod: never --yes=remote, and the allow-list refuses it if added', () => {
        const { args } = publishArgs('prod', { modulePath, yesMigrate: true });
        expect(args.some((a) => a.includes('remote'))).toBe(false);
        expect(() => assertNoForbiddenProdFlags([...args, '--yes=remote'])).toThrow(
            /forbidden against prod/,
        );
        expect(() =>
            assertNoForbiddenProdFlags([...args.slice(0, -1), '--yes=migrate,remote']),
        ).toThrow(/forbidden against prod/);
    });
    it('every publish carries the module env value for the target (shell env, not --env)', () => {
        expect(publishArgs('test', { modulePath }).env).toEqual({ STDB_TARGET: 'test' });
        expect(publishArgs('prod', { modulePath, yesMigrate: true }).env).toEqual({
            STDB_TARGET: 'prod',
        });
        expect(
            publishArgs('prod', { modulePath, yesMigrate: true }).args.some((a) =>
                a.startsWith('--env'),
            ),
        ).toBe(false);
    });
    it('prod: never a wipe, always --yes=migrate', () => {
        expect(() => publishArgs('prod', { modulePath, clearDatabase: true })).toThrow(
            /refusing a destructive operation/,
        );
        expect(() => publishArgs('prod', { modulePath })).toThrow(/yesMigrate/);
        const { args } = publishArgs('prod', { modulePath, yesMigrate: true });
        expect(args).toEqual([
            'publish',
            'hsr-spacetimedb-prod',
            '--server',
            'maincloud',
            '--no-config',
            '--module-path',
            'spacetimedb',
            '--yes=migrate',
        ]);
        expect(() => assertNoForbiddenProdFlags(args)).not.toThrow();
    });
    it('the forbidden-flag gate catches every wipe spelling', () => {
        for (const bad of [
            '--clear-database',
            '--delete-data',
            '--delete-data=always',
            '-c',
            '-c=always',
            '--yes=delete-data',
            '--yes=all',
            '--yes',
            '-y',
        ]) {
            expect(() => assertNoForbiddenProdFlags(['publish', 'x', bad])).toThrow(
                /forbidden against prod/,
            );
        }
    });
    // T-S10s (A122(23), L100): the prod guard is an allow-list of exact flags and values.
    it('A122(23) L100: combined or other --yes values, unknown flags and a wrong --server value are refused against prod', () => {
        for (const bad of [
            '--yes=migrate,delete-data',
            '--yes=break-clients',
            '--yes=migrate,break-clients',
            '--yes=remote',
            '--anything',
            '-x',
            '--env=prod',
            '--build-options=x',
        ]) {
            expect(
                () =>
                    assertNoForbiddenProdFlags([
                        'publish',
                        'hsr-spacetimedb-prod',
                        '--server',
                        'maincloud',
                        '--no-config',
                        bad,
                    ]),
                bad,
            ).toThrow(/forbidden against prod/);
        }
        expect(() =>
            assertNoForbiddenProdFlags(['publish', 'x', '--server', 'local', '--no-config']),
        ).toThrow(/forbidden against prod/);
        expect(() =>
            assertNoForbiddenProdFlags(['publish', 'x', '--server', 'maincloud', '--module-path']),
        ).toThrow(/forbidden against prod/);
        expect(() =>
            assertNoForbiddenProdFlags(['publish', 'x', '--module-path', '--yes=migrate']),
        ).toThrow(/forbidden against prod/);
    });
    it('A122(23) L100 (neighbour): the commands publishArgs and readArgs build for prod pass the allow-list', () => {
        expect(() =>
            assertNoForbiddenProdFlags(publishArgs('prod', { modulePath, yesMigrate: true }).args),
        ).not.toThrow();
        expect(() => assertNoForbiddenProdFlags(readArgs('prod', 'describe'))).not.toThrow();
        expect(() =>
            assertNoForbiddenProdFlags(
                readArgs('prod', 'sql', ['SELECT COUNT(*) AS n FROM hsr_character']),
            ),
        ).not.toThrow();
    });
    it('plain test publish keeps the migration prompt (no --yes=migrate) unless asked', () => {
        expect(publishArgs('test', { modulePath }).args).not.toContain('--yes=migrate');
        expect(publishArgs('test', { modulePath, yesMigrate: true }).args).toContain(
            '--yes=migrate',
        );
    });
});

describe('readArgs and wipe guard', () => {
    it('describe gets --json; every command gets --no-config and the explicit name', () => {
        expect(readArgs('prod', 'describe')).toEqual([
            'describe',
            'hsr-spacetimedb-prod',
            '--server',
            'maincloud',
            '--no-config',
            '--json',
        ]);
        expect(readArgs('test', 'sql', ['SELECT COUNT(*) AS n FROM user'])).toEqual([
            'sql',
            'hsr-spacetimedb-test1',
            '--server',
            'maincloud',
            '--no-config',
            'SELECT COUNT(*) AS n FROM user',
        ]);
    });
    it('assertWipeAllowed only passes for test', () => {
        expect(() => assertWipeAllowed('test')).not.toThrow();
        expect(() => assertWipeAllowed('prod')).toThrow(EnvConfigError);
    });
});
