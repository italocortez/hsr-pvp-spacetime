/**
 * Call server_nuke_test_data reducer via the server token.
 *
 * Usage: npx tsx scripts/nuke-test-data.ts
 *
 * Wipes all test state on the configured maincloud database. Preserves
 * seed data (characters, lightcones, costs, archetypes, achievements,
 * configs, GC jobs) and the SYSTEM user (id=0) with its identity mapping.
 *
 * Much faster than `spacetime publish --clear-database` + post-publish.ts
 * (typically ~100ms vs ~11s) and safer because it preserves seed data in
 * place rather than rebuilding it.
 *
 * Requires SPACETIMEDB_SERVER_TOKEN in .env.local.
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
            if (!process.env[key]) process.env[key] = value;
        }
    } catch { /* file missing, skip */ }
}

loadEnvFile('.env.local');
loadEnvFile('.env');

const serverToken = process.env.SPACETIMEDB_SERVER_TOKEN;
if (!serverToken) {
    console.error('SPACETIMEDB_SERVER_TOKEN not found in .env.local. Run register-server.ts first.');
    process.exit(1);
}

let host = process.env.SPACETIMEDB_HOST ?? process.env.NEXT_PUBLIC_SPACETIMEDB_HOST ?? 'wss://maincloud.spacetimedb.com';
if (host.startsWith('https://')) host = host.replace('https://', 'wss://');
else if (host.startsWith('http://')) host = host.replace('http://', 'ws://');

let dbName: string;
try {
    const stConfig = JSON.parse(readFileSync(resolve(process.cwd(), 'spacetime.json'), 'utf-8'));
    dbName = stConfig.database;
} catch {
    console.error('spacetime.json not found — run from project root');
    process.exit(1);
}

// Safety: refuse to nuke anything that doesn't look like a test database.
if (!dbName.includes('-test')) {
    console.error(`Refusing to nuke database "${dbName}" — name does not contain "-test".`);
    process.exit(1);
}

console.log(`Connecting to ${host} / ${dbName} ...`);
const t0 = Date.now();

DbConnection.builder()
    .withUri(host)
    .withDatabaseName(dbName)
    .withToken(serverToken)
    .withConfirmedReads(false)
    .onConnect(async (conn) => {
        console.log(`Calling server_nuke_test_data...`);
        try {
            await conn.reducers.serverNukeTestData({ confirmation: 'NUKE_TEST_DATA' });
            const elapsed = Date.now() - t0;
            console.log(`[OK] server_nuke_test_data resolved in ${elapsed}ms`);
            process.exit(0);
        } catch (err) {
            const elapsed = Date.now() - t0;
            console.error(`[FAIL] after ${elapsed}ms:`, err);
            process.exit(1);
        }
    })
    .onConnectError((_ctx, err) => {
        console.error('Connection failed:', err);
        process.exit(1);
    })
    .build();
