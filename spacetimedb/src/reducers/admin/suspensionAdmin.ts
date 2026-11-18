import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { ensureAdmin } from '@module/helpers/identity/ensurePermissions';
import { liftSuspension, suspendUser } from '@module/helpers/identity/suspensionActions';

// Account suspension from the app (A195, A213(3), A214; suspension-s1). Admin only (ensureAdmin), like the ban. The
// rules and the side effects live in helpers/identity/suspensionActions.ts; the server twins are in
// reducers/identity/server.ts.

/**
 * Admin-only: suspend a verified user by id. `reason` is optional (0 to 500 characters), kept for the admins' record
 * and never shown to the person. An Admin target is refused here (user ruling 2026-11-17: an Admin is suspended only
 * through server_suspend_user). See suspendUser for the checks and the lobby side effects.
 */
export const admin_suspend_user = spacetimedb.reducer({
    userId: t.u32(),
    reason: t.string(),
}, (ctx, { userId, reason }) => {
    const admin = ensureAdmin(ctx);
    const target = ctx.db.User.id.find(userId);
    if (!target) throw new SenderError(`User #${userId} not found.`);
    suspendUser(ctx, target, reason, admin.id, { fromApp: true });
});

/** Admin-only: lift the suspension of any suspended user (an Admin's too). */
export const admin_lift_suspension = spacetimedb.reducer({
    userId: t.u32(),
}, (ctx, { userId }) => {
    const admin = ensureAdmin(ctx);
    const target = ctx.db.User.id.find(userId);
    if (!target) throw new SenderError(`User #${userId} not found.`);
    liftSuspension(ctx, target, admin.id);
});
