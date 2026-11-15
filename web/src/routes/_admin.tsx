import { createFileRoute } from '@tanstack/react-router';
import { requireUser, showsNoAccess } from '@/auth/guards';
import { StaffOutlet } from '@/auth/StaffOutlet';

/** Staff area: a visitor is sent to sign in; a user below Moderator sees the no-access page. */
export const Route = createFileRoute('/_admin')({
    beforeLoad: ({ context, location }) => requireUser(context.auth, location.href),
    // The no-access page is a splash, outside the app shell (S14.1).
    staticData: { splash: ({ auth }) => showsNoAccess(auth) },
    component: StaffOutlet,
});
