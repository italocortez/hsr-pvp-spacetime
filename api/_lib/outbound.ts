// The function's outbound calls: Discord's token and user endpoints, and the module's
// `linker_present_code` over the SpacetimeDB HTTP API. Every call has a 5 s timeout; nothing is
// retried. Nothing here logs.
import { REFUSAL_TEXT_MAX } from '../../shared/auth-flow.js';
import type { AuthConfig } from './config.js';

export const OUTBOUND_TIMEOUT_MS = 5000;

export interface DiscordEndpoints {
    authorize: string;
    token: string;
    me: string;
}

/** Discord's real endpoints. The deployed function has no way to use any other. */
export const DISCORD_ENDPOINTS: DiscordEndpoints = {
    authorize: 'https://discord.com/oauth2/authorize',
    token: 'https://discord.com/api/v10/oauth2/token',
    me: 'https://discord.com/api/v10/users/@me',
};

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The authorize address the browser is sent to (`prompt=consent`, scope `identify` only). */
export function authorizeUrl(
    endpoints: DiscordEndpoints,
    clientId: string,
    state: string,
    redirectUri: string,
): string {
    const url = new URL(endpoints.authorize);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('prompt', 'consent');
    return url.toString();
}

export type DiscordUser = { id: string; username: string };
export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

async function send(
    fetchImpl: FetchLike,
    url: string,
    init: RequestInit,
): Promise<Response | string> {
    try {
        return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });
    } catch (error) {
        const name = (error as { name?: unknown } | null)?.name;
        return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable';
    }
}

/** Exchanges the authorization code, then reads the user: the id and the handle (`username`). */
export async function fetchDiscordUser(
    fetchImpl: FetchLike,
    endpoints: DiscordEndpoints,
    config: Pick<AuthConfig, 'clientId' | 'clientSecret'>,
    code: string,
    redirectUri: string,
): Promise<Outcome<DiscordUser>> {
    const tokenRes = await send(fetchImpl, endpoints.token, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: config.clientId,
            client_secret: config.clientSecret,
        }).toString(),
    });
    if (typeof tokenRes === 'string') return { ok: false, reason: `discord_token_${tokenRes}` };
    if (!tokenRes.ok) return { ok: false, reason: 'discord_token_status' };
    let accessToken: unknown;
    try {
        accessToken = ((await tokenRes.json()) as { access_token?: unknown } | null)?.access_token;
    } catch {
        return { ok: false, reason: 'discord_token_body' };
    }
    if (typeof accessToken !== 'string' || accessToken === '') {
        return { ok: false, reason: 'discord_token_body' };
    }

    const meRes = await send(fetchImpl, endpoints.me, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (typeof meRes === 'string') return { ok: false, reason: `discord_user_${meRes}` };
    if (!meRes.ok) return { ok: false, reason: 'discord_user_status' };
    let me: { id?: unknown; username?: unknown } | null;
    try {
        me = (await meRes.json()) as { id?: unknown; username?: unknown } | null;
    } catch {
        return { ok: false, reason: 'discord_user_body' };
    }
    const id = me?.id;
    const username = me?.username;
    if (typeof id !== 'string' || !/^[0-9]{17,20}$/.test(id)) {
        return { ok: false, reason: 'discord_user_body' };
    }
    if (typeof username !== 'string' || username.trim() === '') {
        return { ok: false, reason: 'discord_user_body' };
    }
    return { ok: true, value: { id, username } };
}

/** The module's answer to the presentation. `refused` carries the module's own (user-facing) text. */
export type PresentResult =
    | { kind: 'presented' }
    | { kind: 'refused'; text: string }
    | { kind: 'error'; reason: string };

/** True when `text` holds a C0 control (below U+0020), DEL or a C1 control (U+007F to U+009F), or U+2028 / U+2029. */
function hasLineOrControl(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
    }
    return false;
}

/** The HTTP status maincloud answers for a reducer that threw (a `SenderError`), observed at M5b. */
export const REDUCER_FAILED_STATUS = 530;

/**
 * `POST <host>/v1/database/<db>/call/linker_present_code` with the link token as bearer and the
 * five arguments as a JSON array (the reducer's parameter order). One attempt, no retry: a
 * timeout leaves the outcome unknown, and the page then shows "failed".
 */
export async function presentLinkCode(
    fetchImpl: FetchLike,
    config: Pick<AuthConfig, 'stdbHttpHost' | 'dbName' | 'linkToken'>,
    args: { linkCode: string; providerId: string; providerName: string; confirmHash: string },
): Promise<PresentResult> {
    const url = `${config.stdbHttpHost}/v1/database/${encodeURIComponent(config.dbName)}/call/linker_present_code`;
    const res = await send(fetchImpl, url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.linkToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify([
            args.linkCode,
            'discord',
            args.providerId,
            args.providerName,
            args.confirmHash,
        ]),
    });
    if (typeof res === 'string') return { kind: 'error', reason: `stdb_${res}` };
    if (res.ok) return { kind: 'presented' };
    if (res.status === REDUCER_FAILED_STATUS) {
        // Only a plain-text, one-line message of at most REFUSAL_TEXT_MAX characters is a module
        // refusal the visitor may read; HTML, JSON or a multi-line body (a proxy page, a stack) is not.
        const type = (res.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
        if (type !== 'text/plain') return { kind: 'error', reason: 'stdb_body' };
        let text = '';
        try {
            text = (await res.text()).trim();
        } catch {
            return { kind: 'error', reason: 'stdb_body' };
        }
        // A guard refusal means the function's own key is wrong: not the visitor's business.
        // Case, leading whitespace and zero-width characters do not hide it.
        const head = text.replace(/^[\s\u200B-\u200D\u2060\uFEFF]+/, '').toLowerCase();
        if (head === '' || head.startsWith('forbidden'))
            return { kind: 'error', reason: 'stdb_forbidden' };
        // One line of printable text: no C0 or C1 control (tab and line breaks included), no
        // Unicode line or paragraph separator.
        if (hasLineOrControl(text) || text.length > REFUSAL_TEXT_MAX) {
            return { kind: 'error', reason: 'stdb_body' };
        }
        return { kind: 'refused', text };
    }
    if (res.status === 401 || res.status === 403) return { kind: 'error', reason: 'stdb_auth' };
    return { kind: 'error', reason: 'stdb_status' };
}
