// T-S10w: in-memory tests for step S10w (DECISIONS.md A142). A game account selected in an active lobby cannot be edited
// by anyone: the Admin roster tools refuse it exactly when the owner's own edit is refused (accountLobbyLocks: every
// LobbyMemberAccount row of the account except those of an abandoned membership, S10e review F3). An Admin cannot insert,
// change or delete a character, light-cone or synergy cost row of a cost set (an upsert equal to the stored row is not a change) while a lobby on that set has a game live (Drafting,
// Equipping or Scoring), the A107(4) test (liveLobbiesOnCostSet). State is built through the module's reducers; HSR
// accounts, account characters, account selections and cost rows are written straight into the in-memory datastore
// outside any reducer, like the earlier suites. Admin calls run as the owner identity ('internal', linked by init to the
// SYSTEM Admin). TestClock; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    guest,
    lobbyRow,
    newHarness,
    priceCharacters,
    priceLightcones,
    session,
    setupLobby,
    steps,
    tx,
    type Harness,
    type Lobby,
    type SetupOpts,
} from './s4-fixtures';
import { captain, completeDraft, insertCharacter, playToScoring, selectAccount } from './s7-fixtures';
import { insertHsrAccount, verified } from './s8-fixtures';
import { seedElo } from './s8d-fixtures';
import { parkedLobby } from './s10-a2-fixtures';
import { rejection } from './s10-c2-fixtures';

// ─── Texts ───────────────────────────────────────────────────────────────────

/** A142: the Admin roster refusal (names the lobby by its join code). */
const LOCKED = (joinCode: string) =>
    `This account is selected in active lobby ${joinCode}; its roster cannot be edited until the player's membership in that lobby ends or the lobby closes.`;
/** S10w fix pass (review F1): a costSetId that is not null or a whole number 0..4294967295. */
const BAD_SET = (tableName: string) => `Invalid costSetId for ${tableName}: must be a whole number from 0 to 4294967295.`;
/** D-24: admin_delete_hsr_account's refusal, unchanged. */
const DELETE_LOCKED = 'Cannot delete an account that is selected in an active lobby. Leave the lobby first.';
/** A142: the Admin cost-row refusal (the A107(4) test). */
const COST_LOCKED = (costSetId: number, live: number) =>
    `Cannot change a cost row of cost set ${costSetId} while ${live} ${live === 1 ? 'lobby using it is' : 'lobbies using it are'} in Drafting, Equipping or Scoring.`;

// ─── Builders ────────────────────────────────────────────────────────────────

type Side = 'Blue' | 'Red';
const ONE_V_ONE: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['r1', 'RedPlayer']];
const TWO_V_TWO: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];

/** A 1v1 Classic lobby on set 0; `noStart` keeps it in Waiting. */
function classic(noStart = false): Lobby {
    return setupLobby(newHarness(), { seats: ONE_V_ONE, noStart });
}

/** b1's HSR account (inactive, so no join auto-selects it) owning A at E0 and selected for the lobby. */
function selectedAccount(s: Lobby): number {
    insertCharacter(s.test, 'A', 5);
    insertCharacter(s.test, 'B', 5);
    const id = insertHsrAccount(s.test, s.a.b1.userId, '800000001');
    s.test.db.HsrAccount.id.update({ ...s.test.db.HsrAccount.id.find(id)!, isActive: false });
    selectAccount(s.test, s.lobbyId, s.a.b1.userId, id, { A: 0 });
    return id;
}

const ownedOf = (test: Harness, id: number) =>
    Object.fromEntries([...test.db.HsrAccountCharacter.hsr_account_id.filter(id)].map((r) => [r.characterName, r.eidolonLevel]));

type AdminPath = [name: string, body: (id: number) => (ctx: any) => unknown];
const ROSTER_PATHS: AdminPath[] = [
    ['admin_batch_upsert_characters (eidolon update)', (id) => (ctx) =>
        M.admin_batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: JSON.stringify([{ characterName: 'A', eidolonLevel: 3 }]) })],
    ['admin_batch_upsert_characters (add)', (id) => (ctx) =>
        M.admin_batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: JSON.stringify([{ characterName: 'B', eidolonLevel: 1 }]) })],
    ['admin_batch_remove_characters', (id) => (ctx) =>
        M.admin_batch_remove_characters(ctx, { hsrAccountId: id, characterNamesJson: '["A"]' })],
];
const DELETE_PATH = (id: number) => (ctx: any) => M.admin_delete_hsr_account(ctx, { hsrAccountId: id });

// ════════════════════════════════════════════════════════════════════════════
// A142: the Admin roster paths
// ════════════════════════════════════════════════════════════════════════════

describe('A142: an Admin cannot edit the characters of an account selected in an active lobby', () => {
    for (const stage of ['Waiting', 'Drafting'] as const) {
        for (const [name, body] of ROSTER_PATHS) {
            it(`A142: ${name} is refused for an account selected in a ${stage} lobby; the roster is unchanged`, () => {
                const s = classic(stage === 'Waiting');
                expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe(stage);
                const id = selectedAccount(s);
                expect(rejection(s.test, 'internal', body(id))).toBe(LOCKED(lobbyRow(s.test, s.lobbyId).joinCode));
                expect(ownedOf(s.test, id)).toEqual({ A: 0 });
            });
        }
        it(`A142 (D-24 unchanged): admin_delete_hsr_account is refused for an account selected in a ${stage} lobby`, () => {
            const s = classic(stage === 'Waiting');
            const id = selectedAccount(s);
            expect(rejection(s.test, 'internal', DELETE_PATH(id))).toBe(DELETE_LOCKED);
            expect(s.test.db.HsrAccount.id.find(id)).toBeDefined();
        });
    }

    for (const [name, body] of ROSTER_PATHS) {
        it(`A142: ${name} is accepted for an account of the same player that is not selected (live draft)`, () => {
            const s = classic();
            selectedAccount(s);
            const other = insertHsrAccount(s.test, s.a.b1.userId, '800000002');
            s.test.db.HsrAccount.id.update({ ...s.test.db.HsrAccount.id.find(other)!, isActive: false });
            s.test.db.HsrAccountCharacter.insert({ hsrAccountId: other, characterName: 'A', eidolonLevel: 0, createdById: 0, createdDate: s.test.clock.now(), lastModifiedById: 0, lastModifiedDate: s.test.clock.now() } as any);
            tx(s.test, 'internal', body(other));
            expect(ownedOf(s.test, other)).not.toEqual({ A: 0 });
        });

        it(`A142: ${name} is accepted once the player left the Waiting lobby (the selection is released)`, () => {
            const s = classic(true);
            const id = selectedAccount(s);
            tx(s.test, s.a.b1, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
            tx(s.test, 'internal', body(id));
            expect(ownedOf(s.test, id)).not.toEqual({ A: 0 });
        });

        it(`A142: ${name} is accepted once the Waiting lobby is closed by its host`, () => {
            const s = classic(true);
            const id = selectedAccount(s);
            tx(s.test, s.host, (ctx) => M.close_lobby(ctx, { lobbyId: s.lobbyId }));
            expect(s.test.db.Lobby.id.find(s.lobbyId)).toBeNull();
            tx(s.test, 'internal', body(id));
            expect(ownedOf(s.test, id)).not.toEqual({ A: 0 });
        });

        it(`A142: ${name} is accepted once the drafting lobby is gone (deleted through the Admin table editor)`, () => {
            const s = classic();
            const id = selectedAccount(s);
            tx(s.test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: 'Lobby', primaryKeyJson: String(s.lobbyId) }));
            tx(s.test, 'internal', body(id));
            expect(ownedOf(s.test, id)).not.toEqual({ A: 0 });
        });

        it(`A142 (S10e review F3 kept): ${name} is accepted for the account of a member who abandoned the match`, () => {
            const s = classic();
            const id = selectedAccount(s);
            tx(s.test, s.a.b1, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId })); // away (A68(2))
            expect(rejection(s.test, 'internal', body(id))).toBe(LOCKED(lobbyRow(s.test, s.lobbyId).joinCode)); // away still locks
            tx(s.test, s.a.b1, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));
            const row = [...s.test.db.LobbyMember.by_lobby_and_user.filter([s.lobbyId, s.a.b1.userId])][0];
            expect(row.abandonedAt).toBeDefined();
            expect([...s.test.db.LobbyMemberAccount.by_account.filter(id)]).toHaveLength(1); // the row stays for the match
            tx(s.test, 'internal', body(id));
            expect(ownedOf(s.test, id)).not.toEqual({ A: 0 });
        });
    }
});

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

// ════════════════════════════════════════════════════════════════════════════
// A142 vs S10u review G2: the step-down route through an Admin roster edit is closed
// ════════════════════════════════════════════════════════════════════════════

describe('A142 (S10u review G2): an Admin roster edit between a bid and its sale is refused; the sale completes at the level checked at the bid', () => {
    const nominatorOf = (s: Lobby) => session(s.test, s.lobbyId).nextNominatorTeam.tag as Side;
    const nominate = (s: Lobby, name: string) => {
        advance(s.test, 300);
        tx(s.test, captain(s, nominatorOf(s)), (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: name }));
    };
    const pass = (s: Lobby, side: Side) => { advance(s.test, 300); tx(s.test, captain(s, side), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId })); };

    /** 2v2 ownership Auction, budgets 10 / 2, minimum raise 1; X costs 10 / 11.5 / 15...; b1 owns X at E0, b2 at E2; Blue nominates X at 10. */
    function bidOnX(verifiedBlue = false) {
        const test = newHarness();
        const s = setupLobby(test, {
            seats: TWO_V_TWO,
            actors: verifiedBlue ? { b1: verified(test, 'b1'), b2: verified(test, 'b2') } : {},
            lobby: { draftMode: { tag: 'Auction' }, requireOwnership: true, characterBudget: 10, lightconeBudget: 2, minimumBidRaise: 1 },
        });
        priceCharacters(s.test, s.lobbyId, ['X'], [10, 11.5, 15, 15, 15, 15, 15]);
        const acct: Record<string, number> = {};
        for (const [who, e] of [['b1', 0], ['b2', 2], ['r1', 0], ['r2', 0]] as const) {
            acct[who] = insertHsrAccount(s.test, s.a[who].userId, `80000010${who.charCodeAt(1)}`);
            s.test.db.HsrAccount.id.update({ ...s.test.db.HsrAccount.id.find(acct[who])!, isActive: false });
            selectAccount(s.test, s.lobbyId, s.a[who].userId, acct[who], { X: e });
        }
        if (nominatorOf(s) !== 'Blue') { nominate(s, 'EMPTY'); pass(s, 'Blue'); }
        nominate(s, 'X'); // Blue holds 10; its default is E0 (extra 0)
        return { s, acct };
    }
    const soldX = (s: Lobby) => steps(s.test, s.lobbyId)
        .filter((x) => x.action.tag === 'AuctionSold')
        .map((x) => x.payload.value as any)
        .find((p) => p.characterName === 'X');

    for (const [name, body] of [
        ['admin_batch_remove_characters (b1 loses X)', (id: number) => (ctx: any) => M.admin_batch_remove_characters(ctx, { hsrAccountId: id, characterNamesJson: '["X"]' })],
        ['admin_batch_upsert_characters (b1 at E2)', (id: number) => (ctx: any) => M.admin_batch_upsert_characters(ctx, { hsrAccountId: id, charactersJson: JSON.stringify([{ characterName: 'X', eidolonLevel: 2 }]) })],
    ] as const) {
        it(`A142: ${name} is refused mid-round; Red passes and X is sold at E0 with no extra (0 / 2)`, () => {
            const { s, acct } = bidOnX();
            expect(rejection(s.test, 'internal', body(acct.b1))).toBe(LOCKED(lobbyRow(s.test, s.lobbyId).joinCode));
            expect(ownedOf(s.test, acct.b1)).toEqual({ X: 0 });
            pass(s, 'Red');
            const sold = soldX(s);
            expect([sold.eidolon, sold.eidolonCost, sold.charCharged, sold.lcCharged]).toEqual([0, 0, 10, 0]);
            const x = session(s.test, s.lobbyId);
            expect({ char: x.teamBlueCharBudget, lc: x.teamBlueLcBudget }).toEqual({ char: 0, lc: 2 });
        });
    }

    // T-S10w fix pass (review F5): the same scenario through the Admin cost tools.
    const xCost = (ladder: number[]) => ({
        characterName: 'X', gameMode: 'MemoryOfChaos', draftMode: 'Auction',
        costs: Object.fromEntries(ladder.map((v, i) => [`e${i}`, v])), costSetId: 0,
    });
    for (const [name, body] of [
        ['admin_bulk_upsert HsrCharacterCost (X e1..e6 at 30)', (ctx: any) =>
            M.admin_bulk_upsert(ctx, { tableName: 'HsrCharacterCost', jsonData: JSON.stringify([xCost([10, 30, 30, 30, 30, 30, 30])]) })],
        ['admin_delete_row HsrCharacterCost (X)', (ctx: any) =>
            M.admin_delete_row(ctx, { tableName: 'HsrCharacterCost', primaryKeyJson: JSON.stringify({ characterName: 'X', gameModeTag: 'MemoryOfChaos', draftModeTag: 'Auction', costSetId: 0 }) })],
    ] as const) {
        it(`A142: ${name} is refused mid-round; Red passes and X is sold at E0 with no extra (0 / 2)`, () => {
            const { s } = bidOnX();
            expect(rejection(s.test, 'internal', body)).toBe(COST_LOCKED(0, 1));
            pass(s, 'Red');
            const sold = soldX(s);
            expect([sold.eidolon, sold.eidolonCost, sold.charCharged, sold.lcCharged]).toEqual([0, 0, 10, 0]);
            const x = session(s.test, s.lobbyId);
            expect({ char: x.teamBlueCharBudget, lc: x.teamBlueLcBudget }).toEqual({ char: 0, lc: 2 });
        });
    }

    // T-S10w fix pass (review F5): the two routes A142 leaves to the S10u fallback, end to end through the reducers.
    /** Sold at E1 (extra 1.5: E2's extra 5 does not fit 0 + 2); Blue 0 / 0.5, total 12 - (10 + 1.5); Red untouched. */
    function expectStepDown(s: Lobby) {
        pass(s, 'Red');
        const sold = soldX(s);
        expect([sold.eidolon, sold.eidolonCost, sold.charCharged, sold.lcCharged]).toEqual([1, 1.5, 10, 1.5]);
        const x = session(s.test, s.lobbyId);
        expect({ char: x.teamBlueCharBudget, lc: x.teamBlueLcBudget }).toEqual({ char: 0, lc: 0.5 });
        expect(x.teamBlueCharBudget + x.teamBlueLcBudget).toBe(12 - (10 + 1.5)); // no budget created
        expect({ char: x.teamRedCharBudget, lc: x.teamRedLcBudget }).toEqual({ char: 10, lc: 2 });
    }

    it('A142 (route 1): server_delete_user of a seated Blue player mid-round removes its account rows; the sale steps down to E1', () => {
        const { s, acct } = bidOnX(true);
        const username = s.test.db.User.id.find(s.a.b1.userId)!.username;
        tx(s.test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));
        expect(s.test.db.HsrAccount.id.find(acct.b1)).toBeNull();
        expect(ownedOf(s.test, acct.b1)).toEqual({});
        expectStepDown(s);
    });

    it('A142 (route 2): a Blue player who abandons the match may then edit the selected roster as its owner; the sale steps down to E1', () => {
        const { s, acct } = bidOnX(true);
        const removeX = (ctx: any) => M.batch_remove_characters(ctx, { hsrAccountId: acct.b1, characterNamesJson: '["X"]' });
        tx(s.test, s.a.b1, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId })); // away: still locked
        expect(rejection(s.test, s.a.b1, removeX)).toMatch(/Leave the lobby first\.$/);
        tx(s.test, s.a.b1, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));
        tx(s.test, s.a.b1, removeX);
        expect(ownedOf(s.test, acct.b1)).toEqual({});
        expectStepDown(s);
    });
});
