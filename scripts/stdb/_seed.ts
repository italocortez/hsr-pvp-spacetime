/**
 * Bootstrap step 5 (ACCESS-SECURITY-OPS §C.4), shared by bootstrap.ts and seed.ts.
 * Runs as the DELEGATE identity (linked to the SYSTEM admin user by server_register_delegate).
 *
 *   a. data/seed/{characters,lightcones,synergies}.json → admin_bulk_upsert (normalized by seed-normalizers.ts)
 *      + Archetype names and the character ↔ archetype junction rows
 *   b. data/seed/achievements.json → create_achievement + add_achievement_criteria (skipped by name if present)
 *   c. admin_seed_elo_config, admin_seed_rating_config (reject when already seeded → reported as "exists")
 *   d. seed_identity_gc_job, seed_lobby_gc_job (idempotent in the module)
 *
 * Subscribes only to `achievement` and `archetype` (to read back auto-increment ids), never to all tables.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DbConnection } from '../../web/src/module_bindings';
import { subscribeOnly, waitFor } from './_connection';
import { REPO_ROOT } from './_env';
import {
    extractArchetypeAssignments,
    newArchetypeRows,
    normalizeCharacterCosts,
    normalizeCharacters,
    normalizeLightconeCosts,
    normalizeLightcones,
    normalizePairings,
    type RawCharacter,
    type RawLightcone,
    type RawPairing,
} from './seed-normalizers';

const SEED_DIR = resolve(REPO_ROOT, 'data/seed');

type CreateAchievementArgs = Parameters<DbConnection['reducers']['createAchievement']>[0];
type AddCriteriaArgs = Parameters<DbConnection['reducers']['addAchievementCriteria']>[0];

/** data/seed/achievements.json: enums are `{ tag }` objects; `null` means absent. */
interface SeedAchievement {
    name: string;
    description: string;
    rarity: CreateAchievementArgs['rarity'];
    isManualOnly: boolean;
    maxAwards: number | null;
    criteria: Array<{
        statTable: string;
        statField: string;
        operator: AddCriteriaArgs['operator'];
        thresholdValue: number;
        filterGameMode: string | null;
        filterCharacterName: string | null;
        filterMatchType: string | null;
    }>;
}

function loadJson<T>(file: string): T[] {
    const path = resolve(SEED_DIR, file);
    if (!existsSync(path)) {
        console.warn(`[seed] ${file} not found in data/seed/ — skipping`);
        return [];
    }
    return JSON.parse(readFileSync(path, 'utf-8')) as T[];
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

async function seedGameData(conn: DbConnection): Promise<void> {
    const characters = loadJson<RawCharacter>('characters.json');
    const lightcones = loadJson<RawLightcone>('lightcones.json');
    const pairings = loadJson<RawPairing>('synergies.json');
    // S10f (roster audit #10): only new archetypes are sent (newArchetypeRows, seed-normalizers.ts; S11a L109).
    const existingArchetypes = [...conn.db.Archetype.iter()].map((r) => r.name);

    const payloads = [
        { tableName: 'HsrCharacter', rows: normalizeCharacters(characters) },
        { tableName: 'HsrLightcone', rows: normalizeLightcones(lightcones) },
        { tableName: 'HsrCharacterCost', rows: normalizeCharacterCosts(characters) },
        { tableName: 'HsrLightconeCost', rows: normalizeLightconeCosts(lightcones) },
        { tableName: 'HsrSynergyCost', rows: normalizePairings(pairings) },
        {
            tableName: 'Archetype',
            rows: newArchetypeRows(characters, existingArchetypes),
        },
    ].filter((p) => p.rows.length > 0);

    for (const { tableName, rows } of payloads) {
        await conn.reducers.adminBulkUpsert({ tableName, jsonData: JSON.stringify(rows) });
        console.log(`[seed] ${tableName}: ${rows.length} rows upserted`);
    }

    // Archetype junction rows (D-07): resolve names → ids from the subscribed archetype table.
    const assignments = extractArchetypeAssignments(characters);
    if (assignments.length === 0) return;
    const wanted = new Set(assignments.flatMap((a) => a.archetypeNames));
    await waitFor(() => {
        const have = new Set([...conn.db.Archetype.iter()].map((r) => r.name));
        return [...wanted].every((n) => have.has(n)) ? true : undefined;
    }, 'archetype ids');
    const idByName = new Map([...conn.db.Archetype.iter()].map((r) => [r.name, r.id] as const));
    for (const { characterName, archetypeNames } of assignments) {
        const ids = archetypeNames
            .map((n) => idByName.get(n))
            .filter((id): id is number => id !== undefined);
        if (ids.length > 0) {
            await conn.reducers.adminAssignCharacterArchetypes({
                characterName,
                archetypeIdsJson: JSON.stringify(ids),
            });
        }
    }
    console.log(`[seed] archetype assignments: ${assignments.length} characters`);
}

async function seedAchievements(conn: DbConnection): Promise<void> {
    for (const a of loadJson<SeedAchievement>('achievements.json')) {
        if ([...conn.db.Achievement.iter()].some((r) => r.name === a.name)) {
            console.log(`[seed] achievement "${a.name}": exists, skipped (criteria untouched)`);
            continue;
        }
        await conn.reducers.createAchievement({
            name: a.name,
            description: a.description,
            rarity: a.rarity,
            isManualOnly: a.isManualOnly,
            maxAwards: a.maxAwards ?? undefined,
        });
        const id = await waitFor(
            () => [...conn.db.Achievement.iter()].find((r) => r.name === a.name)?.id,
            `achievement "${a.name}" id`,
        );
        for (const c of a.criteria) {
            await conn.reducers.addAchievementCriteria({
                achievementId: id,
                statTable: c.statTable,
                statField: c.statField,
                operator: c.operator,
                thresholdValue: c.thresholdValue,
                filterGameMode: c.filterGameMode ?? undefined,
                filterCharacterName: c.filterCharacterName ?? undefined,
                filterMatchType: c.filterMatchType ?? undefined,
            });
        }
        console.log(`[seed] achievement "${a.name}": created with ${a.criteria.length} criteria`);
    }
}

/** Reducers that reject when their singleton exists: report "exists" instead of failing the run. */
async function seedSingleton(label: string, call: () => Promise<void>): Promise<void> {
    try {
        await call();
        console.log(`[seed] ${label}: seeded`);
    } catch (err) {
        const msg = errMessage(err);
        if (/already/i.test(msg)) {
            console.log(`[seed] ${label}: exists (${msg})`);
            return;
        }
        throw new Error(`${label}: ${msg}`);
    }
}

export async function seedAll(conn: DbConnection): Promise<void> {
    await subscribeOnly(conn, ['SELECT * FROM achievement', 'SELECT * FROM archetype'], 'seed');

    console.log('[seed] game data (data/seed/)');
    await seedGameData(conn);

    console.log('[seed] starter achievements');
    await seedAchievements(conn);

    console.log('[seed] config singletons and scheduled jobs');
    await seedSingleton('EloConfig', () => conn.reducers.adminSeedEloConfig({}));
    await seedSingleton('AccountRatingConfig', () => conn.reducers.adminSeedRatingConfig({}));
    await seedSingleton('IdentityGcJob', () => conn.reducers.seedIdentityGcJob({}));
    await seedSingleton('LobbyGcJob', () => conn.reducers.seedLobbyGcJob({}));
}
