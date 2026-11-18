// User.username helpers shared by login_as_guest (reducers/identity/auth.ts) and confirm_link
// (reducers/identity/server.ts). User.username is a unique column: an insert or update with a taken name aborts the
// whole transaction on the index, so every writer that derives a name picks a free one first.
import { SenderError } from 'spacetimedb/server';
import {
    USERNAME_CHANGE_WINDOW_MS, USERNAME_CHANGES_PER_WINDOW, USERNAME_MAX_LENGTH, USERNAME_TOO_OFTEN_TEXT,
    normalizeUsername, usernameRuleError,
} from '@shared/identity';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';

/** Usernames are at most 32 characters (update_username, update_display_name); S14.5s: defined in @shared/identity. */
export { USERNAME_MAX_LENGTH };

/**
 * S10r (A122(1), L1): the name rules of a player's own rename, shared by update_display_name / update_username and
 * admin_update_user: the value is trimmed, must not be empty and is at most USERNAME_MAX_LENGTH characters.
 * Returns the trimmed value.
 */
export function checkDisplayName(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.length === 0) throw new SenderError('Display name cannot be empty');
    if (trimmed.length > USERNAME_MAX_LENGTH) throw new SenderError(`Display name must be ${USERNAME_MAX_LENGTH} characters or fewer`);
    return trimmed;
}

/**
 * S14.5s (A226 item 2): the rule for a NEW username (update_username, admin_update_user when the name changes): the
 * shared `usernameRuleError` of `@shared/identity` (Discord's form, 2 to 32 characters, reserved names refused), the
 * same function the web's form runs. Replaces S10r's checkUsername (trim, non-empty, 32 characters), whose texts for
 * those two cases are kept. Returns the trimmed value. Whether the name is taken is checked by the caller.
 */
export function checkNewUsername(raw: string): string {
    const error = usernameRuleError(raw);
    if (error !== null) throw new SenderError(error);
    return normalizeUsername(raw);
}

/**
 * S14.5s (A226 item 2): counts one accepted username change of the user (update_username only), refusing it with
 * USERNAME_TOO_OFTEN_TEXT once the fixed window (USERNAME_CHANGE_WINDOW_MS, one hour) holds
 * USERNAME_CHANGES_PER_WINDOW (3) changes. One primary-key read and one write on the private UserUsernameRate row.
 * The caller runs it after every other check, so a change refused for another reason counts nothing.
 */
export function consumeUsernameChangeAllowance(ctx: any, userId: number): void {
    const now: bigint = ctx.timestamp.microsSinceUnixEpoch;
    const state = ctx.db.UserUsernameRate.userId.find(userId);
    if (!state) {
        ctx.db.UserUsernameRate.insert(insertWithAudit(ctx, { userId, windowStart: ctx.timestamp, changeCount: 1 }, userId));
        return;
    }
    const windowOpen = now - state.windowStart.microsSinceUnixEpoch < BigInt(USERNAME_CHANGE_WINDOW_MS) * 1000n;
    if (!windowOpen) {
        ctx.db.UserUsernameRate.userId.update(updateWithAudit(ctx, state, { windowStart: ctx.timestamp, changeCount: 1 }, userId));
        return;
    }
    if (state.changeCount >= USERNAME_CHANGES_PER_WINDOW) throw new SenderError(USERNAME_TOO_OFTEN_TEXT);
    ctx.db.UserUsernameRate.userId.update(updateWithAudit(ctx, state, { changeCount: state.changeCount + 1 }, userId));
}

/**
 * S10e (identity audit #3): `base` when no other user holds it, else the first free `base_2`, `base_3`, ... (the base
 * shortened so the result stays within USERNAME_MAX_LENGTH). `selfUserId` is the user being named (their own current
 * name counts as free); pass -1 for a user that does not exist yet. Index reads only (User.username).
 */
export function uniqueUsername(ctx: any, base: string, selfUserId: number): string {
    const holder = ctx.db.User.username.find(base);
    if (!holder || holder.id === selfUserId) return base;
    for (let n = 2; ; n++) {
        const suffix = `_${n}`;
        const candidate = base.slice(0, USERNAME_MAX_LENGTH - suffix.length) + suffix;
        const other = ctx.db.User.username.find(candidate);
        if (!other || other.id === selfUserId) return candidate;
    }
}

/**
 * S10h (review of the test task): the base guest name, "Guest_" + the LAST 8 hex characters of the identity. A
 * SpacetimeDB identity is not uniformly random from its first character: its 32 bytes are a 2-byte fixed tag (hex
 * "c200"), a 4-byte checksum, then 26 bytes of the BLAKE3 hash of issuer|subject (Identity::from_claims), so the first
 * 8 hex characters carry only 16 varying bits. The trailing characters come from the hash and vary across identities.
 * Collisions remain possible (32 bits); login_as_guest resolves them through uniqueUsername.
 */
export function guestUsernameBase(identityHex: string): string {
    return `Guest_${identityHex.slice(-8)}`;
}
