import { useEffect, useState } from 'react';

/*
 * S14.4p: the current icon of a Discord server, from one of its invite codes (user ruling 2026-11-17: the visitor's
 * browser asks Discord, so the icon stays current without a stored address). Shared: any page that shows a Discord
 * server may use it.
 *
 * The lookup is Discord's public invite endpoint, `GET https://discord.com/api/v10/invites/<code>` (no credentials, no
 * extra headers, no referrer, redirects refused); the answer's `guild.id` and `guild.icon` make the CDN address
 * `https://cdn.discordapp.com/icons/<id>/<icon>.webp?size=128`. Both hosts are allowed by the CSP (`vercel.json`
 * `connect-src` and `img-src`; docs/frontend/hosting.md). The answer is checked strictly before any address is built:
 * the id is a digit string, the icon a 32-character hex hash, possibly prefixed `a_` (animated; the webp is its still
 * frame). Anything else is "no icon", and the caller shows its own fallback.
 *
 * Each code's answer is remembered for the browser session (an in-memory map, mirrored to sessionStorage inside
 * try/catch), so a second render or a return to the page asks Discord nothing. A failed lookup (network, status,
 * malformed answer) is remembered for FAILED_LOOKUP_TTL_MS only, so a visitor does not hammer Discord and a later
 * visit tries again. Concurrent requests for one code share one fetch.
 */

/** The shape of a Discord invite code (the module stores only this shape, helpers/admin/partnerServers.ts). */
export const DISCORD_INVITE_CODE = /^[A-Za-z0-9-]{2,32}$/;
/** A failed lookup is not retried for this long. */
export const FAILED_LOOKUP_TTL_MS = 5 * 60_000;

const GUILD_ID = /^\d{1,20}$/;
const ICON_HASH = /^(?:a_)?[0-9a-f]{32}$/;
const STORAGE_PREFIX = 'hsr.discordInvite.';

type Entry =
    | { kind: 'icon'; guildId: string; icon: string }
    | { kind: 'none' }
    | { kind: 'failed'; until: number };

const memory = new Map<string, Entry>();
const inFlight = new Map<string, Promise<Entry>>();

/** The invite endpoint for a code that has the invite shape. */
export function discordInviteApiUrl(code: string): string {
    return `https://discord.com/api/v10/invites/${code}`;
}

/** The join link of an invite code. */
export function discordInviteUrl(code: string): string {
    return `https://discord.com/invite/${code}`;
}

/** The CDN address of a checked guild id and icon hash. */
function iconUrl(guildId: string, icon: string): string {
    return `https://cdn.discordapp.com/icons/${guildId}/${icon}.webp?size=128`;
}

/** An entry with a checked shape, or undefined (a stored entry is checked like an answer). */
function checkedEntry(value: unknown): Entry | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const v = value as Record<string, unknown>;
    if (v.kind === 'none') return { kind: 'none' };
    // A failure is remembered for FAILED_LOOKUP_TTL_MS at most: a time further ahead (a tampered or corrupt entry)
    // is not trusted, so it cannot hold back the icon for the whole session.
    if (
        v.kind === 'failed' &&
        typeof v.until === 'number' &&
        Number.isFinite(v.until) &&
        v.until <= Date.now() + FAILED_LOOKUP_TTL_MS
    ) {
        return { kind: 'failed', until: v.until };
    }
    if (
        v.kind === 'icon' &&
        typeof v.guildId === 'string' &&
        GUILD_ID.test(v.guildId) &&
        typeof v.icon === 'string' &&
        ICON_HASH.test(v.icon)
    ) {
        return { kind: 'icon', guildId: v.guildId, icon: v.icon };
    }
    return undefined;
}

/**
 * The entry for Discord's answer: an icon when `guild.id` and `guild.icon` have their shapes, "none" when the guild has
 * no icon (`icon: null`), and undefined (a failed lookup) for anything else.
 */
export function entryFromInviteAnswer(body: unknown): Entry | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const guild = (body as { guild?: unknown }).guild;
    if (!guild || typeof guild !== 'object') return undefined;
    const { id, icon } = guild as { id?: unknown; icon?: unknown };
    if (typeof id !== 'string' || !GUILD_ID.test(id)) return undefined;
    if (icon === null) return { kind: 'none' };
    if (typeof icon !== 'string' || !ICON_HASH.test(icon)) return undefined;
    return { kind: 'icon', guildId: id, icon };
}

function readStored(code: string): Entry | undefined {
    try {
        const raw = sessionStorage.getItem(STORAGE_PREFIX + code);
        return raw === null ? undefined : checkedEntry(JSON.parse(raw));
    } catch {
        return undefined;
    }
}

function remember(code: string, entry: Entry): void {
    memory.set(code, entry);
    try {
        sessionStorage.setItem(STORAGE_PREFIX + code, JSON.stringify(entry));
    } catch {
        // No storage (private window, blocked site data): the in-memory map still holds it.
    }
}

/** The remembered entry for `code`, if it is still good (a failed one only until it expires). */
function cached(code: string, now: number): Entry | undefined {
    const entry = memory.get(code) ?? readStored(code);
    if (!entry) return undefined;
    if (entry.kind === 'failed' && entry.until <= now) return undefined;
    memory.set(code, entry);
    return entry;
}

const urlOf = (entry: Entry | undefined): string | undefined =>
    entry?.kind === 'icon' ? iconUrl(entry.guildId, entry.icon) : undefined;

async function lookup(code: string): Promise<Entry> {
    let entry: Entry | undefined;
    try {
        const response = await fetch(discordInviteApiUrl(code), {
            method: 'GET',
            credentials: 'omit',
            // No Referer (the image and the Join link send none either); `Origin` cannot be removed from a
            // cross-origin fetch. No redirect: the CSP allows only the invite path, and a redirect would leave it.
            referrerPolicy: 'no-referrer',
            redirect: 'error',
        });
        entry = response.ok ? entryFromInviteAnswer(await response.json()) : undefined;
    } catch {
        entry = undefined;
    }
    const result = entry ?? { kind: 'failed' as const, until: Date.now() + FAILED_LOOKUP_TTL_MS };
    remember(code, result);
    return result;
}

function request(code: string): Promise<Entry> {
    let pending = inFlight.get(code);
    if (!pending) {
        pending = lookup(code).finally(() => inFlight.delete(code));
        inFlight.set(code, pending);
    }
    return pending;
}

/**
 * The icon address of the Discord server behind invite `code`, or undefined while unknown, when the server has no
 * icon, when the lookup failed, or for a code without the invite shape (then nothing is requested). While `enabled` is
 * false nothing is requested either (an answer remembered earlier still shows): the caller turns it on when the icon is
 * about to be seen.
 */
export function useDiscordInviteIcon(code: string, enabled = true): string | undefined {
    const valid = DISCORD_INVITE_CODE.test(code);
    const [state, setState] = useState(() => ({
        code,
        url: valid ? urlOf(cached(code, Date.now())) : undefined,
    }));

    useEffect(() => {
        if (!valid) return;
        const known = cached(code, Date.now());
        if (known) {
            setState((s) =>
                s.code === code && s.url === urlOf(known) ? s : { code, url: urlOf(known) },
            );
            return;
        }
        if (!enabled) return;
        let active = true;
        void request(code).then((entry) => {
            if (active) setState({ code, url: urlOf(entry) });
        });
        return () => {
            active = false;
        };
    }, [code, valid, enabled]);

    return state.code === code ? state.url : undefined;
}

/** Tests only: forget every remembered answer (sessionStorage is the test's to clear). */
export function resetDiscordInviteCacheForTests(): void {
    memory.clear();
    inFlight.clear();
}
