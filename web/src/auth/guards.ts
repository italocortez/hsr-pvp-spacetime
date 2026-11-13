import { redirect } from '@tanstack/react-router';
import type { AuthSnapshot } from './authStore';
import { isRoleAtLeast } from './roles';

/*
 * Route guards for the `_authed` and `_admin` layouts' `beforeLoad`. UX only: the module is the
 * real authority. While `auth.ready` is false they let the route through and its layout renders
 * nothing; the snapshot change that sets `ready` re-runs them (router.invalidate in App).
 */

/** A visitor goes to `/?login=1&next=<href>`. Used by both `_authed` and `_admin`. */
export function requireUser(auth: AuthSnapshot, href: string): void {
    if (!auth.ready) return;
    if (!auth.user) throw redirect({ to: '/', search: { login: 1, next: href } });
}

/** True for Moderator and above: the `_admin` layout shows the no-access page to anyone else. */
export function isStaff(auth: AuthSnapshot): boolean {
    return auth.user !== undefined && isRoleAtLeast(auth.user.role, 'Moderator');
}
