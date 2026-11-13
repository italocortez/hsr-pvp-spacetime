import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigFromFile } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEV_PROD_REFUSAL } from './assertDevTarget';

/*
 * The dev guard in web/vite.config.ts (user decision 2026-11-13), loaded through Vite's own
 * config loader: no server is started. The target comes from the process environment here (the
 * config reads it before the env files).
 */

// jsdom gives this file a non-file import.meta.url, so the web folder is found from the cwd
// (the repo root under `npm test`, or web/ itself).
const ROOT = [join(process.cwd(), 'web'), process.cwd()].find((d) =>
    existsSync(join(d, 'vite.config.ts')),
) as string;
const FILE = join(ROOT, 'vite.config.ts');
const saved = process.env.VITE_STDB_TARGET;

afterEach(() => {
    if (saved === undefined) delete process.env.VITE_STDB_TARGET;
    else process.env.VITE_STDB_TARGET = saved;
});

type Env = { command: 'serve' | 'build'; mode: string; isPreview: boolean };
const SERVE: Env = { command: 'serve', mode: 'development', isPreview: false };
const PREVIEW: Env = { command: 'serve', mode: 'production', isPreview: true };
const BUILD: Env = { command: 'build', mode: 'production', isPreview: false };

function load(env: Env, target: string | undefined) {
    if (target === undefined) delete process.env.VITE_STDB_TARGET;
    else process.env.VITE_STDB_TARGET = target;
    return loadConfigFromFile(env, FILE, ROOT, 'silent');
}

describe('vite.config.ts dev guard', () => {
    it('serve (dev) with the prod target is refused with the guard message', async () => {
        await expect(load(SERVE, 'prod')).rejects.toThrow(DEV_PROD_REFUSAL);
    });

    it('serve (dev) with the test target loads', async () => {
        await expect(load(SERVE, 'test')).resolves.toBeTruthy();
    });

    it('M8: vite preview is refused for every target and points to npm run preview', async () => {
        await expect(load(PREVIEW, 'prod')).rejects.toThrow(/Run `npm run preview`/);
        await expect(load(PREVIEW, 'test')).rejects.toThrow(/Run `npm run preview`/);
    });

    it('a build with the prod target loads', async () => {
        await expect(load(BUILD, 'prod')).resolves.toBeTruthy();
    });

    it('a build without a target is refused (the existing build check)', async () => {
        await expect(load(BUILD, undefined)).rejects.toThrow(/VITE_STDB_TARGET must be/);
    });
});
