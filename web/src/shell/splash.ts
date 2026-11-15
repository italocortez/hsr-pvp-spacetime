import type { AuthSnapshot } from '@/auth/authStore';

/*
 * Which screens render without the app shell (S14.1): the full-screen splash pages. A route marks
 * itself with `staticData.splash`, either always (`true`, the standby page) or by a rule over its
 * own match (the sign-in panel at `/?login=1`, a bad lobby id, the no-access page). The root's
 * not-found page is a splash too. The rule is read from the router state, so the decision is known
 * when the route matches, before its code chunk has loaded (no flash of the bar on a splash page).
 */

export type SplashInput = {
    search: Record<string, unknown>;
    params: Record<string, string>;
    auth: AuthSnapshot;
};

export type SplashRule = boolean | ((input: SplashInput) => boolean);

declare module '@tanstack/react-router' {
    interface StaticDataRouteOption {
        /** True (or a rule returning true) when the route renders a full-screen splash. */
        splash?: SplashRule;
    }
}

/** The fields of a router match this rule reads. */
export type SplashMatch = {
    status: string;
    _notFound?: boolean;
    staticData?: { splash?: SplashRule };
    search: unknown;
    params: unknown;
};

/** True when the current matches render a splash page (no bar, no shell `main`). */
export function isSplashScreen(matches: readonly SplashMatch[], auth: AuthSnapshot): boolean {
    for (const match of matches) {
        if (match._notFound || match.status === 'notFound') return true;
        const rule = match.staticData?.splash;
        if (rule === true) return true;
        if (
            typeof rule === 'function' &&
            rule({
                search: (match.search ?? {}) as Record<string, unknown>,
                params: (match.params ?? {}) as Record<string, string>,
                auth,
            })
        ) {
            return true;
        }
    }
    return false;
}
