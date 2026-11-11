/**
 * T-S10 batch C2: the seed normalizer round-trip, as a unit test (orchestrator ruling; replaces the read side of the
 * live test/backend/seed/round-trip.test.ts). Runs scripts/stdb/seed-normalizers.ts over the committed public seed
 * data (data/seed/*.json, A18) and asserts the shapes and counts the live test asserted after bootstrap: the D-22
 * 3-mode fan-out, Phase 15.4 D-14 (one row per present sub-block, draftMode in {Classic, Auction}), D-01 / D-02 (the
 * `costs` structs), D-13 / D-25 (synergy Classic + Auction rows), A21 (canonical pair order), A17 (positioning columns,
 * no Spine keys). The write side (admin_bulk_upsert storing these rows) is spacetimedb/src/__tests__/seed/seed-rows.test.ts.
 * Pure: reads files, connects nowhere.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    canonicalPair,
    extractArchetypeAssignments,
    extractArchetypeNames,
    normalizeCharacterCosts,
    normalizeCharacters,
    normalizeLightconeCosts,
    normalizeLightcones,
    normalizePairings,
    toPascalCase,
    type RawCharacter,
    type RawLightcone,
    type RawPairing,
} from '../../../scripts/stdb/seed-normalizers';

const load = <T>(file: string): T[] =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../../../data/seed/${file}`, import.meta.url)), 'utf-8')) as T[];

const characters = load<RawCharacter>('characters.json');
const lightcones = load<RawLightcone>('lightcones.json');
const pairings = load<RawPairing>('synergies.json');

const GAME_MODES = ['AnomalyArbitration', 'ApocalypticShadow', 'MemoryOfChaos'];
const DRAFT_MODES = ['Auction', 'Classic'];
const PATHS = ['Abundance', 'Destruction', 'Erudition', 'Harmony', 'Hunt', 'Nihility', 'Preservation', 'Remembrance', 'Elation'];
const ELEMENTS = ['Fire', 'Ice', 'Imaginary', 'Lightning', 'Physical', 'Quantum', 'Wind'];
const ROLES = ['Dps', 'Sustain', 'Support'];
// The admin_bulk_upsert EXPECTED_KEYS of each table (spacetimedb/src/tables/roster/*: columns minus audit / auto-inc id).
const KEYS = {
    HsrCharacter: ['aliases', 'displayName', 'element', 'imageUrl', 'name', 'path', 'posX', 'posY', 'rarity', 'role', 'treatAsVersion', 'versionReleased', 'width'],
    HsrLightcone: ['aliases', 'displayName', 'imageUrl', 'name', 'path', 'posX', 'posY', 'rarity', 'width'],
    HsrCharacterCost: ['characterName', 'costSetId', 'costs', 'draftMode', 'gameMode'],
    HsrLightconeCost: ['costSetId', 'costs', 'draftMode', 'gameMode', 'lightconeName'],
    HsrSynergyCost: ['characterA', 'characterB', 'costModifier', 'costSetId', 'draftMode', 'gameMode'],
};

type Row = Record<string, any>;
const keysOf = (r: object) => Object.keys(r).sort();
const distinct = (xs: unknown[]) => [...new Set(xs)].sort();
/** Present sub-blocks in a raw `cost` object (the number of rows D-14 says to emit). */
function presentSubBlocks(cost: Record<string, any> | undefined): number {
    if (!cost) return 0;
    let n = 0;
    for (const [mode, block] of Object.entries(cost)) {
        if (mode === 'cost_set_id' || !block || typeof block !== 'object') continue;
        if (block.classic !== undefined) n++;
        if (block.auction !== undefined) n++;
    }
    return n;
}

describe('seed normalizer round-trip over data/seed (A18, D-22, Phase 15.4)', () => {
    it('characters: one HsrCharacter row per entry with exactly the upsert keys, valid enum tags and the A17 positioning columns', () => {
        const rows = normalizeCharacters(characters) as Row[];
        expect(rows.length).toBe(characters.length);
        expect(rows.length).toBeGreaterThan(0);
        expect(distinct(rows.map((r) => r.name))).toHaveLength(rows.length);
        for (const r of rows) {
            expect(keysOf(r)).toEqual(KEYS.HsrCharacter);
            expect(PATHS).toContain(r.path);
            expect(ELEMENTS).toContain(r.element);
            expect(ROLES).toContain(r.role);
            for (const k of ['posX', 'posY', 'width', 'rarity', 'versionReleased', 'treatAsVersion']) expect(Number.isFinite(r[k])).toBe(true);
        }
    });

    it('HsrCharacterCost (D-14, D-01): one row per present sub-block, draftMode in {Classic, Auction}, all 3 game modes, cost set 0, e0..e6 numbers, unique keys', () => {
        const rows = normalizeCharacterCosts(characters) as Row[];
        expect(rows.length).toBe(characters.reduce((n, c) => n + presentSubBlocks(c.cost as any), 0));
        expect(distinct(rows.map((r) => r.gameMode))).toEqual(GAME_MODES);
        expect(DRAFT_MODES).toEqual(expect.arrayContaining(distinct(rows.map((r) => r.draftMode))));
        expect(rows.some((r) => r.draftMode === 'Classic')).toBe(true);
        expect(rows.some((r) => r.costSetId === 0)).toBe(true);
        for (const r of rows) {
            expect(keysOf(r)).toEqual(KEYS.HsrCharacterCost);
            expect(keysOf(r.costs)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
            expect(Object.values(r.costs).every((v) => Number.isFinite(v))).toBe(true);
        }
        const tuples = rows.map((r) => `${r.characterName}|${r.gameMode}|${r.draftMode}|${r.costSetId}`);
        expect(distinct(tuples)).toHaveLength(rows.length);
    });

    it('light cones (D-14, D-02): one HsrLightcone row per entry; HsrLightconeCost one row per present sub-block with s1..s5 numbers in all 3 game modes', () => {
        const lcRows = normalizeLightcones(lightcones) as Row[];
        expect(lcRows.length).toBe(lightcones.length);
        for (const r of lcRows) {
            expect(keysOf(r)).toEqual(KEYS.HsrLightcone);
            expect(PATHS).toContain(r.path);
        }
        const rows = normalizeLightconeCosts(lightcones) as Row[];
        expect(rows.length).toBe(lightcones.reduce((n, lc) => n + presentSubBlocks(lc.cost as any), 0));
        expect(distinct(rows.map((r) => r.gameMode))).toEqual(GAME_MODES);
        expect(rows.some((r) => r.costSetId === 0)).toBe(true);
        for (const r of rows) {
            expect(keysOf(r)).toEqual(KEYS.HsrLightconeCost);
            expect(DRAFT_MODES).toContain(r.draftMode);
            expect(keysOf(r.costs)).toEqual(['s1', 's2', 's3', 's4', 's5']);
            expect(Object.values(r.costs).every((v) => Number.isFinite(v))).toBe(true);
        }
    });

    it('HsrSynergyCost (D-13, D-25, A21): both Classic and Auction rows, numeric modifiers, canonical pair order, 3 game modes; swapping source and target changes nothing', () => {
        const rows = normalizePairings(pairings) as Row[];
        expect(rows.length).toBe(pairings.reduce((n, p) => n + presentSubBlocks(p.cost as any), 0));
        expect(distinct(rows.map((r) => r.draftMode))).toEqual(DRAFT_MODES);
        expect(distinct(rows.map((r) => r.gameMode))).toEqual(GAME_MODES);
        for (const r of rows) {
            expect(keysOf(r)).toEqual(KEYS.HsrSynergyCost);
            expect(r.characterA <= r.characterB).toBe(true);
            expect(Number.isFinite(r.costModifier)).toBe(true);
        }
        const swapped = pairings.map((p) => ({ ...p, source_name: p.target_name, target_name: p.source_name }));
        expect(normalizePairings(swapped)).toEqual(rows);
        expect(canonicalPair('kafka', 'acheron')).toEqual(['acheron', 'kafka']);
    });

    it('normalize → re-normalize is idempotent: the same input gives the same rows, a JSON round-trip (the reducer payload) preserves them, and enum tags re-normalize to themselves', () => {
        const runs = () => ({
            characters: normalizeCharacters(characters),
            characterCosts: normalizeCharacterCosts(characters),
            lightcones: normalizeLightcones(lightcones),
            lightconeCosts: normalizeLightconeCosts(lightcones),
            pairings: normalizePairings(pairings),
        });
        const first = runs();
        expect(runs()).toEqual(first);
        expect(JSON.parse(JSON.stringify(first))).toEqual(first);
        for (const r of first.characters as Row[]) {
            for (const k of ['path', 'element', 'role']) expect(toPascalCase(r[k])).toBe(r[k]);
        }
        expect(toPascalCase('nihility')).toBe('Nihility');
    });

    it('archetypes (D-07): the names are sorted and unique, and every assignment names a listed archetype', () => {
        const names = extractArchetypeNames(characters);
        expect(names.length).toBeGreaterThan(0);
        expect(names).toEqual(distinct(names));
        const assignments = extractArchetypeAssignments(characters);
        expect(assignments.length).toBe(characters.filter((c) => (c.archetype ?? []).length > 0).length);
        for (const a of assignments) for (const n of a.archetypeNames) expect(names).toContain(n);
    });
});
