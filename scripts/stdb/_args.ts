/**
 * Shared CLI parsing for scripts/stdb/*.ts.
 *
 *   --target test|prod   the database target (wins over the STDB_TARGET env var; neither → fail fast)
 *   --dry-run            print the exact CLI command instead of running it (scripts that spawn the CLI)
 *   --<flag>             any other boolean flag (e.g. --clear)
 *   positionals          everything else, in order (e.g. manage-user's action + username)
 */
import { ENV_KEYS, EnvConfigError, parseTarget, type Target } from '../../shared/stdb-targets';

export interface CliArgs {
    target: Target;
    dryRun: boolean;
    flags: ReadonlySet<string>;
    positionals: readonly string[];
}

/** Parse argv. `--target <t>` (or `--target=<t>`) wins over `process.env.STDB_TARGET`. */
export function parseCli(
    argv: readonly string[] = process.argv.slice(2),
    env: Readonly<Record<string, string | undefined>> = process.env,
): CliArgs {
    let flagTarget: string | undefined;
    const flags = new Set<string>();
    const positionals: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--target') {
            flagTarget = argv[i + 1];
            if (flagTarget === undefined || flagTarget.startsWith('--')) {
                throw new EnvConfigError('--target needs a value (expected "test" or "prod").');
            }
            i++;
        } else if (a.startsWith('--target=')) {
            flagTarget = a.slice('--target='.length);
        } else if (a.startsWith('--')) {
            flags.add(a.slice(2));
        } else {
            positionals.push(a);
        }
    }
    const target =
        flagTarget !== undefined
            ? parseTarget(flagTarget, '--target')
            : parseTarget(env[ENV_KEYS.target], ENV_KEYS.target);
    return { target, dryRun: flags.has('dry-run'), flags, positionals };
}

/** For local-only scripts that take no target (generate). */
export function parseFlags(argv: readonly string[] = process.argv.slice(2)): {
    dryRun: boolean;
    flags: ReadonlySet<string>;
} {
    const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2)));
    return { dryRun: flags.has('dry-run'), flags };
}

/** Run a script body; a thrown error prints one line and exits 1 (fail fast). */
export function runMain(name: string, body: () => Promise<void> | void): void {
    Promise.resolve()
        .then(body)
        .then(() => process.exit(0))
        .catch((err: unknown) => {
            if (err instanceof EnvConfigError) {
                console.error(`[${name}] ${err.message}`);
            } else {
                console.error(`[${name}] failed:`, err instanceof Error ? err.message : err);
            }
            process.exit(1);
        });
}
