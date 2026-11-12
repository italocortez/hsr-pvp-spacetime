import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useAuth } from '@/auth/authStore';
import { router } from '@/router';

/** The router with the auth snapshot as context; a snapshot change re-runs the route guards. */
export function App() {
    const auth = useAuth();
    const seen = useRef(auth);

    useEffect(() => {
        if (seen.current === auth) return;
        seen.current = auth;
        void router.invalidate();
    }, [auth]);

    return <RouterProvider router={router} context={{ auth }} />;
}
