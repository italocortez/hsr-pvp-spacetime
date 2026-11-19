// S14.5s fix pass (A228 item 4): how a server script names the account it acts on. One grammar for the module's
// server_* reducers (findUserByReference, helpers/identity/usernames.ts) and scripts/stdb/manage-user.ts, which
// resolves the reference first, prints the account, then passes `id:<n>` so the reducer acts on that very account.
// Pure TypeScript: no `spacetimedb` or `react` import.
//
//   id:<n>          the user id
//   discord:<id>    the Discord id (a snowflake, 17 to 20 digits) of a linked account
//   anything else   the exact username (as before)
//
// A username under the current rule has no colon, so the prefixed forms never shadow one.

export type UserReference =
    | { kind: 'id'; userId: number }
    | { kind: 'discord'; discordId: string }
    | { kind: 'username'; username: string };

export const USER_REFERENCE_ID_PREFIX = 'id:';
export const USER_REFERENCE_DISCORD_PREFIX = 'discord:';

/** The largest user id (`User.id` is a u32). */
const MAX_USER_ID = 0xffffffff;

/** The refusal of a malformed `id:` or `discord:` reference; null when `ref` parses. */
export function userReferenceError(ref: string): string | null {
    if (ref.length === 0) {
        return 'A user reference is required (a username, id:<n> or discord:<id>).';
    }
    if (ref.startsWith(USER_REFERENCE_ID_PREFIX)) {
        const digits = ref.slice(USER_REFERENCE_ID_PREFIX.length);
        if (!/^[0-9]{1,10}$/.test(digits) || Number(digits) > MAX_USER_ID) {
            return `"${ref}" is not a valid user id reference (id:<n>).`;
        }
    } else if (ref.startsWith(USER_REFERENCE_DISCORD_PREFIX)) {
        const digits = ref.slice(USER_REFERENCE_DISCORD_PREFIX.length);
        if (!/^[0-9]{17,20}$/.test(digits)) {
            return `"${ref}" is not a valid Discord id reference (discord:<17 to 20 digits>).`;
        }
    }
    return null;
}

/** The parsed reference. Throws an Error with userReferenceError's text when it does not parse. */
export function parseUserReference(ref: string): UserReference {
    const error = userReferenceError(ref);
    if (error !== null) throw new Error(error);
    if (ref.startsWith(USER_REFERENCE_ID_PREFIX)) {
        return { kind: 'id', userId: Number(ref.slice(USER_REFERENCE_ID_PREFIX.length)) };
    }
    if (ref.startsWith(USER_REFERENCE_DISCORD_PREFIX)) {
        return { kind: 'discord', discordId: ref.slice(USER_REFERENCE_DISCORD_PREFIX.length) };
    }
    return { kind: 'username', username: ref };
}

/** An account as the script sees it (view_admin_users joined with view_admin_user_private). */
export interface ReferencedAccount {
    id: number;
    username: string;
    /** The Discord id of a Discord-linked account; undefined otherwise. */
    discordId?: string;
}

/**
 * The accounts `ref` names among `accounts`, by the module's rule (findUserByReference): at most one for `id:` and a
 * username, possibly more for `discord:` (the module refuses that case). Throws userReferenceError's text for a
 * malformed reference.
 */
export function matchUserReference<T extends ReferencedAccount>(
    accounts: readonly T[],
    ref: string,
): T[] {
    const parsed = parseUserReference(ref);
    if (parsed.kind === 'id') return accounts.filter((a) => a.id === parsed.userId);
    if (parsed.kind === 'discord') return accounts.filter((a) => a.discordId === parsed.discordId);
    return accounts.filter((a) => a.username === parsed.username);
}

/** The reference of one user id, as the script passes it to the reducer after printing the account. */
export function userIdReference(userId: number): string {
    return `${USER_REFERENCE_ID_PREFIX}${userId}`;
}
