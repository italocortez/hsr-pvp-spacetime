import { createFileRoute } from '@tanstack/react-router';
import { GuardedOutlet } from '@/auth/GuardedOutlet';
import { requireStaff } from '@/auth/guards';

/** Staff area: Moderator and above. */
export const Route = createFileRoute('/_admin')({
    beforeLoad: ({ context, location }) => requireStaff(context.auth, location.href),
    component: GuardedOutlet,
});
