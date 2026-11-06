// Prototype: test / prod environment resolver for the new repo (brief 9.2).
// Pure TypeScript. No SpacetimeDB runtime, no fs, no process.env: callers pass a plain
// record so the same function serves scripts, the test harness and vitest configs.
//
// Design rules this encodes (ACCESS-SECURITY-OPS.md part C):
//   1. Exactly two targets, named `test` and `prod`. Nothing else parses.
//   2. The database names are committed constants, keyed by target. They are not secrets
//      (they ship in the JS bundle) and there is no fallback: a missing target throws.
//   3. Secrets are read from ONE key name, `STDB_SERVER_TOKEN`, but from a per-target file
//      (`.env.test.local` / `.env.prod.local`), so prod secrets never sit where test tooling reads.
//   4. Every CLI invocation names the database explicitly and passes `--no-config` (the CLI
//      otherwise insists on the spacetime.json database; see skill references/spacetime-json.md).
//   5. `--clear-database` / `--delete-data` are refused for prod at the resolver, before any
//      shell command is built. Prod publishes always carry `--yes=migrate` and nothing more.

export type Target = 'test' | 'prod';

export const TARGETS: readonly Target[] = ['test', 'prod'];

/** Committed, non-secret. Renamed by the user on 2026-11-06. */
export const STDB_DATABASES: Readonly<Record<Target, string>> = {
    test: 'hsr-spacetimedb-test1',
    prod: 'hsr-spacetimedb-prod',
};

export const STDB_SERVER_NICKNAME = 'maincloud';
export const STDB_HOST = 'wss://maincloud.spacetimedb.com';

/** The one env-var vocabulary, used identically in every layer. */
export const ENV_KEYS = {
    /** Node side (scripts, test harness, vitest configs). */
    target: 'STDB_TARGET',
    serverToken: 'STDB_SERVER_TOKEN',
    /** Browser side (Vite only exposes VITE_*). The value set is identical: `test` | `prod`. */
    viteTarget: 'VITE_STDB_TARGET',
} as const;

export class EnvConfigError extends Error {
    constructor(message: string) {
        super(`[env-config] ${message}`);
        this.name = 'EnvConfigError';
    }
}

export function parseTarget(raw: string | undefined, source: string = ENV_KEYS.target): Target {
    if (raw === undefined || raw === '') {
        throw new EnvConfigError(`${source} is required (expected "test" or "prod"); refusing to guess a database.`);
    }
    if (raw !== 'test' && raw !== 'prod') {
        throw new EnvConfigError(`${source}="${raw}" is not a target; expected "test" or "prod".`);
    }
    return raw;
}

/** Per-target secret file. `.env.local` is deliberately not read by anything. */
export function envFileFor(target: Target): string {
    return `.env.${target}.local`;
}

/** Invariant shared with the wipe guards: test names carry "-test", prod names never do. */
export function assertNameMatchesTarget(target: Target, dbName: string): void {
    const hasTestMarker = dbName.includes('-test');
    if (target === 'test' && !hasTestMarker) {
        throw new EnvConfigError(`database "${dbName}" is configured as test but its name has no "-test" marker.`);
    }
    if (target === 'prod' && hasTestMarker) {
        throw new EnvConfigError(`database "${dbName}" is configured as prod but its name carries a "-test" marker.`);
    }
    if (dbName !== STDB_DATABASES[target]) {
        throw new EnvConfigError(`database "${dbName}" is not the committed ${target} database "${STDB_DATABASES[target]}".`);
    }
}

export interface BackendEnv {
    target: Target;
    dbName: string;
    host: string;
    server: string;
    /** Present only when the caller asked for it (requireToken) or the file supplied it. */
    serverToken?: string;
    envFile: string;
}

export interface ResolveOptions {
    /** Scripts that call `server_*` reducers set this; read-only scripts don't. */
    requireToken?: boolean;
}

/**
 * Resolve the backend connection for one explicit target.
 * `env` is the merged record of process.env + the per-target file, loaded by the caller.
 */
export function resolveBackendEnv(
    target: Target,
    env: Readonly<Record<string, string | undefined>>,
    opts: ResolveOptions = {},
): BackendEnv {
    const dbName = STDB_DATABASES[target];
    assertNameMatchesTarget(target, dbName);

    const token = env[ENV_KEYS.serverToken];
    if (opts.requireToken && (token === undefined || token === '')) {
        throw new EnvConfigError(
            `${ENV_KEYS.serverToken} is missing for target "${target}"; expected it in ${envFileFor(target)} (written by the bootstrap script).`,
        );
    }

    return {
        target,
        dbName,
        host: STDB_HOST,
        server: STDB_SERVER_NICKNAME,
        serverToken: token && token !== '' ? token : undefined,
        envFile: envFileFor(target),
    };
}

export interface BrowserEnv {
    target: Target;
    dbName: string;
    host: string;
    /** localStorage key for the SDK token; scoped per database so test and prod identities never mix. */
    tokenStorageKey: string;
}

/** Vite side: `import.meta.env` is passed in; only VITE_STDB_TARGET is read. */
export function resolveBrowserEnv(env: Readonly<Record<string, string | undefined>>): BrowserEnv {
    const target = parseTarget(env[ENV_KEYS.viteTarget], ENV_KEYS.viteTarget);
    const dbName = STDB_DATABASES[target];
    assertNameMatchesTarget(target, dbName);
    return {
        target,
        dbName,
        host: STDB_HOST,
        tokenStorageKey: `${STDB_HOST}/${dbName}/auth_token`,
    };
}

// ─── CLI argument builders ─────────────────────────────────────────────────────

/** Guard used by global-setup, nuke scripts and the publish builder. */
export function assertWipeAllowed(target: Target): void {
    if (target !== 'test') {
        throw new EnvConfigError(`refusing a destructive operation on target "${target}"; only "test" may be wiped.`);
    }
}

export interface PublishOptions {
    modulePath: string;
    /** Wipe all data. Allowed on test only. */
    clearDatabase?: boolean;
    /** Auto-confirm only the migration prompt. Required on prod. */
    yesMigrate?: boolean;
}

export interface PublishCommand {
    /** argv without the executable. Explicit name + --no-config always. */
    args: string[];
    /**
     * Extra process environment for the spawn. The module declares `env: { STDB_TARGET }` in `schema(...)`;
     * SpacetimeDB 2.12+ reads declared keys from the publisher's shell environment at publish time
     * (`--env <name>` on the CLI selects a spacetime.{name}.json config file, it does NOT set a module value).
     */
    env: Record<string, string>;
}

/**
 * `spacetime publish …` for CLI 2.14.1: `-c, --delete-data[=always|on-conflict|never]` is the wipe
 * (`--clear-database` is only the placeholder name in 2.14.1 `--help`), `--yes=<list>` skips named prompts.
 */
export function publishArgs(target: Target, opts: PublishOptions): PublishCommand {
    const dbName = STDB_DATABASES[target];
    assertNameMatchesTarget(target, dbName);
    const args = ['publish', dbName, '--server', STDB_SERVER_NICKNAME, '--no-config', '--module-path', opts.modulePath];
    const env = { [ENV_KEYS.target]: target };

    if (opts.clearDatabase) {
        assertWipeAllowed(target);
        args.push('--delete-data=always', '--yes=delete-data');
        return { args, env };
    }
    if (target === 'prod') {
        if (!opts.yesMigrate) {
            throw new EnvConfigError('prod publishes must pass yesMigrate: true (reviewed delta, `--yes=migrate`).');
        }
        args.push('--yes=migrate');
        return { args, env };
    }
    if (opts.yesMigrate) args.push('--yes=migrate');
    return { args, env };
}

/** Read-only CLI commands against a target: describe / sql / logs. */
export function readArgs(target: Target, command: 'describe' | 'sql' | 'logs', extra: string[] = []): string[] {
    const dbName = STDB_DATABASES[target];
    assertNameMatchesTarget(target, dbName);
    const base = [command, dbName, '--server', STDB_SERVER_NICKNAME, '--no-config'];
    if (command === 'describe') base.push('--json');
    return [...base, ...extra];
}

/** Forbidden anywhere in automation; listed so a lint/grep gate can assert their absence. */
export const FORBIDDEN_PROD_FLAGS = ['--clear-database', '--delete-data', '-c', '--yes=delete-data', '--yes=all', '--yes', '-y'] as const;

export function assertNoForbiddenProdFlags(args: readonly string[]): void {
    for (const a of args) {
        if ((FORBIDDEN_PROD_FLAGS as readonly string[]).includes(a) || a.startsWith('--delete-data=') || a.startsWith('-c=')) {
            throw new EnvConfigError(`argument "${a}" is forbidden against prod.`);
        }
    }
}
