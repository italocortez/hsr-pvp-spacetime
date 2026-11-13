import { Outlet } from '@tanstack/react-router';
import { NoAccessPage } from '@/pages/no-access/NoAccessPage';
import { useAuth } from './authStore';
import { isStaff } from './guards';
import { NotReady } from './NotReady';

/**
 * The `_admin` layout body. Nothing (neutral title) until auth is ready or while there is no
 * user (the guard's sign-in redirect is on its way); the no-access page in place for a user below Moderator, at the
 * same URL; the route for staff. Reads the auth store, so a role change switches the view live.
 */
export function StaffOutlet() {
    const auth = useAuth();
    if (!auth.ready || !auth.user) return <NotReady />;
    return isStaff(auth) ? <Outlet /> : <NoAccessPage />;
}
