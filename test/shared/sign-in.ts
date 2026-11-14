/**
 * T-M5a3: the live sign-in, the real way (the removed server_link_provider did it in one server call):
 *   1. request_link_code on the user's own connection (a fresh 32-byte nonce);
 *   2. the code read back from view_my_link_request (a short subscription on the user's connection);
 *   3. linker_present_code on a short-lived connection with the Linker token (STDB_LINK_TOKEN, written by bootstrap),
 *      with the hash of a fresh confirm token: base64url(SHA-256(the token's 32 bytes));
 *   4. confirm_link on the user's connection with the token.
 * Test database only (the env helpers refuse any other target). Node's crypto supplies the nonce, the token and the hash,
 * independently of the module's own SHA-256.
 */
import { createHash, randomBytes } from 'node:crypto';
import { DbConnection } from '@bindings/index';
import { backendEnv, linkToken } from './env';

/** A random, valid Discord id for a test user (18 digits, never starting with 0). */
export function randomDiscordId(): string {
    let id = String(1 + Math.floor(Math.random() * 9));
    for (let i = 0; i < 17; i++) id += String(Math.floor(Math.random() * 10));
    return id;
}

function openLinker(): Promise<DbConnection> {
    const token = linkToken();
    if (!token) throw new Error('STDB_LINK_TOKEN missing from .env.test.local (written by the bootstrap script, M5a3)');
    const env = backendEnv();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Linker connection timeout')), 10000);
        DbConnection.builder()
            .withUri(env.host)
            .withDatabaseName(env.dbName)
            .withToken(token)
            .withConfirmedReads(false)
            .onConnect((conn) => { clearTimeout(timeout); resolve(conn); })
            .onConnectError((_ctx, err) => { clearTimeout(timeout); reject(new Error(`Linker connection failed: ${err}`)); })
            .onDisconnect(() => {})
            .build();
    });
}

/** Reads the caller's live code from view_my_link_request (one subscription, dropped afterwards). */
function readOwnCode(conn: DbConnection): Promise<string> {
    return new Promise((resolve, reject) => {
        let settled = false;
        /** Settles once. The subscription is dropped in onApplied, the only point where unsubscribe is valid. */
        const finish = (outcome: { code: string } | { error: Error }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if ('code' in outcome) resolve(outcome.code);
            else reject(outcome.error);
        };
        // Timeout path: the subscription is still pending, so it cannot be unsubscribed yet; if it applies later,
        // onApplied drops it at once.
        const timeout = setTimeout(() => finish({ error: new Error('view_my_link_request did not apply within 10 s') }), 10000);
        const handle = conn.subscriptionBuilder()
            .onApplied(() => {
                const rows = settled ? [] : ([...(conn.db as any).viewMyLinkRequest.iter()] as Array<{ code?: string }>);
                handle.unsubscribe();
                const code = rows[0]?.code;
                finish(code ? { code } : { error: new Error('no live code in view_my_link_request') });
            })
            .onError((ctx) => {
                // An errored subscription has ended: nothing to unsubscribe.
                finish({ error: new Error(`view_my_link_request subscription failed: ${ctx.event?.message ?? 'unknown error'}`) });
            })
            .subscribe(['SELECT * FROM view_my_link_request']);
    });
}

/**
 * Signs the guest on `conn` in with a Discord account (a random id unless given; an existing account's id re-points
 * the identity, Case 1b). Resolves after confirm_link returned; a refusal of any step rejects.
 */
export async function signInLive(conn: DbConnection, providerName: string, providerId = randomDiscordId()): Promise<string> {
    await conn.reducers.requestLinkCode({ clientNonce: randomBytes(32).toString('base64url') });
    const linkCode = await readOwnCode(conn);
    const confirmToken = randomBytes(32).toString('base64url');
    const confirmHash = createHash('sha256').update(Buffer.from(confirmToken, 'base64url')).digest('base64url');
    const linker = await openLinker();
    try {
        await linker.reducers.linkerPresentCode({ linkCode, provider: 'discord', providerId, providerName, confirmHash });
    } finally {
        linker.disconnect();
    }
    await conn.reducers.confirmLink({ confirmToken });
    return providerId;
}

/** True when the Linker token is available (bootstrap has run since M5a3). */
export function hasLinkToken(): boolean {
    return linkToken().length > 0;
}
