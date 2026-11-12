import '@/styles/fonts.css';
import '@/styles/tokens.css';
import '@/styles/base.css';

import { resolveBrowserEnv } from '@shared/stdb-targets';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';

// Fails fast on a missing or unknown VITE_STDB_TARGET. No connection is opened here (M6).
const env = resolveBrowserEnv(import.meta.env);
if (import.meta.env.DEV) {
    console.info(`[stdb] target=${env.target} database=${env.dbName}`);
}

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
