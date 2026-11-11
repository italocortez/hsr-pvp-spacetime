import { SenderError } from 'spacetimedb/server';

/**
 * S11a (triage L11): the one guard of every scheduled reducer (`run_user_deletion`, `run_identity_gc`, `run_lobby_gc`,
 * `run_referee_transfer_check`, `run_tournament_finalize`). A call that does not come from the scheduler is refused
 * before any read or write.
 *
 * Mechanism (SDK 2.14.1, documented): `ctx.senderAuth.isInternal`, typed in `spacetimedb/dist/lib/reducers.d.ts`
 * (`AuthCtx.isInternal`: "Whether the sender of this invocation is this database, as it is for scheduled reducers and
 * procedures. This is equivalent to `ctx.sender.isEqual(ctx.databaseIdentity)`. It is false in `init`, whose sender is
 * the database's owner."), built by `AuthCtxImpl.forSender` in `dist/server/index.mjs` (v2.14.0, PR #5892). The
 * database owner, a delegate, a Moderator or an Admin calling the reducer by name is not the database, so the guard
 * refuses them too: the manual runs go through `admin_gc_identities` / `admin_gc_lobbies` (`ensureModerator`).
 *
 * The in-memory harness models the scheduler's sender as `TestAuth.internal()` (sender = the module identity,
 * `isInternal: true`); whether the live scheduler presents the same sender is a live-run check (S11a log).
 *
 * The text keeps "Forbidden" so `test/live/isinternal-rejection.test.ts` (`/no such reducer|Forbidden/i`) accepts it.
 */
export function ensureScheduler(ctx: any, reducerName: string): void {
    if (!ctx.senderAuth.isInternal) {
        throw new SenderError(`Forbidden: ${reducerName} is a scheduled reducer and runs only from the scheduler.`);
    }
}
