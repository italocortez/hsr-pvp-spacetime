/**
 * Live residue (T-S10, ACCESS-SECURITY-OPS §D.5): subscription delivery and isolation over a real WebSocket.
 * Re-created from test/backend/auth/auth-subscriptions.test.ts (minus its tautology: the old test asserted an
 * empty cache for a table it never subscribed) plus SEC-01b from test/backend/auth/auth-security.test.ts.
 *
 *   1. view_my_profile is per sender: an anonymous connection receives 0 rows; after login_as_guest exactly its own
 *      row arrives (docs/auth/contract.md "Guest Login (First Time)": username Guest_{hex8}, isGuest).
 *   2. SEC-01b: private tables never reach a client, even one that subscribes everything it can. Type level: the
 *      generated bindings have no accessor for UserPrivate, UserIdentity, HsrAccount, LobbyMember (A37); a
 *      `@ts-expect-error` turns a regression into a compile error. Runtime: subscribeToAllTables delivers none of them
 *      (deliberately used here: the client "that subscribes everything" is the subject), and a direct
 *      `SELECT * FROM <private table>` subscription is refused by the server.
 *   3. What is public today: the User table (PAGE-MAP D2: only the admin Users tab subscribes it); a client
 *      subscribed to its own User row receives it.
 *
 * Estimated runtime: ~25 s (three guest connections; test 2 pulls every public table once).
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
    type LiveConn,
    closeAll,
    connectGuest,
    openConnection,
    subscribe,
    trySubscribe,
    waitFor,
} from './_helpers';

const PRIVATE_TABLES = ['user_private', 'user_identity', 'hsr_account', 'lobby_member'] as const;

describe('Auth subscriptions over the wire (§D.5)', () => {
    const open: LiveConn[] = [];

    afterAll(() => closeAll(open));

    it('view_my_profile: anonymous → 0 rows; after login_as_guest → exactly the caller\'s own row (auth contract "Guest Login")', async () => {
        const c = await openConnection();
        open.push(c);

        await subscribe(c.conn, ['SELECT * FROM view_my_profile']);
        expect(c.conn.db.viewMyProfile.count()).toBe(0n);

        await c.conn.reducers.loginAsGuest({});
        const row = await waitFor(() => [...c.conn.db.viewMyProfile.iter()][0], 'own view_my_profile row after login');

        const rows = [...c.conn.db.viewMyProfile.iter()];
        expect(rows).toHaveLength(1);
        expect(row.isGuest).toBe(true);
        expect(row.username).toBe(`Guest_${c.identity.slice(0, 8)}`);
    }, 30_000);

    it('SEC-01b: UserPrivate, UserIdentity, HsrAccount and LobbyMember never reach a client that subscribes everything (A37)', async () => {
        // Type level: no client accessor exists for a private table.
        const typeProbe = (conn: LiveConn['conn']) => [
            // @ts-expect-error UserPrivate is private (A37): no generated accessor
            conn.db.userPrivate,
            // @ts-expect-error UserIdentity is private (A37): no generated accessor
            conn.db.userIdentity,
            // @ts-expect-error HsrAccount is private (D-20, A37): no generated accessor
            conn.db.hsrAccount,
            // @ts-expect-error LobbyMember is private (A37): members are read through view_my_lobby_members
            conn.db.lobbyMember,
        ];

        const c = await openConnection();
        open.push(c);
        await c.conn.reducers.loginAsGuest({});
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('subscribeToAllTables: timeout')), 30_000);
            c.conn.subscriptionBuilder()
                .onApplied(() => {
                    clearTimeout(timer);
                    resolve();
                })
                .onError((ctx) => {
                    clearTimeout(timer);
                    reject(new Error(`subscribeToAllTables failed: ${ctx.event?.message}`));
                })
                .subscribeToAllTables();
        });

        // Runtime: the client cache has no such table, under any spelling.
        expect(typeProbe(c.conn).every((accessor) => accessor === undefined)).toBe(true);
        const cached = Object.keys(c.conn.db).map((k) => k.toLowerCase().replace(/_/g, ''));
        for (const name of ['userprivate', 'useridentity', 'hsraccount', 'lobbymember']) {
            expect(cached).not.toContain(name);
        }

        // Runtime: a raw subscription to each private table is refused by the server.
        for (const table of PRIVATE_TABLES) {
            const outcome = await trySubscribe(c.conn, `SELECT * FROM ${table}`);
            expect(outcome.applied, `SELECT * FROM ${table} must be refused`).toBe(false);
        }
    }, 90_000);

    it('User is public today (PAGE-MAP D2: only the admin Users tab subscribes it): a client subscribed to its own User row receives it', async () => {
        const guest = await connectGuest();
        open.push(guest);

        await subscribe(guest.conn, [`SELECT * FROM user WHERE id = ${guest.userId}`]);
        const own = await waitFor(
            () => [...guest.conn.db.user.iter()].find((u) => u.id === guest.userId),
            'own User row',
        );
        expect(own.username).toBe(guest.username);
    }, 30_000);
});
