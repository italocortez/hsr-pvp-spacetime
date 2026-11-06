/**
 * Post-clear-database seed script. Reads combined-format JSON from test/data/,
 * transforms to match admin_bulk_upsert expectations, and seeds all game data tables.
 *
 * Mimics what the frontend admin panel does: receive combined JSON, split into
 * table-specific payloads, call admin_bulk_upsert for each table.
 *
 * Phase 15 D-22 canonical shape: snake_case keys, `cost` wrapper with
 * `cost_set_id` + 3-mode blocks (memory_of_chaos / apocalyptic_shadow /
 * anomaly_arbitration), Spine + positioning passthrough on characters.
 *
 * Run after bootstrap.ts: npx tsx test/shared/seed-data.ts
 */
import { DbConnection } from '../../src/module_bindings';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'node:url';

// Guard: this is a CLI script, never import it.
// Side-effects (file reads, DbConnection, reducer calls, process.exit) run at module
// top level; importing this file would execute all of them.
if (import.meta.url !== pathToFileURL(process.argv[1] || '').href) {
    throw new Error('test/shared/seed-data.ts is a CLI entry point — do not import');
}

const envPath = path.resolve(import.meta.dirname || '.', '../../.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const token = envContent.match(/SPACETIMEDB_SERVER_TOKEN=(.+)/)?.[1]?.trim() || '';
const uri = envContent.match(/SPACETIMEDB_URI=(.+)/)?.[1]?.trim() || 'wss://maincloud.spacetimedb.com';
const db = envContent.match(/SPACETIMEDB_DB=(.+)/)?.[1]?.trim() || 'hsrpvp-spacetimedb-nextjs-test1';

if (!token) {
  console.error('ERROR: SPACETIMEDB_SERVER_TOKEN not found in .env.local');
  process.exit(1);
}

const dataDir = path.resolve(import.meta.dirname || '.', '../data');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── Sub-block extractors (Phase 15.4 D-14: no zero-pad; absent = no row) ──

type EidolonSubBlock = { E0?: number; E1?: number; E2?: number; E3?: number; E4?: number; E5?: number; E6?: number };
type SuperpositionSubBlock = { S1?: number; S2?: number; S3?: number; S4?: number; S5?: number };
type PairingSubBlock = { modifier: number };
type RawPairingModeBlock = { classic?: PairingSubBlock; auction?: PairingSubBlock };

function extractEidolonCost(block: EidolonSubBlock | undefined) {
  if (!block || typeof block !== 'object') return undefined;
  return {
    e0: block.E0 ?? 0, e1: block.E1 ?? 0, e2: block.E2 ?? 0,
    e3: block.E3 ?? 0, e4: block.E4 ?? 0, e5: block.E5 ?? 0, e6: block.E6 ?? 0,
  };
}

function extractSuperpositionCost(block: SuperpositionSubBlock | undefined) {
  if (!block || typeof block !== 'object') return undefined;
  return {
    s1: block.S1 ?? 0, s2: block.S2 ?? 0, s3: block.S3 ?? 0, s4: block.S4 ?? 0, s5: block.S5 ?? 0,
  };
}

// Game mode mapping: snake_case JSON keys → enum variant names (D-22)
const GAME_MODE_MAP: Record<string, 'MemoryOfChaos' | 'ApocalypticShadow' | 'AnomalyArbitration'> = {
  memory_of_chaos: 'MemoryOfChaos',
  apocalyptic_shadow: 'ApocalypticShadow',
  anomaly_arbitration: 'AnomalyArbitration',
};

function snakeToPascalMode(k: string): 'MemoryOfChaos' | 'ApocalypticShadow' | 'AnomalyArbitration' | undefined {
  return GAME_MODE_MAP[k];
}

// ── Raw types (D-22 canonical shape, mirrored from scripts/seed-data.ts) ──

type RawPositioning = { x?: number; y?: number; width?: number };

type RawCharacter = {
  name: string;
  display_name: string;
  aliases?: string[];
  rarity: number;
  path: string;
  element: string;
  role: string;
  archetype?: string[];
  version_released?: number;
  treat_as_version?: number;
  image_url?: string;
  skel_url?: string;
  atlas_url?: string;
  atlas_img_url?: string[];
  positioning?: RawPositioning;
  cost?: {
    cost_set_id: number;
    [mode: string]: { classic?: EidolonSubBlock; auction?: EidolonSubBlock } | number | undefined;
  };
};

type RawLightcone = {
  name: string;
  display_name: string;
  aliases?: string[];
  path: string;
  rarity: number;
  image_url?: string;
  positioning?: RawPositioning;
  cost?: {
    cost_set_id: number;
    [mode: string]: { classic?: SuperpositionSubBlock; auction?: SuperpositionSubBlock } | number | undefined;
  };
};

type RawPairing = {
  source_name: string;
  target_name: string;
  cost?: {
    cost_set_id: number;
    [mode: string]: RawPairingModeBlock | number | undefined;
  };
};

// ── Transform characters (combined → HsrCharacter + HsrCharacterCost) ──

const rawChars: RawCharacter[] = JSON.parse(fs.readFileSync(path.join(dataDir, 'characters_table.json'), 'utf8'));

const chars = rawChars.map((c: RawCharacter) => ({
  name: c.name,
  displayName: c.display_name,
  aliases: c.aliases || [],
  rarity: c.rarity,
  path: cap(c.path),
  element: cap(c.element),
  role: cap(c.role),
  imageUrl: c.image_url || '',
  versionReleased: c.version_released ?? 0,
  treatAsVersion: c.treat_as_version ?? 0,
  skelUrl: c.skel_url && c.skel_url.length > 0 ? c.skel_url : null,
  atlasUrl: c.atlas_url && c.atlas_url.length > 0 ? c.atlas_url : null,
  atlasImgUrls: c.atlas_img_url ?? [],
  posX: c.positioning?.x ?? 0,
  posY: c.positioning?.y ?? 0,
  width: c.positioning?.width ?? 0,
}));

// Extract unique archetype names from JSON (D-35)
const archetypeNames = [...new Set(rawChars.flatMap((c: RawCharacter) => c.archetype || []))].sort() as string[];
const archetypes = archetypeNames.map((name: string) => ({ name, description: '' }));

// Phase 15.4 D-14: one row per present sub-block (classic/auction); absent = no row.
const charCosts: any[] = [];
for (const c of rawChars) {
  if (!c.cost) continue;
  const csId = c.cost.cost_set_id ?? 0;
  const modes = Object.keys(c.cost).filter(k => k !== 'cost_set_id');
  for (const rawMode of modes) {
    const modeBlock = c.cost[rawMode] as { classic?: EidolonSubBlock; auction?: EidolonSubBlock } | undefined;
    if (!modeBlock || typeof modeBlock !== 'object') continue;

    const classicCosts = extractEidolonCost(modeBlock.classic);
    const auctionCosts = extractEidolonCost(modeBlock.auction);

    // D-14: both sub-blocks absent → skip mode.
    if (!classicCosts && !auctionCosts) continue;

    const gm = snakeToPascalMode(rawMode);
    if (!gm) {
      console.warn(`[seed] unknown game mode for character ${c.name}: ${rawMode}`);
      continue;
    }

    // D-14: one row per present sub-block. Absent sub-block → no row for that draftMode.
    if (classicCosts) {
      charCosts.push({
        characterName: c.name, gameMode: gm,
        draftMode: 'Classic', costs: classicCosts,
        costSetId: csId,
      });
    }
    if (auctionCosts) {
      charCosts.push({
        characterName: c.name, gameMode: gm,
        draftMode: 'Auction', costs: auctionCosts,
        costSetId: csId,
      });
    }
  }
}

// ── Transform lightcones (combined → HsrLightcone + HsrLightconeCost) ──

const rawLCs: RawLightcone[] = JSON.parse(fs.readFileSync(path.join(dataDir, 'lightcones_table.json'), 'utf8'));

const lightcones = rawLCs.map((lc: RawLightcone) => ({
  name: lc.name,
  displayName: lc.display_name,
  aliases: lc.aliases || [],
  path: cap(lc.path),
  rarity: lc.rarity,
  imageUrl: lc.image_url || '',
  posX: lc.positioning?.x ?? 0,
  posY: lc.positioning?.y ?? 0,
  width: lc.positioning?.width ?? 0,
}));

// Phase 15.4 D-14: one row per present sub-block (classic/auction); absent = no row.
const lcCosts: any[] = [];
for (const lc of rawLCs) {
  if (!lc.cost) continue;
  const csId = lc.cost.cost_set_id ?? 0;
  const modes = Object.keys(lc.cost).filter(k => k !== 'cost_set_id');
  for (const rawMode of modes) {
    const modeBlock = lc.cost[rawMode] as { classic?: SuperpositionSubBlock; auction?: SuperpositionSubBlock } | undefined;
    if (!modeBlock || typeof modeBlock !== 'object') continue;

    const classicCosts = extractSuperpositionCost(modeBlock.classic);
    const auctionCosts = extractSuperpositionCost(modeBlock.auction);

    // D-14: both sub-blocks absent → skip mode.
    if (!classicCosts && !auctionCosts) continue;

    const gm = snakeToPascalMode(rawMode);
    if (!gm) {
      console.warn(`[seed] unknown game mode for lightcone ${lc.name}: ${rawMode}`);
      continue;
    }

    // D-14: one row per present sub-block. Absent sub-block → no row for that draftMode.
    if (classicCosts) {
      lcCosts.push({
        lightconeName: lc.name, gameMode: gm,
        draftMode: 'Classic', costs: classicCosts,
        costSetId: csId,
      });
    }
    if (auctionCosts) {
      lcCosts.push({
        lightconeName: lc.name, gameMode: gm,
        draftMode: 'Auction', costs: auctionCosts,
        costSetId: csId,
      });
    }
  }
}

// ── Transform pairings (combined → HsrSynergyCost) ──

const pairingPath = path.join(dataDir, 'pairing_table.json');
const rawPairings: RawPairing[] = fs.existsSync(pairingPath)
  ? JSON.parse(fs.readFileSync(pairingPath, 'utf8'))
  : [];

// Phase 15.4 D-12 / D-14: sibling-block pairing input, one row per present sub-block.
const synergyCosts: any[] = [];
for (const p of rawPairings) {
  if (!p.cost) continue;
  const csId = p.cost.cost_set_id ?? 0;
  const modes = Object.keys(p.cost).filter(k => k !== 'cost_set_id');
  for (const rawMode of modes) {
    const modeBlock = p.cost[rawMode] as RawPairingModeBlock | undefined;
    if (!modeBlock || typeof modeBlock !== 'object') continue;
    const gm = snakeToPascalMode(rawMode);
    if (!gm) {
      console.warn(`[seed] unknown game mode for pairing ${p.source_name}->${p.target_name}: ${rawMode}`);
      continue;
    }

    if (modeBlock.classic !== undefined) {
      synergyCosts.push({
        sourceName: p.source_name,
        targetName: p.target_name,
        gameMode: gm,
        draftMode: 'Classic',
        costModifier: Number(modeBlock.classic.modifier),
        costSetId: csId,
      });
    }
    if (modeBlock.auction !== undefined) {
      synergyCosts.push({
        sourceName: p.source_name,
        targetName: p.target_name,
        gameMode: gm,
        draftMode: 'Auction',
        costModifier: Number(modeBlock.auction.modifier),
        costSetId: csId,
      });
    }
  }
}

// ── Seed ──

const tables: [string, string, any[]][] = [
  ['HsrCharacter', 'characters', chars],
  ['HsrLightcone', 'lightcones', lightcones],
  ['HsrCharacterCost', 'character costs', charCosts],
  ['HsrLightconeCost', 'lightcone costs', lcCosts],
  ['HsrSynergyCost', 'synergy costs', synergyCosts],
  ['Archetype', 'archetypes', archetypes],
];

console.log(`Seeding ${db}:`);
for (const [, label, rows] of tables) console.log(`  ${rows.length} ${label}`);

DbConnection.builder()
  .withUri(uri)
  .withDatabaseName(db)
  .withToken(token)
  .withConfirmedReads(false)
  .onConnect(async (conn) => {
    const BATCH = 20;
    for (const [tableName, label, rows] of tables) {
      if (rows.length === 0) { console.log(`  Skipping ${label} (empty)`); continue; }
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        console.log(`  ${tableName} batch ${Math.floor(i / BATCH) + 1}: ${chunk.length} rows...`);
        conn.reducers.adminBulkUpsert({ tableName, jsonData: JSON.stringify(chunk) });
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // Archetype junction seeding (D-07): subscribe to resolve name→id
    const assignments = rawChars
      .filter((c: RawCharacter) => c.archetype && c.archetype.length > 0)
      .map((c: RawCharacter) => ({ characterName: c.name, archetypeNames: c.archetype as string[] }));

    if (assignments.length > 0) {
      console.log(`  Waiting 3s for Archetype IDs to settle...`);
      await new Promise(r => setTimeout(r, 3000));

      // Subscribe to Archetype table to get IDs
      conn.subscriptionBuilder()
        .onApplied(async () => {
          const archetypeMap = new Map<string, number>();
          for (const row of conn.db.Archetype.iter()) {
            archetypeMap.set(row.name, row.id);
          }
          console.log(`  Resolved ${archetypeMap.size} archetype IDs, seeding junctions...`);

          for (const { characterName, archetypeNames } of assignments) {
            const ids = archetypeNames
              .map((n: string) => archetypeMap.get(n))
              .filter((id: number | undefined): id is number => id !== undefined);
            if (ids.length > 0) {
              conn.reducers.adminAssignCharacterArchetypes({
                characterName,
                archetypeIdsJson: JSON.stringify(ids),
              });
              await new Promise(r => setTimeout(r, 100));
            }
          }
          console.log(`  Archetype assignments complete (${assignments.length} characters).`);
          console.log('Seed complete.');
          conn.disconnect();
          process.exit(0);
        })
        .subscribe('SELECT * FROM archetype');
    } else {
      console.log('Seed complete.');
      conn.disconnect();
      process.exit(0);
    }
  })
  .onConnectError((_ctx: any, err: any) => {
    console.error('Connection failed:', err);
    process.exit(1);
  })
  .onDisconnect(() => {})
  .build();
