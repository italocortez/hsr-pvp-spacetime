// User.username helpers shared by login_as_guest (reducers/identity/auth.ts) and confirm_link
// (reducers/identity/server.ts). User.username is a unique column: an insert or update with a taken name aborts the
// whole transaction on the index, so every writer that derives a name picks a free one first.
import { SenderError } from 'spacetimedb/server';
import {
    USERNAME_CHANGE_INTERVAL_MS, USERNAME_MAX_LENGTH, USERNAME_TOO_OFTEN_TEXT,
    normalizeUsername, parseUserReference, usernameBaseFromProvider, usernameRuleError, withUsernameSuffix,
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
 * A228 item 8 (replaces S14.5s's 3 per hour): records one accepted username change of the user (update_username
 * only), refusing it with USERNAME_TOO_OFTEN_TEXT while less than USERNAME_CHANGE_INTERVAL_MS (one hour) has passed
 * since their last accepted change (`lastChangeAt`, from ctx.timestamp only). A clock that does not advance, or steps
 * back, keeps the change refused. One primary-key read and one write on the private UserUsernameRate row. The caller
 * runs it after every other check, so a change refused for another reason records nothing.
 */
export function consumeUsernameChangeAllowance(ctx: any, userId: number): void {
    const now: bigint = ctx.timestamp.microsSinceUnixEpoch;
    const state = ctx.db.UserUsernameRate.userId.find(userId);
    if (!state) {
        ctx.db.UserUsernameRate.insert(insertWithAudit(ctx, { userId, lastChangeAt: ctx.timestamp }, userId));
        return;
    }
    if (now - state.lastChangeAt.microsSinceUnixEpoch < BigInt(USERNAME_CHANGE_INTERVAL_MS) * 1000n) {
        throw new SenderError(USERNAME_TOO_OFTEN_TEXT);
    }
    ctx.db.UserUsernameRate.userId.update(updateWithAudit(ctx, state, { lastChangeAt: ctx.timestamp }, userId));
}

/** A228 items 2 and 3: how many names one base may try (the base, then `_2` to `_9`). Index reads only. */
export const USERNAME_SUFFIX_ATTEMPTS = 9;

/**
 * A228 items 2 and 3: `base` when it is free (or held by `selfUserId`), else the first free `base_2` ... `base_9`
 * (USERNAME_SUFFIX_ATTEMPTS, the base shortened to keep 32 characters) that `accept` admits; null when none is.
 * Index reads only (User.username).
 */
export function firstFreeUsername(ctx: any, base: string, selfUserId: number, accept: (name: string) => boolean): string | null {
    for (let n = 1; n <= USERNAME_SUFFIX_ATTEMPTS; n++) {
        const candidate = n === 1 ? base : withUsernameSuffix(base, n);
        if (!accept(candidate)) continue;
        const holder = ctx.db.User.username.find(candidate);
        if (!holder || holder.id === selfUserId) return candidate;
    }
    return null;
}

/** A228 item 2: the refusal when no free name can be derived (practically unreachable: 18 index reads all taken). */
export const NO_FREE_USERNAME_TEXT = 'No free username could be derived for this account. Please contact support.';

/**
 * A228 item 2 (review S1): the username of a Discord sign-in (a guest's first link, applyProviderLink). The provider
 * name goes through the shared rule: usernameBaseFromProvider lowercases it and maps it to the rule's characters; a
 * result the rule still refuses (reserved, too short, no letter or digit) falls back to `user_<last 8 digits of the
 * provider id>`. A taken name gets a suffix (`_2` to `_9`, each candidate checked by the rule, so `guest_2` or `admin_2`
 * is never produced); when the provider base has no free candidate the fallback base is tried the same way.
 * Deterministic (no random draw), bounded (at most 18 index reads), index reads only. Throws NO_FREE_USERNAME_TEXT
 * when every candidate is taken.
 */
export function providerUsername(ctx: any, providerName: string, providerId: string, selfUserId: number): string {
    const ruleAccepts = (name: string) => usernameRuleError(name) === null;
    const fromProvider = usernameBaseFromProvider(providerName);
    if (fromProvider !== null) {
        const name = firstFreeUsername(ctx, fromProvider, selfUserId, ruleAccepts);
        if (name !== null) return name;
    }
    const fallback = `user_${providerId.slice(-8)}`;
    const name = firstFreeUsername(ctx, fallback, selfUserId, ruleAccepts);
    if (name === null) throw new SenderError(NO_FREE_USERNAME_TEXT);
    return name;
}

/**
 * A228 item 4 (review S3): the user a server_* reducer acts on, from a reference in the shared grammar
 * (`@shared/identity` parseUserReference): `id:<n>` (User.id), `discord:<id>` (User.provider_id, Discord-linked
 * rows only; more than one holder is refused), or an exact username (User.username). Index reads only. Throws a
 * SenderError for a malformed reference and `User "<ref>" not found` when nothing matches (the text of before).
 */
export function findUserByReference(ctx: any, ref: string): any {
    let parsed;
    try {
        parsed = parseUserReference(ref);
    } catch (e) {
        throw new SenderError((e as Error).message);
    }
    let user: any = null;
    if (parsed.kind === 'id') {
        user = ctx.db.User.id.find(parsed.userId);
    } else if (parsed.kind === 'discord') {
        const holders = [...ctx.db.User.provider_id.filter(parsed.discordId)].filter((u: any) => u.loginMethod === 'discord');
        if (holders.length > 1) throw new SenderError(`More than one account holds Discord id ${parsed.discordId}; use id:<n>.`);
        user = holders[0] ?? null;
    } else {
        user = ctx.db.User.username.find(parsed.username);
    }
    if (!user) throw new SenderError(`User "${ref}" not found`);
    return user;
}

/**
 * A228 item 3 (review S2): lowercases every username once. Skips the SYSTEM user (found by its upper-case name
 * everywhere) and guests (`Guest_<hex8>`, not chosen by anyone; the reserved `guest_` prefix keeps a lowercase twin
 * out of reach). Users are taken in id order, so on a collision the older account keeps the plain lowercase name and
 * the other gets the first free `_2` ... `_9` (firstFreeUsername, no rule check: an old name may hold characters the
 * current rule refuses; only its case changes). A name with no free candidate is left as it is and counted. Writes
 * only rows whose name changes, so a second run writes nothing. Audit actor: SYSTEM (the caller passes it).
 * Full read of User: a one-off server-only operation (A37 exemption, as the admin views).
 */
export function lowercaseAllUsernames(ctx: any, actorId: number): { changed: number; suffixed: number; leftAsIs: string[] } {
    const users = [...ctx.db.User.iter()]
        .filter((u: any) => !u.isGuest && u.username !== 'SYSTEM' && u.username !== u.username.toLowerCase())
        .sort((a: any, b: any) => a.id - b.id);
    let changed = 0;
    let suffixed = 0;
    const leftAsIs: string[] = [];
    for (const u of users) {
        const base = u.username.toLowerCase();
        const name = firstFreeUsername(ctx, base, u.id, () => true);
        if (name === null) {
            leftAsIs.push(u.username);
            continue;
        }
        const current = ctx.db.User.id.find(u.id);
        ctx.db.User.id.update(updateWithAudit(ctx, current, { username: name }, actorId));
        changed++;
        if (name !== base) suffixed++;
    }
    return { changed, suffixed, leftAsIs };
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
