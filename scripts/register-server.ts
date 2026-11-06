/**
 * One-time setup script: registers a SpacetimeDB identity as the trusted "Server" identity.
 *
 * Usage:
 *   npx tsx scripts/register-server.ts
 *
 * What it does:
 *   1. Loads .env.local for connection config
 *   2. Connects to SpacetimeDB (gets a fresh identity + token)
 *   3. Calls the register_server reducer (marks that identity as trusted)
 *   4. Prints the token — add it to .env.local as SPACETIMEDB_SERVER_TOKEN
 *
 * Only works when no server identity is registered yet. To re-register,
 * clear-publish the database first.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DbConnection } from '../src/module_bindings';

// Manually load .env.local (tsx doesn't auto-load it)
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

// Resolve host — ensure wss:// protocol for WebSocket
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
    .withConfirmedReads(false)
    // No token — get a fresh identity
    .onConnect((connection, identity, token) => {
        console.log(`\nConnected with identity: ${identity.toHexString()}`);
        console.log(`\nCalling register_server ...`);

        try {
            connection.reducers.registerServer({});
            console.log(`\nServer identity registered successfully!\n`);
            console.log(`Add this to your .env.local:\n`);
            console.log(`SPACETIMEDB_SERVER_TOKEN=${token}`);
            console.log(`\nThen restart your Next.js dev server.`);
        } catch (err) {
            console.error(`\nFailed to register:`, err);
        }

        // Give the reducer call time to send before disconnecting
        setTimeout(() => process.exit(0), 2000);
    })
    .onConnectError((_ctx, err) => {
        console.error('Connection failed:', err);
        process.exit(1);
    })
    .build();
