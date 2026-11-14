/**
 * T-M5b (fix pass, deploy blocker): `.vercelignore` drops `scripts/`, so the production build
 * must not reach it. Vite's own config loader bundles `web/vite.config.ts` and reports every file
 * it pulled in (`dependencies`): none may be under `scripts/`, for a build and for the dev server,
 * and only the dev server gets the local sign-in plugin. Nothing is built or served.
 */
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile, type PluginOption } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const WEB = fileURLToPath(new URL('../../../web', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../../web/vite.config.ts', import.meta.url));

afterEach(() => vi.unstubAllEnvs());

const repoPath = (abs: string) => relative(REPO, abs).split(sep).join('/');

/** Plugin names, with nested arrays flattened. */
async function pluginNames(option: PluginOption | PluginOption[] | undefined): Promise<string[]> {
    const resolved = await option;
    if (!resolved) return [];
    if (Array.isArray(resolved)) return (await Promise.all(resolved.map(pluginNames))).flat();
    return 'name' in resolved ? [resolved.name] : [];
}

async function load(command: 'build' | 'serve') {
    vi.stubEnv('VITE_STDB_TARGET', 'test');
    const loaded = await loadConfigFromFile(
        { command, mode: command === 'build' ? 'production' : 'development', isPreview: false, isSsrBuild: false },
        CONFIG,
        WEB,
        'silent',
    );
    if (!loaded) throw new Error('no config');
    return { deps: loaded.dependencies.map(repoPath), plugins: await pluginNames(loaded.config.plugins) };
}

describe('web/vite.config.ts never reaches scripts/', () => {
    it('build: no dependency under scripts/, and no local sign-in plugin', async () => {
        const { deps, plugins } = await load('build');
        expect(deps).toContain('web/vite.config.ts');
        expect(deps.filter((d) => d.startsWith('scripts/'))).toEqual([]);
        expect(plugins).not.toContain('hsr-local-auth');
        expect(plugins.length).toBeGreaterThan(0);
    }, 30_000);

    it('dev server: the plugin is added, and still nothing under scripts/ is bundled into the config', async () => {
        const { deps, plugins } = await load('serve');
        expect(plugins).toContain('hsr-local-auth');
        expect(deps).toContain('web/vite-plugin-local-auth.ts');
        expect(deps.filter((d) => d.startsWith('scripts/'))).toEqual([]);
    }, 30_000);
});
