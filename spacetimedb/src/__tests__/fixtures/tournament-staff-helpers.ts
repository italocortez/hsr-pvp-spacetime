// Shared helpers: an Admin, DQ and lock bodies and the waitlist rows of the tournament tests.
// From S10g (s10g-tournament.test.ts); not a test file.
import { M, type Actor, type Harness } from './harness';
import { setUserRole, verified } from './tournament-builders';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function admin(test: Harness, name = 'admin'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Admin');
    return a;
}

export const dq = (tournamentId: number, userId: number, dqWholeTeam = false) =>
    (ctx: any) => M.dq_participant(ctx, { tournamentId, userId, reason: 'test', dqWholeTeam });
export const lockBody = (tournamentId: number, hsrAccountIds: number[]) =>
    (ctx: any) => M.lock_tournament_accounts(ctx, { tournamentId, hsrAccountIds });

export const waitlistRows = (test: Harness, tournamentId: number, userId: number) =>
    [...test.db.TournamentWaitlistAccount.by_tournament_and_user.filter([tournamentId, userId])].map((r) => r.hsrAccountId).sort((a, b) => a - b);
