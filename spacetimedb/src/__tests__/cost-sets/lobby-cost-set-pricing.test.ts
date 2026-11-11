// Cost sets: every price comes from the lobby's own cost set, game mode and draft mode; a missing entry is refused.
// Decisions: A107, A108
// Contracts: docs/cost-sets/contract.md
// From S10i (s10i-draft-cost.test.ts).
import { describe, expect, it } from 'vitest';
import {
    characterCostAt,
    doesCostSetCover,
    lightconeCostAt,
} from '@module/helpers/draft/costSetGuards';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    dropDefaultCostCoverage,
    ensureCharacterRef,
    ensureLightconeRef,
    guest,
    lobbyRow,
    newBareHarness,
    newHarness,
    priceCharacterAt,
    priceCharacters,
    priceLightconeAt,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    rejection,
    type Team,
} from '../fixtures/harness';
import { host as tournamentHost } from '../fixtures/identity';
import { seedReferenceNames } from '../fixtures/roster';
import {
    MOC,
    charRow,
    createSet,
    editChar,
    editLc,
    key0,
    ladder,
    liveChars,
    publish,
    sLadder,
    type Mode,
} from '../fixtures/cost-sets';
import {
    H,
    arrange,
    blueNames,
    captain,
    completeDraft,
    draftAuction,
    draftClassic,
    halves,
    insertSynergy,
    lineup,
    redNames,
    selectAccount,
    blueMate,
    equipBody,
    expireTurn,
    lastStepOf,
    lobbyState,
    nominateBody,
    passBody,
    payloadOf,
    pickBody,
    withAccounts,
} from '../fixtures/draft-and-scoring';

const COST_MISSING = (name: string) => `${name} has no cost in this lobby's cost set.`;

interface Prices {
    chars?: Record<string, Partial<Record<Mode, number[]>>>;
    lcs?: Record<string, Partial<Record<Mode, number[]>>>;
}

/** Seeds the reference rows, creates a set (clone of `sourceSetId`), writes the draft prices, publishes it (confirm). */
function pricedSet(test: Harness, owner: Actor, name: string, p: Prices, sourceSetId = 0): number {
    seedReferenceNames(test, Object.keys(p.chars ?? {}), Object.keys(p.lcs ?? {}));
    const id = createSet(test, owner, name, sourceSetId);
    for (const [n, modes] of Object.entries(p.chars ?? {})) for (const [m, l] of Object.entries(modes)) editChar(test, owner, id, n, m as Mode, l!);
    for (const [n, modes] of Object.entries(p.lcs ?? {})) for (const [m, l] of Object.entries(modes)) editLc(test, owner, id, n, m as Mode, l!);
    publish(test, owner, id, true);
    return id;
}
const bidBody = (s: Lobby, bidAmount: number) => (ctx: any) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount });
const eidolonBody = (s: Lobby, team: Team, characterName: string, eidolon: number) => (ctx: any) =>
    M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: { tag: team }, characterName, eidolon });

// ════════════════════════════════════════════════════════════════════════════
// B.2 A107(1): every price is the lobby's own set, game mode and draft mode
// ════════════════════════════════════════════════════════════════════════════

/**
 * Set 0 prices `k` (Classic 1.., Auction 3..) and `lc` (Classic 1.., Auction 2..); the custom set, cloned from it and
 * edited, prices `k` Classic 10..16 and Auction 20, 22, .., 32, and `lc` Classic 5..9 and Auction 15..19. Every price
 * differs from the default set's and Classic differs from Auction.
 */
function customWorld() {
    const test = newHarness();
    const owner = tournamentHost(test, 'owner');
    ensureCharacterRef(test, 'k');
    ensureLightconeRef(test, 'lc');
    priceCharacterAt(test, key0('Classic'), 'k', ladder(1));
    priceCharacterAt(test, key0('Auction'), 'k', ladder(3));
    priceLightconeAt(test, key0('Classic'), 'lc', sLadder(1));
    priceLightconeAt(test, key0('Auction'), 'lc', sLadder(2));
    const id = pricedSet(test, owner, 'custom', {
        chars: { k: { Classic: ladder(10), Auction: ladder(20, 2) } },
        lcs: { lc: { Classic: sLadder(5), Auction: sLadder(15) } },
    });
    return { test, owner, id };
}

describe('A107(1): every price is read from the lobby\'s own cost set, game mode and draft mode', () => {
    it('Classic lobby on a custom set: pick_character, set_eidolon and equip_lightcone charge the custom Classic prices (A107(1), A101)', () => {
        const { test, id } = customWorld();
        const s = setupLobby(test, { lobby: { costSetId: id } });
        tx(test, captain(s, 'Blue'), pickBody(s, 'k', 2));
        expect(payloadOf(test, s.lobbyId, 'Pick')).toMatchObject({ characterName: 'k', eidolon: 2, costPaid: 12 });
        completeDraft(s);
        tx(test, captain(s, 'Blue'), eidolonBody(s, 'Blue', 'k', 4));
        expect(payloadOf(test, s.lobbyId, 'SetEidolon')).toMatchObject({ characterName: 'k', eidolon: 4, costPaid: 14 });
        advance(test, 300); // the lineup throttle
        const lcBefore = session(test, s.lobbyId).teamBlueLcBudget;
        tx(test, captain(s, 'Blue'), equipBody(s, 'Blue', 'k', 'lc', 2));
        expect(payloadOf(test, s.lobbyId, 'EquipLightcone')).toMatchObject({ lightconeName: 'lc', superimposition: 2, costPaid: 6 });
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(lcBefore - 6);
    });

    it('Classic lobby on a custom set: the timer auto-pick charges the custom Classic e0, not the default set\'s (A107(1), A86)', () => {
        const { test, id } = customWorld();
        const s = setupLobby(test, { lobby: { costSetId: id, autoRandomPick: true }, beforeStart: withAccounts(test) });
        expireTurn(s);
        const step = lastStepOf(test, s.lobbyId, 'Pick');
        expect(step.actorUserId).toBe(0);
        expect(step.payload.value).toMatchObject({ characterName: 'k', eidolon: 0, costPaid: 10 });
    });

    it('Auction lobby on a custom set: nomination base, the sale\'s eidolon extra, set_eidolon and equip_lightcone charge the custom Auction prices, never the Classic rows (A107(1), A101, A61, A64)', () => {
        const { test, id } = customWorld();
        const s = setupLobby(test, { lobby: { costSetId: id, draftMode: { tag: 'Auction' }, requireOwnership: true } });
        selectAccount(test, s.lobbyId, captain(s, 'Blue').userId, 900, { k: 2 });
        selectAccount(test, s.lobbyId, blueMate(s).userId, 901, { k: 4 });
        tx(test, captain(s, 'Blue'), nominateBody(s, 'k'));
        expect(session(test, s.lobbyId).currentBidAmount).toBe(20); // custom Auction e0 (Classic 10, default 3)
        tx(test, captain(s, 'Red'), passBody(s));
        const sold = payloadOf(test, s.lobbyId, 'AuctionSold');
        expect(sold).toMatchObject({ characterName: 'k', winningAmount: 20, eidolon: 2, eidolonCost: 4 }); // 24 - 20
        completeDraft(s, 'EMPTY');
        tx(test, captain(s, 'Blue'), eidolonBody(s, 'Blue', 'k', 4));
        expect(payloadOf(test, s.lobbyId, 'SetEidolon')).toMatchObject({ eidolon: 4, costPaid: 8 }); // 28 - 20
        advance(test, 300);
        tx(test, captain(s, 'Blue'), equipBody(s, 'Blue', 'k', 'lc', 2));
        expect(payloadOf(test, s.lobbyId, 'EquipLightcone')).toMatchObject({ lightconeName: 'lc', costPaid: 16 }); // Auction s2
    });

    it('a set with no rows for a draft mode cannot be selected for it: create_lobby in that mode is rejected, the priced mode is accepted (A107(1)(2), doesCostSetCover)', () => {
        const test = newBareHarness(); // fix pass (review F2): the clone of set 0 carries no coverage rows
        const owner = tournamentHost(test, 'owner');
        const id = pricedSet(test, owner, 'classic only', { chars: { k: { Classic: ladder(1) } }, lcs: { lc: { Classic: sLadder(1) } } });
        expect(liveChars(test, id).map((r) => r.draftMode.tag)).toEqual(['Classic']); // A107(2): an unpriced mode is not filled
        expect(tx(test, 'internal', (ctx) => [doesCostSetCover(ctx, id, MOC, 'Classic'), doesCostSetCover(ctx, id, MOC, 'Auction')]))
            .toEqual([true, false]);
        const h = guest(test, 'h');
        const msg = rejection(test, h, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, costSetId: id, draftMode: { tag: 'Auction' } } as any));
        expect([...test.db.Lobby.iter()]).toHaveLength(0);
        expect(msg).toBe('This cost set has no costs for MemoryOfChaos × Auction. Pick another set or ask its owner to extend it.');
        tx(test, h, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, costSetId: id } as any));
        expect([...test.db.Lobby.iter()].map((l) => l.costSetId)).toEqual([id]);
    });

    it('fix pass (review F2, A108(2)): the default set is checked like any other: with no Auction rows an Auction lobby on set 0 is refused at creation with the coverage text; Classic is accepted', () => {
        const test = newHarness();
        dropDefaultCostCoverage(test); // set 0 as a database that was not re-seeded: Classic rows only
        priceCharacterAt(test, key0('Classic'), 'k', ladder(1));
        priceLightconeAt(test, key0('Classic'), 'lc', sLadder(1));
        expect(tx(test, 'internal', (ctx) => [doesCostSetCover(ctx, 0, MOC, 'Classic'), doesCostSetCover(ctx, 0, MOC, 'Auction')]))
            .toEqual([true, false]);
        const h = guest(test, 'h');
        const msg = rejection(test, h, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, costSetId: 0, draftMode: { tag: 'Auction' } } as any));
        expect([...test.db.Lobby.iter()]).toHaveLength(0);
        expect(msg).toBe('This cost set has no costs for MemoryOfChaos × Auction. Pick another set or ask its owner to extend it.');
        tx(test, h, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, costSetId: 0 } as any));
        expect([...test.db.Lobby.iter()].map((l) => [l.costSetId, l.draftMode.tag])).toEqual([[0, 'Classic']]);
    });

    it('fix pass (review F3, A108(2)): a cost row that lacks the requested eidolon or superimposition field is rejected with a text naming the entry and the field, never priced at a default', () => {
        // Engineered: the reducers bound eidolon to 0..6 and superimposition to 1..5, the fields every row carries, so the
        // lookups are called directly with a level outside them.
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        priceCharacters(test, s.lobbyId, ['k'], ladder(1));
        priceLightconeAt(test, key0('Classic'), 'lc', sLadder(1));
        const lobby = lobbyRow(test, s.lobbyId);
        expect(tx(test, 'internal', (ctx) => [characterCostAt(ctx, lobby, 'k', 6), lightconeCostAt(ctx, lobby, 'lc', 5)])).toEqual([7, 5]);
        expect(rejection(test, 'internal', (ctx) => characterCostAt(ctx, lobby, 'k', 7))).toBe('The cost row of k has no e7 value.');
        expect(rejection(test, 'internal', (ctx) => lightconeCostAt(ctx, lobby, 'lc', 6))).toBe('The cost row of lc has no s6 value.');
        expect(tx(test, 'internal', (ctx) => characterCostAt(ctx, lobby, 'EMPTY', 7))).toBe(0); // EMPTY is 0 by rule
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B.3 A107(5) / A108: an entry with no row cannot be drafted
// ════════════════════════════════════════════════════════════════════════════

/**
 * A harness whose lobbies use set 0 ('default') or a published custom set ('custom'): `k` and `lc` priced in both draft
 * modes; `ghost` / `ghostlc` are reference rows added after the custom set went live, so neither set prices them.
 */
function ghostWorld(which: 'default' | 'custom') {
    const test = newHarness();
    let costSetId = 0;
    if (which === 'default') {
        for (const m of ['Classic', 'Auction'] as const) {
            priceCharacterAt(test, key0(m), 'k', ladder(1));
            priceLightconeAt(test, key0(m), 'lc', sLadder(1));
        }
    } else {
        const owner = tournamentHost(test, 'owner');
        costSetId = pricedSet(test, owner, 'live set', {
            chars: { k: { Classic: ladder(1), Auction: ladder(1) } },
            lcs: { lc: { Classic: sLadder(1), Auction: sLadder(1) } },
        });
    }
    ensureCharacterRef(test, 'ghost'); // added to the reference data after the set went live (A107(5))
    ensureLightconeRef(test, 'ghostlc');
    return { test, costSetId };
}

describe('A107(5) / A108(2): an entry with no row in the lobby\'s set and mode is refused, on the default set as on any other', () => {
    for (const which of ['default', 'custom'] as const) {
        it(`${which} set, Classic: pick, set_eidolon and equip of an unpriced entry are refused with the text and change nothing (A107(5), A108(2))`, () => {
            const { test, costSetId } = ghostWorld(which);
            const s = setupLobby(test, { lobby: { costSetId } });
            let before = lobbyState(s);
            let msg = rejection(test, captain(s, 'Blue'), pickBody(s, 'ghost'));
            expect(lobbyState(s)).toBe(before);
            expect(msg).toBe(COST_MISSING('ghost'));

            tx(test, captain(s, 'Blue'), pickBody(s, 'k')); // the priced entry passes
            completeDraft(s);
            before = lobbyState(s);
            msg = rejection(test, captain(s, 'Blue'), equipBody(s, 'Blue', 'k', 'ghostlc'));
            expect(lobbyState(s)).toBe(before);
            expect(msg).toBe(COST_MISSING('ghostlc'));

            // Engineered: k's row disappears while it is drafted (a patch cannot do it mid-game, A107(4)), so set_eidolon
            // meets a drafted character with no row.
            test.db.HsrCharacterCost.delete(charRow(liveChars(test, costSetId), 'k')!);
            before = lobbyState(s);
            msg = rejection(test, captain(s, 'Blue'), eidolonBody(s, 'Blue', 'k', 1));
            expect(lobbyState(s)).toBe(before);
            expect(msg).toBe(COST_MISSING('k'));
        });

        it(`${which} set, Auction: nominate and bid of an unpriced entry are refused with the text and change nothing (A107(5), A108(2))`, () => {
            const { test, costSetId } = ghostWorld(which);
            const s = setupLobby(test, { lobby: { costSetId, draftMode: { tag: 'Auction' } } });
            let before = lobbyState(s);
            let msg = rejection(test, captain(s, 'Blue'), nominateBody(s, 'ghost'));
            expect(lobbyState(s)).toBe(before);
            expect(msg).toBe(COST_MISSING('ghost'));

            tx(test, captain(s, 'Blue'), nominateBody(s, 'k'));
            // Engineered: the open nomination's row disappears (no reducer can do it mid-game, A107(4)); the bid reads it.
            test.db.HsrCharacterCost.delete(charRow(liveChars(test, costSetId), 'k', 'Auction')!);
            before = lobbyState(s);
            msg = rejection(test, captain(s, 'Red'), bidBody(s, 5));
            expect(lobbyState(s)).toBe(before);
            expect(msg).toBe(COST_MISSING('k'));
        });
    }

    it('the Classic timer auto-pick never draws an unpriced character, with or without requireOwnership (A107(5))', () => {
        // Without ownership the pool is the priced characters: k, then nothing (EMPTY).
        const { test } = ghostWorld('default');
        const s = setupLobby(test, { lobby: { autoRandomPick: true }, beforeStart: withAccounts(test) });
        for (let i = 0; i < 3; i++) expireTurn(s);
        const picked = steps(test, s.lobbyId).filter((st) => st.action.tag === 'Pick').sort((a, b) => a.sequence - b.sequence)
            .map((st) => (st.payload.value as any).characterName);
        expect(picked).toEqual(['k', 'EMPTY', 'EMPTY']);

        // With ownership Blue owns both; the pool is the owned characters that have a row: k, then EMPTY.
        const t2 = ghostWorld('default').test;
        const o = setupLobby(t2, {
            lobby: { autoRandomPick: true, requireOwnership: true },
            beforeStart: withAccounts(t2, { b1: { ghost: 0, k: 0 } }),
        });
        for (let i = 0; i < 4; i++) expireTurn(o); // B R R B
        const bluePicks = steps(t2, o.lobbyId).filter((st) => st.action.tag === 'Pick' && st.actorSlot.tag === 'Blue')
            .sort((a, b) => a.sequence - b.sequence).map((st) => (st.payload.value as any).characterName);
        expect(bluePicks).toEqual(['k', 'EMPTY']);
    });

    for (const mode of ['Classic', 'Auction'] as const) {
        it(`${mode}: the timer auto-ban draws only characters priced in the lobby's draft mode, then SKIP (A107(1)(5), A101)`, () => {
            const test = newHarness();
            ensureCharacterRef(test, 'ghost');
            priceCharacterAt(test, key0(mode), 'k', ladder(1));
            priceCharacterAt(test, key0(mode === 'Classic' ? 'Auction' : 'Classic'), 'ghost', ladder(1)); // the other mode only
            const s = setupLobby(test, { lobby: { draftMode: { tag: mode }, banMode: { tag: 'Four' }, autoRandomPick: true }, beforeStart: withAccounts(test) });
            expireTurn(s);
            expireTurn(s);
            const bans = steps(test, s.lobbyId).filter((st) => st.action.tag === 'Ban').sort((a, b) => a.sequence - b.sequence)
                .map((st) => [st.actorUserId, (st.payload.value as any).characterName]);
            expect(bans).toEqual([[0, 'k'], [0, 'SKIP']]);
        });
    }

    it('EMPTY is always accepted at cost 0 with no row: a Classic pick and an Auction nomination on a set that prices nothing (A107(5), D-54)', () => {
        const test = newHarness();
        const c = setupLobby(test);
        tx(test, captain(c, 'Blue'), pickBody(c, 'EMPTY'));
        expect(payloadOf(test, c.lobbyId, 'Pick')).toMatchObject({ characterName: 'EMPTY', costPaid: 0 });

        const t2 = newHarness();
        const a = setupLobby(t2, { lobby: { draftMode: { tag: 'Auction' } } });
        tx(t2, captain(a, 'Blue'), nominateBody(a, 'EMPTY'));
        expect(payloadOf(t2, a.lobbyId, 'Nominate')).toMatchObject({ characterName: 'EMPTY' });
        expect(session(t2, a.lobbyId).currentBidAmount).toBe(0);
    });

    it('a synergy pair with no row in the lobby\'s draft mode adds no surcharge and rejects nothing; the priced mode adds it (A107(1), A108(1))', () => {
        // Set 0 holds the blue-1 + blue-2 synergy in Classic only.
        const classic = newHarness();
        insertSynergy(classic, 'blue-1', 'blue-2', 5, 'Classic');
        const c = setupLobby(classic);
        draftClassic(c, blueNames(), redNames());
        arrange(c, captain(c, 'Blue'), 'Blue', halves(blueNames()));
        expect(lineup(classic, c.lobbyId, 'Blue').synergySurcharge).toBe(H(5));

        const auction = newHarness();
        insertSynergy(auction, 'blue-1', 'blue-2', 5, 'Classic');
        const a = setupLobby(auction, { lobby: { draftMode: { tag: 'Auction' } } });
        draftAuction(a, blueNames(), redNames());
        arrange(a, captain(a, 'Blue'), 'Blue', halves(blueNames()));
        expect(lineup(auction, a.lobbyId, 'Blue').synergySurcharge).toBe(0);
    });
});
