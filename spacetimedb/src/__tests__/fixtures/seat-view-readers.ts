// Shared helpers: the view reader and display names of the seat-targeting tests.
// From S9c (s9c-rulings.test.ts); not a test file.
import { M, TestAuth, type Actor, type Harness } from './harness';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export type Reader = Actor | TestAuth;
export const authOf = (r: Reader): TestAuth => ('auth' in r ? r.auth : r);
export function view<T = any>(test: Harness, name: string, who: Reader): T[] {
    return (M as any)[name](test.viewContext(authOf(who)), {}) as T[];
}
export const displayName = (test: Harness, who: Actor) => test.db.User.id.find(who.userId)!.displayName;
