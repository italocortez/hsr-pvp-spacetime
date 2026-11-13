import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import type { AuthSnapshot } from '@/auth/authStore';
import { ConnectionGate } from '@/stdb/ConnectionGate';

export type RouterContext = { auth: AuthSnapshot };

// Dev only and lazily loaded: the production build drops this branch and the devtools package.
const RouterDevtools = import.meta.env.DEV
    ? lazy(() =>
          import('@tanstack/react-router-devtools').then((m) => ({
              default: m.TanStackRouterDevtools,
          })),
      )
    : () => null;

export const Route = createRootRouteWithContext<RouterContext>()({
    component: RootLayout,
});

function RootLayout() {
    return (
        <>
            <ConnectionGate>
                <Outlet />
            </ConnectionGate>
            <Suspense>
                <RouterDevtools />
            </Suspense>
        </>
    );
}
