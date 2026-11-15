import { createFileRoute } from '@tanstack/react-router';
import { LoadFailedPage } from '@/pages/connection/LoadFailedPage';
import { SignInFrame } from '@/pages/sign-in/SignInFrame';
import { loadedSignInPage, loadSignInPage } from '@/pages/sign-in/signInPanel';
import { isSignInSearch, parseIndexSearch } from '@/pages/sign-in/signInSearch';
import { StandbyPage } from '@/pages/standby/StandbyPage';

/*
 * `/` without `login=1` must not wait for the sign-in panel's chunk (S14.1, first paint). For
 * `login=1` the route's loader fetches it, so the router resolves only once the panel can render:
 * a client-side navigation shows the panel on the commit of the new location (the route
 * announcer then finds its `h1` and title), and a hover on "Sign in" preloads it
 * (`defaultPreload: 'intent'`). While it loads on a hard load of `/?login=1` (the Discord
 * return), the pending component paints the panel's inert frame at once. If the chunk fails to
 * load, the error component shows the offline splash with a reloading Retry.
 */

// `?login=1&next=` is set by the guards; `status` by the login function's return (M5b).
export const Route = createFileRoute('/')({
    validateSearch: parseIndexSearch,
    // `login` is a loader dependency, so `/` and `/?login=1` are two matches (two pages).
    loaderDeps: ({ search }) => ({ login: isSignInSearch(search) }),
    // Synchronous for `/` alone (nothing to wait for), a promise only for the panel.
    loader: ({ deps }): Promise<void> | undefined =>
        deps.login ? loadSignInPage().then(() => undefined) : undefined,
    pendingComponent: IndexPending,
    pendingMs: 0,
    pendingMinMs: 0,
    // The panel's chunk did not load: the offline splash with a reloading Retry.
    errorComponent: LoadFailedPage,
    // Only the page component is split off: the pending and error screens stay in this route's
    // part of the entry chunk, so they render while the network that failed the chunk is down.
    codeSplitGroupings: [['component']],
    // The sign-in panel is a splash outside the app shell; `/` alone renders inside it (S14.1).
    staticData: { splash: ({ search }) => isSignInSearch(search) },
    component: IndexRoute,
});

function IndexRoute() {
    const { login, next, status } = Route.useSearch();
    if (!login) return <StandbyPage />;
    // The loader has loaded the panel before the router resolves this match, so the frame here
    // is unreachable today; it stays as a guard should the router ever render before the loader.
    const SignInPage = loadedSignInPage();
    return SignInPage ? <SignInPage next={next} status={status} /> : <SignInFrame />;
}

/**
 * Only `login=1` waits on something (the panel's chunk). `/` alone is pending only for the moment
 * its own route chunk takes, and shows nothing then, as before (a standby block here would mount
 * twice).
 */
function IndexPending() {
    const { login } = Route.useSearch();
    return login ? <SignInFrame /> : null;
}
