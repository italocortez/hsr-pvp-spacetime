/**
 * Seed game data tables from test/data/ JSON files.
 *
 * Usage:
 *   npx tsx scripts/seed-data.ts
 *
 * Requires SPACETIMEDB_SERVER_TOKEN in .env.local (from register-server.ts or post-publish.ts).
 *
 * Reads test/data/{characters_table,lightcones_table,pairing_table}.json,
 * normalizes them to the admin_bulk_upsert API format (Phase 15 D-22 canonical shape:
 * snake_case keys, `cost` wrapper with `cost_set_id` + 3-mode blocks, Spine +
 * positioning passthrough), and calls the reducer for each table:
 *   HsrCharacter, HsrLightcone, HsrCharacterCost, HsrLightconeCost, HsrSynergyCost.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'node:url';
import { DbConnection } from '../src/module_bindings';
import {
    normalizeCharacters,
    normalizeLightcones,
    normalizeCharacterCosts,
    normalizeLightconeCosts,
    normalizePairings,
    extractArchetypeNames,
    extractArchetypeAssignments,
    type RawCharacter,
    type RawLightcone,
    type RawPairing,
} from '../lib/seed-normalizers';

// ─── Env loading (same as register-server.ts) ─────────────────────────────────

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
    } catch { /* file doesn't exist, skip */ }
}

loadEnvFile('.env.local');
loadEnvFile('.env');

// ─── Load and normalize all data ──────────────────────────────────────────────

function loadJson<T>(filePath: string): T[] {
    if (!existsSync(filePath)) {
        console.warn(`[seed] Data file not found: ${filePath} — skipping`);
        return [];
    }
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T[];
}

function buildSeedPayloads(
    characters: RawCharacter[],
    lightcones: RawLightcone[],
    pairings: RawPairing[]
): Array<{ tableName: string; rows: object[] }> {
    const archetypeNames = extractArchetypeNames(characters);

    return [
        { tableName: 'HsrCharacter', rows: normalizeCharacters(characters) },
        { tableName: 'HsrLightcone', rows: normalizeLightcones(lightcones) },
        { tableName: 'HsrCharacterCost', rows: normalizeCharacterCosts(characters) },
        { tableName: 'HsrLightconeCost', rows: normalizeLightconeCosts(lightcones) },
        { tableName: 'HsrSynergyCost', rows: normalizePairings(pairings) },
        { tableName: 'Archetype', rows: archetypeNames.map(name => ({ name, description: '' })) },
    ].filter(p => p.rows.length > 0);
}

// ─── Seed via WebSocket SDK ────────────────────────────────────────────────────

/** Connect as server identity and upsert all game data tables.
 *  Exported for use by post-publish.ts. */
export async function seedAll(serverToken: string): Promise<void> {
    const dataDir = resolve(process.cwd(), 'test/data');
    const characters = loadJson<RawCharacter>(resolve(dataDir, 'characters_table.json'));
    const lightcones = loadJson<RawLightcone>(resolve(dataDir, 'lightcones_table.json'));
    const pairings = loadJson<RawPairing>(resolve(dataDir, 'pairing_table.json'));

    const payloads = buildSeedPayloads(characters, lightcones, pairings);
    if (payloads.length === 0) {
        console.log('[seed] No data files found. Skipping seed.');
        return;
    }

    let host = process.env.SPACETIMEDB_HOST ?? process.env.NEXT_PUBLIC_SPACETIMEDB_HOST ?? 'wss://maincloud.spacetimedb.com';
    if (host.startsWith('https://')) host = host.replace('https://', 'wss://');
    else if (host.startsWith('http://')) host = host.replace('http://', 'ws://');
    else if (!host.startsWith('wss://') && !host.startsWith('ws://')) {
        // Bare hostname — assume secure WebSocket
        host = `wss://${host}`;
    }

    let dbName: string;
    try {
        const stConfig = JSON.parse(readFileSync(resolve(process.cwd(), 'spacetime.json'), 'utf-8'));
        dbName = stConfig.database;
    } catch {
        console.error('[seed] spacetime.json not found — run from project root');
        throw new Error('spacetime.json not found');
    }

    console.log(`[seed] Connecting to ${host} / ${dbName} ...`);

    return new Promise((done, reject) => {
        const timeout = setTimeout(() => reject(new Error('[seed] Connection timeout (30s)')), 30000);

        DbConnection.builder()
            .withUri(host)
            .withDatabaseName(dbName)
            .withToken(serverToken)
            .withConfirmedReads(false)
            .onConnect(async (connection, identity) => {
                clearTimeout(timeout);
                console.log(`[seed] Connected as: ${identity.toHexString()}`);

                try {
                    for (const { tableName, rows } of payloads) {
                        console.log(`[seed] Upserting ${rows.length} rows -> ${tableName} ...`);
                        await connection.reducers.adminBulkUpsert({
                            tableName,
                            jsonData: JSON.stringify(rows),
                        });
                        console.log(`[seed] ${tableName}: done`);
                    }
                    console.log('\n[seed] All tables seeded successfully.');
                } catch (err) {
                    console.error('[seed] Seed failed:', err);
                    connection.disconnect();
                    reject(err);
                    return;
                }

                // Archetype junction seeding (D-07): subscribe to Archetype table to resolve name→id
                // Reuse `characters` loaded at the top of seedAll (WR-03 — avoid double-parse)
                const assignments = extractArchetypeAssignments(characters);

                if (assignments.length > 0) {
                    console.log(`[seed] Waiting for Archetype table subscription to resolve IDs...`);
                    connection.subscriptionBuilder()
                        .onApplied(async () => {
                            try {
                                // Build name→id map from subscribed Archetype rows
                                const archetypeMap = new Map<string, number>();
                                for (const row of connection.db.Archetype.iter()) {
                                    archetypeMap.set(row.name, row.id);
                                }
                                console.log(`[seed] Resolved ${archetypeMap.size} archetype IDs`);

                                // Seed junction rows
                                for (const { characterName, archetypeNames } of assignments) {
                                    const ids = archetypeNames
                                        .map(n => archetypeMap.get(n))
                                        .filter((id): id is number => id !== undefined);
                                    if (ids.length > 0) {
                                        await connection.reducers.adminAssignCharacterArchetypes({
                                            characterName,
                                            archetypeIdsJson: JSON.stringify(ids),
                                        });
                                    }
                                }
                                console.log(`[seed] Archetype assignments seeded for ${assignments.length} characters.`);
                            } catch (err) {
                                console.error('[seed] Junction seeding failed:', err);
                            } finally {
                                connection.disconnect();
                                done();
                            }
                        })
                        .subscribe('SELECT * FROM archetype');
                } else {
                    setTimeout(() => {
                        connection.disconnect();
                        done();
                    }, 1000);
                }
            })
            .onConnectError((_ctx, err) => {
                clearTimeout(timeout);
                reject(new Error(`[seed] Connection failed: ${err}`));
            })
            .build();
    });
}

// ─── CLI entry point ───────────────────────────────────────────────────────────

// Only run when called directly (not when imported by post-publish.ts)
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const serverToken = process.env.SPACETIMEDB_SERVER_TOKEN;
    if (!serverToken) {
        console.error('[seed] SPACETIMEDB_SERVER_TOKEN not found in .env.local. Run register-server.ts first.');
        process.exit(1);
    }

    seedAll(serverToken)
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
