/**
 * Post-publish bootstrap: register server identity and seed all game data tables.
 *
 * Usage (run immediately after "spacetime publish --clear-database"):
 *   npx tsx scripts/post-publish.ts
 *
 * What it does:
 *   1. Connects fresh (no token) to get a new identity
 *   2. Calls register_server to mark this identity as trusted
 *   3. Appends SPACETIMEDB_SERVER_TOKEN to .env.local
 *   4. Calls seedAll() to upsert HsrCharacter, HsrLightcone, costs, and synergies
 *   5. Seeds 3 starter achievements (MMR Elite, Veteran, Solar First Tournament Winner)
 *   6. Seeds config tables (EloConfig, AccountRatingConfig) with defaults
 *
 * After completion, restart your Next.js dev server to pick up the new token.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { DbConnection } from '../src/module_bindings';
import { seedAll } from './seed-data';

// ─── Env loading ───────────────────────────────────────────────────────────────

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

// ─── .env.local token writer ───────────────────────────────────────────────────

function writeTokenToEnvLocal(token: string): void {
    const envPath = resolve(process.cwd(), '.env.local');
    let content = '';

    if (existsSync(envPath)) {
        content = readFileSync(envPath, 'utf-8');
        // Remove existing SPACETIMEDB_SERVER_TOKEN line(s)
        content = content
            .split('\n')
            .filter(line => !line.startsWith('SPACETIMEDB_SERVER_TOKEN='))
            .join('\n');
        // Ensure trailing newline
        if (content && !content.endsWith('\n')) content += '\n';
    }

    content += `SPACETIMEDB_SERVER_TOKEN=${token}\n`;
    writeFileSync(envPath, content, 'utf-8');
    console.log(`\n[bootstrap] Token written to .env.local`);
}

// ─── Read spacetime.json (single source of truth) ───────────────────────────

function readSpacetimeJson(): { database: string; server?: string } {
    const path = resolve(process.cwd(), 'spacetime.json');
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
        console.error('[bootstrap] spacetime.json not found — run from project root');
        process.exit(1);
    }
}

const spacetimeConfig = readSpacetimeJson();

// ─── Achievement seeding (D-27) ──────────────────────────────────────────────

async function seedAchievements(connection: DbConnection): Promise<void> {
    // Subscribe so we can read back auto-generated IDs from the cache
    connection.subscriptionBuilder().subscribeToAllTables();
    await new Promise(res => setTimeout(res, 2000));

    // Helper: create achievement then poll subscription cache for the row by name
    const waitForId = (name: string, timeoutMs = 5000): Promise<number> =>
        new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                const row = [...connection.db.Achievement.iter()].find(a => a.name === name);
                if (row) return resolve(row.id);
                if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout waiting for achievement "${name}" ID`));
                setTimeout(check, 200);
            };
            check();
        });

    // 1. "MMR Elite" — auto-award, unlimited awards
    // Criteria: MmrRating.globalCompositeRating >= 1500
    try {
        await connection.reducers.createAchievement({
            name: 'MMR Elite',
            description: 'Reach a global composite MMR rating of 1500 or higher.',
            rarity: { tag: 'Epic' },
            isManualOnly: false,
            maxAwards: undefined,
        });
        const mmrEliteId = await waitForId('MMR Elite');
        await connection.reducers.addAchievementCriteria({
            achievementId: mmrEliteId,
            statTable: 'MmrRating',
            statField: 'globalCompositeRating',
            operator: { tag: 'GreaterOrEqual' },
            thresholdValue: 1500,
            filterGameMode: undefined,
            filterCharacterName: undefined,
            filterMatchType: undefined,
        });
        console.log('[bootstrap] Created "MMR Elite" with criteria');
    } catch (err) {
        console.error('[bootstrap] Failed to seed MMR Elite:', err);
    }

    // 2. "Veteran" — auto-award, unlimited awards
    // Criteria: PlayerStat.wins >= 10 (summed across all modes)
    // Note: the actual field name in PlayerStat is 'wins' (not 'matchesWon' per D-27 draft)
    try {
        await connection.reducers.createAchievement({
            name: 'Veteran',
            description: 'Win 10 or more matches across all game modes.',
            rarity: { tag: 'Rare' },
            isManualOnly: false,
            maxAwards: undefined,
        });
        const veteranId = await waitForId('Veteran');
        await connection.reducers.addAchievementCriteria({
            achievementId: veteranId,
            statTable: 'PlayerStat',
            statField: 'wins',
            operator: { tag: 'GreaterOrEqual' },
            thresholdValue: 10,
            filterGameMode: undefined,
            filterCharacterName: undefined,
            filterMatchType: undefined,
        });
        console.log('[bootstrap] Created "Veteran" with criteria');
    } catch (err) {
        console.error('[bootstrap] Failed to seed Veteran:', err);
    }

    // 3. "Solar First Tournament Winner" — manual-only, globally unique (maxAwards=1)
    // No criteria rows — isManualOnly achievements are never auto-awarded
    try {
        await connection.reducers.createAchievement({
            name: 'Solar First Tournament Winner',
            description: 'Champion of the inaugural Solar First tournament. Manually awarded by tournament organizers.',
            rarity: { tag: 'Legendary' },
            isManualOnly: true,
            maxAwards: 1,
        });
        console.log('[bootstrap] Created "Solar First Tournament Winner" (manual-only, maxAwards=1)');
    } catch (err) {
        console.error('[bootstrap] Failed to seed Solar First Tournament Winner:', err);
    }

}

// ─── Main bootstrap ────────────────────────────────────────────────────────────

let host = process.env.SPACETIMEDB_HOST ?? process.env.NEXT_PUBLIC_SPACETIMEDB_HOST ?? 'wss://maincloud.spacetimedb.com';
if (host.startsWith('https://')) host = host.replace('https://', 'wss://');
else if (host.startsWith('http://')) host = host.replace('http://', 'ws://');

const dbName = spacetimeConfig.database;

console.log(`[bootstrap] Connecting to ${host} / ${dbName} ...`);
console.log('[bootstrap] Step 1/7: registering server identity');

const _conn = DbConnection.builder()
    .withUri(host)
    .withDatabaseName(dbName)
    .withConfirmedReads(false)
    // No token — get a fresh identity on a clean database
    .onConnect(async (connection, identity, token) => {
        console.log(`[bootstrap] Connected with identity: ${identity.toHexString()}`);

        // Step 1: Register server identity
        try {
            await connection.reducers.registerServer({});
            console.log('[bootstrap] register_server: success');
        } catch (err) {
            console.error('[bootstrap] register_server failed:', err);
            process.exit(1);
        }

        // Step 2: Write token to .env.local
        console.log('[bootstrap] Step 2/7: writing token to .env.local');
        writeTokenToEnvLocal(token);
        // Also set in current process env so seedAll() can use the right host/db
        process.env.SPACETIMEDB_SERVER_TOKEN = token;

        // Small delay to let register_server commit propagate
        await new Promise(res => setTimeout(res, 1000));

        // Step 3: Seed all game data tables
        console.log('\n[bootstrap] Step 3/7: seeding game data tables');
        try {
            await seedAll(token);
        } catch (err) {
            console.error('[bootstrap] Seed failed:', err);
            console.log('\n[bootstrap] Token was written to .env.local. Run seed-data.ts manually to retry seeding.');
            process.exit(1);
        }

        // Step 4: Seed starter achievements (D-27)
        console.log('\n[bootstrap] Step 4/7: seeding starter achievements');
        await seedAchievements(connection);

        // Step 5: Seed config tables (EloConfig, AccountRatingConfig)
        console.log('\n[bootstrap] Step 5/7: seeding config tables');
        try {
            await connection.reducers.adminSeedEloConfig({});
            console.log('[bootstrap] EloConfig seeded with defaults');
        } catch (err: any) {
            console.log('[bootstrap] EloConfig:', err.message || 'already exists');
        }
        try {
            await connection.reducers.adminSeedRatingConfig({});
            console.log('[bootstrap] AccountRatingConfig seeded with defaults');
        } catch (err: any) {
            console.log('[bootstrap] AccountRatingConfig:', err.message || 'already exists');
        }

        // Step 6: Seed identity GC scheduled job
        console.log('\n[bootstrap] Step 6/7: seeding identity GC job');
        try {
            await connection.reducers.seedIdentityGcJob({});
            console.log('[bootstrap] IdentityGcJob seeded -- first run in 7 days');
        } catch (err: any) {
            console.log('[bootstrap] IdentityGcJob:', err.message || 'already exists');
        }

        // Step 7: Seed lobby GC scheduled job (retroactive fix -- Phase 09 required manual seeding)
        console.log('\n[bootstrap] Step 7/7: seeding lobby GC job');
        try {
            await connection.reducers.seedLobbyGcJob({});
            console.log('[bootstrap] LobbyGcJob seeded -- first run in 15 minutes');
        } catch (err: any) {
            console.log('[bootstrap] LobbyGcJob:', err.message || 'already exists');
        }

        console.log('\n[bootstrap] Bootstrap complete!');
        console.log('Restart your Next.js dev server to pick up the new SPACETIMEDB_SERVER_TOKEN.');
        process.exit(0);
    })
    .onConnectError((_ctx, err) => {
        console.error('[bootstrap] Connection failed:', err);
        process.exit(1);
    })
    .build();
