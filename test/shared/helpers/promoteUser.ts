/**
 * Shared user-role promotion helpers.
 *
 * promoteUser opens a server-token connection and calls server_set_role to
 * promote a user by username. Requires SPACETIMEDB_SERVER_TOKEN env var
 * (written by scripts/post-publish.ts into .env.local).
 *
 * Convenience wrappers:
 *   - promoteToAdmin(username): shorthand for promoteUser(username, 'Admin')
 *   - promoteToRole(h, roleTag): resolves username from a TestHarness's User row
 */

import { DbConnection } from '@/src/module_bindings';
import type { TestHarness } from '../connection';

function getUri(): string {
    return process.env.SPACETIMEDB_URI || 'wss://maincloud.spacetimedb.com';
}

function getDb(): string {
    return process.env.SPACETIMEDB_DB || process.env.SPACETIMEDB_DB_NAME || 'hsrpvp-spacetimedb-nextjs-test1';
}

function getServerToken(): string {
    return process.env.SPACETIMEDB_SERVER_TOKEN || '';
}

/**
 * Promote a user to the given role using a server-token connection.
 * Connects, calls server_set_role, waits 1s for commit, then disconnects.
 */
export async function promoteUser(username: string, roleTag: string): Promise<void> {
    const token = getServerToken();
    if (!token) {
        throw new Error('SPACETIMEDB_SERVER_TOKEN required for promoteUser');
    }
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Promote timeout')), 10000);
        DbConnection.builder()
            .withUri(getUri())
            .withDatabaseName(getDb())
            .withToken(token)
            .withConfirmedReads(false)
            .onConnect((conn) => {
                conn.reducers.serverSetRole({ username, roleTag });
                setTimeout(() => {
                    clearTimeout(timeout);
                    conn.disconnect();
                    resolve();
                }, 1000);
            })
            .onConnectError((_ctx, err) => {
                clearTimeout(timeout);
                reject(err);
            })
            .build();
    });
}

/** Convenience wrapper: promoteUser(username, 'Admin') */
export async function promoteToAdmin(username: string): Promise<void> {
    return promoteUser(username, 'Admin');
}

/**
 * Promote a user via their TestHarness. Looks up the username from the User
 * table using h.userId, then calls promoteUser.
 */
export async function promoteToRole(h: TestHarness, roleTag: string): Promise<void> {
    const user = [...h.conn.db.User.iter()].find(u => u.id === h.userId);
    if (!user) {
        throw new Error(`User not found for userId ${h.userId}`);
    }
    return promoteUser(user.username, roleTag);
}
