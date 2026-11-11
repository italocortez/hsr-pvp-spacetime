// Cost sets: an Admin cannot change a cost row of a set while a lobby on it has a game live.
// Decisions: A142
// Contracts: docs/cost-sets/contract.md
// From S10w (s10w-account-edit-lock.test.ts).
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    guest,
    lobbyRow,
    newHarness,
    priceCharacters,
    priceLightcones,
    setupLobby,
    tx,
    type Harness,
    type Lobby,
} from '../fixtures/harness';
import {
    completeDraft,
    insertCharacter,
    playToScoring,
} from '../fixtures/draft-and-scoring-builders';
import { seedElo } from '../fixtures/tournament-match-builders';
import { parkedLobby } from '../fixtures/ranked-game-builders';
import { rejection } from '../fixtures/calendar-roster-rating-builders';
import { COST_LOCKED, classic } from '../fixtures/live-lobby-lock-helpers';

/** S10w fix pass (review F1): a costSetId that is not null or a whole number 0..4294967295. */
const BAD_SET = (tableName: string) => `Invalid costSetId for ${tableName}: must be a whole number from 0 to 4294967295.`;

// ════════════════════════════════════════════════════════════════════════════
// A142: the Admin cost-row paths
// ════════════════════════════════════════════════════════════════════════════

const charCostRow = (name: string, costSetId: number, e0: number) => ({
    characterName: name, gameMode: 'MemoryOfChaos', draftMode: 'Classic',
    costs: { e0, e1: e0, e2: e0, e3: e0, e4: e0, e5: e0, e6: e0 }, costSetId,
});
const lcCostRow = (name: string, costSetId: number, s1: number) => ({
    lightconeName: name, gameMode: 'MemoryOfChaos', draftMode: 'Classic',
    costs: { s1, s2: s1, s3: s1, s4: s1, s5: s1 }, costSetId,
});
const upsert = (tableName: string, row: object) => (ctx: any) =>
    M.admin_bulk_upsert(ctx, { tableName, jsonData: JSON.stringify([row]) });
const del = (tableName: string, key: object) => (ctx: any) =>
    M.admin_delete_row(ctx, { tableName, primaryKeyJson: JSON.stringify(key) });

const synRow = (a: string, b: string, costSetId: number, costModifier: number) => ({
    characterA: a, characterB: b, gameMode: 'MemoryOfChaos', draftMode: 'Classic', costModifier, costSetId,
});
/** The id of the K + K2 synergy row of a set. */
const synergyId = (src: { db: any }, costSetId: number): number =>
    [...src.db.HsrSynergyCost.cost_set_id.filter(costSetId)].find((r: any) => r.characterA === 'K' && r.characterB === 'K2')!.id;
/** A K + K2 synergy row of a set (modifier 1), written straight into the datastore. */
function seedSynergy(test: Harness, costSetId: number) {
    const ts = test.clock.now();
    test.db.HsrSynergyCost.insert({
        id: 0, ...synRow('K', 'K2', costSetId, 1), gameMode: { tag: 'MemoryOfChaos' }, draftMode: { tag: 'Classic' },
        createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts,
    } as any);
}

/** Every Admin cost-row path, aimed at cost set `costSetId` (K, L and the K + K2 synergy are priced there first). */
function costPaths(costSetId: number): Array<[string, (ctx: any) => unknown]> {
    return [
        ['admin_bulk_upsert HsrSynergyCost (change)', upsert('HsrSynergyCost', synRow('K', 'K2', costSetId, 9))],
        ['admin_bulk_upsert HsrSynergyCost (insert)', upsert('HsrSynergyCost', synRow('K', 'N2', costSetId, 9))],
        ['admin_delete_row HsrSynergyCost', (ctx: any) =>
            M.admin_delete_row(ctx, { tableName: 'HsrSynergyCost', primaryKeyJson: String(synergyId(ctx, costSetId)) })],
        ['admin_bulk_upsert HsrCharacterCost (change)', upsert('HsrCharacterCost', charCostRow('K', costSetId, 9))],
        ['admin_bulk_upsert HsrCharacterCost (insert)', upsert('HsrCharacterCost', charCostRow('N', costSetId, 9))],
        ['admin_bulk_upsert HsrLightconeCost (change)', upsert('HsrLightconeCost', lcCostRow('L', costSetId, 9))],
        ['admin_bulk_upsert HsrLightconeCost (insert)', upsert('HsrLightconeCost', lcCostRow('O', costSetId, 9))],
        ['admin_delete_row HsrCharacterCost', del('HsrCharacterCost', { characterName: 'K', gameModeTag: 'MemoryOfChaos', draftModeTag: 'Classic', costSetId })],
        ['admin_delete_row HsrLightconeCost', del('HsrLightconeCost', { lightconeName: 'L', gameModeTag: 'MemoryOfChaos', draftModeTag: 'Classic', costSetId })],
    ];
}

/** The cost rows of a set, canonical (audit columns left out). */
const costRows = (test: Harness, costSetId: number) => JSON.stringify([
    ...[...test.db.HsrCharacterCost.cost_set_id.filter(costSetId)].map((r) => [r.characterName, r.draftMode.tag, r.costs]),
    ...[...test.db.HsrLightconeCost.cost_set_id.filter(costSetId)].map((r) => [r.lightconeName, r.draftMode.tag, r.costs]),
    ...[...test.db.HsrSynergyCost.cost_set_id.filter(costSetId)].map((r) => [r.characterA, r.characterB, r.costModifier]),
].sort());

function pricedLobby(noStart: boolean): Lobby {
    const s = classic(noStart);
    priceCharacters(s.test, s.lobbyId, ['K'], 1);
    priceLightcones(s.test, s.lobbyId, ['L'], 1);
    insertCharacter(s.test, 'K2', 5);
    insertCharacter(s.test, 'N2', 5);
    seedSynergy(s.test, 0);
    return s;
}

describe('A142: an Admin cannot change a cost row of a set while a lobby on it has a game live', () => {
    for (const [name, body] of costPaths(0)) {
        it(`A142: ${name} is refused while a lobby on the set is in Drafting; no row changes`, () => {
            const s = pricedLobby(false);
            expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('Drafting');
            const before = costRows(s.test, 0);
            expect(rejection(s.test, 'internal', body)).toBe(COST_LOCKED(0, 1));
            expect(costRows(s.test, 0)).toBe(before);
        });

        it(`A142: ${name} is accepted while the only lobby on the set is in Waiting`, () => {
            const s = pricedLobby(true);
            const before = costRows(s.test, 0);
            tx(s.test, 'internal', body);
            expect(costRows(s.test, 0)).not.toBe(before);
        });
    }

    for (const [name, body] of costPaths(7)) {
        it(`A142: ${name} on another cost set is accepted while a lobby on set 0 is in Drafting`, () => {
            const s = pricedLobby(false);
            const ts = s.test.clock.now();
            const audit = { createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts };
            s.test.db.HsrCharacterCost.insert({ ...charCostRow('K', 7, 1), gameMode: { tag: 'MemoryOfChaos' }, draftMode: { tag: 'Classic' }, ...audit } as any);
            s.test.db.HsrLightconeCost.insert({ ...lcCostRow('L', 7, 1), gameMode: { tag: 'MemoryOfChaos' }, draftMode: { tag: 'Classic' }, ...audit } as any);
            seedSynergy(s.test, 7);
            const before = costRows(s.test, 7);
            tx(s.test, 'internal', body);
            expect(costRows(s.test, 7)).not.toBe(before);
        });
    }

    it('A142: the count in the text covers every live lobby on the set (2 lobbies in Drafting)', () => {
        const s = pricedLobby(false);
        setupLobby(s.test, { seats: [['b9', 'BluePlayer'], ['r9', 'RedPlayer']], actors: { host: guest(s.test, 'host9') } });
        expect([...s.test.db.Lobby.iter()].filter((l) => l.stage.tag === 'Drafting')).toHaveLength(2);
        // T-S10w fix pass (review F4): the path is picked by name (the base character guard), not by its index.
        const charChange = costPaths(0).find(([name]) => name === 'admin_bulk_upsert HsrCharacterCost (change)')![1];
        expect(rejection(s.test, 'internal', charChange)).toBe(COST_LOCKED(0, 2));
    });
});

// T-S10w fix pass (review F5): the guard in every live stage, reached through the reducers.
describe('A142: the cost-row guard in Equipping and Scoring (refused) and AwaitingResult (accepted)', () => {
    /** Prices K, L and the K + K2 synergy on set 0 of a lobby already past Waiting. */
    function priceAll(s: Lobby) {
        priceCharacters(s.test, s.lobbyId, ['K'], 1);
        priceLightcones(s.test, s.lobbyId, ['L'], 1);
        insertCharacter(s.test, 'K2', 5);
        insertCharacter(s.test, 'N2', 5);
        seedSynergy(s.test, 0);
    }
    const toEquipping = () => { const s = classic(); completeDraft(s); return s; };
    const toScoring = () => playToScoring(newHarness());

    for (const [stage, build] of [['Equipping', toEquipping], ['Scoring', toScoring]] as const) {
        it(`A142: every Admin cost-row path is refused while the lobby on the set is in ${stage}; no row changes`, () => {
            const s = build();
            expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe(stage);
            priceAll(s);
            const before = costRows(s.test, 0);
            for (const [name, body] of costPaths(0)) {
                expect(rejection(s.test, 'internal', body), name).toBe(COST_LOCKED(0, 1));
            }
            expect(costRows(s.test, 0)).toBe(before);
        });
    }

    it('A142: every Admin cost-row path is accepted once the game is past (AwaitingResult)', () => {
        const test = newHarness();
        seedElo(test);
        const s = parkedLobby(test); // a Ranked game closed by the host: the lobby parks (a Casual one is finalized and gone)
        expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        priceAll(s);
        for (const [name, body] of costPaths(0)) {
            const before = costRows(s.test, 0);
            tx(s.test, 'internal', body);
            expect(costRows(s.test, 0), name).not.toBe(before);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// T-S10w fix pass (review F1): costSetId must be null or a whole number 0..4294967295
// ════════════════════════════════════════════════════════════════════════════

describe('A142 (review F1): a cost row or key whose costSetId is not a whole number is refused before any lookup or guard', () => {
    const BAD: unknown[] = ['0', 0.4, false, true, [0], {}, 4294967296, -1, '7'];
    const withSet = (row: object, costSetId: unknown) => ({ ...row, costSetId });
    const upsertRaw = (tableName: string, row: object) => (ctx: any) =>
        M.admin_bulk_upsert(ctx, { tableName, jsonData: JSON.stringify([row]) });
    const NaN_JSON = (tableName: string, row: object) => (ctx: any) => // JSON has no NaN: a programmatic caller only
        M.admin_bulk_upsert(ctx, { tableName, jsonData: JSON.stringify([row]).replace('"costSetId":0', '"costSetId":NaN') });
    const tables: Array<[string, object, object]> = [
        ['HsrCharacterCost', charCostRow('N2', 0, 9), charCostRow('K', 0, 9)],
        ['HsrLightconeCost', lcCostRow('O', 0, 9), lcCostRow('L', 0, 9)],
        ['HsrSynergyCost', synRow('K', 'N2', 0, 9), synRow('K', 'K2', 0, 9)],
    ];

    for (const [tableName, newRow, changeRow] of tables) {
        for (const live of [true, false]) {
            it(`A142 (F1): ${tableName} upsert with costSetId ${BAD.map((v) => JSON.stringify(v)).join(' / ')} is refused ${live ? 'during a live draft' : 'with no live game'}; nothing is written`, () => {
                const s = pricedLobby(!live);
                const before = JSON.stringify([costRows(s.test, 0), costRows(s.test, 7)]);
                for (const bad of BAD) {
                    for (const row of [newRow, changeRow]) {
                        expect(rejection(s.test, 'internal', upsertRaw(tableName, withSet(row, bad))), `${JSON.stringify(bad)}`).toBe(BAD_SET(tableName));
                    }
                }
                expect(rejection(s.test, 'internal', NaN_JSON(tableName, newRow))).toBe('jsonData must be a JSON array'); // unparsable JSON
                expect(JSON.stringify([costRows(s.test, 0), costRows(s.test, 7)])).toBe(before);
            });
        }

        it(`A142 (F1): ${tableName} upsert with costSetId null (set 0), 0 and 7 still works with no live game; null and 0 are refused by the guard during a live draft`, () => {
            const w = pricedLobby(true);
            tx(w.test, 'internal', upsertRaw(tableName, withSet(changeRow, null)));
            tx(w.test, 'internal', upsertRaw(tableName, withSet(newRow, 7)));
            expect(costRows(w.test, 7)).not.toBe('[]');
            const l = pricedLobby(false);
            expect(rejection(l.test, 'internal', upsertRaw(tableName, withSet(changeRow, null)))).toBe(COST_LOCKED(0, 1));
            expect(rejection(l.test, 'internal', upsertRaw(tableName, withSet(newRow, 0)))).toBe(COST_LOCKED(0, 1));
            tx(l.test, 'internal', upsertRaw(tableName, withSet(newRow, 7))); // another set: accepted
        });
    }

    for (const [tableName, key] of [
        ['HsrCharacterCost', { characterName: 'K', gameModeTag: 'MemoryOfChaos', draftModeTag: 'Classic' }],
        ['HsrLightconeCost', { lightconeName: 'L', gameModeTag: 'MemoryOfChaos', draftModeTag: 'Classic' }],
    ] as const) {
        it(`A142 (F1): admin_delete_row ${tableName} with a bad costSetId in the key is refused; null means set 0`, () => {
            const s = pricedLobby(false);
            const before = costRows(s.test, 0);
            for (const bad of BAD) {
                expect(rejection(s.test, 'internal', del(tableName, { ...key, costSetId: bad })), JSON.stringify(bad)).toBe(BAD_SET(tableName));
            }
            expect(rejection(s.test, 'internal', del(tableName, { ...key, costSetId: null }))).toBe(COST_LOCKED(0, 1));
            expect(costRows(s.test, 0)).toBe(before);
            const w = pricedLobby(true);
            const wBefore = costRows(w.test, 0);
            tx(w.test, 'internal', del(tableName, { ...key, costSetId: null }));
            expect(costRows(w.test, 0)).not.toBe(wBefore);
        });
    }
});

describe('A142: an upsert whose values equal the stored row is not a change (no write, no refusal)', () => {
    /** Set 0 priced with non-dyadic values (f32 storage): K 0.1, L 12.7, K + K2 synergy 1. */
    function nonDyadic(noStart: boolean): Lobby {
        const s = classic(noStart);
        priceCharacters(s.test, s.lobbyId, ['K'], 0.1);
        priceLightcones(s.test, s.lobbyId, ['L'], 12.7);
        insertCharacter(s.test, 'K2', 5);
        seedSynergy(s.test, 0);
        advance(s.test, 60_000); // any rewrite would carry a later lastModifiedDate
        return s;
    }
    const identical = [
        upsert('HsrCharacterCost', charCostRow('K', 0, 0.1)),
        upsert('HsrLightconeCost', lcCostRow('L', 0, 12.7)),
        upsert('HsrSynergyCost', synRow('K2', 'K', 0, 1)), // either order (A21)
    ];
    /** Every set-0 cost row with its audit columns (a rewrite changes lastModifiedDate / lastModifiedById). */
    const withAudit = (test: Harness) => JSON.stringify([
        ...[...test.db.HsrCharacterCost.cost_set_id.filter(0)],
        ...[...test.db.HsrLightconeCost.cost_set_id.filter(0)],
        ...[...test.db.HsrSynergyCost.cost_set_id.filter(0)],
    ].map((r: any) => [r.characterName ?? r.lightconeName ?? `${r.characterA}+${r.characterB}`, r.draftMode.tag, r.costs ?? r.costModifier,
        r.lastModifiedById, String(r.lastModifiedDate.microsSinceUnixEpoch)]).sort(), (_k, v) => (typeof v === 'bigint' ? String(v) : v));

    it('A142: an identical batch (character, light cone, synergy; null costs too) is accepted during a live draft and no row is rewritten', () => {
        const s = nonDyadic(false);
        expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('Drafting');
        const before = withAudit(s.test);
        for (const body of identical) tx(s.test, 'internal', body);
        tx(s.test, 'internal', upsert('HsrCharacterCost', { ...charCostRow('K', 0, 0), costs: null })); // null = keep
        tx(s.test, 'internal', (ctx) => // a multi-row identical batch (the EMPTY coverage row is cost 0)
            M.admin_bulk_upsert(ctx, { tableName: 'HsrCharacterCost', jsonData: JSON.stringify([charCostRow('K', 0, 0.1), charCostRow('EMPTY', 0, 0)]) }));
        expect(withAudit(s.test)).toBe(before);
    });

    it('A142: a batch of identical rows plus one changed price is refused as a whole during a live draft; nothing is written', () => {
        const s = nonDyadic(false);
        const before = withAudit(s.test);
        const changedK = { ...charCostRow('K', 0, 0.1), costs: { e0: 0.1, e1: 0.2, e2: 0.1, e3: 0.1, e4: 0.1, e5: 0.1, e6: 0.1 } };
        // identical rows first, the changed one last: the identical ones are skipped, the change refuses the whole call
        expect(rejection(s.test, 'internal', (ctx) =>
            M.admin_bulk_upsert(ctx, { tableName: 'HsrCharacterCost', jsonData: JSON.stringify([charCostRow('EMPTY', 0, 0), charCostRow('K', 0, 0.1), changedK]) }))).toBe(COST_LOCKED(0, 1));
        expect(withAudit(s.test)).toBe(before);
        // the changed row first, an identical one after it: same refusal
        expect(rejection(s.test, 'internal', (ctx) =>
            M.admin_bulk_upsert(ctx, { tableName: 'HsrCharacterCost', jsonData: JSON.stringify([changedK, charCostRow('EMPTY', 0, 0)]) }))).toBe(COST_LOCKED(0, 1));
        expect(rejection(s.test, 'internal', upsert('HsrSynergyCost', synRow('K', 'K2', 0, 2)))).toBe(COST_LOCKED(0, 1));
        expect(withAudit(s.test)).toBe(before);
    });

    it('A142: outside a live game (Waiting) the identical batch is accepted with no rewrite and the changed price is written', () => {
        const s = nonDyadic(true);
        const before = withAudit(s.test);
        for (const body of identical) tx(s.test, 'internal', body);
        expect(withAudit(s.test)).toBe(before);
        tx(s.test, 'internal', upsert('HsrCharacterCost', { ...charCostRow('K', 0, 0.1), costs: { e0: 0.1, e1: 0.2, e2: 0.1, e3: 0.1, e4: 0.1, e5: 0.1, e6: 0.1 } }));
        tx(s.test, 'internal', upsert('HsrSynergyCost', synRow('K', 'K2', 0, 2)));
        const k = [...s.test.db.HsrCharacterCost.cost_set_id.filter(0)].find((r) => r.characterName === 'K' && r.draftMode.tag === 'Classic')!;
        expect(k.costs.e1).toBe(Math.fround(0.2));
        expect(k.lastModifiedDate.microsSinceUnixEpoch).toBe(s.test.clock.now().microsSinceUnixEpoch);
        expect(s.test.db.HsrSynergyCost.id.find(synergyId(s.test, 0))!.costModifier).toBe(2);
    });
});
