import '@/styles/fonts.css';
import '@/styles/tokens.css';
import '@/styles/base.css';

import { resolveBrowserEnv } from '@shared/stdb-targets';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import { registerServiceWorker } from '@/lib/serviceWorker';
import { assertDevTarget } from '@/stdb/assertDevTarget';
// The connection layer (SDK, bindings, StdbProvider) loads in its own chunk after the first
// render (S14.1, A171 item 2); this entry imports none of it.
import { LazyStdbProvider } from '@/stdb/LazyStdbProvider';

// Fails fast on a missing or unknown VITE_STDB_TARGET, before any connection is built.
const env = resolveBrowserEnv(import.meta.env);
// The dev server never talks to prod; checked before any connection or dev helper exists.
assertDevTarget(import.meta.env.DEV, env.target);

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

function render(): void {
    createRoot(root as HTMLElement).render(
        <StrictMode>
            <LazyStdbProvider>
                <App />
            </LazyStdbProvider>
        </StrictMode>,
    );
}

if (import.meta.env.DEV) {
    console.info(`[stdb] target=${env.target} database=${env.dbName}`);
    // Dev only, dropped from production builds (check:patterns gate 3):
    // window.__devAuth('member') etc. for the route guards; window.__devConnection('offline') etc.
    // for the connection splashes; window.__wireStats() and a panel for the egress meter, which
    // must wrap WebSocket before the provider builds the connection, so it loads before render.
    // The dev server never registers the image cache worker and removes one left from earlier
    // (M10); that runs in the background and does not hold the render.
    void Promise.all([
        import('@/auth/devAuth'),
        import('@/dev/devConnection'),
        import('@/dev/wireStats'),
        import('@/dev/devServiceWorkerReset'),
    ])
        .then(([devAuth, devConnection, wireStats, devServiceWorkerReset]) => {
            devAuth.installDevAuth();
            devConnection.installDevConnection();
            wireStats.installWireStats(env.host);
            void devServiceWorkerReset.resetDevServiceWorkers();
        })
        .finally(render);
} else {
    render();
    // The image cache worker (M10): production builds only, after the window load event.
    registerServiceWorker(import.meta.env.PROD);
}
