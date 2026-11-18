/**
 * One partner community, as the landing page shows it (S14.4p): a row of the public `partner_server` table. The name
 * and the description come from the table, never from Discord; the icon is asked from Discord by the invite code
 * (`useDiscordInviteIcon`).
 */
export type Partner = {
    name: string;
    /** The bare Discord invite code (the module stores nothing else). */
    inviteCode: string;
    /** The tile's one-line text; may be empty. */
    description: string;
};

/** The initials shown in place of a missing icon: the first letter of up to two words. */
export function partnerInitials(name: string): string {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word[0]?.toUpperCase() ?? '')
        .join('');
}

/** The creator's Discord username, copied without the "@" (as the mockup). */
export const CREATOR_DISCORD = 'nathyron';
