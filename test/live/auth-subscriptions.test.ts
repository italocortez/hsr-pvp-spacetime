/**
 * Live residue (T-S10, ACCESS-SECURITY-OPS §D.5): subscription delivery and isolation over a real WebSocket.
 * Re-created from test/backend/auth/auth-subscriptions.test.ts (minus its tautology: the old test asserted an
 * empty cache for a table it never subscribed) plus SEC-01b from test/backend/auth/auth-security.test.ts.
 *
 *   1. view_my_profile is per sender: an anonymous connection receives 0 rows; after login_as_guest exactly its own
 *      row arrives (docs/auth/contract.md "Guest Login (First Time)": username Guest_{last hex8}, `_N` on a collision, isGuest).
 *   2. SEC-01b: private tables never reach a client, even one that subscribes everything it can. Type level: the
 *      generated bindings have no accessor for User (A77, S11a: UserPrivate merged into it), UserIdentity, HsrAccount,
 *      LobbyMember (A37); a `@ts-expect-error` turns a regression into a compile error. Runtime: subscribeToAllTables
 *      delivers none of them (deliberately used here: the client "that subscribes everything" is the subject), and a
 *      direct `SELECT * FROM <private table>` subscription is refused by the server.
 *   3. A77(3) (S11a): User is private; a client subscribing its own User row is refused (the admin Users tab reads
 *      view_admin_users).
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

const PRIVATE_TABLES = ['user', 'user_identity', 'hsr_account', 'lobby_member'] as const; // A77: user (user_private merged)

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
        // S10h: "Guest_" + the LAST 8 hex characters of the identity (guestUsernameBase); test1 accumulates guests, so
        // a 32-bit collision is possible and login_as_guest then appends `_2`, `_3`, ... (uniqueUsername).
        expect(row.username).toMatch(new RegExp(`^Guest_${c.identity.slice(-8)}(_\\d+)?$`));
    }, 30_000);

    it('SEC-01b: User, UserIdentity, HsrAccount and LobbyMember never reach a client that subscribes everything (A37, A77)', async () => {
        // Type level: no client accessor exists for a private table.
        const typeProbe = (conn: LiveConn['conn']) => [
            // @ts-expect-error User is private (A77, S11a; UserPrivate merged into it): no generated accessor
            conn.db.user,
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
        for (const name of ['user', 'useridentity', 'hsraccount', 'lobbymember']) {
            expect(cached).not.toContain(name);
        }

        // Runtime: a raw subscription to each private table is refused by the server.
        for (const table of PRIVATE_TABLES) {
            const outcome = await trySubscribe(c.conn, `SELECT * FROM ${table}`);
            expect(outcome.applied, `SELECT * FROM ${table} must be refused`).toBe(false);
        }
    }, 90_000);

    it('A77(3): User is private: a client subscribing its own User row is refused', async () => {
        const guest = await connectGuest();
        open.push(guest);

        const outcome = await trySubscribe(guest.conn, `SELECT * FROM user WHERE id = ${guest.userId}`);
        expect(outcome.applied, 'SELECT * FROM user must be refused').toBe(false);
    }, 30_000);
});
