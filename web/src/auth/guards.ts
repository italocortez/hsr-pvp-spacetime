import { redirect } from '@tanstack/react-router';
import type { AuthSnapshot } from './authStore';
import { isRoleAtLeast } from './roles';

/*
 * Route guards for the `_authed` and `_admin` layouts' `beforeLoad`. UX only: the module is the
 * real authority. While `auth.ready` is false they let the route through and its layout renders
 * nothing; the snapshot change that sets `ready` re-runs them (router.invalidate in App).
 */

/** A visitor goes to `/?login=1&next=<href>`. */
export function requireUser(auth: AuthSnapshot, href: string): void {
    if (!auth.ready) return;
    if (!auth.user) throw redirect({ to: '/', search: { login: 1, next: href } });
}

/** As `requireUser`, and a user below Moderator goes to `/` with no search. */
export function requireStaff(auth: AuthSnapshot, href: string): void {
    requireUser(auth, href);
    if (auth.user && !isRoleAtLeast(auth.user.role, 'Moderator')) throw redirect({ to: '/' });
}
