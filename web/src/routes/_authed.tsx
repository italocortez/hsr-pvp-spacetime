import { createFileRoute } from '@tanstack/react-router';
import { GuardedOutlet } from '@/auth/GuardedOutlet';
import { requireUser } from '@/auth/guards';

/** Signed-in area (guests included). */
export const Route = createFileRoute('/_authed')({
    beforeLoad: ({ context, location }) => requireUser(context.auth, location.href),
    component: GuardedOutlet,
});
