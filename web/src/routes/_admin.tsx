import { createFileRoute } from '@tanstack/react-router';
import { requireUser } from '@/auth/guards';
import { StaffOutlet } from '@/auth/StaffOutlet';

/** Staff area: a visitor is sent to sign in; a user below Moderator sees the no-access page. */
export const Route = createFileRoute('/_admin')({
    beforeLoad: ({ context, location }) => requireUser(context.auth, location.href),
    component: StaffOutlet,
});
