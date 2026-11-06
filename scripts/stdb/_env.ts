/**
 * Per-target secret files (.env.test.local / .env.prod.local, gitignored by `.env*.local`).
 * Values are never logged. `.env.local` is deliberately not read by anything.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    type BackendEnv,
    envFileFor,
    type ResolveOptions,
    resolveBackendEnv,
    type Target,
} from '../../shared/stdb-targets';

/** Repository root (scripts/stdb/ → ../..). Paths never depend on the caller's cwd. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Written next to STDB_SERVER_TOKEN by bootstrap, so the next bootstrap can revoke the old delegate. */
export const SERVER_IDENTITY_KEY = 'STDB_SERVER_IDENTITY';

export function envFilePath(target: Target): string {
    return resolve(REPO_ROOT, envFileFor(target));
}

/** Parse a dotenv-style file into a record (KEY=VALUE lines, `#` comments; missing file → {}). */
export function readEnvFile(path: string): Record<string, string> {
    if (!existsSync(path)) return {};
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
}

/**
 * process.env merged with the per-target file. The file wins: a token exported in the shell for
 * another target must never be used against this one.
 */
export function targetEnvRecord(target: Target): Record<string, string | undefined> {
    return { ...process.env, ...readEnvFile(envFilePath(target)) };
}

export function backendEnvFor(target: Target, opts: ResolveOptions = {}): BackendEnv {
    return resolveBackendEnv(target, targetEnvRecord(target), opts);
}

/** Create or replace the given keys in `.env.<target>.local`, keeping every other line. */
export function upsertEnvFile(target: Target, values: Record<string, string>): void {
    const path = envFilePath(target);
    const keys = new Set(Object.keys(values));
    const kept = existsSync(path)
        ? readFileSync(path, 'utf-8')
              .split(/\r?\n/)
              .filter((line) => {
                  const eq = line.indexOf('=');
                  return eq <= 0 || !keys.has(line.slice(0, eq).trim());
              })
        : [];
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
    const lines = [...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)];
    writeFileSync(path, `${lines.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 });
}
