/**
 * T-S10 residue: helpers for the live residue suite (test/live/, ACCESS-SECURITY-OPS §D.5).
 *
 * The residue runs on test1 only, once per release (CLAUDE.md §2). These helpers open plain SDK connections that
 * subscribe exactly the views a file needs (frontend rule §4: views, not `subscribeToAllTables`), so the residue's
 * egress stays proportional to what it asserts. The target, host and server token come from test/shared/env.ts
 * (STDB_TARGET=test + .env.test.local, re-read on every call because globalSetup's bootstrap rotates the token).
 *
 * Errors propagate: no helper swallows a reducer rejection.
 */

import { DbConnection, type SubscriptionHandle } from '@/src/module_bindings';
import { backendEnv, serverToken } from '../shared/env';

export type Reducers = DbConnection['reducers'];
/** What the lobby helpers need: typed reducers and a client cache. The shared harness's `conn` (db: any) fits. */
export type ClientLike = Pick<DbConnection, 'db' | 'reducers'>;

export interface LiveConn {
    conn: DbConnection;
    identity: string;
    token: string;
}

export interface LiveUser extends LiveConn {
    userId: number;
    username: string;
}

/** Opens a connection (a fresh anonymous identity, or the given token's identity). No subscription, no reducer. */
export function openConnection(opts: { token?: string; timeoutMs?: number } = {}): Promise<LiveConn> {
    const env = backendEnv();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('openConnection: timeout')), opts.timeoutMs ?? 30_000);
        let builder = DbConnection.builder()
            .withUri(env.host)
            .withDatabaseName(env.dbName)
            .withConfirmedReads(false);
        if (opts.token) builder = builder.withToken(opts.token);
        builder
            .onConnect((conn, identity, token) => {
                clearTimeout(timer);
                resolve({ conn, identity: identity.toHexString(), token });
            })
            .onConnectError((_ctx, err) => {
                clearTimeout(timer);
                reject(new Error(`openConnection failed: ${err}`));
            })
            .onDisconnect(() => {})
            .build();
    });
}

/** Subscribes `queries` and resolves with the handle once applied; rejects on a subscription error. */
export function subscribe(conn: DbConnection, queries: string[], timeoutMs = 20_000): Promise<SubscriptionHandle> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`subscribe timeout: ${queries.join('; ')}`)), timeoutMs);
        const handle: SubscriptionHandle = conn.subscriptionBuilder()
            .onApplied(() => {
                clearTimeout(timer);
                resolve(handle);
            })
            .onError((ctx) => {
                clearTimeout(timer);
                reject(new Error(`subscription error [${queries.join('; ')}]: ${ctx.event?.message ?? 'unknown'}`));
            })
            .subscribe(queries);
    });
}

/** Like `subscribe`, but reports the outcome instead of throwing: for queries the server must refuse. */
export async function trySubscribe(
    conn: DbConnection,
    query: string,
    timeoutMs = 15_000,
): Promise<{ applied: true } | { applied: false; error: string }> {
    try {
        const handle = await subscribe(conn, [query], timeoutMs);
        handle.unsubscribe();
        return { applied: true };
    } catch (err) {
        return { applied: false, error: (err as Error).message };
    }
}

/** Polls `probe` until it returns a truthy value; throws with `what` after `timeoutMs`. */
export async function waitFor<T>(
    probe: () => T | undefined | null | false,
    what: string,
    timeoutMs = 20_000,
    intervalMs = 250,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = probe();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms: ${what}`);
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Disconnects every connection; never throws (afterAll). */
export function closeAll(conns: Array<{ conn: { disconnect(): void } } | undefined>): void {
    for (const c of conns) {
        try {
            c?.conn.disconnect();
        } catch {
            /* already closed */
        }
    }
}

const SELF_QUERIES = ['SELECT * FROM view_my_identity', 'SELECT * FROM view_my_profile'];

async function readSelf(c: LiveConn, extraQueries: string[], expectGuest: boolean): Promise<LiveUser> {
    await subscribe(c.conn, [...SELF_QUERIES, ...extraQueries]);
    const profile = await waitFor(
        () => [...c.conn.db.viewMyProfile.iter()].find((p) => p.isGuest === expectGuest),
        `view_my_profile row (isGuest=${expectGuest}) for ${c.identity.slice(0, 8)}`,
    );
    const mapping = await waitFor(() => [...c.conn.db.viewMyIdentity.iter()][0], 'view_my_identity row');
    if (mapping.userId !== profile.id) {
        throw new Error(`view_my_identity userId ${mapping.userId} != view_my_profile id ${profile.id}`);
    }
    return { ...c, userId: profile.id, username: profile.username };
}

/** A guest: connect, `login_as_guest`, subscribe the caller's own identity views (+ `extraQueries`). */
export async function connectGuest(extraQueries: string[] = []): Promise<LiveUser> {
    const c = await openConnection();
    await c.conn.reducers.loginAsGuest({});
    return readSelf(c, extraQueries, true);
}

/**
 * A verified user: a guest upgraded through `server_link_provider` on a server-token connection (the auth
 * function's path, M5). The username is the provider name, `Live_<random>`, unique per call.
 */
export async function connectVerified(extraQueries: string[] = []): Promise<LiveUser> {
    const c = await openConnection();
    await c.conn.reducers.loginAsGuest({});
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await withServer((s) =>
        s.reducers.serverLinkProvider({
            callerIdentityHex: c.identity,
            provider: 'discord',
            providerId: `live_${suffix}`,
            providerName: `Live_${suffix}`,
        }),
    );
    return readSelf(c, extraQueries, false);
}

/** Runs `fn` on a short-lived connection that carries the delegate token (STDB_SERVER_TOKEN). */
export async function withServer<T>(fn: (server: DbConnection) => Promise<T>): Promise<T> {
    const token = serverToken();
    if (!token) throw new Error('STDB_SERVER_TOKEN missing from .env.test.local (written by the globalSetup bootstrap)');
    const s = await openConnection({ token });
    try {
        return await fn(s.conn);
    } finally {
        s.conn.disconnect();
    }
}

/** `server_set_role` through the delegate (the manage-user script's path). Awaited: a rejection propagates. */
export function setRole(username: string, roleTag: 'Admin' | 'Moderator' | 'TournamentHost' | 'User'): Promise<void> {
    return withServer((s) => s.reducers.serverSetRole({ username, roleTag }));
}

// ─── Lobby ────────────────────────────────────────────────────────────────────

export type CreateLobbyArgs = Parameters<Reducers['createLobby']>[0];

/** create_lobby arguments for a casual 1v1 Classic lobby (current bindings, S9c). */
export function casualLobbyArgs(overrides: Partial<CreateLobbyArgs> = {}): CreateLobbyArgs {
    return {
        teamSize: 1,
        draftMode: { tag: 'Classic' },
        banMode: { tag: 'None' },
        gameMode: { tag: 'MemoryOfChaos' },
        matchType: { tag: 'Casual' },
        isPublic: true,
        password: '',
        standardTurnSeconds: 60,
        reserveBankSeconds: 120,
        characterBudget: 100,
        lightconeBudget: 50,
        minimumBidRaise: 1,
        rosterDiffAdvantage: 0,
        rosterThreshold: 0,
        underThresholdAdvantage: 0,
        aboveThresholdPenalty: 0,
        deathPenalty: 0,
        isAnonymousPlayers: false,
        isAnonymousSpectators: false,
        rosterVisibility: { tag: 'OpenRoster' },
        requireOwnership: false,
        costSetId: 0,
        disconnectPolicy: { tag: 'Standard' },
        disconnectForfeitSeconds: 60,
        allowMirrorPicks: false,
        autoRandomPick: false,
        refereeCanUndo: true,
        refereeCanPause: true,
        refereeCanSetCaptain: true,
        refereeCanKick: true,
        allowPlayerPause: true,
        teamBlueAlias: 'Blue',
        teamRedAlias: 'Red',
        ...overrides,
    };
}

export const LOBBY_QUERIES = ['SELECT * FROM view_my_lobby', 'SELECT * FROM view_my_lobby_members'];

/** The lobby the caller sits in, from its `view_my_lobby` cache (needs that view subscribed). */
export function myLobbyId(c: Pick<DbConnection, 'db'>): number | undefined {
    return [...c.db.viewMyLobby.iter()][0]?.id;
}

/** The caller's `view_my_lobby_members` rows for `lobbyId`, by seat number. */
export function lobbyMembers(c: Pick<DbConnection, 'db'>, lobbyId: number) {
    return [...c.db.viewMyLobbyMembers.iter()]
        .filter((m) => m.lobbyId === lobbyId)
        .sort((x, y) => x.joinSeq - y.joinSeq);
}

/** The member row of `userId` as `viewer` sees it (non-anonymous lobbies carry the user id). */
export function memberAs(viewer: Pick<DbConnection, 'db'>, lobbyId: number, userId: number) {
    return lobbyMembers(viewer, lobbyId).find((m) => m.userId === userId);
}

/**
 * Host creates a casual 1v1 lobby and takes Blue; the guest joins and takes Red; both confirm. Stops in Waiting
 * unless `start` (then `start_draft`: Drafting). Both clients must have LOBBY_QUERIES subscribed. Returns the id.
 */
export async function setupOneVsOne(
    host: ClientLike,
    guest: ClientLike,
    opts: { start: boolean; lobby?: Partial<CreateLobbyArgs> },
): Promise<number> {
    await host.reducers.createLobby(casualLobbyArgs(opts.lobby));
    const lobbyId = await waitFor(() => myLobbyId(host), 'host sees its lobby in view_my_lobby');
    await host.reducers.setTeamSlot({ lobbyId, lobbySlot: { tag: 'BluePlayer' } });
    await host.reducers.confirmReady({ lobbyId });
    await guest.reducers.joinLobby({ lobbyId, joinCode: '', password: '' });
    await guest.reducers.setTeamSlot({ lobbyId, lobbySlot: { tag: 'RedPlayer' } });
    await guest.reducers.confirmReady({ lobbyId });
    if (opts.start) await host.reducers.startDraft({ lobbyId });
    return lobbyId;
}
