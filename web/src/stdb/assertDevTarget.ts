import type { Target } from '@shared/stdb-targets';

/** The message both refusals use (main.tsx and vite.config.ts, which keeps its own copy). */
export const DEV_PROD_REFUSAL =
    'Dev mode cannot run against the prod database. Set VITE_STDB_TARGET=test.';

/**
 * Throws when the dev server would connect to the prod database (user decision 2026-11-13).
 * A production build with target `prod` is not dev and passes. (`vite preview` is refused by
 * web/vite.config.ts since M8; the local preview is `npm run preview`, test only.)
 */
export function assertDevTarget(isDev: boolean, target: Target): void {
    if (isDev && target === 'prod') throw new Error(DEV_PROD_REFUSAL);
}
