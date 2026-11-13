import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useAuth } from '@/auth/authStore';
import { router as appRouter } from '@/router';

/**
 * The router with the auth snapshot as context; a snapshot change re-runs the route guards.
 * `router` is the app's router; tests pass their own (memory history).
 */
export function App({ router = appRouter }: { router?: typeof appRouter }) {
    const auth = useAuth();
    const seen = useRef(auth);

    useEffect(() => {
        if (seen.current === auth) return;
        seen.current = auth;
        void router.invalidate();
    }, [auth, router]);

    return <RouterProvider router={router} context={{ auth }} />;
}
