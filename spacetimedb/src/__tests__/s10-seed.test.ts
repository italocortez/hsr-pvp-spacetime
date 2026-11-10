// T-S10 batch C2: the seed pipeline's write side, in memory (SpacetimeDB test-utils; nothing reaches maincloud).
// Ported from test/backend/seed/round-trip.test.ts and the default-seed cases of
// test/backend/reducers/admin/seed-cost-extraction.test.ts. Orchestrator ruling: this file feeds admin_bulk_upsert with
// small inline samples shaped like the normalizer output (scripts/stdb/seed-normalizers.ts, A18) and asserts the stored
// rows; it neither imports scripts/ nor reads files. The normalizer round-trip over data/seed/*.json is the unit test
// test/backend/seed/round-trip.unit.test.ts; the "bootstrap seeded test1" invariants stay in the live smoke residue.
// Clauses: docs/admin/contract.md admin_bulk_upsert (flow 1-6, Error Cases, Edge Cases), Phase 15.4 D-14 (one row per
// present sub-block), D-19 (full-tuple match incl. costSetId), D-25 (synergy Auction rows), A21 (canonical pairs).
import { describe, expect, it } from 'vitest';
import { M, newHarness, type Harness } from './s4-fixtures';
import { verified } from './s8-fixtures';
import { bulkUpsert, rejection, seedCharacters } from './s10-c2-fixtures';

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
        const test = newHarness();
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
        const test = newHarness();
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
        const test = newHarness();
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
        const test = newHarness();
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
        const test = newHarness();
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
        const test = newHarness();
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
