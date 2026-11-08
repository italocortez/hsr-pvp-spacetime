import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';

/**
 * Upsert the per-identity UserPresence row as online (A48): `client_connected` for a mapped identity,
 * `login_as_guest` for a fresh guest (its connect preceded the mapping). Idempotent.
 */
export function markPresenceOnline(ctx: any, identity: any, userId: number): void {
    const presence = ctx.db.UserPresence.identity.find(identity);
    if (presence) {
        ctx.db.UserPresence.identity.update(updateWithAudit(ctx, presence, {
            userId,
            isOnline: true,
            lastLoginAt: ctx.timestamp,
            lastSeenAt: ctx.timestamp,
        }, userId));
    } else {
        ctx.db.UserPresence.insert(insertWithAudit(ctx, {
            identity,
            userId,
            isOnline: true,
            lastLoginAt: ctx.timestamp,
            lastSeenAt: ctx.timestamp,
        }, userId));
    }
}

/** "User online" = any UserPresence row of the user with isOnline = true (A48). */
export function hasLivePresence(ctx: any, userId: number): boolean {
    return [...ctx.db.UserPresence.user_id.filter(userId)].some((p: any) => p.isOnline);
}
