import { Outlet } from '@tanstack/react-router';
import { useAuth } from './authStore';
import { NotReady } from './NotReady';

/**
 * The `_authed` layout body: nothing (the void background, a neutral title) until auth is ready,
 * and nothing while there is no user (after a sign-out the redirect follows the invalidate), so
 * pages under it always have a user. (`_admin` uses `StaffOutlet`, which also shows no-access.)
 */
export function GuardedOutlet() {
    const auth = useAuth();
    return auth.ready && auth.user ? <Outlet /> : <NotReady />;
}
