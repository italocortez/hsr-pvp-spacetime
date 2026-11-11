// Seed: admin_bulk_upsert writes the seed rows; re-seed keeps archetype descriptions; data/seed prices every entry.
// Decisions: A108
// Contracts: docs/cost-sets/contract.md, docs/archetypes/contract.md
// From S10, S10f, S10i (s10-seed.test.ts, s10f-draft-results.test.ts, s10i-draft-cost.test.ts).
import { describe, expect, it } from 'vitest';
// T-S10i fix pass (review F2): newBareHarness, no set-0 coverage rows; these tests read the rows of set 0.
import { M, newBareHarness, type Harness, rejection } from '../fixtures/harness';
import { verified } from '../fixtures/identity';
import { seedCharacters } from '../fixtures/roster';
import { bulkUpsert } from '../fixtures/cost-sets';
import characterSeed from '../../../../data/seed/characters.json';
import lightconeSeed from '../../../../data/seed/lightcones.json';
import { newArchetypeRows, type RawCharacter } from '../../../../scripts/stdb/seed-normalizers';

// ─── Inline samples, shaped like normalizeCharacters / normalizeLightcones / normalize*Costs / normalizePairings ──

const character = (name: string, over: Record<string, unknown> = {}) => ({
    name, displayName: name.toUpperCase(), aliases: [name], rarity: 5, path: 'Nihility', element: 'Lightning', role: 'Dps',
    imageUrl: `https://img/${name}.png`, versionReleased: 2.1, treatAsVersion: 0, posX: -10, posY: 4, width: 120, ...over,
});
const lightcone = (name: string) => ({
    name, displayName: name, aliases: [name], path: 'Erudition', rarity: 4, imageUrl: '', posX: -48, posY: -32, width: 120,
});
const eidolons = (base: number) => ({ e0: base, e1: base + 1, e2: base + 3.5, e3: base + 4, e4: base + 5, e5: base + 6, e6: base + 8 });
const supers = (base: number) => ({ s1: base, s2: base + 0.5, s3: base + 1, s4: base + 1.5, s5: base + 2 });
const charCost = (characterName: string, draftMode: 'Classic' | 'Auction', base: number, costSetId = 0, gameMode = 'MemoryOfChaos') =>
    ({ characterName, gameMode, draftMode, costs: eidolons(base), costSetId });
const lcCost = (lightconeName: string, draftMode: 'Classic' | 'Auction', base: number, costSetId = 0, gameMode = 'MemoryOfChaos') =>
    ({ lightconeName, gameMode, draftMode, costs: supers(base), costSetId });
const pairing = (characterA: string, characterB: string, draftMode: 'Classic' | 'Auction', costModifier: number, gameMode = 'MemoryOfChaos') =>
    ({ characterA, characterB, gameMode, draftMode, costModifier, costSetId: 0 });

const charCosts = (test: Harness) =>
    [...test.db.HsrCharacterCost.iter()].map((r) => `${r.characterName}|${r.gameMode.tag}|${r.draftMode.tag}|${r.costSetId}`).sort();
const charCostRow = (test: Harness, name: string, draftMode: string, costSetId = 0) =>
    [...test.db.HsrCharacterCost.iter()].find((r) => r.characterName === name && r.draftMode.tag === draftMode && r.costSetId === costSetId);

describe('admin_bulk_upsert: seed rows (in memory)', () => {
    it('HsrCharacter / HsrLightcone / Archetype rows land with every column; a second upsert by name updates in place (flow 4, A17 positioning columns)', () => {
        const test = newBareHarness();
        bulkUpsert(test, 'HsrCharacter', [character('acheron'), character('kafka', { role: 'Support', element: 'Lightning', path: 'Nihility' })]);
        bulkUpsert(test, 'HsrLightcone', [lightcone('adreamscentedinwheat'), lightcone('alongthepassingshore')]);
        bulkUpsert(test, 'Archetype', [{ name: 'Debuff', description: '' }, { name: 'DoT', description: '' }]);

        const acheron = test.db.HsrCharacter.name.find('acheron')!;
        expect(acheron).toMatchObject({
            displayName: 'ACHERON', aliases: ['acheron'], rarity: 5, imageUrl: 'https://img/acheron.png',
            versionReleased: 2.1, treatAsVersion: 0, posX: -10, posY: 4, width: 120,
        });
        expect([acheron.path.tag, acheron.element.tag, acheron.role.tag]).toEqual(['Nihility', 'Lightning', 'Dps']);
        expect(test.db.HsrCharacter.name.find('kafka')!.role.tag).toBe('Support');
        expect(test.db.HsrLightcone.name.find('adreamscentedinwheat')).toMatchObject({ path: { tag: 'Erudition' }, rarity: 4, posX: -48, posY: -32, width: 120 });
        expect([...test.db.Archetype.iter()].map((a) => a.name).sort()).toEqual(['Debuff', 'DoT']);

        bulkUpsert(test, 'HsrCharacter', [character('acheron', { displayName: 'Acheron', width: 0 })]);
        expect([...test.db.HsrCharacter.iter()]).toHaveLength(2);
        expect(test.db.HsrCharacter.name.find('acheron')).toMatchObject({ displayName: 'Acheron', width: 0, posX: -10 });
    });

    it('15.4-1..3 (D-14): both sub-blocks → a Classic and an Auction row; Classic-only → 1 row; Auction-only → 1 row; costs keep e0..e6 (fractions included)', () => {
        const test = newBareHarness();
        bulkUpsert(test, 'HsrCharacterCost', [
            charCost('acheron', 'Classic', 7), charCost('acheron', 'Auction', 2),
            charCost('kafka', 'Classic', 4),
            charCost('aglaea', 'Auction', 3),
        ]);
        expect(charCosts(test)).toEqual([
            'acheron|MemoryOfChaos|Auction|0', 'acheron|MemoryOfChaos|Classic|0',
            'aglaea|MemoryOfChaos|Auction|0',
            'kafka|MemoryOfChaos|Classic|0',
        ]);
        expect(charCostRow(test, 'acheron', 'Classic')!.costs).toEqual(eidolons(7));
        expect(charCostRow(test, 'acheron', 'Auction')!.costs).toEqual(eidolons(2));
        expect(charCostRow(test, 'kafka', 'Auction')).toBeUndefined();
        expect(charCostRow(test, 'aglaea', 'Classic')).toBeUndefined();
    });

    it('D-19: the cost row key is (name, gameMode, draftMode, costSetId): re-upserting Classic updates it alone; another game mode and cost set 5 coexist', () => {
        const test = newBareHarness();
        bulkUpsert(test, 'HsrCharacterCost', [charCost('acheron', 'Classic', 7), charCost('acheron', 'Auction', 2)]);
        bulkUpsert(test, 'HsrCharacterCost', [
            charCost('acheron', 'Classic', 9),
            charCost('acheron', 'Classic', 1, 5),
            charCost('acheron', 'Classic', 6, 0, 'ApocalypticShadow'),
        ]);
        expect(charCosts(test)).toEqual([
            'acheron|ApocalypticShadow|Classic|0',
            'acheron|MemoryOfChaos|Auction|0', 'acheron|MemoryOfChaos|Classic|0', 'acheron|MemoryOfChaos|Classic|5',
        ]);
        expect(charCostRow(test, 'acheron', 'Classic')!.costs).toEqual(eidolons(9));
        expect(charCostRow(test, 'acheron', 'Auction')!.costs).toEqual(eidolons(2));
        expect(charCostRow(test, 'acheron', 'Classic', 5)!.costs).toEqual(eidolons(1));

        bulkUpsert(test, 'HsrCharacterCost', [charCost('acheron', 'Classic', 3)]); // re-seeding set 0 leaves set 5 alone
        expect(charCostRow(test, 'acheron', 'Classic', 5)!.costs).toEqual(eidolons(1));
    });

    it('HsrLightconeCost: one row per present sub-block, s1..s5 kept, keyed by (name, gameMode, draftMode, costSetId) (D-14, D-19)', () => {
        const test = newBareHarness();
        bulkUpsert(test, 'HsrLightconeCost', [
            lcCost('adreamscentedinwheat', 'Classic', 1.5), lcCost('adreamscentedinwheat', 'Auction', 1),
            lcCost('alongthepassingshore', 'Classic', 3),
        ]);
        bulkUpsert(test, 'HsrLightconeCost', [lcCost('adreamscentedinwheat', 'Classic', 2)]);
        const rows = [...test.db.HsrLightconeCost.iter()];
        expect(rows.map((r) => `${r.lightconeName}|${r.draftMode.tag}`).sort()).toEqual([
            'adreamscentedinwheat|Auction', 'adreamscentedinwheat|Classic', 'alongthepassingshore|Classic',
        ]);
        expect(rows.find((r) => r.lightconeName === 'adreamscentedinwheat' && r.draftMode.tag === 'Classic')!.costs).toEqual(supers(2));
        expect(rows.find((r) => r.lightconeName === 'adreamscentedinwheat' && r.draftMode.tag === 'Auction')!.costs).toEqual(supers(1));
    });

    it('HsrSynergyCost (D-25, A21): Classic and zero-valued Auction rows per game mode, stored in canonical order; the reversed pair updates, a pair listed twice is rejected', () => {
        const test = newBareHarness();
        // T-S10c (audit 2026-11-09, roster finding 1): a synergy needs both names as HsrCharacter rows.
        seedCharacters(test, ['anaxa', 'cerydra', 'kafka', 'acheron']);
        bulkUpsert(test, 'HsrSynergyCost', [
            pairing('cerydra', 'anaxa', 'Classic', 3), pairing('cerydra', 'anaxa', 'Auction', 0),
            pairing('anaxa', 'cerydra', 'Classic', 3, 'ApocalypticShadow'), pairing('anaxa', 'cerydra', 'Auction', 0, 'ApocalypticShadow'),
        ]);
        const rows = () => [...test.db.HsrSynergyCost.iter()].map((r) =>
            `${r.characterA}+${r.characterB}|${r.gameMode.tag}|${r.draftMode.tag}|${r.costModifier}`).sort();
        expect(rows()).toEqual([
            'anaxa+cerydra|ApocalypticShadow|Auction|0', 'anaxa+cerydra|ApocalypticShadow|Classic|3',
            'anaxa+cerydra|MemoryOfChaos|Auction|0', 'anaxa+cerydra|MemoryOfChaos|Classic|3',
        ]);

        bulkUpsert(test, 'HsrSynergyCost', [pairing('cerydra', 'anaxa', 'Auction', 1.5)]);
        expect(rows()).toContain('anaxa+cerydra|MemoryOfChaos|Auction|1.5');
        expect(rows()).toHaveLength(4);

        const msg = rejection(test, 'internal', (ctx) => M.admin_bulk_upsert(ctx, {
            tableName: 'HsrSynergyCost',
            jsonData: JSON.stringify([pairing('kafka', 'acheron', 'Classic', 1), pairing('acheron', 'kafka', 'Classic', 2)]),
        }));
        expect(rows()).toHaveLength(4);
        expect(msg).toContain('Synergy pair acheron + kafka is listed twice');
    });

    it('admin_bulk_upsert error cases: a missing draftMode key, an unsupported table, a non-array payload, a non-admin caller; an empty array is a no-op', () => {
        const test = newBareHarness();
        const { draftMode: _omit, ...noDraftMode } = charCost('acheron', 'Classic', 7);
        const call = (tableName: string, jsonData: string) => (ctx: any) => M.admin_bulk_upsert(ctx, { tableName, jsonData });

        expect(rejection(test, 'internal', call('HsrCharacterCost', JSON.stringify([noDraftMode])))).toContain('missing: [draftMode]');
        expect(rejection(test, 'internal', call('User', '[]'))).toContain('Bulk upsert not supported for table: User');
        expect(rejection(test, 'internal', call('HsrCharacter', '{}'))).toContain('jsonData must be a JSON array');
        expect(rejection(test, verified(test, 'seeduser'), call('HsrCharacter', JSON.stringify([character('acheron')]))))
            .toContain('Forbidden: Requires Admin privileges.');

        bulkUpsert(test, 'HsrCharacterCost', []);
        expect([...test.db.HsrCharacterCost.iter()]).toEqual([]);
        expect([...test.db.HsrCharacter.iter()]).toEqual([]);
    });
});

describe('Roster #10: re-seed keeps archetype descriptions (cost-sets architecture S10f "Seed")', () => {
    // S11a (triage L109): the seed's archetype filter is the pure newArchetypeRows (scripts/stdb/seed-normalizers.ts),
    // which scripts/stdb/_seed.ts feeds with the names read from conn.db.Archetype; here the names come from test.db and
    // the rows go through the same admin_bulk_upsert. The live re-seed at S11a is the end-to-end check.
    it('re-running the seed does not resend an existing archetype name, so an admin-written description survives (roster audit #10)', () => {
        const test = newBareHarness();
        const raw = characterSeed as unknown as RawCharacter[];
        const first = newArchetypeRows(raw, []);
        expect(first.length).toBeGreaterThan(0);
        expect(first.every((r) => r.description === '')).toBe(true);
        bulkUpsert(test, 'Archetype', first);
        const names = () => [...test.db.Archetype.iter()].map((r) => r.name);
        expect(names().sort()).toEqual(first.map((r) => r.name).sort());

        const edited = first[0].name;
        bulkUpsert(test, 'Archetype', [{ name: edited, description: 'Written by an admin' }]);

        const second = newArchetypeRows(raw, names()); // the re-seed reads the existing names first
        expect(second).toEqual([]);
        expect(test.db.Archetype.name.find(edited)!.description).toBe('Written by an admin');

        // A name new to the data is still sent, with the empty description.
        const withNew = [...raw, { ...raw[0], name: 'seed-probe', archetype: ['Brand New Archetype'] }];
        expect(newArchetypeRows(withNew, names())).toEqual([{ name: 'Brand New Archetype', description: '' }]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B.9 A108: the default set's seed carries Auction prices equal to Classic
// ════════════════════════════════════════════════════════════════════════════

const SEED_MODES = ['memory_of_chaos', 'apocalyptic_shadow', 'anomaly_arbitration'];

describe('A108(1): data/seed prices every character and light cone for Auction, equal to Classic, in all three game modes', () => {
    for (const [file, seed] of [['characters.json', characterSeed], ['lightcones.json', lightconeSeed]] as Array<[string, unknown]>) {
        it(`${file}: every entry has a Classic and an Auction block per game mode and each Auction block equals its Classic block (A108(1))`, () => {
            const entries = seed as Array<{ name: string; cost: Record<string, any> }>;
            expect(entries.length).toBeGreaterThan(0);
            const bad: string[] = [];
            for (const e of entries) {
                for (const mode of SEED_MODES) {
                    const block = e.cost?.[mode];
                    if (!block?.classic || !block?.auction) bad.push(`${e.name}: ${mode} missing a block`);
                    else if (JSON.stringify(block.auction) !== JSON.stringify(block.classic)) bad.push(`${e.name}: ${mode} auction differs`);
                }
            }
            expect(bad).toEqual([]);
        });
    }
});
