// User.username helpers shared by login_as_guest (reducers/identity/auth.ts) and confirm_link
// (reducers/identity/server.ts). User.username is a unique column: an insert or update with a taken name aborts the
// whole transaction on the index, so every writer that derives a name picks a free one first.
import { SenderError } from 'spacetimedb/server';

/** Usernames are at most 32 characters (update_username, update_display_name). */
export const USERNAME_MAX_LENGTH = 32;

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

/** S10r (A122(1), L1): see checkDisplayName. */
export function checkUsername(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.length === 0) throw new SenderError('Username cannot be empty');
    if (trimmed.length > USERNAME_MAX_LENGTH) throw new SenderError(`Username must be ${USERNAME_MAX_LENGTH} characters or fewer`);
    return trimmed;
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
