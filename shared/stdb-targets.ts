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
//      shell command is built. Prod publishes always carry `--yes=migrate` and nothing more; every prod command is
//      checked against an allow-list of exact flags (S10s, assertNoForbiddenProdFlags), which refuses `--yes=remote`.
//      Test publishes always carry `--yes=remote` and `--yes=break-clients` so they run without a terminal (M5b, user
//      ruling 2026-11-14: a test publish may disconnect clients).

export type Target = 'test' | 'prod';

/** Committed, non-secret. Renamed by the user on 2026-11-06. */
export const STDB_DATABASES: Readonly<Record<Target, string>> = {
    test: 'hsr-spacetimedb-test1',
    prod: 'hsr-spacetimedb-prod',
};

export const STDB_SERVER_NICKNAME = 'maincloud';
export const STDB_HOST = 'wss://maincloud.spacetimedb.com';

/** The target key names, standalone so browser code reads them without ENV_KEYS. */
const TARGET_KEY = 'STDB_TARGET';
const VITE_TARGET_KEY = 'VITE_STDB_TARGET';

/**
 * The one env-var vocabulary, used identically in every layer. M5b: browser code must not reference
 * this object (it names the secret keys, and check:patterns gate 10 refuses them in web/dist);
 * `parseTarget` and `resolveBrowserEnv` use the standalone constants above, so the bundler drops it.
 */
export const ENV_KEYS = {
    /** Node side (scripts, test harness, vitest configs). */
    target: TARGET_KEY,
    serverToken: 'STDB_SERVER_TOKEN',
    /** M5a3: the auth function's Linker token (it may only present sign-in codes); written by bootstrap. */
    linkToken: 'STDB_LINK_TOKEN',
    /** Browser side (Vite only exposes VITE_*). The value set is identical: `test` | `prod`. */
    viteTarget: VITE_TARGET_KEY,
} as const;

export class EnvConfigError extends Error {
    constructor(message: string) {
        super(`[env-config] ${message}`);
        this.name = 'EnvConfigError';
    }
}

export function parseTarget(raw: string | undefined, source: string = TARGET_KEY): Target {
    if (raw === undefined || raw === '') {
        throw new EnvConfigError(
            `${source} is required (expected "test" or "prod"); refusing to guess a database.`,
        );
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
        throw new EnvConfigError(
            `database "${dbName}" is configured as test but its name has no "-test" marker.`,
        );
    }
    if (target === 'prod' && hasTestMarker) {
        throw new EnvConfigError(
            `database "${dbName}" is configured as prod but its name carries a "-test" marker.`,
        );
    }
    if (dbName !== STDB_DATABASES[target]) {
        throw new EnvConfigError(
            `database "${dbName}" is not the committed ${target} database "${STDB_DATABASES[target]}".`,
        );
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
    const target = parseTarget(env[VITE_TARGET_KEY], VITE_TARGET_KEY);
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
        throw new EnvConfigError(
            `refusing a destructive operation on target "${target}"; only "test" may be wiped.`,
        );
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
 * `spacetime publish …` for CLI 2.15.0 (`--help` unchanged since 2.14.1): `-c, --delete-data[=always|on-conflict|never]`
 * is the wipe (`--clear-database` is only the placeholder name in `--help`), `--yes=<list>` skips named prompts
 * (repeated `--yes=<value>` flags are accepted).
 * Test publishes always carry `--yes=remote` (skips the "publish to a non-local server?" prompt, so the script and
 * the live suite's globalSetup run without a terminal) and, since M5b, `--yes=break-clients` (user ruling
 * 2026-11-14: "we accept that it would disconnect clients"); the migration prompt stays.
 * Prod never gets `--yes=remote`: it keeps `--yes=migrate` only and its interactive non-local confirmation.
 */
export function publishArgs(target: Target, opts: PublishOptions): PublishCommand {
    const dbName = STDB_DATABASES[target];
    assertNameMatchesTarget(target, dbName);
    const args = [
        'publish',
        dbName,
        '--server',
        STDB_SERVER_NICKNAME,
        '--no-config',
        '--module-path',
        opts.modulePath,
    ];
    const env = { [ENV_KEYS.target]: target };
    if (target === 'test') args.push('--yes=remote', '--yes=break-clients');

    if (opts.clearDatabase) {
        assertWipeAllowed(target);
        args.push('--delete-data=always', '--yes=delete-data');
        return { args, env };
    }
    if (target === 'prod') {
        if (!opts.yesMigrate) {
            throw new EnvConfigError(
                'prod publishes must pass yesMigrate: true (reviewed delta, `--yes=migrate`).',
            );
        }
        args.push('--yes=migrate');
        return { args, env };
    }
    if (opts.yesMigrate) args.push('--yes=migrate');
    return { args, env };
}

/** Read-only CLI commands against a target: describe / sql / logs. */
export function readArgs(
    target: Target,
    command: 'describe' | 'sql' | 'logs',
    extra: string[] = [],
): string[] {
    const dbName = STDB_DATABASES[target];
    assertNameMatchesTarget(target, dbName);
    const base = [command, dbName, '--server', STDB_SERVER_NICKNAME, '--no-config'];
    if (command === 'describe') base.push('--json');
    return [...base, ...extra];
}

/** Forbidden anywhere in automation; listed so a lint/grep gate can assert their absence. */
export const FORBIDDEN_PROD_FLAGS = [
    '--clear-database',
    '--delete-data',
    '-c',
    '--yes=delete-data',
    '--yes=all',
    '--yes',
    '-y',
] as const;

/**
 * S10s (A122(23), L100): the only flags a prod command may carry, exactly as written (no `=value` variants except
 * `--yes=migrate`): the ones publishArgs and readArgs build. `true` = the flag takes the next argument as its value.
 */
export const ALLOWED_PROD_FLAGS: Readonly<Record<string, boolean>> = {
    '--server': true, // value must be STDB_SERVER_NICKNAME
    '--no-config': false,
    '--module-path': true, // value: any path that is not itself a flag
    '--yes=migrate': false, // the one confirmation prod accepts (CLAUDE.md §5, skill "Publishing")
    '--json': false, // describe
};

/**
 * S10s (A122(23), L100): an allow-list. Every argument that starts with `-` must be one of ALLOWED_PROD_FLAGS, spelled
 * exactly; `--server` must be followed by `maincloud` and `--module-path` by a value that is not a flag. Anything else
 * (`--yes=migrate,delete-data`, `--yes=break-clients`, `-y`, `--delete-data`, `--anything`) is refused. Positional
 * arguments (the command, the database name, an SQL text) pass.
 */
export function assertNoForbiddenProdFlags(args: readonly string[]): void {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === undefined || !a.startsWith('-')) continue;
        if (!Object.hasOwn(ALLOWED_PROD_FLAGS, a)) {
            throw new EnvConfigError(`argument "${a}" is forbidden against prod.`);
        }
        if (!ALLOWED_PROD_FLAGS[a]) continue;
        const value = args[i + 1];
        if (
            value === undefined ||
            value.startsWith('-') ||
            (a === '--server' && value !== STDB_SERVER_NICKNAME)
        ) {
            throw new EnvConfigError(`argument "${a} ${value ?? ''}" is forbidden against prod.`);
        }
        i++; // the value is consumed
    }
}
