// S14.5s (A226 item 2): the rule for a NEW username, shared by the module (update_username, admin_update_user through
// spacetimedb/src/helpers/identity/usernames.ts) and the web's profile form, so both run this very function.
// Pure TypeScript: no `spacetimedb` or `react` import. The rule applies when a name changes; A228 item 2: a Discord
// sign-in derives its name through `usernameBaseFromProvider` (the module adds a suffix when needed); A228 item 3:
// existing names are lowercased once (server_lowercase_usernames), so every verified name is lowercase.
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
    // S14.5s fix pass (review M4): official-looking names, mention keywords and the site's own name
    'official',
    'discord',
    'everyone',
    'here',
    'null',
    'undefined',
    'ipc',
    'ipcbattlegrounds',
    'ipc_battlegrounds',
    'ipc.battlegrounds',
];

/**
 * Prefixes nobody may take. S14.5s fix pass (review M4): staff lookalikes (`admin1`, `admins`, `mod_x`, `staff.team`,
 * `support_bot`); `mod` and `staff` alone are exact entries above, so `modern` and `staffy` stay free.
 */
export const RESERVED_USERNAME_PREFIXES: readonly string[] = [
    'guest_',
    'admin',
    'moderator',
    'mod_',
    'mod.',
    'staff_',
    'staff.',
    'support_',
    'support.',
    'official_',
    'official.',
];

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

/**
 * A228 item 8: a player may change their own username once per hour: a change is refused while less than this many
 * milliseconds have passed since their last accepted change.
 */
export const USERNAME_CHANGE_INTERVAL_MS = 60 * 60 * 1000;

export const USERNAME_TOO_OFTEN_TEXT =
    'You can change your username once per hour. Try again later.';

/**
 * A228 item 2: the username base a Discord sign-in derives from the provider name: lowercased, every character outside
 * the rule's set replaced by an underscore, runs of periods collapsed to one, capped at USERNAME_MAX_LENGTH. Returns
 * null when the result still fails the rule (too short, reserved, no letter or digit at all); the module then uses a
 * fallback base. The caller adds a suffix when the base is taken.
 */
export function usernameBaseFromProvider(providerName: string): string | null {
    const base = normalizeUsername(providerName)
        .toLowerCase()
        .replace(/[^a-z0-9_.]/g, '_')
        .replace(/\.{2,}/g, '.')
        .slice(0, USERNAME_MAX_LENGTH);
    if (!/[a-z0-9]/.test(base)) return null;
    return usernameRuleError(base) === null ? base : null;
}

/** `base` with the suffix `_<n>`, the base shortened so the result stays within USERNAME_MAX_LENGTH. */
export function withUsernameSuffix(base: string, n: number): string {
    const suffix = `_${n}`;
    return base.slice(0, USERNAME_MAX_LENGTH - suffix.length) + suffix;
}
