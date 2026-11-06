/**
 * Run the spacetime CLI (or a local command) with a fixed shape: target-bound commands always
 * carry `--server maincloud --no-config` and run with `STDB_TARGET=<target>` in the child
 * environment (the module reads the declared value at publish time; `--env <name>` would only
 * select a spacetime.<name>.json file).
 */
import { spawnSync } from 'node:child_process';
import {
    assertNoForbiddenProdFlags,
    ENV_KEYS,
    EnvConfigError,
    STDB_SERVER_NICKNAME,
    type Target,
} from '../../shared/stdb-targets';
import { REPO_ROOT } from './_env';

export interface SpawnSpec {
    /** argv for `spacetime`, without the executable. */
    args: readonly string[];
    /** Set for target-bound commands; omitted for local ones (generate). */
    target?: Target;
    /** Extra child environment (publish passes publishArgs(...).env). Never secrets. */
    env?: Record<string, string>;
    dryRun: boolean;
    /** Capture stdout instead of inheriting it. */
    captureStdout?: boolean;
}

function assertShape(spec: SpawnSpec): void {
    if (spec.target === undefined) return;
    const a = spec.args;
    const serverIdx = a.indexOf('--server');
    if (
        serverIdx === -1 ||
        a[serverIdx + 1] !== STDB_SERVER_NICKNAME ||
        !a.includes('--no-config')
    ) {
        throw new EnvConfigError(
            `refusing "spacetime ${a.join(' ')}": target-bound commands need --server ${STDB_SERVER_NICKNAME} --no-config.`,
        );
    }
    if (spec.target === 'prod') assertNoForbiddenProdFlags(a);
}

export function childEnvFor(spec: SpawnSpec): Record<string, string> {
    return { ...(spec.target ? { [ENV_KEYS.target]: spec.target } : {}), ...(spec.env ?? {}) };
}

export function formatCommand(spec: SpawnSpec): string {
    const envPart = Object.entries(childEnvFor(spec))
        .map(([k, v]) => `${k}=${v} `)
        .join('');
    return `${envPart}spacetime ${spec.args.join(' ')}`;
}

/** Returns captured stdout ('' when inherited or dry-run). Throws on a non-zero exit. */
export function runSpacetime(spec: SpawnSpec): string {
    assertShape(spec);
    if (spec.dryRun) {
        console.log(`[dry-run] ${formatCommand(spec)}`);
        const keys = Object.keys(childEnvFor(spec));
        console.log(
            `[dry-run] child environment keys: ${keys.length > 0 ? keys.join(', ') : '(none)'}`,
        );
        return '';
    }
    const res = spawnSync('spacetime', [...spec.args], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...childEnvFor(spec) },
        stdio: spec.captureStdout ? ['inherit', 'pipe', 'inherit'] : 'inherit',
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
        throw new Error(`spacetime ${spec.args[0]} exited with status ${res.status}`);
    }
    return spec.captureStdout ? res.stdout : '';
}

/** Run a local command line through the shell (npm / npx need it on Windows). Throws on failure. */
export function runLocal(commandLine: string, env: Record<string, string> = {}): void {
    const res = spawnSync(commandLine, {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        stdio: 'inherit',
        shell: true,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`"${commandLine}" exited with status ${res.status}`);
}
