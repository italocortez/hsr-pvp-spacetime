// Cost sets: a synergy pair modifier is never negative (A199(2)).
// Contracts: docs/roster/contract.md (cost sets, Phase S14.3-pairs execution)
//
// T-S14.3-pairs: every reducer path that writes a cost set's pair modifier refuses a negative one with one text, and a
// refused write changes nothing; 0 and a positive value pass. Rows "written before the rule" are inserted directly into
// the tables (no reducer can write them any more), the way the scoring fixtures insert synergy rows. The seed
// normalizer refuses a negative modifier before anything is sent. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { AUDIT, M, newBareHarness, rejection, tx, type Harness } from '../fixtures/harness';
import { seedCharacters } from '../fixtures/roster';
import { MOC, bulkUpsert, costSetId, costSetRow, draftSyn, liveSyn, publish, synergyRow } from '../fixtures/cost-sets';
import synergySeed from '../../../../data/seed/synergies.json';
import { normalizePairings, type RawPairing } from '../../../../scripts/stdb/seed-normalizers';

const NEGATIVE = "A pairing's cost cannot be negative.";

function harness() {
    const test = newBareHarness();
    seedCharacters(test, ['kafka', 'pela']);
    return test;
}

const createSet = (test: Harness, name: string, sourceSetId = 0) => {
    tx(test, 'internal', (ctx) => M.create_cost_set(ctx, { name, sourceSetId, gameModeTag: MOC }));
    return costSetId(test, name);
};
const editBody = (costSetId: number, costModifier: number, draftModeTag = 'Classic') => (ctx: any) =>
    M.edit_draft_synergy_cost(ctx, { costSetId, sourceName: 'pela', targetName: 'kafka', gameModeTag: MOC, draftModeTag, costModifier });
const mods = (rows: Array<{ draftMode: { tag: string }; costModifier: number }>) =>
    rows.map((r) => [r.draftMode.tag, r.costModifier]).sort();

/** A live HsrSynergyCost row written directly (as if before A199). */
function insertLive(test: Harness, costSetId: number, costModifier: number, draftMode = 'Classic') {
    test.db.HsrSynergyCost.insert({
        id: 0, characterA: 'kafka', characterB: 'pela', gameMode: { tag: MOC }, draftMode: { tag: draftMode },
        costModifier, costSetId, ...AUDIT(test),
    } as any);
}

describe('edit_draft_synergy_cost refuses a negative pair modifier (A199(2))', () => {
    it('a negative modifier is refused with the text and writes nothing; 0 and a positive one are stored', () => {
        const test = harness();
        const id = createSet(test, 'edits');
        const msgs = [-0.01, -1, -100_000].map((v) => rejection(test, 'internal', editBody(id, v)));
        expect(draftSyn(test, id)).toHaveLength(0);
        expect(msgs).toEqual(Array(3).fill(NEGATIVE));
        tx(test, 'internal', editBody(id, 0));
        tx(test, 'internal', editBody(id, 2.5, 'Auction'));
        expect(mods(draftSyn(test, id))).toEqual([['Auction', 2.5], ['Classic', 0]]);
    });

    it('editing a stored pair to a negative value is refused and the stored value stays', () => {
        const test = harness();
        const id = createSet(test, 'keep');
        tx(test, 'internal', editBody(id, 3));
        expect(rejection(test, 'internal', editBody(id, -3))).toBe(NEGATIVE);
        expect(mods(draftSyn(test, id))).toEqual([['Classic', 3]]);
    });
});

describe('create_cost_set refuses to copy a negative pair modifier (A199(2))', () => {
    it('a source row with a negative modifier refuses the copy; no set and no draft row is created', () => {
        const test = harness();
        insertLive(test, 0, -1);
        const msg = rejection(test, 'internal', (ctx) => M.create_cost_set(ctx, { name: 'copy', sourceSetId: 0, gameModeTag: MOC }));
        expect([...test.db.CostSet.iter()]).toHaveLength(0);
        expect([...test.db.CostSetDraftSynergy.iter()]).toHaveLength(0);
        expect(msg).toBe(NEGATIVE);
    });

    it('source rows at 0 and above are copied as they are', () => {
        const test = harness();
        insertLive(test, 0, 0, 'Classic');
        insertLive(test, 0, 1.5, 'Auction');
        const id = createSet(test, 'copy');
        expect(mods(draftSyn(test, id))).toEqual([['Auction', 1.5], ['Classic', 0]]);
    });
});

describe('publish_cost_set refuses a draft holding a negative pair modifier (A199(2))', () => {
    it('a negative draft row refuses the publish; the set stays a draft and no live row is written; fixed, it publishes', () => {
        const test = harness();
        const id = createSet(test, 'draft');
        test.db.CostSetDraftSynergy.insert({
            costSetId: id, characterA: 'kafka', characterB: 'pela', gameMode: { tag: MOC }, draftMode: { tag: 'Classic' },
            costModifier: -2, ...AUDIT(test),
        } as any);
        const msg = rejection(test, 'internal', (ctx) => M.publish_cost_set(ctx, { costSetId: id }));
        expect(costSetRow(test, id)).toMatchObject({ isDraft: true, isPublished: false });
        expect(liveSyn(test, id)).toHaveLength(0);
        expect(msg).toBe(NEGATIVE);
        tx(test, 'internal', editBody(id, 0));
        publish(test, 'internal', id);
        expect(mods(liveSyn(test, id))).toEqual([['Classic', 0]]);
    });

    it('a published set whose live row is negative and has no draft (before S10i): the publish is refused until the pair is edited', () => {
        const test = harness();
        const id = createSet(test, 'legacy');
        publish(test, 'internal', id); // empty draft: published with no rows, so the draft stays empty
        insertLive(test, id, -4);
        expect(rejection(test, 'internal', (ctx) => M.publish_cost_set(ctx, { costSetId: id }))).toBe(NEGATIVE);
        expect(mods(liveSyn(test, id))).toEqual([['Classic', -4]]);
        expect(draftSyn(test, id)).toHaveLength(0); // the draft copy made by the refused call rolled back
        // The edit copies the live row into the draft (ensureDraftCopy) and replaces it in the same call.
        tx(test, 'internal', editBody(id, 1));
        publish(test, 'internal', id);
        expect(mods(liveSyn(test, id))).toEqual([['Classic', 1]]);
    });
});

describe('admin_bulk_upsert(HsrSynergyCost) refuses a negative pair modifier (A199(2); the seed path)', () => {
    it('a negative modifier on insert is refused and the whole call rolls back; 0 and a positive one are written', () => {
        const test = harness();
        const msg = rejection(test, 'internal', (ctx) => M.admin_bulk_upsert(ctx, {
            tableName: 'HsrSynergyCost',
            jsonData: JSON.stringify([synergyRow('kafka', 'pela', 'Auction', 1), synergyRow('kafka', 'pela', 'Classic', -0.5)]),
        }));
        expect([...test.db.HsrSynergyCost.iter()]).toHaveLength(0);
        expect(msg).toBe(NEGATIVE);
        bulkUpsert(test, 'HsrSynergyCost', [synergyRow('kafka', 'pela', 'Classic', 0), synergyRow('kafka', 'pela', 'Auction', 1)]);
        expect(mods(liveSyn(test, 0))).toEqual([['Auction', 1], ['Classic', 0]]);
    });

    it('updating a stored row to a negative value is refused and the stored value stays; null keeps it', () => {
        const test = harness();
        bulkUpsert(test, 'HsrSynergyCost', [synergyRow('kafka', 'pela', 'Classic', 2)]);
        const msg = rejection(test, 'internal', (ctx) => M.admin_bulk_upsert(ctx, {
            tableName: 'HsrSynergyCost', jsonData: JSON.stringify([synergyRow('pela', 'kafka', 'Classic', -2)]),
        }));
        expect(mods(liveSyn(test, 0))).toEqual([['Classic', 2]]);
        expect(msg).toBe(NEGATIVE);
        bulkUpsert(test, 'HsrSynergyCost', [{ ...synergyRow('kafka', 'pela', 'Classic', 0), costModifier: null }]);
        expect(mods(liveSyn(test, 0))).toEqual([['Classic', 2]]);
    });
});

describe('seed normalizer refuses a negative pair modifier before anything is sent (A199(2))', () => {
    it('normalizePairings throws a plain error naming the pair', () => {
        const raw: RawPairing[] = [{
            source_name: 'pela', target_name: 'kafka',
            cost: { cost_set_id: 0, memory_of_chaos: { classic: { modifier: 1 }, auction: { modifier: -0.5 } } },
        }];
        expect(() => normalizePairings(raw)).toThrow(
            "synergies.json: pair kafka + pela (memory_of_chaos, Auction) has a negative modifier (-0.5); a pairing's cost cannot be negative.");
    });

    it('data/seed/synergies.json holds no negative modifier: it normalizes, every modifier 0 or more', () => {
        const rows = normalizePairings(synergySeed as RawPairing[]) as Array<{ costModifier: number }>;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.filter((r) => !(r.costModifier >= 0))).toEqual([]);
    });
});
