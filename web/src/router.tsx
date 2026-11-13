import { createRouter } from '@tanstack/react-router';
import { authStore } from '@/auth/authStore';
import { parseSearch, stringifySearch } from '@/lib/searchParams';
import { NotFoundPage } from '@/pages/not-found/NotFoundPage';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
    routeTree,
    // Replaced on every render by RouterProvider's `context` prop (App.tsx).
    context: { auth: authStore.getSnapshot() },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    // Unknown paths render the root's not-found page; a guarded layout that only partly matches
    // (`/admin/zzz`) does not take them over (user ruling, M4: "straight 404").
    notFoundMode: 'root',
    defaultNotFoundComponent: () => <NotFoundPage />,
    // Plain-text search params, no JSON quoting (A169).
    parseSearch,
    stringifySearch,
});

// Types every Link `to`, `params` and `search` against the route tree.
declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}
