import { Outlet } from '@tanstack/react-router';
import { useAuth } from './authStore';

/**
 * The `_authed` layout body: nothing (the void background) until auth is ready.
 * (`_admin` uses `StaffOutlet`, which also shows the no-access page.)
 */
export function GuardedOutlet() {
    return useAuth().ready ? <Outlet /> : null;
}
