import { Outlet } from '@tanstack/react-router';
import { useAuth } from './authStore';

/** The `_authed` / `_admin` layout body: nothing (the void background) until auth is ready. */
export function GuardedOutlet() {
    return useAuth().ready ? <Outlet /> : null;
}
