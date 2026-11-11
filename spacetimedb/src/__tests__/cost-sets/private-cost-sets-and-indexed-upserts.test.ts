// Cost sets: CostSet is private, the published sets reach everyone through a view; the admin cost upserts and deletes
// find their row through the composite indexes.
// Decisions: A107, A108, A21 (unordered synergy pairs)
// Contracts: docs/cost-sets/contract.md
// From S11a.
//
// T-S11a (triage L91): `cost_set` was a public table, so any client read the name and creator of every unpublished
// draft. The table is private; view_published_cost_sets (anonymous, is_published index) lists the published sets; the
// owner keeps view_my_cost_sets.
// T-S11a (triage L92, S10j review F3): admin_bulk_upsert('HsrCharacterCost' / 'HsrLightconeCost' / 'HsrSynergyCost')
// and admin_delete_row on the two cost tables read the key through by_character_mode_and_set,
// by_lightcone_mode_and_set and by_tuple instead of scanning every set's rows. The behaviour is unchanged: the same
// key in another set or mode is a different row, a synergy pair matches in either order, a bad key is "Row not found".
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DbConnection } from '@bindings/index';
import { guest, newHarness, rejection, tx, M } from '../fixtures/harness';
import { verified } from '../fixtures/identity';
import { shared, view } from '../fixtures/views';
import {
    bulkUpsert, charCostRow, characterRow, createSet, lcCostRow, lightconeRow, liveChar, liveLc, liveSyn, publish, synergyRow,
} from '../fixtures/cost-sets';

describe('L91: CostSet is private; the published sets are a view', () => {
    it('view_published_cost_sets lists the published sets only, to anyone; the owner still reads its drafts', () => {
        const test = newHarness();
        const owner = verified(test, 'owner');
        setOwnerRole(test, owner.userId);
        const draftId = createSet(test, owner, 'my-unpublished-draft');
        const pubId = createSet(test, 'internal', 'published-one');
        publish(test, 'internal', pubId, true);

        const listed = shared<any>(test, 'view_published_cost_sets').map((r) => r.id);
        expect(listed).toContain(pubId);
        expect(listed).not.toContain(draftId);
        expect(shared<any>(test, 'view_published_cost_sets').every((r) => r.isPublished)).toBe(true);

        expect(view<any>(test, 'view_my_cost_sets', owner).map((r) => r.id)).toContain(draftId);
        expect(view<any>(test, 'view_my_cost_sets', guest(test, 'nosy')).map((r) => r.id)).not.toContain(draftId);
    });

    it('bindings: no cost_set table handle for clients; the view handle exists', () => {
        type Db = DbConnection['db'];
        expectTypeOf<Db>().not.toHaveProperty('costSet');
        expectTypeOf<Db>().toHaveProperty('viewPublishedCostSets');
    });
});

/** create_cost_set needs a Tournament Host or above. */
function setOwnerRole(test: ReturnType<typeof newHarness>, userId: number) {
    test.db.User.id.update({ ...test.db.User.id.find(userId)!, role: { tag: 'TournamentHost' } as any });
}

describe('L92: the admin cost upserts and deletes find the row by the composite index', () => {
    function world() {
        const test = newHarness();
        bulkUpsert(test, 'HsrCharacter', [characterRow('acheron'), characterRow('jingliu')]);
        bulkUpsert(test, 'HsrLightcone', [lightconeRow('shore')]);
        const other = createSet(test, 'internal', 'other-set');
        return { test, other };
    }
    const charRows = (test: any, setId: number) => liveChar(test, setId).filter((r: any) => r.characterName === 'acheron')
        .map((r: any) => `${r.gameMode.tag}/${r.draftMode.tag}=${r.costs.e0}`).sort();

    it('an upsert updates the row of its own key (set, mode, draft mode) and inserts a new key; no duplicate', () => {
        const { test, other } = world();
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('acheron', 'Classic', 3, 0), charCostRow('acheron', 'Classic', 4, other)]);
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('acheron', 'Classic', 5, 0), charCostRow('acheron', 'Auction', 6, 0)]);
        expect(charRows(test, 0)).toEqual(['MemoryOfChaos/Auction=6', 'MemoryOfChaos/Classic=5']);
        expect(charRows(test, other)).toEqual(['MemoryOfChaos/Classic=4']);

        bulkUpsert(test, 'HsrLightconeCost', [lcCostRow('shore', 'Classic', 1, 0)]);
        bulkUpsert(test, 'HsrLightconeCost', [lcCostRow('shore', 'Classic', 2, 0)]);
        expect(liveLc(test, 0).filter((r: any) => r.lightconeName === 'shore').map((r: any) => r.costs.s1)).toEqual([2]);
    });

    it('a synergy pair sent in the other order updates the stored row; the same pair in another set is its own row', () => {
        const { test, other } = world();
        bulkUpsert(test, 'HsrSynergyCost', [synergyRow('acheron', 'jingliu', 'Classic', 1, 0), synergyRow('acheron', 'jingliu', 'Classic', 2, other)]);
        bulkUpsert(test, 'HsrSynergyCost', [synergyRow('jingliu', 'acheron', 'Classic', 7, 0)]);
        expect(liveSyn(test, 0).map((r: any) => [r.characterA, r.characterB, r.costModifier])).toEqual([['acheron', 'jingliu', 7]]);
        expect(liveSyn(test, other).map((r: any) => r.costModifier)).toEqual([2]);
    });

    it('admin_delete_row removes exactly its key; a key of another set stays; an unknown key or enum tag is "Row not found"', () => {
        const { test, other } = world();
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('acheron', 'Classic', 3, 0), charCostRow('acheron', 'Classic', 4, other)]);
        bulkUpsert(test, 'HsrLightconeCost', [lcCostRow('shore', 'Classic', 1, 0), lcCostRow('shore', 'Classic', 1, other)]);
        const del = (tableName: string, key: Record<string, unknown>) => (ctx: any) =>
            M.admin_delete_row(ctx, { tableName, primaryKeyJson: JSON.stringify(key) });

        tx(test, 'internal', del('HsrCharacterCost', { characterName: 'acheron', gameModeTag: 'MemoryOfChaos', draftModeTag: 'Classic', costSetId: 0 }));
        expect(charRows(test, 0)).toEqual([]);
        expect(charRows(test, other)).toEqual(['MemoryOfChaos/Classic=4']);
        tx(test, 'internal', del('HsrLightconeCost', { lightconeName: 'shore', gameModeTag: 'MemoryOfChaos', draftModeTag: 'Classic', costSetId: other }));
        expect(liveLc(test, other).filter((r: any) => r.lightconeName === 'shore')).toHaveLength(0);
        expect(liveLc(test, 0).filter((r: any) => r.lightconeName === 'shore')).toHaveLength(1);

        for (const key of [
            { characterName: 'acheron', gameModeTag: 'MemoryOfChaos', draftModeTag: 'Classic', costSetId: 0 }, // already gone
            { characterName: 'acheron', gameModeTag: 'Chess', draftModeTag: 'Classic', costSetId: other },      // unknown mode
            { characterName: 'acheron', gameModeTag: 'MemoryOfChaos', draftModeTag: 'Blitz', costSetId: other }, // unknown draft mode
            { characterName: 42, gameModeTag: 'MemoryOfChaos', draftModeTag: 'Classic', costSetId: other },     // not a name
        ]) {
            expect(rejection(test, 'internal', del('HsrCharacterCost', key))).toBe('Row not found');
        }
        expect(charRows(test, other)).toEqual(['MemoryOfChaos/Classic=4']);
    });
});
