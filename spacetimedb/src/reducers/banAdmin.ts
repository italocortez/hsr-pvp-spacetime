import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import { ensureAdmin } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';

/**
 * Admin-only: Ban a provider ID (e.g., a Discord ID).
 * Creates a BanRecord and soft-deletes the affected user (if any) to trigger
 * the existing client-side auto-logout path in useAuth.ts (D-08 enforcement point 3).
 */
export const admin_ban_user = spacetimedb.reducer({
    banTypeTag: t.string(),   // 'DiscordId'
    providerId: t.string(),
    reason: t.string(),
}, (ctx, { banTypeTag, providerId, reason }) => {
    const admin = ensureAdmin(ctx);

    // Validate banType
    const validBanTypes = ['DiscordId'];
    if (!validBanTypes.includes(banTypeTag)) {
        throw new SenderError(`Invalid banType "${banTypeTag}". Must be one of: ${validBanTypes.join(', ')}`);
    }
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

    // Check for existing ban with same type + provider.
    // Note: multi-column index causes PANIC in SpacetimeDB TS SDK (Plan 01 deviation WR-01).
    // Use single-column ban_record_provider_id index + in-memory banType.tag filter.
    const existing = [...ctx.db.BanRecord.ban_record_provider_id.filter(providerId)]
        .filter((r: any) => r.banType.tag === banTypeTag);
    if (existing.length > 0) {
        throw new SenderError(`Provider ${banTypeTag}:${providerId} is already banned.`);
    }

    // Create the ban record
    ctx.db.BanRecord.insert(insertWithAudit(ctx, {
        id: 0,  // autoInc
        banType: { tag: banTypeTag, value: {} } as any,
        providerId,
        reason,
        bannedByUserId: admin.id,
    }, admin.id));

    // D-08 enforcement point 3: Soft-delete the user to trigger auto-logout.
    // Find the user via UserPrivate.user_private_discord_id index.
    const privateRows = [...ctx.db.UserPrivate.user_private_discord_id.filter(providerId)];
    for (const priv of privateRows) {
        const user = ctx.db.User.id.find(priv.userId);
        if (user && !user.deletedAt) {
            ctx.db.User.id.update(
                updateWithAudit(ctx, user, { deletedAt: ctx.timestamp }, admin.id),
            );
            // D-10 R1 fix: schedule deletion cascade 5s out (matches admin.ts:181-188 pattern)
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
    console.log(`[UNBAN] BanRecord #${banRecordId} deleted (${record.banType.tag}:${record.providerId})`);
});
