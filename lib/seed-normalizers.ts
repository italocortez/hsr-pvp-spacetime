/**
 * Pure data-shape normalizers for the D-22 canonical seed format
 * (test/data/{characters,lightcones,pairing}_table.json).
 *
 * Shared between scripts/seed-data.ts (CLI bootstrap after `--clear-database`
 * publish) and components/features/admin-view/components/BulkUpsert.tsx
 * (admin UI bulk-upsert flow that auto-splits a fat character / lightcone /
 * pairing payload into multi-table reducer calls).
 *
 * No Node-specific APIs — runs in browser and CLI.
 */

// Capitalize first letter only (e.g. "nihility" → "Nihility", "dps" → "Dps")
export function toPascalCase(s: string): string {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Game mode mapping: snake_case JSON keys → enum variant names (D-22)
export const GAME_MODE_MAP: Record<string, 'MemoryOfChaos' | 'ApocalypticShadow' | 'AnomalyArbitration'> = {
    memory_of_chaos: 'MemoryOfChaos',
    apocalyptic_shadow: 'ApocalypticShadow',
    anomaly_arbitration: 'AnomalyArbitration',
};

export function snakeToPascalMode(k: string): 'MemoryOfChaos' | 'ApocalypticShadow' | 'AnomalyArbitration' | undefined {
    return GAME_MODE_MAP[k];
}

// ─── Raw types (D-22 canonical shape, D-01 sibling-block shape) ───────────────

export type EidolonSubBlock = { E0?: number; E1?: number; E2?: number; E3?: number; E4?: number; E5?: number; E6?: number };
export type RawModeEidolonBlock = { classic?: EidolonSubBlock; auction?: EidolonSubBlock };

export type SuperpositionSubBlock = { S1?: number; S2?: number; S3?: number; S4?: number; S5?: number };
export type RawModeSuperpositionBlock = { classic?: SuperpositionSubBlock; auction?: SuperpositionSubBlock };

export type RawCharacterCost = {
    cost_set_id: number;
    [mode: string]: RawModeEidolonBlock | number | undefined;
};

export type RawLightconeCost = {
    cost_set_id: number;
    [mode: string]: RawModeSuperpositionBlock | number | undefined;
};

export type RawPairingModeBlock = { classic?: { modifier: number }; auction?: { modifier: number } };

export type RawPairingCost = {
    cost_set_id: number;
    [mode: string]: RawPairingModeBlock | number | undefined;
};

export type RawPositioning = { x?: number; y?: number; width?: number };

export type RawCharacter = {
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
    cost?: RawCharacterCost;
};

export type RawLightcone = {
    name: string;
    display_name: string;
    aliases?: string[];
    path: string;
    rarity: number;
    image_url?: string;
    positioning?: RawPositioning;
    cost?: RawLightconeCost;
};

export type RawPairing = {
    source_name: string;
    target_name: string;
    cost?: RawPairingCost;
};

// ─── Fat-shape detection (used by BulkUpsert auto-detect) ─────────────────────

/** A character row is "fat" (D-22 canonical) if it carries archetype, cost, or positioning. */
export function isFatCharacter(row: any): boolean {
    if (!row || typeof row !== 'object') return false;
    return 'archetype' in row || 'cost' in row || 'positioning' in row;
}

/** A lightcone row is "fat" if it carries cost or positioning. */
export function isFatLightcone(row: any): boolean {
    if (!row || typeof row !== 'object') return false;
    return 'cost' in row || 'positioning' in row;
}

/** A pairing row is "fat" if it carries the nested cost block (vs flat costModifier). */
export function isFatPairing(row: any): boolean {
    if (!row || typeof row !== 'object') return false;
    return 'cost' in row;
}

// ─── Normalizers (D-22 snake_case → camelCase row for admin_bulk_upsert) ─────

/** Normalize characters_table.json → HsrCharacter rows */
export function normalizeCharacters(raw: RawCharacter[]): object[] {
    return raw.map(c => ({
        name: c.name,
        displayName: c.display_name,
        aliases: c.aliases ?? [],
        rarity: c.rarity,
        path: toPascalCase(c.path),
        element: toPascalCase(c.element),
        role: toPascalCase(c.role),
        imageUrl: c.image_url ?? '',
        versionReleased: c.version_released ?? 0,
        treatAsVersion: c.treat_as_version ?? 0,
        skelUrl: c.skel_url && c.skel_url.length > 0 ? c.skel_url : null,
        atlasUrl: c.atlas_url && c.atlas_url.length > 0 ? c.atlas_url : null,
        atlasImgUrls: c.atlas_img_url ?? [],
        posX: c.positioning?.x ?? 0,
        posY: c.positioning?.y ?? 0,
        width: c.positioning?.width ?? 0,
    }));
}

/** Extract unique archetype names from characters_table.json */
export function extractArchetypeNames(raw: RawCharacter[]): string[] {
    const names = new Set<string>();
    for (const c of raw) {
        if (c.archetype) {
            for (const a of c.archetype) names.add(a);
        }
    }
    return [...names].sort();
}

/** Build character-to-archetype assignment map from JSON */
export function extractArchetypeAssignments(raw: RawCharacter[]): Array<{ characterName: string; archetypeNames: string[] }> {
    return raw
        .filter(c => c.archetype && c.archetype.length > 0)
        .map(c => ({ characterName: c.name, archetypeNames: c.archetype! }));
}

// ─── Sub-block extractors (Phase 15.4 D-14: no zero-pad; absent = no row) ────

export function extractEidolonCost(block: EidolonSubBlock | undefined) {
    if (!block || typeof block !== 'object') return undefined;
    return {
        e0: block.E0 ?? 0,
        e1: block.E1 ?? 0,
        e2: block.E2 ?? 0,
        e3: block.E3 ?? 0,
        e4: block.E4 ?? 0,
        e5: block.E5 ?? 0,
        e6: block.E6 ?? 0,
    };
}

export function extractSuperpositionCost(block: SuperpositionSubBlock | undefined) {
    if (!block || typeof block !== 'object') return undefined;
    return {
        s1: block.S1 ?? 0,
        s2: block.S2 ?? 0,
        s3: block.S3 ?? 0,
        s4: block.S4 ?? 0,
        s5: block.S5 ?? 0,
    };
}

/** Extract HsrCharacterCost rows (Phase 15.4 D-14: one row per present sub-block,
 *  no zero-pad fallback; `draftMode` discriminates Classic vs Auction). */
export function normalizeCharacterCosts(raw: RawCharacter[]): object[] {
    const rows: object[] = [];
    for (const c of raw) {
        if (!c.cost) continue;
        const csId = c.cost.cost_set_id ?? 0;
        const modes = Object.keys(c.cost).filter(k => k !== 'cost_set_id');
        for (const rawMode of modes) {
            const modeBlock = c.cost[rawMode] as RawModeEidolonBlock | undefined;
            if (!modeBlock || typeof modeBlock !== 'object') continue;

            const classicCosts = extractEidolonCost(modeBlock.classic);
            const auctionCosts = extractEidolonCost(modeBlock.auction);

            // D-14: both sub-blocks absent → skip the mode entirely.
            if (!classicCosts && !auctionCosts) continue;

            const gameMode = snakeToPascalMode(rawMode);
            if (!gameMode) continue;

            // D-14: one row per present sub-block. Absent sub-block → no row for that draftMode.
            if (classicCosts) {
                rows.push({
                    characterName: c.name,
                    gameMode,
                    draftMode: 'Classic',
                    costs: classicCosts,
                    costSetId: csId,
                });
            }
            if (auctionCosts) {
                rows.push({
                    characterName: c.name,
                    gameMode,
                    draftMode: 'Auction',
                    costs: auctionCosts,
                    costSetId: csId,
                });
            }
        }
    }
    return rows;
}

/** Normalize lightcones_table.json → HsrLightcone rows */
export function normalizeLightcones(raw: RawLightcone[]): object[] {
    return raw.map(lc => ({
        name: lc.name,
        displayName: lc.display_name,
        aliases: lc.aliases ?? [],
        path: toPascalCase(lc.path),
        rarity: lc.rarity,
        imageUrl: lc.image_url ?? '',
        posX: lc.positioning?.x ?? 0,
        posY: lc.positioning?.y ?? 0,
        width: lc.positioning?.width ?? 0,
    }));
}

/** Extract HsrLightconeCost rows (Phase 15.4 D-14: one row per present sub-block,
 *  no zero-pad fallback; `draftMode` discriminates Classic vs Auction). */
export function normalizeLightconeCosts(raw: RawLightcone[]): object[] {
    const rows: object[] = [];
    for (const lc of raw) {
        if (!lc.cost) continue;
        const csId = lc.cost.cost_set_id ?? 0;
        const modes = Object.keys(lc.cost).filter(k => k !== 'cost_set_id');
        for (const rawMode of modes) {
            const modeBlock = lc.cost[rawMode] as RawModeSuperpositionBlock | undefined;
            if (!modeBlock || typeof modeBlock !== 'object') continue;

            const classicCosts = extractSuperpositionCost(modeBlock.classic);
            const auctionCosts = extractSuperpositionCost(modeBlock.auction);

            // D-14: both sub-blocks absent → skip the mode entirely.
            if (!classicCosts && !auctionCosts) continue;

            const gameMode = snakeToPascalMode(rawMode);
            if (!gameMode) continue;

            // D-14: one row per present sub-block. Absent sub-block → no row for that draftMode.
            if (classicCosts) {
                rows.push({
                    lightconeName: lc.name,
                    gameMode,
                    draftMode: 'Classic',
                    costs: classicCosts,
                    costSetId: csId,
                });
            }
            if (auctionCosts) {
                rows.push({
                    lightconeName: lc.name,
                    gameMode,
                    draftMode: 'Auction',
                    costs: auctionCosts,
                    costSetId: csId,
                });
            }
        }
    }
    return rows;
}

/** Extract HsrSynergyCost rows from pairing_table.json (Phase 15.4 D-12 / D-14:
 *  sibling-block shape with classic + auction sub-blocks; one row per present sub-block). */
export function normalizePairings(raw: RawPairing[]): object[] {
    const rows: object[] = [];
    for (const p of raw) {
        if (!p.cost) continue;
        const csId = p.cost.cost_set_id ?? 0;
        const modes = Object.keys(p.cost).filter(k => k !== 'cost_set_id');
        for (const rawMode of modes) {
            const modeBlock = p.cost[rawMode] as RawPairingModeBlock | undefined;
            if (!modeBlock || typeof modeBlock !== 'object') continue;
            const gameMode = snakeToPascalMode(rawMode);
            if (!gameMode) continue;

            if (modeBlock.classic !== undefined) {
                rows.push({
                    sourceName: p.source_name,
                    targetName: p.target_name,
                    gameMode,
                    draftMode: 'Classic',
                    costModifier: Number(modeBlock.classic.modifier),
                    costSetId: csId,
                });
            }
            if (modeBlock.auction !== undefined) {
                rows.push({
                    sourceName: p.source_name,
                    targetName: p.target_name,
                    gameMode,
                    draftMode: 'Auction',
                    costModifier: Number(modeBlock.auction.modifier),
                    costSetId: csId,
                });
            }
        }
    }
    return rows;
}
