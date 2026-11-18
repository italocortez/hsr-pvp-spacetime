// S14.5s (A226 item 2): the rule for a NEW username, shared by the module (update_username, admin_update_user through
// spacetimedb/src/helpers/identity/usernames.ts) and the web's profile form, so both run this very function.
// Pure TypeScript: no `spacetimedb` or `react` import. Existing usernames are not rewritten: the rule applies only when
// a name changes.
//
// Discord's own form: lowercase letters a to z, digits, underscore and period; 2 to 32 characters; no two periods in a
// row. Reserved names are refused. The input is trimmed first (the module's renames have always trimmed).

/** The longest username (also the display name and provider name cap in the module). */
export const USERNAME_MAX_LENGTH = 32;

/** The shortest new username. */
export const USERNAME_MIN_LENGTH = 2;

/** The characters a new username may use. */
export const USERNAME_CHARACTERS = /^[a-z0-9_.]+$/;

/**
 * Names nobody may take. `system` covers the SYSTEM user (whose name is upper case and is never renamed); `guest`
 * and the `guest_` prefix keep a lookalike of the guest names (`Guest_<hex8>`, login_as_guest) out of reach.
 */
export const RESERVED_USERNAMES: readonly string[] = [
    'system',
    'admin',
    'administrator',
    'moderator',
    'mod',
    'staff',
    'support',
    'guest',
];

/** Prefixes nobody may take. */
export const RESERVED_USERNAME_PREFIXES: readonly string[] = ['guest_'];

export const USERNAME_EMPTY_TEXT = 'Username cannot be empty';
export const USERNAME_TOO_LONG_TEXT = `Username must be ${USERNAME_MAX_LENGTH} characters or fewer`;
export const USERNAME_TOO_SHORT_TEXT = `Username must be at least ${USERNAME_MIN_LENGTH} characters`;
export const USERNAME_CHARACTERS_TEXT =
    'Username can use only lowercase letters a to z, digits, underscore and period';
export const USERNAME_DOUBLE_PERIOD_TEXT = 'Username cannot contain two periods in a row';
export const USERNAME_RESERVED_TEXT = 'That username is reserved';

/** The name as the module stores it: trimmed. */
export function normalizeUsername(raw: string): string {
    return raw.trim();
}

/** Whether `name` (already trimmed) is a reserved name or starts with a reserved prefix. */
export function isReservedUsername(name: string): boolean {
    if (RESERVED_USERNAMES.includes(name)) return true;
    return RESERVED_USERNAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The refusal text for a new username, or null when the rule accepts it. Checks in this order: empty, too long, too
 * short, characters, two periods in a row, reserved. Whether the name is taken is not part of the rule (the module
 * reads the unique `User.username` index; the web reads `view_user_by_username(name)`).
 */
export function usernameRuleError(raw: string): string | null {
    const name = normalizeUsername(raw);
    if (name.length === 0) return USERNAME_EMPTY_TEXT;
    if (name.length > USERNAME_MAX_LENGTH) return USERNAME_TOO_LONG_TEXT;
    if (name.length < USERNAME_MIN_LENGTH) return USERNAME_TOO_SHORT_TEXT;
    if (!USERNAME_CHARACTERS.test(name)) return USERNAME_CHARACTERS_TEXT;
    if (name.includes('..')) return USERNAME_DOUBLE_PERIOD_TEXT;
    if (isReservedUsername(name)) return USERNAME_RESERVED_TEXT;
    return null;
}

/** The module's refusal when the name is held by another account (exact, case-sensitive match). */
export function usernameTakenText(name: string): string {
    return `Username "${name}" is already taken.`;
}

/** S14.5s: the short-term limit on a player's own username changes: this many per window. */
export const USERNAME_CHANGES_PER_WINDOW = 3;

/** S14.5s: the fixed window of that limit, in milliseconds (one hour). */
export const USERNAME_CHANGE_WINDOW_MS = 60 * 60 * 1000;

export const USERNAME_TOO_OFTEN_TEXT = `You can change your username ${USERNAME_CHANGES_PER_WINDOW} times per hour. Try again later.`;
