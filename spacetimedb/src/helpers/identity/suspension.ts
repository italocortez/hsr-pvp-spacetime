import { SenderError } from 'spacetimedb/server';

// ─── Account suspension: the checks (A195, A213, A214; suspension-s1) ─────────────────────────────────────────────
// The read side only, so the permission helper and the view caller helper can import it without pulling in the lobby
// code. The writes (suspend, lift, the lobby side effects) live in suspensionActions.ts. Every check is one
// primary-key read of the private UserSuspension table, never a scan.

/** The one refusal of every user reducer for a suspended caller (getAuthenticatedUser and the self-resolving ones). */
export const SUSPENDED_TEXT = 'Your account is suspended.';
/** The refusal of a Discord sign-in to a suspended account (planProviderLink; shown after "Sign-in refused."). */
export const SUSPENDED_SIGN_IN_TEXT = 'This account is suspended.';

/** True when `userId` has a UserSuspension row (one primary-key read). */
export function isSuspended(ctx: any, userId: number | undefined): boolean {
    if (userId === undefined) return false;
    return !!ctx.db.UserSuspension.userId.find(userId);
}

/** Throws SUSPENDED_TEXT when the user is suspended; `user` undefined passes (the caller's own refusal follows). */
export function ensureNotSuspended(ctx: any, user: any | undefined): void {
    if (user && isSuspended(ctx, user.id)) throw new SenderError(SUSPENDED_TEXT);
}
