/**
 * Manage users via the server identity: change roles or delete any user.
 *
 * Usage:
 *   npx tsx scripts/manage-user.ts set-role <username> <newRole>
 *   npx tsx scripts/manage-user.ts delete <username>
 *
 * Roles: Admin, Moderator, TournamentHost, User
 *
 * Requires SPACETIMEDB_SERVER_TOKEN in .env.local (from register-server.ts).
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DbConnection } from '../src/module_bindings';

function loadEnvFile(filename: string) {
    try {
        const content = readFileSync(resolve(process.cwd(), filename), 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const value = trimmed.slice(eqIdx + 1).trim();
            if (!process.env[key]) {
                process.env[key] = value;
            }
        }
    } catch {
        // File doesn't exist, skip
    }
}

loadEnvFile('.env.local');
loadEnvFile('.env');

const VALID_ROLES = ['Admin', 'Moderator', 'TournamentHost', 'User'];

const action = process.argv[2];
const username = process.argv[3];

if (!action || !username || !['set-role', 'delete'].includes(action)) {
    console.error(`Usage:
  npx tsx scripts/manage-user.ts set-role <username> <newRole>
  npx tsx scripts/manage-user.ts delete <username>

Roles: ${VALID_ROLES.join(', ')}`);
    process.exit(1);
}

let newRole: string | undefined;
if (action === 'set-role') {
    newRole = process.argv[4];
    if (!newRole || !VALID_ROLES.includes(newRole)) {
        console.error(`Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
        process.exit(1);
    }
}

const serverToken = process.env.SPACETIMEDB_SERVER_TOKEN;
if (!serverToken) {
    console.error('SPACETIMEDB_SERVER_TOKEN not found in .env.local. Run register-server.ts first.');
    process.exit(1);
}

let host = process.env.SPACETIMEDB_HOST ?? process.env.NEXT_PUBLIC_SPACETIMEDB_HOST ?? 'wss://maincloud.spacetimedb.com';
if (host.startsWith('https://')) {
    host = host.replace('https://', 'wss://');
} else if (host.startsWith('http://')) {
    host = host.replace('http://', 'ws://');
}

let dbName: string;
try {
    const stConfig = JSON.parse(readFileSync(resolve(process.cwd(), 'spacetime.json'), 'utf-8'));
    dbName = stConfig.database;
} catch {
    console.error('spacetime.json not found — run from project root');
    process.exit(1);
}

console.log(`Connecting to ${host} / ${dbName} ...`);

const _conn = DbConnection.builder()
    .withUri(host)
    .withDatabaseName(dbName)
    .withToken(serverToken)
    .withConfirmedReads(false)
    .onConnect((connection, identity) => {
        console.log(`Connected as server identity: ${identity.toHexString()}`);

        try {
            if (action === 'set-role') {
                connection.reducers.serverSetRole({ username, roleTag: newRole! });
                console.log(`\nUser "${username}" role set to ${newRole}.`);
            } else if (action === 'delete') {
                connection.reducers.serverDeleteUser({ username });
                console.log(`\nUser "${username}" has been deleted.`);
            }
        } catch (err) {
            console.error(`\nFailed to ${action}:`, err);
        }

        setTimeout(() => process.exit(0), 2000);
    })
    .onConnectError((_ctx, err) => {
        console.error('Connection failed:', err);
        process.exit(1);
    })
    .build();
