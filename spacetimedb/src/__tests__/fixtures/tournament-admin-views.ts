// Shared helpers: an Admin and a view reader of the tournament tests.
// From S10s (s10s-triage-fixes.test.ts); not a test file.
import { M, type Actor, type Harness } from './harness';
import { setUserRole, verified } from './tournament-builders';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function admin(test: Harness, name = 'boss'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Admin');
    return a;
}

export const viewAs = <T = any>(test: Harness, name: string, who: Actor, args: Record<string, unknown> = {}): T[] =>
    (M as any)[name](test.viewContext(who.auth), args) as T[];
