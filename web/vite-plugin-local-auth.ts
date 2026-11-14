import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

/** The part of the local runner (scripts/local-auth/localAuth.ts) this plugin uses. */
export interface LocalAuthRunner {
    createLocalAuth(options: {
        root: string;
        target: string | undefined;
        shellEnv?: Readonly<Record<string, string | undefined>>;
        log?: (line: string) => void;
    }): {
        banner: string[];
        handle(req: IncomingMessage, res: ServerResponse): boolean;
    };
}

/**
 * Loads the local runner at dev-server start. `scripts/` is not uploaded to Vercel
 * (.vercelignore), so nothing on the build path may import it: the path is a plain string handed
 * to tsx (a pinned dev dependency, as in scripts/preview/preview.mjs), never an import specifier
 * the config bundler would follow. tsx also maps the runner's `.js` specifiers to `.ts`.
 */
async function loadRunner(): Promise<LocalAuthRunner> {
    const { tsImport } = await import('tsx/esm/api');
    return (await tsImport(
        '../scripts/local-auth/localAuth.ts',
        import.meta.url,
    )) as LocalAuthRunner;
}

/**
 * M5b, dev server only: vite.config.ts adds this plugin for `serve` (never for a build; `vite
 * preview` is refused by the config), and `apply: 'serve'` repeats the rule. It mounts
 * /api/auth/discord/start and /callback on `npm run dev` with the login function's own handlers
 * and the config from the repo root's `.env.test.local`. The config never reaches
 * `import.meta.env` or the client. Any target but `test` refuses the routes (503).
 * A plugin is build tooling, not part of the bundle. `load` is replaceable in tests.
 */
export function localAuthPlugin(
    root: string,
    load: () => Promise<LocalAuthRunner> = loadRunner,
): Plugin {
    let target: string | undefined;
    return {
        name: 'hsr-local-auth',
        apply: 'serve',
        configResolved(config) {
            target = process.env.VITE_STDB_TARGET ?? config.env.VITE_STDB_TARGET;
        },
        async configureServer(server) {
            const { createLocalAuth } = await load();
            const auth = createLocalAuth({
                root,
                target,
                shellEnv: process.env,
                log: (line) => server.config.logger.info(line),
            });
            for (const line of auth.banner) server.config.logger.info(line);
            server.middlewares.use((req, res, next) => {
                if (!auth.handle(req, res)) next();
            });
        },
    };
}
