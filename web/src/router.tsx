import { createRouter } from '@tanstack/react-router';
import { authStore } from '@/auth/authStore';
import { NotFoundPage } from '@/pages/not-found/NotFoundPage';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
    routeTree,
    // Replaced on every render by RouterProvider's `context` prop (App.tsx).
    context: { auth: authStore.getSnapshot() },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultNotFoundComponent: () => <NotFoundPage />,
});

// Types every Link `to`, `params` and `search` against the route tree.
declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}
