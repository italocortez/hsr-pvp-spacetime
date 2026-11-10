// T-S10 (batch C1): cost data in memory, ported from the live test/backend/cost-sets/{cost-set-lifecycle,
// synergy-auction-round-trip} and test/backend/reducers/admin/{cost-set-pk, partial-update, seed-cost-extraction}
// tests. Spec: docs/cost-sets/contract.md (lifecycle reducers, acceptance scenarios, edge cases; Phase 15.4 D-16..D-21,
// A21 unordered synergy pairs) and docs/admin/contract.md § admin_bulk_upsert (Phase 15.4 composite-tuple keys, D-19
// partial update, EXPECTED_KEYS). The live edit tests only asserted "no throw"; here every edit is checked on the draft
// or live rows. The two client-bindings checks (index accessors) are type-level, like s9a "LobbyPreset is private".
// The default seed's own content stays with the seed port. Nothing reaches maincloud.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DbConnection } from '@bindings/index';
import { M, expectReject, guest, newHarness, tx, type Actor, type Harness } from './s4-fixtures';
import { host as tournamentHost, moderator, verified } from './s8-fixtures';
import {
    E,
    S,
    bulkUpsert,
    charCostRow,
    characterRow,
    costSetId,
    costSetRow,
    draftChar,
    draftLc,
    draftSyn,
    eCost,
    keysOf,
    lcCostRow,
    lightconeRow,
    liveChar,
    liveLc,
    liveSyn,
    sCost,
    synergyRow,
} from './s10-c1-fixtures';
import { seedCharacters, seedReferenceNames } from './s10-c2-fixtures';

const FORBIDDEN_OWNER = 'Forbidden: You do not own this cost set and are not a Moderator.';
const MOC = 'MemoryOfChaos';

/**
 * T-S10c (audit 2026-11-09, roster finding 1): synergy writes require both names as HsrCharacter rows, so the
 * synergy fixtures seed their characters first.
 */
function seedSynergyCharacters(test: Harness, names = ['kafka', 'blackswan']) {
    seedCharacters(test, names);
}

/** Default set 0 rows for MoC (Classic + Auction) and one ApocalypticShadow row that must never be cloned into a MoC set. */
function seedDefaultSet(test: Harness) {
    seedSynergyCharacters(test, ['acheron', 'pela']);
    bulkUpsert(test, 'HsrCharacterCost', [
        charCostRow('acheron', 'Classic', 2), charCostRow('acheron', 'Auction', 20),
        charCostRow('acheron', 'Classic', 9, 0, 'ApocalypticShadow'),
    ]);
    bulkUpsert(test, 'HsrLightconeCost', [lcCostRow('shore', 'Classic', 1), lcCostRow('shore', 'Auction', 10)]);
    bulkUpsert(test, 'HsrSynergyCost', [synergyRow('acheron', 'pela', 'Classic', 0.5), synergyRow('acheron', 'pela', 'Auction', 1.5)]);
}

/** create_cost_set as `who` (clone of `sourceSetId`, MoC); returns the new id. */
function createSet(test: Harness, who: Actor | 'internal', name: string, sourceSetId = 0, gameModeTag = MOC): number {
    tx(test, who, (ctx) => M.create_cost_set(ctx, { name, sourceSetId, gameModeTag }));
    return costSetId(test, name.trim());
}

const editChar = (test: Harness, who: Actor | 'internal', id: number, characterName: string, draftModeTag: string, costsJson: string) =>
    tx(test, who, (ctx) => M.edit_draft_character_cost(ctx, { costSetId: id, characterName, gameModeTag: MOC, draftModeTag, costsJson }));
const editLc = (test: Harness, who: Actor | 'internal', id: number, lightconeName: string, draftModeTag: string, costsJson: string) =>
    tx(test, who, (ctx) => M.edit_draft_lightcone_cost(ctx, { costSetId: id, lightconeName, gameModeTag: MOC, draftModeTag, costsJson }));
const editSyn = (test: Harness, who: Actor | 'internal', id: number, sourceName: string, targetName: string, draftModeTag: string, costModifier: number) =>
    tx(test, who, (ctx) => M.edit_draft_synergy_cost(ctx, { costSetId: id, sourceName, targetName, gameModeTag: MOC, draftModeTag, costModifier }));
const publish = (test: Harness, who: Actor | 'internal', id: number) => tx(test, who, (ctx) => M.publish_cost_set(ctx, { costSetId: id }));
const lock = (test: Harness, who: Actor | 'internal', id: number) => tx(test, who, (ctx) => M.lock_cost_set(ctx, { costSetId: id }));
const unpublish = (test: Harness, who: Actor | 'internal', id: number) => tx(test, who, (ctx) => M.unpublish_cost_set(ctx, { costSetId: id }));
const del = (test: Harness, who: Actor | 'internal', id: number) => tx(test, who, (ctx) => M.delete_cost_set(ctx, { costSetId: id }));

const flags = (test: Harness, id: number) => {
    const r = costSetRow(test, id)!;
    return { isDraft: r.isDraft, isPublished: r.isPublished, isLocked: r.isLocked };
};

// ════════════════════════════════════════════════════════════════════════════
// Cost-set lifecycle (cost-sets contract)
// ════════════════════════════════════════════════════════════════════════════

describe('create_cost_set (cost-sets contract § create_cost_set; D-20)', () => {
    it('a Tournament Host creates a draft set cloned from set 0, filtered by game mode, both draft modes kept (scenario "Create Cost Set (clone from source)")', () => {
        const test = newHarness();
        seedDefaultSet(test);
        const org = tournamentHost(test);
        const id = createSet(test, org, '  Spring rules  ');
        const row = costSetRow(test, id)!;
        expect(row).toMatchObject({ name: 'Spring rules', creatorId: org.userId, isDraft: true, isPublished: false, isLocked: false });
        expect(row.gameMode.tag).toBe(MOC);
        expect(keysOf(draftChar(test, id), 'characterName')).toEqual(['acheron|MemoryOfChaos|Auction', 'acheron|MemoryOfChaos|Classic']);
        expect(keysOf(draftLc(test, id), 'lightconeName')).toEqual(['shore|MemoryOfChaos|Auction', 'shore|MemoryOfChaos|Classic']);
        expect(draftSyn(test, id).map((r) => `${r.characterA}+${r.characterB}|${r.draftMode.tag}|${r.costModifier}`).sort())
            .toEqual(['acheron+pela|Auction|1.5', 'acheron+pela|Classic|0.5']);
        expect(draftChar(test, id).find((r) => r.draftMode.tag === 'Auction')!.costs).toEqual(eCost(20));
        expect(liveChar(test, id)).toHaveLength(0);
    });

    it('a guest and a verified User are rejected (Permission: TournamentHost+); no set is created', () => {
        const test = newHarness();
        const g = guest(test, 'g');
        const user = verified(test, 'plain');
        for (const who of [g, user]) {
            expectReject(test, who, (ctx) => M.create_cost_set(ctx, { name: 'No', sourceSetId: 0, gameModeTag: MOC }),
                'Forbidden: Requires Tournament Host, Moderator, or Admin privileges.');
        }
        expect([...test.db.CostSet.iter()]).toHaveLength(0);
    });

    it('rejects an empty / whitespace or over-100-character name, an unknown game mode, an unknown source and an unpublished source (contract error table)', () => {
        const test = newHarness();
        const org = tournamentHost(test);
        const draft = createSet(test, org, 'still a draft');
        const NAME = 'Cost set name must be between 1 and 100 characters.';
        for (const name of ['', '   ', 'n'.repeat(101)]) {
            expectReject(test, org, (ctx) => M.create_cost_set(ctx, { name, sourceSetId: 0, gameModeTag: MOC }), NAME);
        }
        expectReject(test, org, (ctx) => M.create_cost_set(ctx, { name: 'x', sourceSetId: 0, gameModeTag: 'PureFiction' }),
            'Invalid gameModeTag. Must be one of: MemoryOfChaos, ApocalypticShadow, AnomalyArbitration');
        expectReject(test, org, (ctx) => M.create_cost_set(ctx, { name: 'x', sourceSetId: 4040, gameModeTag: MOC }), 'Source cost set 4040 not found.');
        expectReject(test, org, (ctx) => M.create_cost_set(ctx, { name: 'x', sourceSetId: draft, gameModeTag: MOC }),
            `Source cost set ${draft} must be published before cloning.`);
        expect([...test.db.CostSet.iter()]).toHaveLength(1);
    });

    it('cloning a published non-default set copies that set\'s live rows (both draft modes), not set 0\'s', () => {
        const test = newHarness();
        seedDefaultSet(test);
        seedReferenceNames(test, ['kafka']); // T-S10f: edit_draft_*_cost requires the reference rows (roster audit #9)
        const org = tournamentHost(test);
        const src = createSet(test, org, 'source');
        editChar(test, org, src, 'acheron', 'Classic', E(7));
        editChar(test, org, src, 'kafka', 'Auction', E(8));
        publish(test, org, src);
        const copy = createSet(test, org, 'copy', src);
        const rows = draftChar(test, copy);
        expect(keysOf(rows, 'characterName')).toEqual(['acheron|MemoryOfChaos|Auction', 'acheron|MemoryOfChaos|Classic', 'kafka|MemoryOfChaos|Auction']);
        expect(rows.find((r) => r.characterName === 'acheron' && r.draftMode.tag === 'Classic')!.costs).toEqual(eCost(7));
    });
});

describe('edit_draft_*_cost (cost-sets contract §§ edit_draft_character_cost / lightcone / synergy; D-16..D-18, A21)', () => {
    it('one call = one row per (name, mode, draftMode): Classic and Auction rows are separate, a re-edit replaces the row (scenario "Edit Draft Costs")', () => {
        const test = newHarness();
        seedReferenceNames(test, ['kafka'], ['patience']); // T-S10f: edit_draft_*_cost requires the reference rows (roster audit #9)
        const org = tournamentHost(test);
        const id = createSet(test, org, 'edits');
        editChar(test, org, id, 'kafka', 'Classic', E(3));
        editChar(test, org, id, 'kafka', 'Auction', E(30));
        editChar(test, org, id, 'kafka', 'Classic', E(4));
        editLc(test, org, id, 'patience', 'Classic', S(2));
        editLc(test, org, id, 'patience', 'Auction', S(20));
        const chars = draftChar(test, id);
        expect(keysOf(chars, 'characterName')).toEqual(['kafka|MemoryOfChaos|Auction', 'kafka|MemoryOfChaos|Classic']);
        expect(chars.find((r) => r.draftMode.tag === 'Classic')!.costs).toEqual(eCost(4));
        expect(chars.find((r) => r.draftMode.tag === 'Auction')!.costs).toEqual(eCost(30));
        expect(draftLc(test, id).map((r) => [r.draftMode.tag, r.costs.s1]).sort()).toEqual([['Auction', 20], ['Classic', 2]]);
    });

    it('a synergy edit is keyed by the 5-tuple: an Auction row is inserted then updated; editing B + A updates the A + B row (A21)', () => {
        const test = newHarness();
        seedSynergyCharacters(test);
        const org = tournamentHost(test);
        const id = createSet(test, org, 'synergy');
        editSyn(test, org, id, 'kafka', 'blackswan', 'Auction', 2);
        expect(draftSyn(test, id)).toEqual([expect.objectContaining({ characterA: 'blackswan', characterB: 'kafka', costModifier: 2 })]);
        editSyn(test, org, id, 'blackswan', 'kafka', 'Auction', -1.5);
        editSyn(test, org, id, 'kafka', 'blackswan', 'Classic', 0.25);
        const rows = draftSyn(test, id);
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.draftMode.tag === 'Auction')!.costModifier).toBe(-1.5);
        expect(rows.find((r) => r.draftMode.tag === 'Classic')!.costModifier).toBe(0.25);
    });

    it('rejects invalid JSON, a missing e0 / s1 field and an unknown set (edge cases "costsJson ...")', () => {
        const test = newHarness();
        const org = tournamentHost(test);
        const id = createSet(test, org, 'bad input');
        expect(() => editChar(test, org, id, 'kafka', 'Classic', 'not json')).toThrow('costsJson must be a valid JSON object.');
        expect(() => editChar(test, org, id, 'kafka', 'Classic', JSON.stringify({ e1: 1, e2: 1, e3: 1, e4: 1, e5: 1, e6: 1 })))
            .toThrow('costsJson must have numeric field "e0".');
        expect(() => editLc(test, org, id, 'patience', 'Classic', JSON.stringify({ s2: 1, s3: 1, s4: 1, s5: 1 })))
            .toThrow('costsJson must have numeric field "s1".');
        expect(() => editChar(test, org, 4040, 'kafka', 'Classic', E(1))).toThrow('Cost set 4040 not found.');
        expect(draftChar(test, id)).toHaveLength(0);
    });

    it('another Tournament Host cannot edit or publish the set; a Moderator edits and publishes any set (Permission: owner or Moderator+)', () => {
        const test = newHarness();
        seedReferenceNames(test, ['kafka']); // T-S10f: edit_draft_*_cost requires the reference rows (roster audit #9)
        const org = tournamentHost(test, 'owner');
        const rival = tournamentHost(test, 'rival');
        const mod = moderator(test);
        const id = createSet(test, org, 'owned');
        expect(() => editChar(test, rival, id, 'kafka', 'Classic', E(1))).toThrow(FORBIDDEN_OWNER);
        expect(() => editLc(test, rival, id, 'patience', 'Classic', S(1))).toThrow(FORBIDDEN_OWNER);
        expect(() => editSyn(test, rival, id, 'a', 'b', 'Classic', 1)).toThrow(FORBIDDEN_OWNER);
        expect(() => publish(test, rival, id)).toThrow(FORBIDDEN_OWNER);
        editChar(test, mod, id, 'kafka', 'Classic', E(5));
        publish(test, mod, id);
        expect(flags(test, id)).toEqual({ isDraft: false, isPublished: true, isLocked: false });
        expect(liveChar(test, id)[0].costs).toEqual(eCost(5));
    });
});

describe('publish / lock / unpublish / delete (cost-sets contract; scenarios "Publish", "Lock", "Unpublish", "Delete")', () => {
    it('publish copies every draft row, both draft modes, to the live tables with their values, deletes the drafts and flips the flags (Pitfall 7 guard)', () => {
        const test = newHarness();
        seedSynergyCharacters(test);
        seedReferenceNames(test, ['kafka'], ['patience']); // T-S10f: edit_draft_*_cost requires the reference rows (roster audit #9)
        const org = tournamentHost(test);
        const id = createSet(test, org, 'full');
        editChar(test, org, id, 'kafka', 'Classic', E(3));
        editChar(test, org, id, 'kafka', 'Auction', E(30));
        editLc(test, org, id, 'patience', 'Classic', S(2));
        editLc(test, org, id, 'patience', 'Auction', S(20));
        editSyn(test, org, id, 'kafka', 'blackswan', 'Classic', 0.5);
        editSyn(test, org, id, 'kafka', 'blackswan', 'Auction', 2.5);
        publish(test, org, id);

        expect(flags(test, id)).toEqual({ isDraft: false, isPublished: true, isLocked: false });
        expect(liveChar(test, id).map((r) => [r.draftMode.tag, r.costs.e0]).sort()).toEqual([['Auction', 30], ['Classic', 3]]);
        expect(liveLc(test, id).map((r) => [r.draftMode.tag, r.costs.s1]).sort()).toEqual([['Auction', 20], ['Classic', 2]]);
        expect(liveSyn(test, id).map((r) => [r.draftMode.tag, r.costModifier]).sort()).toEqual([['Auction', 2.5], ['Classic', 0.5]]);
        expect([draftChar(test, id), draftLc(test, id), draftSyn(test, id)].map((r) => r.length)).toEqual([0, 0, 0]);
    });

    it('a published set can be neither edited nor published again', () => {
        const test = newHarness();
        const org = tournamentHost(test);
        const id = createSet(test, org, 'done');
        publish(test, org, id);
        expect(() => publish(test, org, id)).toThrow('Cannot publish a cost set that is not in draft state.');
        expect(() => editChar(test, org, id, 'kafka', 'Classic', E(1)))
            .toThrow('Cannot edit a cost set that is not in draft state. Publish creates a live copy; clone to make a new draft.');
        expect(() => editLc(test, org, id, 'patience', 'Classic', S(1))).toThrow('Cannot edit a cost set that is not in draft state.');
        expect(() => editSyn(test, org, id, 'a', 'b', 'Classic', 1)).toThrow('Cannot edit a cost set that is not in draft state.');
    });

    it('lock: a published set locks once; a draft or an already locked set is rejected; a rival is rejected', () => {
        const test = newHarness();
        const org = tournamentHost(test, 'owner');
        const rival = tournamentHost(test, 'rival');
        const draft = createSet(test, org, 'draft');
        const id = createSet(test, org, 'lockable');
        publish(test, org, id);
        expect(() => lock(test, org, draft)).toThrow('Cannot lock a cost set that is not published.');
        expect(() => lock(test, rival, id)).toThrow(FORBIDDEN_OWNER);
        lock(test, org, id);
        expect(flags(test, id)).toEqual({ isDraft: false, isPublished: true, isLocked: true });
        expect(() => lock(test, org, id)).toThrow('Cost set is already locked.');
    });

    it('unpublish: refused before lock and on an unpublished set; after lock it clears both flags and the live rows stay', () => {
        const test = newHarness();
        seedReferenceNames(test, ['kafka']); // T-S10f: edit_draft_*_cost requires the reference rows (roster audit #9)
        const org = tournamentHost(test);
        const id = createSet(test, org, 'retiring');
        editChar(test, org, id, 'kafka', 'Classic', E(3));
        publish(test, org, id);
        expect(() => unpublish(test, org, id)).toThrow('Cost set must be locked before it can be unpublished. Call lock_cost_set first.');
        lock(test, org, id);
        unpublish(test, org, id);
        expect(flags(test, id)).toEqual({ isDraft: false, isPublished: false, isLocked: false });
        expect(liveChar(test, id)).toHaveLength(1);
        expect(() => unpublish(test, org, id)).toThrow('Cost set is not published.');
    });

    it('delete: refused while published; after unpublish it removes the set and its live rows of both draft modes, leaving other sets alone', () => {
        const test = newHarness();
        seedSynergyCharacters(test);
        seedDefaultSet(test);
        seedReferenceNames(test, ['kafka'], ['patience']); // T-S10f: edit_draft_*_cost requires the reference rows (roster audit #9)
        const org = tournamentHost(test);
        const keep = createSet(test, org, 'keep');
        editChar(test, org, keep, 'kafka', 'Classic', E(1));
        publish(test, org, keep);
        const id = createSet(test, org, 'doomed');
        editChar(test, org, id, 'kafka', 'Classic', E(3));
        editChar(test, org, id, 'kafka', 'Auction', E(30));
        editLc(test, org, id, 'patience', 'Auction', S(2));
        editSyn(test, org, id, 'kafka', 'blackswan', 'Auction', 1);
        publish(test, org, id);
        expect(liveChar(test, id).map((r) => `${r.characterName}|${r.draftMode.tag}`).sort())
            .toEqual(['acheron|Auction', 'acheron|Classic', 'kafka|Auction', 'kafka|Classic']); // cloned from set 0 + edits
        const keptRows = liveChar(test, keep);
        expect(() => del(test, org, id)).toThrow('Cost set must be unpublished before deleting. Call unpublish_cost_set first.');
        lock(test, org, id);
        unpublish(test, org, id);
        del(test, org, id);

        expect(costSetRow(test, id)).toBeFalsy();
        expect([liveChar(test, id), liveLc(test, id), liveSyn(test, id)].map((r) => r.length)).toEqual([0, 0, 0]);
        expect(liveChar(test, keep)).toEqual(keptRows);
        expect(liveChar(test, 0)).toHaveLength(3);
        expect(liveSyn(test, 0)).toHaveLength(2);
    });

    it('delete of a never-published draft removes its draft rows; a rival cannot delete it', () => {
        const test = newHarness();
        seedDefaultSet(test);
        const org = tournamentHost(test, 'owner');
        const rival = tournamentHost(test, 'rival');
        const id = createSet(test, org, 'abandoned');
        expect(draftChar(test, id)).toHaveLength(2);
        expect(() => del(test, rival, id)).toThrow(FORBIDDEN_OWNER);
        del(test, org, id);
        expect(costSetRow(test, id)).toBeFalsy();
        expect([draftChar(test, id), draftLc(test, id), draftSyn(test, id)].map((r) => r.length)).toEqual([0, 0, 0]);
    });

    it('the default set (id 0) cannot be locked, unpublished or deleted, even by an Admin (scenario "Default Cost Set Protection")', () => {
        const test = newHarness();
        seedDefaultSet(test);
        expect(() => lock(test, 'internal', 0)).toThrow('The default cost set (id=0) cannot be locked.');
        expect(() => unpublish(test, 'internal', 0)).toThrow('The default cost set (id=0) cannot be unpublished.');
        expect(() => del(test, 'internal', 0)).toThrow('The default cost set (id=0) cannot be deleted.');
        expect(liveChar(test, 0)).toHaveLength(3);
    });

    it('lock, unpublish, delete and publish of an unknown set are "Cost set N not found."', () => {
        const test = newHarness();
        for (const op of [lock, unpublish, del, publish]) {
            expect(() => op(test, 'internal', 4040)).toThrow('Cost set 4040 not found.');
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// admin_bulk_upsert: composite-tuple keys (admin contract § admin_bulk_upsert, Phase 15.4 D-19 / D-25)
// ════════════════════════════════════════════════════════════════════════════

describe('admin_bulk_upsert on the cost tables: the (name, mode, draftMode, costSetId) key', () => {
    it('Classic and Auction rows of the same character / light cone / synergy pair coexist as separate rows', () => {
        const test = newHarness();
        seedSynergyCharacters(test);
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('kafka', 'Classic', 1), charCostRow('kafka', 'Auction', 10)]);
        bulkUpsert(test, 'HsrLightconeCost', [lcCostRow('patience', 'Classic', 1), lcCostRow('patience', 'Auction', 10)]);
        bulkUpsert(test, 'HsrSynergyCost', [synergyRow('kafka', 'blackswan', 'Classic', 0.5), synergyRow('kafka', 'blackswan', 'Auction', 1.5)]);
        expect(liveChar(test, 0).map((r) => [r.draftMode.tag, r.costs.e0]).sort()).toEqual([['Auction', 10], ['Classic', 1]]);
        expect(liveLc(test, 0).map((r) => [r.draftMode.tag, r.costs.s1]).sort()).toEqual([['Auction', 10], ['Classic', 1]]);
        expect(liveSyn(test, 0).map((r) => [r.characterA, r.characterB, r.draftMode.tag, r.costModifier]).sort())
            .toEqual([['blackswan', 'kafka', 'Auction', 1.5], ['blackswan', 'kafka', 'Classic', 0.5]]);
    });

    it('re-upserting the Classic row updates it in place (one row) and leaves the Auction sibling untouched', () => {
        const test = newHarness();
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('kafka', 'Classic', 1), charCostRow('kafka', 'Auction', 10)]);
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('kafka', 'Classic', 4)]);
        const rows = liveChar(test, 0);
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.draftMode.tag === 'Classic')!.costs).toEqual(eCost(4));
        expect(rows.find((r) => r.draftMode.tag === 'Auction')!.costs).toEqual(eCost(10));
    });

    it('synergy: updating the Classic row keeps its id, never touches the Auction sibling, and a reversed pair is the same row (A21)', () => {
        const test = newHarness();
        seedSynergyCharacters(test);
        bulkUpsert(test, 'HsrSynergyCost', [synergyRow('kafka', 'blackswan', 'Classic', 0.5), synergyRow('kafka', 'blackswan', 'Auction', 1.5)]);
        const before = new Map(liveSyn(test, 0).map((r) => [r.draftMode.tag, r]));
        bulkUpsert(test, 'HsrSynergyCost', [synergyRow('blackswan', 'kafka', 'Classic', 2)]);
        const after = new Map(liveSyn(test, 0).map((r) => [r.draftMode.tag, r]));
        expect(after.size).toBe(2);
        expect(after.get('Classic')).toMatchObject({ id: before.get('Classic')!.id, costModifier: 2 });
        expect(after.get('Auction')).toEqual(before.get('Auction'));
    });

    it('the same pair listed twice in one payload, in either order, is rejected (A21)', () => {
        const test = newHarness();
        seedSynergyCharacters(test);
        expect(() => bulkUpsert(test, 'HsrSynergyCost', [synergyRow('kafka', 'blackswan', 'Auction', 1), synergyRow('blackswan', 'kafka', 'Auction', 2)]))
            .toThrow('Synergy pair blackswan + kafka is listed twice (pairs are unordered).');
        expect(liveSyn(test, 0)).toHaveLength(0);
    });

    it('rows of distinct costSetIds coexist; re-seeding set 0 never overwrites the set-5 row (legacy regression)', () => {
        const test = newHarness();
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('kafka', 'Classic', 5, 5)]);
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('kafka', 'Classic', 1, 0)]);
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('kafka', 'Classic', 2, 0)]);
        expect(liveChar(test, 5).map((r) => r.costs.e0)).toEqual([5]);
        expect(liveChar(test, 0).map((r) => r.costs.e0)).toEqual([2]);
    });

    it('a payload carrying only one draft mode writes only that mode (seed extraction 15.4-2 / 15.4-3)', () => {
        const test = newHarness();
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('classic-only', 'Classic', 1), charCostRow('auction-only', 'Auction', 2)]);
        expect(keysOf(liveChar(test, 0), 'characterName')).toEqual(['auction-only|MemoryOfChaos|Auction', 'classic-only|MemoryOfChaos|Classic']);
    });

    it.each([
        ['HsrCharacterCost', { characterName: 'kafka', gameMode: MOC, costs: eCost(1), costSetId: 0 }],
        ['HsrLightconeCost', { lightconeName: 'patience', gameMode: MOC, costs: sCost(1), costSetId: 0 }],
        ['HsrSynergyCost', { characterA: 'kafka', characterB: 'blackswan', gameMode: MOC, costModifier: 1, costSetId: 0 }],
    ])('%s: a row without the draftMode key is rejected by the key check (D-19)', (tableName, row) => {
        const test = newHarness();
        expect(() => bulkUpsert(test, tableName, [row])).toThrow(/Row 0 key mismatch: missing: \[draftMode\]/);
    });

    it('a non-Admin is rejected; an unsupported table and a non-array payload are rejected with the contract texts', () => {
        const test = newHarness();
        const mod = moderator(test);
        expect(() => bulkUpsert(test, 'HsrCharacterCost', [charCostRow('kafka', 'Classic', 1)], mod)).toThrow('Forbidden: Requires Admin privileges.');
        expect(() => bulkUpsert(test, 'User', [])).toThrow('Bulk upsert not supported for table: User');
        expect(() => tx(test, 'internal', (ctx) => M.admin_bulk_upsert(ctx, { tableName: 'HsrCharacterCost', jsonData: '{}' })))
            .toThrow('jsonData must be a JSON array');
        bulkUpsert(test, 'HsrCharacterCost', []); // edge case: an empty array is a no-op
        expect(liveChar(test, 0)).toHaveLength(0);
    });

    it('client bindings expose the composite btree accessors of the three live cost tables (type-level)', () => {
        type Db = DbConnection['db'];
        expectTypeOf<Db['hsrCharacterCost']>().toHaveProperty('by_character_mode_and_set');
        expectTypeOf<Db['hsrLightconeCost']>().toHaveProperty('by_lightcone_mode_and_set');
        expectTypeOf<Db['hsrSynergyCost']>().toHaveProperty('by_tuple');
    });
});

describe('synergy Auction round trip (Phase 15.4 D-25a)', () => {
    it('admin_bulk_upsert writes an Auction synergy row with its modifier and set id', () => {
        const test = newHarness();
        seedSynergyCharacters(test);
        bulkUpsert(test, 'HsrSynergyCost', [synergyRow('kafka', 'blackswan', 'Auction', 3.5, 7)]);
        expect(liveSyn(test, 7)).toEqual([expect.objectContaining({
            characterA: 'blackswan', characterB: 'kafka', costModifier: 3.5, costSetId: 7, gameMode: expect.objectContaining({ tag: MOC }),
            draftMode: expect.objectContaining({ tag: 'Auction' }),
        })]);
    });

    it('an Auction-only draft synergy publishes to one live Auction row and no Classic row', () => {
        const test = newHarness();
        seedSynergyCharacters(test);
        const org = tournamentHost(test);
        const id = createSet(test, org, 'auction syn');
        editSyn(test, org, id, 'kafka', 'blackswan', 'Auction', 4);
        publish(test, org, id);
        expect(liveSyn(test, id).map((r) => [r.draftMode.tag, r.costModifier])).toEqual([['Auction', 4]]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// admin_bulk_upsert partial update (admin contract § admin_bulk_upsert; Phase 15 D-08 / D-10, 15.4 D-19)
// ════════════════════════════════════════════════════════════════════════════

describe('admin_bulk_upsert partial update: null = keep on an existing row, default on a new row', () => {
    it('HsrCharacter: a row with only imageUrl set keeps every other stored field', () => {
        const test = newHarness();
        bulkUpsert(test, 'HsrCharacter', [characterRow('pu-char', {
            displayName: 'Partial', aliases: ['alpha', 'beta'], element: 'Ice', role: 'Support', imageUrl: 'img.orig',
            versionReleased: 2.5, treatAsVersion: 2, posX: 10, posY: 20, width: 300,
        })]);
        const nulls = Object.fromEntries(Object.keys(characterRow('x')).filter((k) => k !== 'name').map((k) => [k, null]));
        bulkUpsert(test, 'HsrCharacter', [{ ...nulls, name: 'pu-char', imageUrl: 'img.NEW' }]);
        const row = test.db.HsrCharacter.name.find('pu-char')!;
        expect(row).toMatchObject({
            displayName: 'Partial', aliases: ['alpha', 'beta'], rarity: 5, imageUrl: 'img.NEW', versionReleased: 2.5, treatAsVersion: 2,
            posX: 10, posY: 20, width: 300,
        });
        expect([row.path.tag, row.element.tag, row.role.tag]).toEqual(['Destruction', 'Ice', 'Support']);
    });

    it('HsrLightcone: a row with only imageUrl set keeps every other stored field', () => {
        const test = newHarness();
        bulkUpsert(test, 'HsrLightcone', [lightconeRow('pu-lc', { displayName: 'PU LC', aliases: ['lc-alpha'], rarity: 4, imageUrl: 'lc.orig', posX: 5, posY: 15, width: 250 })]);
        const nulls = Object.fromEntries(Object.keys(lightconeRow('x')).filter((k) => k !== 'name').map((k) => [k, null]));
        bulkUpsert(test, 'HsrLightcone', [{ ...nulls, name: 'pu-lc', imageUrl: 'lc.NEW' }]);
        const row = test.db.HsrLightcone.name.find('pu-lc')!;
        expect(row).toMatchObject({ displayName: 'PU LC', aliases: ['lc-alpha'], rarity: 4, imageUrl: 'lc.NEW', posX: 5, posY: 15, width: 250 });
        expect(row.path.tag).toBe('Destruction');
    });

    it('the insert branch applies the schema defaults to null fields of a new row', () => {
        const test = newHarness();
        bulkUpsert(test, 'HsrCharacter', [characterRow('pu-new', {
            displayName: null, aliases: null, rarity: null, imageUrl: null, versionReleased: null, treatAsVersion: null, posX: null, posY: null, width: null,
        })]);
        expect(test.db.HsrCharacter.name.find('pu-new')).toMatchObject({
            displayName: '', aliases: [], rarity: 0, imageUrl: '', versionReleased: 0, treatAsVersion: 0, posX: 0, posY: 0, width: 0,
        });
    });

    it('HsrCharacterCost: null costs on an existing row keep the stored struct', () => {
        const test = newHarness();
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('kafka', 'Classic', 5, 9)]);
        bulkUpsert(test, 'HsrCharacterCost', [{ ...charCostRow('kafka', 'Classic', 0, 9), costs: null }]);
        expect(liveChar(test, 9).map((r) => r.costs)).toEqual([eCost(5)]);
    });

    it('per-draftMode independence: a null-costs update of the Classic row keeps it, and the Auction row is untouched by both writes', () => {
        const test = newHarness();
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('kafka', 'Classic', 5, 9), charCostRow('kafka', 'Auction', 50, 9)]);
        bulkUpsert(test, 'HsrCharacterCost', [{ ...charCostRow('kafka', 'Classic', 0, 9), costs: null }]);
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('kafka', 'Classic', 6, 9)]);
        const rows = liveChar(test, 9);
        expect(rows.find((r) => r.draftMode.tag === 'Classic')!.costs).toEqual(eCost(6));
        expect(rows.find((r) => r.draftMode.tag === 'Auction')!.costs).toEqual(eCost(50));
    });

    it('a non-null costs struct replaces the stored one wholesale (no field-level merge inside the struct)', () => {
        const test = newHarness();
        bulkUpsert(test, 'HsrCharacterCost', [charCostRow('kafka', 'Auction', 5, 9)]);
        const next = { e0: 111, e1: 112, e2: 113, e3: 114, e4: 115, e5: 116, e6: 117 };
        bulkUpsert(test, 'HsrCharacterCost', [{ ...charCostRow('kafka', 'Auction', 0, 9), costs: next }]);
        expect(liveChar(test, 9).map((r) => r.costs)).toEqual([next]);
    });
});
