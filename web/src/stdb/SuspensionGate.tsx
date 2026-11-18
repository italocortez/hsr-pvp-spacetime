import type { ReactNode } from 'react';
import { signOut } from '@/auth/signOut';
import { SuspendedPage } from '@/pages/suspended/SuspendedPage';
import { useSuspended } from './suspensionStatus';

/**
 * SUS2: the root layout body below `ConnectionGate`: the shell and the routes, or the suspended
 * page while Layer 0's `view_my_suspension` holds a row. The routes unmount, so every route
 * subscription ends; Layer 0 keeps running, and when the row goes (lifted) the app comes back
 * without a reload. A connection failure or maintenance (`ConnectionGate`) shows first.
 * "Sign out" here loads the home page `/`, whatever the address (user ruling, SUS2 fix pass).
 */
export function SuspensionGate({ children }: { children?: ReactNode }) {
    const suspended = useSuspended();
    if (!suspended) return children;
    return <SuspendedPage onSignOut={() => signOut({ to: '/' })} />;
}
