import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import { ensureAdmin } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { DISCORD_LOGIN_METHOD } from '@module/helpers/lobby/banHelper';

// A46 (S3): BanRecord is keyed by loginMethod + providerId. The admin API still takes the legacy
// `banTypeTag` ('DiscordId') so the admin fixtures compile; it maps to the login method here.
// M5: the parameter becomes `loginMethod: t.string()` ('discord') together with the link-code flow.
const BAN_TYPE_TO_LOGIN_METHOD: Record<string, string> = { DiscordId: DISCORD_LOGIN_METHOD };

/**
 * Admin-only: Ban a provider ID (e.g., a Discord ID).
 * Creates a BanRecord and soft-deletes the affected user (if any): deletedAt is set and a UserDeletionJob runs the
 * deletion 5 s later (D-08 enforcement point 3). There is no client signal for deletedAt.
 */
export const admin_ban_user = spacetimedb.reducer({
    banTypeTag: t.string(),   // 'DiscordId'
    providerId: t.string(),
    reason: t.string(),
}, (ctx, { banTypeTag, providerId, reason }) => {
    const admin = ensureAdmin(ctx);

    // Validate banType
    const validBanTypes = Object.keys(BAN_TYPE_TO_LOGIN_METHOD);
    if (!validBanTypes.includes(banTypeTag)) {
        throw new SenderError(`Invalid banType "${banTypeTag}". Must be one of: ${validBanTypes.join(', ')}`);
    }
    const loginMethod = BAN_TYPE_TO_LOGIN_METHOD[banTypeTag];
    if (!providerId || providerId.length === 0) {
        throw new SenderError('providerId is required');
    }
    if (providerId.length > 32) {
        throw new SenderError('providerId must be 32 characters or fewer');
    }
    if (!reason || reason.length === 0) {
        throw new SenderError('reason is required');
    }
    if (reason.length > 500) {
        throw new SenderError('reason must be 500 characters or fewer');
    }

    // Check for existing ban with same login method + provider.
    // Single-column provider_id index + in-memory loginMethod filter (see banHelper).
    const existing = [...ctx.db.BanRecord.provider_id.filter(providerId)]
        .filter((r: any) => r.loginMethod === loginMethod);
    if (existing.length > 0) {
        throw new SenderError(`Provider ${banTypeTag}:${providerId} is already banned.`);
    }

    // Create the ban record
    ctx.db.BanRecord.insert(insertWithAudit(ctx, {
        id: 0,  // autoInc
        loginMethod,
        providerId,
        reason,
        bannedByUserId: admin.id,
    }, admin.id));

    // D-08 enforcement point 3: soft-delete the user; the scheduled deletion follows.
    // Find the user via UserPrivate.provider_id index (same login method).
    const privateRows = [...ctx.db.UserPrivate.provider_id.filter(providerId)]
        .filter((p: any) => p.loginMethod === loginMethod);
    for (const priv of privateRows) {
        const user = ctx.db.User.id.find(priv.userId);
        if (user && !user.deletedAt) {
            ctx.db.User.id.update(
                updateWithAudit(ctx, user, { deletedAt: ctx.timestamp }, admin.id),
            );
            // D-10 R1 fix: schedule deletion cascade 5s out (the admin_delete_row('User') pattern, reducers/admin/admin.ts)
            const deleteAt = ctx.timestamp.microsSinceUnixEpoch + 5_000_000n;
            ctx.db.UserDeletionJob.insert(insertWithAudit(ctx, {
                scheduledId: 0n,
                scheduledAt: ScheduleAt.time(deleteAt),
                userId: priv.userId,
            }, admin.id));
            console.log(`[BAN] User #${user.id} soft-deleted due to ban on ${banTypeTag}:${providerId}`);
        }
    }
});

/**
 * Admin-only: Remove a ban record by ID.
 * D-07: Permanent bans -- admins lift them manually by deleting the record.
 */
export const admin_unban_user = spacetimedb.reducer({
    banRecordId: t.u32(),
}, (ctx, { banRecordId }) => {
    ensureAdmin(ctx);

    const record = ctx.db.BanRecord.id.find(banRecordId);
    if (!record) {
        throw new SenderError(`BanRecord #${banRecordId} not found.`);
    }

    ctx.db.BanRecord.id.delete(banRecordId);
    console.log(`[UNBAN] BanRecord #${banRecordId} deleted (${record.loginMethod}:${record.providerId})`);
});
