// T-S10i: in-memory tests for step S10i, the draft-completion and cost-set rulings of DECISIONS A100, A102, A106,
// A107 (which replaces part of A101) and A108. Spec: those rows and the "Phase S10i execution" sections of
// docs/{cost-sets,match-session,match-results,player-stats,mmr,views}/architecture.md. Everything runs through the
// module's reducers on the SDK's in-memory datastore and TestClock; reference rows, default-set (id 0) cost rows and the
// few engineered states (named as such) are written straight into the datastore outside any transaction, like the S7
// builders. No pricing shortcut of the shared drivers is used where a missing row is the subject. Nothing reaches
// maincloud.
import { describe, expect, it } from 'vitest';
import characterSeed from '../../../data/seed/characters.json';
import lightconeSeed from '../../../data/seed/lightcones.json';
import { teamDraft } from '@module/helpers/results/scoringHelpers';
import { characterCostAt, doesCostSetCover, lightconeCostAt } from '@module/helpers/draft/costSetGuards';
import {
    priceBanNames,
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    ensureCharacterRef,
    ensureLightconeRef,
    guest,
    dropDefaultCostCoverage,
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
    type CostKey,
    type Harness,
    type Lobby,
    type SetupOpts,
} from './s4-fixtures';
import {
    H,
    arrange,
    blueNames,
    captain,
    completeDraft,
    draftAuction,
    draftClassic,
    engineerFullDraft,
    finishGame,
    halves,
    insertSynergy,
    lineup,
    redNames,
    selectAccount,
} from './s7-fixtures';
import { host as tournamentHost, liveField, moderator, setUserRole, verified } from './s8-fixtures';
import { byKey, captainActor, openMatchLobby, seedElo } from './s8d-fixtures';
import { rejection, seedReferenceNames } from './s10-c2-fixtures';
import { ownedAccount, parkedLobby, playRanked, validateAndFinalize } from './s10-a2-fixtures';

// ─── Shared builders ─────────────────────────────────────────────────────────

const MOC = 'MemoryOfChaos';
type Mode = 'Classic' | 'Auction';
type Team = 'Blue' | 'Red';

/** A JSON snapshot of rows (bigint-safe), to prove "nothing changed" / "byte-for-byte unchanged". */
const snap = (...rows: unknown[]) => JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** e0..e6 = base, base + step, ... */
const ladder = (base: number, step = 1) => Array.from({ length: 7 }, (_, i) => base + i * step);
/** s1..s5 = base, base + 1, ... */
const sLadder = (base: number) => Array.from({ length: 5 }, (_, i) => base + i);
const eJson = (l: number[]) => JSON.stringify({ e0: l[0], e1: l[1], e2: l[2], e3: l[3], e4: l[4], e5: l[5], e6: l[6] });
const sJson = (l: number[]) => JSON.stringify({ s1: l[0], s2: l[1], s3: l[2], s4: l[3], s5: l[4] });
const key0 = (draftMode: Mode): CostKey => ({ costSetId: 0, gameMode: MOC, draftMode });

const COST_MISSING = (name: string) => `${name} has no cost in this lobby's cost set.`;
const LOCKED = 'This cost set is locked; its costs cannot be changed.';
const UNPUBLISHED = 'This cost set is unpublished; its costs cannot be changed.';
const PATCH_BLOCKED = (n: number) =>
    `Cannot patch this cost set while ${n} ${n === 1 ? 'lobby using it is' : 'lobbies using it are'} in Drafting, Equipping or Scoring.`;
const TURN_MS = 30_000; // DEFAULT_LOBBY_ARGS.standardTurnSeconds

// Cost-set reducers (Memory of Chaos sets).
function createSet(test: Harness, who: Actor | 'internal', name: string, sourceSetId = 0): number {
    tx(test, who, (ctx) => M.create_cost_set(ctx, { name, sourceSetId, gameModeTag: MOC }));
    return [...test.db.CostSet.iter()].find((r) => r.name === name)!.id;
}
const editChar = (test: Harness, who: Actor | 'internal', costSetId: number, characterName: string, draftModeTag: Mode, l: number[]) =>
    tx(test, who, (ctx) => M.edit_draft_character_cost(ctx, { costSetId, characterName, gameModeTag: MOC, draftModeTag, costsJson: eJson(l) }));
const editLc = (test: Harness, who: Actor | 'internal', costSetId: number, lightconeName: string, draftModeTag: Mode, l: number[]) =>
    tx(test, who, (ctx) => M.edit_draft_lightcone_cost(ctx, { costSetId, lightconeName, gameModeTag: MOC, draftModeTag, costsJson: sJson(l) }));
const editSyn = (test: Harness, who: Actor | 'internal', costSetId: number, sourceName: string, targetName: string, draftModeTag: Mode, costModifier: number) =>
    tx(test, who, (ctx) => M.edit_draft_synergy_cost(ctx, { costSetId, sourceName, targetName, gameModeTag: MOC, draftModeTag, costModifier }));
const publishBody = (costSetId: number, confirmFillMissing?: boolean) => (ctx: any) =>
    M.publish_cost_set(ctx, { costSetId, confirmFillMissing });
const publish = (test: Harness, who: Actor | 'internal', costSetId: number, confirmFillMissing?: boolean) =>
    tx(test, who, publishBody(costSetId, confirmFillMissing));

const liveChars = (test: Harness, id: number) => [...test.db.HsrCharacterCost.cost_set_id.filter(id)];
const liveLcs = (test: Harness, id: number) => [...test.db.HsrLightconeCost.cost_set_id.filter(id)];
const liveSyns = (test: Harness, id: number) => [...test.db.HsrSynergyCost.cost_set_id.filter(id)];
const draftChars = (test: Harness, id: number) => [...test.db.CostSetDraftCharacter.cost_set_id.filter(id)];
const draftLcs = (test: Harness, id: number) => [...test.db.CostSetDraftLightcone.cost_set_id.filter(id)];
const draftSyns = (test: Harness, id: number) => [...test.db.CostSetDraftSynergy.cost_set_id.filter(id)];
const charRow = (rows: any[], name: string, mode: Mode = 'Classic') =>
    rows.find((r) => r.characterName === name && r.draftMode.tag === mode && r.gameMode.tag === MOC);
const lcRow = (rows: any[], name: string, mode: Mode = 'Classic') =>
    rows.find((r) => r.lightconeName === name && r.draftMode.tag === mode && r.gameMode.tag === MOC);
/** `name|mode|e0` (characters) or `name|mode|s1` (light cones), sorted: the price image of a row set. */
const priceImage = (rows: any[]) =>
    rows.map((r) => `${r.characterName ?? r.lightconeName}|${r.draftMode.tag}|${r.costs.e0 ?? r.costs.s1}`).sort();

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

// Draft calls with no pricing: a missing row stays missing.
const pickBody = (s: Lobby, characterName: string, eidolon = 0) => (ctx: any) =>
    M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon });
const nominateBody = (s: Lobby, characterName: string) => (ctx: any) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName });
const passBody = (s: Lobby) => (ctx: any) => M.pass_bid(ctx, { lobbyId: s.lobbyId });
const bidBody = (s: Lobby, bidAmount: number) => (ctx: any) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount });
const expireBody = (s: Lobby) => (ctx: any) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId });
const advanceBody = (s: Lobby) => (ctx: any) => M.advance_stage(ctx, { lobbyId: s.lobbyId });
const eidolonBody = (s: Lobby, team: Team, characterName: string, eidolon: number) => (ctx: any) =>
    M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: { tag: team }, characterName, eidolon });
const equipBody = (s: Lobby, team: Team, characterName: string, lightconeName: string, superimposition = 1) => (ctx: any) =>
    M.equip_lightcone(ctx, { lobbyId: s.lobbyId, teamSide: { tag: team }, characterName, lightconeName, superimposition });

const lastStepOf = (test: Harness, lobbyId: number, action: string) =>
    steps(test, lobbyId).filter((st) => st.action.tag === action).sort((a, b) => b.sequence - a.sequence)[0];
const payloadOf = (test: Harness, lobbyId: number, action: string) => lastStepOf(test, lobbyId, action).payload.value as any;
const lobbyState = (s: Lobby) =>
    snap(lobbyRow(s.test, s.lobbyId), session(s.test, s.lobbyId), steps(s.test, s.lobbyId).sort((a, b) => a.sequence - b.sequence));
const held = (s: Lobby, team: Team) => tx(s.test, 'internal', (ctx) => teamDraft(ctx, s.lobbyId, team).characters.length);
const expireTurn = (s: Lobby) => {
    advance(s.test, TURN_MS);
    tx(s.test, s.host, expireBody(s));
};

/**
 * beforeStart for autoRandomPick lobbies: start_draft requires every player to hold a selected account with characters.
 * Each player seat gets one account owning `owned[name]` (default: one unpriced filler, which no pool ever draws).
 */
const withAccounts = (test: Harness, owned: Record<string, Record<string, number>> = {}) => (l: Lobby) => {
    dropDefaultCostCoverage(test); // fix pass (review F2): the set-0 coverage rows leave the timer pools once the lobby exists
    let id = 900;
    for (const [name, who] of Object.entries(l.a)) {
        const m = [...test.db.LobbyMember.by_lobby_and_user.filter([l.lobbyId, who.userId])][0];
        if (!m || (m.lobbySlot.tag !== 'BluePlayer' && m.lobbySlot.tag !== 'RedPlayer')) continue;
        selectAccount(test, l.lobbyId, who.userId, id++, owned[name] ?? { [`own-${name}`]: 0 });
    }
};

/** The non-captain Blue player of a 2v2 lobby. */
const blueMate = (s: Lobby) => [s.a.b1, s.a.b2].find((a) => a.userId !== captain(s, 'Blue').userId)!;

/**
 * Plays `n` draft turns through the reducers: a Classic Pick turn picks a priced filler, a Ban turn bans one; an Auction
 * turn is a nomination of a priced filler, passed by the other captain.
 */
function playSome(s: Lobby, n: number) {
    const { test, lobbyId } = s;
    for (let i = 0; i < n; i++) {
        const sess = session(test, lobbyId);
        const step = sess.draftSequence[sess.turnIndex];
        if (step && !sess.isAuctionPhase) {
            const team = step.teamTurn.tag as Team;
            const name = `some-${team}-${i}`;
            if (step.actionRequired.tag === 'Ban') {
                tx(test, captain(s, team), (ctx) => M.ban_character(ctx, { lobbyId, characterName: name }));
            } else {
                priceCharacters(test, lobbyId, [name]);
                tx(test, captain(s, team), pickBody(s, name));
            }
            continue;
        }
        const team = sess.nextNominatorTeam.tag as Team;
        const name = `some-${team}-${i}`;
        priceCharacters(test, lobbyId, [name]);
        tx(test, captain(s, team), nominateBody(s, name));
        tx(test, captain(s, team === 'Blue' ? 'Red' : 'Blue'), passBody(s));
    }
}

// ════════════════════════════════════════════════════════════════════════════
// B.1 A100: no advance out of an unfinished draft
// ════════════════════════════════════════════════════════════════════════════

describe('A100: advance_stage leaves Drafting only once both teams hold charactersPerTeam', () => {
    for (const mode of ['Classic', 'Auction'] as const) {
        for (const format of ['Halves', 'Thirds'] as const) {
            const perTeam = format === 'Halves' ? 8 : 12;

            it(`${mode} ${format}: refused with the counts while a team is short (nothing changes); accepted with both full, EMPTY placeholders counting (A100)`, () => {
                const test = newHarness();
                const s = setupLobby(test, { lobby: { draftMode: { tag: mode }, lineupFormat: { tag: format } } });
                playSome(s, 3);
                const [blue, red] = [held(s, 'Blue'), held(s, 'Red')];
                expect(blue + red).toBe(3);
                let before = lobbyState(s);
                let msg = rejection(test, s.host, advanceBody(s));
                expect(lobbyState(s)).toBe(before);
                expect(msg).toBe(`The draft is not finished: Blue holds ${blue} of ${perTeam} characters and Red holds ${red} of ${perTeam}.`);

                // Engineered: Blue full (EMPTY steps), Red still short; the reducers never leave this state in Drafting.
                engineerFullDraft(s, () => 'EMPTY', ['Blue']);
                before = lobbyState(s);
                msg = rejection(test, s.host, advanceBody(s));
                expect(lobbyState(s)).toBe(before);
                expect(msg).toBe(`The draft is not finished: Blue holds ${perTeam} of ${perTeam} characters and Red holds ${red} of ${perTeam}.`);

                engineerFullDraft(s, () => 'EMPTY', ['Red']);
                expect([held(s, 'Blue'), held(s, 'Red')]).toEqual([perTeam, perTeam]);
                tx(test, s.host, advanceBody(s));
                expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
            });

            it(`${mode} ${format}: the automatic transition at the end of the draft still reaches Equipping without advance_stage (A100)`, () => {
                const test = newHarness();
                const s = setupLobby(test, { lobby: { draftMode: { tag: mode }, lineupFormat: { tag: format } } });
                completeDraft(s);
                expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
                expect([held(s, 'Blue'), held(s, 'Red')]).toEqual([perTeam, perTeam]);
            });
        }
    }
});

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

// ════════════════════════════════════════════════════════════════════════════
// B.4 A107(2): completeness at publish and view_cost_set_missing
// ════════════════════════════════════════════════════════════════════════════

const missingView = (test: Harness, who: Actor, costSetId: number) =>
    ((M as any).view_cost_set_missing(test.viewContext(who.auth), { costSetId }) as any[])
        .map((r) => `${r.costSetId}|${r.draftMode.tag}|${r.kind}|${r.name}`).sort();

/** Reference data c1..c3 and l1, l2; an owner, a rival host, a Moderator and a plain user. */
function completenessWorld() {
    const test = newBareHarness(); // fix pass (review F2): the clones of set 0 carry no coverage rows
    seedReferenceNames(test, ['c1', 'c2', 'c3'], ['l1', 'l2']);
    return { test, owner: tournamentHost(test, 'owner'), rival: tournamentHost(test, 'rival'), mod: moderator(test), plain: verified(test, 'plain') };
}

describe('A107(2): view_cost_set_missing and publish_cost_set completeness', () => {
    it('the owner and a Moderator see, per priced draft mode, the characters and light cones without a draft row; a rival host, a plain user and an unknown id get nothing (A107(2))', () => {
        const { test, owner, rival, mod, plain } = completenessWorld();
        const id = createSet(test, owner, 'gappy');
        editChar(test, owner, id, 'c1', 'Classic', ladder(1));
        editLc(test, owner, id, 'l1', 'Classic', sLadder(1));
        editChar(test, owner, id, 'c1', 'Auction', ladder(1));
        const expected = [
            'Auction|Character|c2', 'Auction|Character|c3', 'Auction|Lightcone|l1', 'Auction|Lightcone|l2',
            'Classic|Character|c2', 'Classic|Character|c3', 'Classic|Lightcone|l2',
        ].map((x) => `${id}|${x}`);
        expect(missingView(test, owner, id)).toEqual(expected);
        expect(missingView(test, mod, id)).toEqual(expected);
        expect(missingView(test, rival, id)).toEqual([]);
        expect(missingView(test, plain, id)).toEqual([]);
        expect(missingView(test, owner, 4040)).toEqual([]);
    });

    it('a draft mode the set does not price is not listed (A107(2))', () => {
        const { test, owner } = completenessWorld();
        const id = createSet(test, owner, 'classic only');
        editChar(test, owner, id, 'c1', 'Classic', ladder(1));
        expect(missingView(test, owner, id)).toEqual(
            ['Classic|Character|c2', 'Classic|Character|c3', 'Classic|Lightcone|l1', 'Classic|Lightcone|l2'].map((x) => `${id}|${x}`));
    });

    it('publish without confirmation is refused with the per-kind and per-mode counts and publishes nothing; with it the gaps are written at 0 in the draft and the live copy, priced modes only (A107(2))', () => {
        const { test, owner } = completenessWorld();
        const id = createSet(test, owner, 'gappy');
        editChar(test, owner, id, 'c1', 'Classic', ladder(1));
        editLc(test, owner, id, 'l1', 'Classic', sLadder(1));
        editChar(test, owner, id, 'c1', 'Auction', ladder(2));
        const before = snap(test.db.CostSet.id.find(id), draftChars(test, id), draftLcs(test, id), liveChars(test, id), liveLcs(test, id));
        const msg = rejection(test, owner, publishBody(id));
        expect(snap(test.db.CostSet.id.find(id), draftChars(test, id), draftLcs(test, id), liveChars(test, id), liveLcs(test, id))).toBe(before);
        expect(msg).toBe('This cost set has no cost for 4 characters and 3 light cones (Auction: 2 characters, 2 light cones; Classic: 2 characters, 1 light cones). Confirm to publish them at cost 0.');

        publish(test, owner, id, true);
        expect(test.db.CostSet.id.find(id)).toMatchObject({ isDraft: false, isPublished: true });
        expect(priceImage(draftChars(test, id))).toEqual(['c1|Auction|2', 'c1|Classic|1', 'c2|Auction|0', 'c2|Classic|0', 'c3|Auction|0', 'c3|Classic|0']);
        expect(priceImage(draftLcs(test, id))).toEqual(['l1|Auction|0', 'l1|Classic|1', 'l2|Auction|0', 'l2|Classic|0']);
        expect(priceImage(liveChars(test, id))).toEqual(priceImage(draftChars(test, id)));
        expect(priceImage(liveLcs(test, id))).toEqual(priceImage(draftLcs(test, id)));
        for (const r of ([...liveChars(test, id), ...liveLcs(test, id)] as any[]).filter((x) => (x.characterName ?? x.lightconeName) !== 'c1' && !((x.lightconeName === 'l1') && x.draftMode.tag === 'Classic'))) {
            expect(Object.values(r.costs).every((v) => v === 0)).toBe(true); // every eidolon / superimposition at 0
        }
        expect(missingView(test, owner, id)).toEqual([]);

        // Priced modes only: a Classic-only set gets no Auction row from the fill.
        const classicOnly = createSet(test, owner, 'classic only');
        editChar(test, owner, classicOnly, 'c1', 'Classic', ladder(1));
        publish(test, owner, classicOnly, true);
        expect([...liveChars(test, classicOnly), ...liveLcs(test, classicOnly)].map((r) => r.draftMode.tag)).not.toContain('Auction');
        expect(liveChars(test, classicOnly)).toHaveLength(3);
        expect(liveLcs(test, classicOnly)).toHaveLength(2);
    });

    it('a complete draft publishes without confirmation (A107(2))', () => {
        const { test, owner } = completenessWorld();
        const id = createSet(test, owner, 'complete');
        for (const c of ['c1', 'c2', 'c3']) editChar(test, owner, id, c, 'Classic', ladder(1));
        for (const l of ['l1', 'l2']) editLc(test, owner, id, l, 'Classic', sLadder(1));
        publish(test, owner, id);
        expect(test.db.CostSet.id.find(id)).toMatchObject({ isPublished: true });
        expect(liveChars(test, id)).toHaveLength(3);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B.5 A107(3)(4): patch in place
// ════════════════════════════════════════════════════════════════════════════

/** A published set (complete in Classic): k 10.., k2 30.., lc 5.., synergy k + k2 = 1. */
function patchWorld() {
    const test = newBareHarness(); // fix pass (review F2): the clone of set 0 carries no coverage rows
    const owner = tournamentHost(test, 'owner');
    seedReferenceNames(test, ['k', 'k2'], ['lc']);
    const id = createSet(test, owner, 'patchable');
    editChar(test, owner, id, 'k', 'Classic', ladder(10));
    editChar(test, owner, id, 'k2', 'Classic', ladder(30));
    editLc(test, owner, id, 'lc', 'Classic', sLadder(5));
    editSyn(test, owner, id, 'k', 'k2', 'Classic', 1);
    publish(test, owner, id);
    return { test, owner, id };
}

/** Distinct actor names per lobby in one harness (identities come from the JWT sub). */
const seatsFor = (tag: string): SetupOpts => ({ seats: [[`${tag}-b`, 'BluePlayer'], [`${tag}-r`, 'RedPlayer']] });
function lobbyOn(test: Harness, costSetId: number, tag: string, over: SetupOpts = {}): Lobby {
    return setupLobby(test, { ...seatsFor(tag), actors: { host: guest(test, `${tag}-host`) }, lobby: { costSetId }, ...over });
}

describe('A107(3)(4): a published set is patched in place', () => {
    it('an edit reaches the live rows only at the next publish; the live rows then equal the draft under the same id; unchanged rows are not rewritten; synergies included (A107(3))', () => {
        const { test, owner, id } = patchWorld();
        const k2Before = snap(charRow(liveChars(test, id), 'k2'));
        const lcBefore = snap(lcRow(liveLcs(test, id), 'lc'));
        const kBefore = charRow(liveChars(test, id), 'k')!;
        const synBefore = liveSyns(test, id)[0];
        advance(test, 5_000);

        editChar(test, owner, id, 'k', 'Classic', ladder(20));
        editSyn(test, owner, id, 'k2', 'k', 'Classic', 2.5);
        expect(charRow(liveChars(test, id), 'k')!.costs.e0).toBe(10); // live untouched until publish
        expect(liveSyns(test, id)[0].costModifier).toBe(1);

        publish(test, owner, id);
        expect(test.db.CostSet.id.find(id)).toMatchObject({ id, isPublished: true, isDraft: false });
        const kAfter = charRow(liveChars(test, id), 'k')!;
        expect(kAfter.costs.e0).toBe(20);
        expect(kAfter.createdDate).toEqual(kBefore.createdDate); // auditUpdate keeps the creation stamp
        expect(kAfter.lastModifiedDate.microsSinceUnixEpoch).toBeGreaterThan(kBefore.lastModifiedDate.microsSinceUnixEpoch);
        expect(snap(charRow(liveChars(test, id), 'k2'))).toBe(k2Before); // unchanged: not rewritten
        expect(snap(lcRow(liveLcs(test, id), 'lc'))).toBe(lcBefore);
        const synAfter = liveSyns(test, id)[0];
        expect(liveSyns(test, id)).toHaveLength(1);
        expect(synAfter).toMatchObject({ id: synBefore.id, costModifier: 2.5 });
        expect(priceImage(liveChars(test, id))).toEqual(priceImage(draftChars(test, id)));
        expect(priceImage(liveLcs(test, id))).toEqual(priceImage(draftLcs(test, id)));
    });

    // No reducer removes a single draft row (edit_draft_* upserts, delete_cost_set removes the whole set). The engineered
    // case below documents what publish does with a live row that has no draft row.
    it('engineered: a live row with no draft row is deleted by the next publish (A107(3); no reducer removes one draft row)', () => {
        const { test, owner, id } = patchWorld();
        test.db.CostSetDraftCharacter.delete(charRow(draftChars(test, id), 'k2')!);
        test.db.CostSetDraftSynergy.delete(draftSyns(test, id)[0]);
        publish(test, owner, id, true); // k2 is a gap again: confirmed at 0
        expect(charRow(liveChars(test, id), 'k2')!.costs.e0).toBe(0);
        expect(liveSyns(test, id)).toHaveLength(0);
    });

    it('lobbies in Waiting and AwaitingResult do not block a patch; Drafting, Equipping and Scoring do, with the count; once those games end the patch passes (A107(4))', () => {
        const { test, owner, id } = patchWorld();
        // The lobby drivers add reference rows for the names they draft, so every publish here confirms the gaps (A107(2)).
        const waiting = lobbyOn(test, id, 'w', { noStart: true });
        const parked = parkedLobby(test, { lobby: { costSetId: id } });
        expect([lobbyRow(test, waiting.lobbyId).stage.tag, lobbyRow(test, parked.lobbyId).stage.tag]).toEqual(['Waiting', 'AwaitingResult']);
        editChar(test, owner, id, 'k', 'Classic', ladder(11));
        publish(test, owner, id, true);
        expect(charRow(liveChars(test, id), 'k')!.costs.e0).toBe(11);

        const one = lobbyOn(test, id, 'one'); // Drafting
        editChar(test, owner, id, 'k', 'Classic', ladder(12)); // the draft stays editable while games run
        let before = snap(liveChars(test, id), test.db.CostSet.id.find(id));
        let msg = rejection(test, owner, publishBody(id, true));
        expect(snap(liveChars(test, id), test.db.CostSet.id.find(id))).toBe(before);
        expect(msg).toBe(PATCH_BLOCKED(1));

        const two = lobbyOn(test, id, 'two');
        completeDraft(two); // Equipping
        before = snap(liveChars(test, id));
        msg = rejection(test, owner, publishBody(id, true));
        expect(msg).toBe(PATCH_BLOCKED(2));
        tx(test, two.host, advanceBody(two)); // Scoring still blocks
        msg = rejection(test, owner, publishBody(id, true));
        expect(snap(liveChars(test, id))).toBe(before);
        expect(msg).toBe(PATCH_BLOCKED(2));

        completeDraft(one);
        finishGame(one); // casual: finalized at the close, the lobby is gone
        msg = rejection(test, owner, publishBody(id, true));
        expect(msg).toBe(PATCH_BLOCKED(1));
        finishGame(two);
        publish(test, owner, id, true);
        expect(charRow(liveChars(test, id), 'k')!.costs.e0).toBe(12);
    });

    it('a preset and a tournament pointing at the set are not changed by a patch and their next lobby reads the new prices (A107(3))', () => {
        // Preset.
        const { test, owner, id } = patchWorld();
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'on the set', costSetId: id } as any));
        const preset = [...test.db.LobbyPreset.iter()].find((p) => p.name === 'on the set')!;
        const presetBefore = snap(preset);
        editChar(test, owner, id, 'k', 'Classic', ladder(20));
        publish(test, owner, id);
        expect(snap(test.db.LobbyPreset.id.find(preset.id))).toBe(presetBefore);
        const s = lobbyOn(test, id, 'p', { lobby: { costSetId: preset.costSetId } });
        tx(test, captain(s, 'Blue'), pickBody(s, 'k'));
        expect(payloadOf(test, s.lobbyId, 'Pick')).toMatchObject({ characterName: 'k', costPaid: 20 });

        // Tournament: the organizer's set is pointed at by the tournament row (engineered selection: the set is created
        // after the field, and the selection path is not the subject here).
        const f = liveField(2);
        seedReferenceNames(f.test, ['k'], ['lc']);
        const tid = createSet(f.test, f.org, 'cup set');
        editChar(f.test, f.org, tid, 'k', 'Classic', ladder(10));
        editLc(f.test, f.org, tid, 'lc', 'Classic', sLadder(5));
        publish(f.test, f.org, tid, true);
        f.test.db.Tournament.id.update({ ...f.test.db.Tournament.id.find(f.id)!, costSetId: tid });
        const tBefore = snap(f.test.db.Tournament.id.find(f.id));
        editChar(f.test, f.org, tid, 'k', 'Classic', ladder(40));
        publish(f.test, f.org, tid, true);
        expect(snap(f.test.db.Tournament.id.find(f.id))).toBe(tBefore);
        const ts = openMatchLobby(f, byKey(f.test, f.id, 'W-R1-M1').id);
        expect(lobbyRow(f.test, ts.lobbyId).costSetId).toBe(tid);
        for (let i = 0; session(f.test, ts.lobbyId).draftSequence[session(f.test, ts.lobbyId).turnIndex].actionRequired.tag === 'Ban'; i++) {
            const team = session(f.test, ts.lobbyId).draftSequence[session(f.test, ts.lobbyId).turnIndex].teamTurn.tag as Team;
            tx(f.test, captainActor(ts, team), (ctx) => (priceBanNames(ctx, ts.lobbyId, [`tb-${i}`]), M.ban_character(ctx, { lobbyId: ts.lobbyId, characterName: `tb-${i}` }))); // T-S10r (A122(7), L32): a ban names a priced character
        }
        tx(f.test, captainActor(ts, 'Blue'), pickBody(ts, 'k'));
        expect(payloadOf(f.test, ts.lobbyId, 'Pick')).toMatchObject({ characterName: 'k', costPaid: 40 });
    });

    it('a clone copies the live rows, not pending draft edits; a set published before S10i (no draft rows) rebuilds its draft on the first edit (A107(3))', () => {
        const { test, owner, id } = patchWorld();
        editChar(test, owner, id, 'k', 'Classic', ladder(20)); // pending, not published
        const copy = createSet(test, owner, 'copy', id);
        expect(charRow(draftChars(test, copy), 'k')!.costs.e0).toBe(10);

        // Engineered pre-S10i state: publish used to delete the draft rows.
        const old = createSet(test, owner, 'old');
        editChar(test, owner, old, 'k', 'Classic', ladder(10));
        editChar(test, owner, old, 'k2', 'Classic', ladder(30));
        editLc(test, owner, old, 'lc', 'Classic', sLadder(5));
        editSyn(test, owner, old, 'k', 'k2', 'Classic', 1);
        publish(test, owner, old);
        for (const r of draftChars(test, old)) test.db.CostSetDraftCharacter.delete(r);
        for (const r of draftLcs(test, old)) test.db.CostSetDraftLightcone.delete(r);
        for (const r of draftSyns(test, old)) test.db.CostSetDraftSynergy.delete(r);
        editChar(test, owner, old, 'k2', 'Classic', ladder(31));
        expect(priceImage(draftChars(test, old))).toEqual(['k2|Classic|31', 'k|Classic|10']);
        expect(priceImage(draftLcs(test, old))).toEqual(['lc|Classic|5']);
        expect(draftSyns(test, old).map((r) => [r.characterA, r.characterB, r.costModifier])).toEqual([['k', 'k2', 1]]);
    });

    it('a locked or an unpublished set rejects edits and publish with their texts; delete clears the draft and the live rows (A107(3))', () => {
        const { test, owner, id } = patchWorld();
        tx(test, owner, (ctx) => M.lock_cost_set(ctx, { costSetId: id }));
        expect(rejection(test, owner, (ctx) => M.edit_draft_character_cost(ctx, { costSetId: id, characterName: 'k', gameModeTag: MOC, draftModeTag: 'Classic', costsJson: eJson(ladder(1)) }))).toBe(LOCKED);
        expect(rejection(test, owner, publishBody(id, true))).toBe(LOCKED);
        tx(test, owner, (ctx) => M.unpublish_cost_set(ctx, { costSetId: id }));
        expect(rejection(test, owner, (ctx) => M.edit_draft_lightcone_cost(ctx, { costSetId: id, lightconeName: 'lc', gameModeTag: MOC, draftModeTag: 'Classic', costsJson: sJson(sLadder(1)) }))).toBe(UNPUBLISHED);
        expect(rejection(test, owner, publishBody(id, true))).toBe(UNPUBLISHED);
        tx(test, owner, (ctx) => M.delete_cost_set(ctx, { costSetId: id }));
        expect([draftChars, draftLcs, draftSyns, liveChars, liveLcs, liveSyns].map((f) => f(test, id).length)).toEqual([0, 0, 0, 0, 0, 0]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B.6 A107(6): history keeps its stored costs
// ════════════════════════════════════════════════════════════════════════════

// T-S10n (A115): the history views are the paged list, its count, the per-match detail views and the paged ratings.
const HISTORY_VIEWS = (matchHistoryId: number): Array<[string, Record<string, unknown>]> => [
    ['view_my_match_history', { page: 0, gameMode: '', draftMode: '', matchType: '' }],
    ['view_my_match_history_count', { gameMode: '', draftMode: '', matchType: '' }],
    ['view_my_match_history_steps', { matchHistoryId }], ['view_my_match_history_lineups', { matchHistoryId }],
    ['view_my_match_history_games', { matchHistoryId }], ['view_my_match_history_participants', { matchHistoryId }],
    ['view_my_mmr_history', { page: 0, gameMode: '' }],
];

describe('A107(6): a patch never touches history', () => {
    it('after a game on the set is finalized, patching its prices leaves the history rows and the history views byte-for-byte unchanged (A107(6))', () => {
        const { test, owner, id } = patchWorld();
        const s = lobbyOn(test, id, 'h');
        tx(test, captain(s, 'Blue'), pickBody(s, 'k'));
        completeDraft(s);
        tx(test, captain(s, 'Blue'), equipBody(s, 'Blue', 'k', 'lc'));
        finishGame(s, 'Blue');
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy(); // casual: finalized at the close
        const reader = s.a['h-b'];
        const matchHistoryId = [...test.db.MatchParticipantHistory.by_user.filter(reader.userId)][0].matchHistoryId;
        const history = () => snap(
            [...test.db.MatchSessionHistory.iter()], [...test.db.MatchSessionStepHistory.iter()], [...test.db.MatchLineupHistory.iter()],
            [...test.db.MatchResultGameHistory.iter()], [...test.db.MatchParticipantHistory.iter()],
            HISTORY_VIEWS(matchHistoryId).map(([v, args]) => (M as any)[v](test.viewContext(reader.auth), args)),
        );
        // The archived step payload is the step's StepPayload as a JSON string.
        const stepPayloads = [...test.db.MatchSessionStepHistory.iter()].map((r: any) => JSON.parse(r.payload));
        expect(stepPayloads.find((p) => p.tag === 'Pick' && p.value.characterName === 'k').value.costPaid).toBe(10);
        expect(stepPayloads.find((p) => p.tag === 'EquipLightcone').value.costPaid).toBe(5);
        const before = history();

        editChar(test, owner, id, 'k', 'Classic', ladder(99));
        editLc(test, owner, id, 'lc', 'Classic', sLadder(99));
        editSyn(test, owner, id, 'k', 'k2', 'Classic', 50);
        publish(test, owner, id, true);
        expect(charRow(liveChars(test, id), 'k')!.costs.e0).toBe(99);
        expect(history()).toBe(before);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B.7 A102: the global rating is per season
// ════════════════════════════════════════════════════════════════════════════

describe('A102: globalCompositeRating is computed from and written to the current season\'s rows only', () => {
    it('season 1 rows keep their stored value; the season 2 rows hold the mean of the season 2 rows only (A102)', () => {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const admin = verified(test, 'admin');
        setUserRole(test, admin.userId, 'Admin');
        for (const name of ['S1', 'S2']) {
            tx(test, admin, (ctx) => M.create_season(ctx, { name, startDate: test.clock.now(), endDate: undefined }));
        }
        const seasonId = (name: string) => [...test.db.Season.iter()].find((x) => x.name === name)!.id;
        const activate = (name: string) => {
            const id = seasonId(name); // read outside the transaction
            tx(test, admin, (ctx) => M.set_active_season(ctx, { seasonId: id }));
        };
        const ratings = (userId: number, season: string) =>
            [...test.db.MmrRating.user_id.filter(userId)].filter((r) => r.seasonId === seasonId(season));

        activate('S1');
        const first = playRanked(test, 'Blue');
        validateAndFinalize(test, first.s, first.recId, mod, 'Blue');
        const a = first.s.a;
        const second = playRanked(test, 'Blue', { actors: a, lobby: { gameMode: { tag: 'ApocalypticShadow' } } });
        validateAndFinalize(test, second.s, second.recId, mod, 'Blue');
        const b1 = a.b1.userId;
        const s1 = ratings(b1, 'S1');
        expect(s1.map((r) => r.gameMode.tag).sort()).toEqual(['ApocalypticShadow', 'MemoryOfChaos']);
        const s1Mean = Math.round(s1.reduce((x, r) => x + r.rating, 0) / s1.length);
        for (const r of s1) expect(r.globalCompositeRating).toBe(s1Mean);
        const s1Before = snap(s1);

        activate('S2');
        const third = playRanked(test, 'Red', { actors: a }); // b1 loses in season 2
        validateAndFinalize(test, third.s, third.recId, mod, 'Red');
        const s2 = ratings(b1, 'S2');
        expect(s2).toHaveLength(1);
        expect(s2[0].rating).toBeLessThan(1000);
        expect(s2[0].globalCompositeRating).toBe(s2[0].rating); // the mean of the season 2 rows only
        const allMean = Math.round([...s1, ...s2].reduce((x, r) => x + r.rating, 0) / 3);
        expect(s2[0].globalCompositeRating).not.toBe(allMean);
        expect(snap(ratings(b1, 'S1'))).toBe(s1Before);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// B.8 A106: a Classic timer auto-pick credits the whole acting team (T-S10k: superseded by A110, ownership)
// ════════════════════════════════════════════════════════════════════════════

const charStats = (test: Harness, characterName: string) =>
    [...test.db.PlayerCharacterStat.iter()].filter((r) => r.characterName === characterName);
const globalStats = (test: Harness, characterName: string) =>
    [...test.db.GlobalCharacterStat.iter()].filter((r) => r.characterName === characterName);

/**
 * A casual Classic game (BanMode Four, autoRandomPick) on set 0: Blue's first ban expires into SKIP (nothing priced yet),
 * Red bans by hand; then `solo` is priced, Blue's pick turn expires into `solo`, Red's into EMPTY; the rest is drafted
 * by hand (completeDraft: each name picked by its captain) and the host closes the game for Blue.
 */
function autoPickGame(seats: SetupOpts['seats'], owned: Record<string, string[]> = {}) {
    const test = newHarness();
    const s = setupLobby(test, { seats, lobby: { autoRandomPick: true, banMode: { tag: 'Four' } }, beforeStart: withAccounts(test) });
    expireTurn(s); // Blue ban → SKIP
    expect(payloadOf(test, s.lobbyId, 'Ban')).toMatchObject({ characterName: 'SKIP' });
    tx(test, captain(s, 'Red'), (ctx) => (priceBanNames(ctx, s.lobbyId, ['red-ban']), M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'red-ban' }))); // T-S10r (A122(7), L32): a ban names a priced character
    priceCharacterAt(test, key0('Classic'), 'solo', ladder(1));
    expireTurn(s); // Blue pick → solo
    expect(lastStepOf(test, s.lobbyId, 'Pick')).toMatchObject({ actorUserId: 0, actorSlot: { tag: 'Blue' } });
    expect(payloadOf(test, s.lobbyId, 'Pick')).toMatchObject({ characterName: 'solo' });
    expireTurn(s); // Red pick → EMPTY
    expect(payloadOf(test, s.lobbyId, 'Pick')).toMatchObject({ characterName: 'EMPTY' });
    const blueCaptain = captain(s, 'Blue'); // read before the close: a finalized casual lobby is gone
    const blueMateActor = s.a.b2 ? blueMate(s) : undefined;
    completeDraft(s);
    // T-S10k (A110(1)): unselected accounts owning the named characters, read at finalization (the close below).
    for (const [name, chars] of Object.entries(owned)) ownedAccount(test, s.a[name].userId, `own-${name}`, chars);
    finishGame(s, 'Blue');
    expect(test.db.MatchSessionHistory.count()).toBe(1n);
    return { test, s, blueCaptain, blueMateActor };
}

// T-S10k re-alignment: A110 supersedes A106 (whole team) and A82(4) (the picker) for the played stat; the timer pick,
// the manual pick and the sale all credit by ownership on the owning side.
describe('A110 (was A106): a Classic timer auto-pick of a real character credits the acting side by ownership', () => {
    for (const [label, seats, owned, creditedBlue] of [
        ['1v1, nobody owns it: the lone Blue player', [['b1', 'BluePlayer'], ['r1', 'RedPlayer']], {}, ['b1']],
        ['2v2 with a Blue coach, b1 and the coach own it: b1 only', [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']], { b1: ['solo'], bc: ['solo'] }, ['b1']],
    ] as Array<[string, SetupOpts['seats'], Record<string, string[]>, string[]]>) {
        it(`${label} has "played" with Blue's win, every Red player "faced", one global row, none for user 0 or the coach; EMPTY and SKIP write nothing (A110(1)(2)(4))`, () => {
            const { test, s } = autoPickGame(seats, owned);
            const blue = creditedBlue.map((n) => s.a[n].userId);
            const red = ['r1', 'r2'].filter((n) => s.a[n]).map((n) => s.a[n].userId);
            const rows = charStats(test, 'solo');
            expect(rows.map((r) => r.userId).sort((x, y) => x - y)).toEqual([...blue, ...red].sort((x, y) => x - y));
            for (const u of blue) expect(rows.find((r) => r.userId === u)).toMatchObject({ matchesPlayed: 1, wins: 1, losses: 0, timesFaced: 0 });
            for (const u of red) expect(rows.find((r) => r.userId === u)).toMatchObject({ matchesPlayed: 0, timesFaced: 1, winsAgainst: 0, lossesAgainst: 1 });
            if (s.a.bc) expect(rows.some((r) => r.userId === s.a.bc.userId)).toBe(false);
            expect([...test.db.PlayerCharacterStat.iter()].filter((r) => r.userId === 0)).toHaveLength(0);
            expect(globalStats(test, 'solo')).toHaveLength(1);
            expect(globalStats(test, 'solo')[0]).toMatchObject({ timesPicked: 1, wins: 1, losses: 0 });
            for (const sentinel of ['EMPTY', 'SKIP']) {
                expect(charStats(test, sentinel)).toHaveLength(0);
                expect(globalStats(test, sentinel)).toHaveLength(0);
            }
        });
    }

    it('a manual Classic pick by the captain of a character only the teammate owns credits the teammate, not the captain (A110(1))', () => {
        const seats: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];
        // completeDraft's first Blue pick, 'fill-blue-1', is made by the Blue captain; the captain is b1 (the first Blue seat).
        const { test, s, blueCaptain, blueMateActor } = autoPickGame(seats, { b2: ['fill-blue-1'] });
        expect(blueMateActor!.userId).toBe(s.a.b2.userId);
        const rows = charStats(test, 'fill-blue-1');
        const played = rows.filter((r) => r.matchesPlayed > 0).map((r) => r.userId);
        expect(played).toEqual([blueMateActor!.userId]);
        expect(rows.some((r) => r.userId === blueCaptain.userId)).toBe(false);
        expect(rows.filter((r) => r.timesFaced > 0).map((r) => r.userId).sort((x, y) => x - y))
            .toEqual([s.a.r1.userId, s.a.r2.userId].sort((x, y) => x - y));
    });

    it('an Auction sale follows ownership: the one owner of the winning team "played", the other team "faced" (A110(1), supersedes A82(2))', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' } } });
        priceCharacterAt(test, key0('Auction'), 'sold', ladder(1));
        tx(test, captain(s, 'Blue'), nominateBody(s, 'sold'));
        tx(test, captain(s, 'Red'), passBody(s));
        completeDraft(s);
        ownedAccount(test, s.a.b2.userId, 'own-b2', ['sold']);
        finishGame(s, 'Blue');
        const rows = charStats(test, 'sold');
        const blue = [s.a.b2.userId];
        expect(rows.filter((r) => r.matchesPlayed > 0).map((r) => r.userId)).toEqual(blue);
        expect(rows.filter((r) => r.matchesPlayed === 1 && r.wins === 1).map((r) => r.userId).sort((x, y) => x - y)).toEqual(blue.sort((x, y) => x - y));
        expect(rows.filter((r) => r.timesFaced === 1).map((r) => r.userId).sort((x, y) => x - y))
            .toEqual([s.a.r1.userId, s.a.r2.userId].sort((x, y) => x - y));
        expect(globalStats(test, 'sold')).toHaveLength(1);
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

/** create_lobby_preset arguments (as s8f-membership). */
const PRESET_ARGS = {
    teamSize: 2, draftMode: { tag: 'Classic' }, banMode: { tag: 'None' }, gameMode: { tag: 'MemoryOfChaos' },
    matchType: { tag: 'Casual' }, standardTurnSeconds: 30, reserveBankSeconds: 60, characterBudget: 100,
    lightconeBudget: 50, minimumBidRaise: 1, rosterDiffAdvantage: 0, rosterThreshold: 0, underThresholdAdvantage: 0,
    aboveThresholdPenalty: 0, deathPenalty: 0, isPublic: true, isAnonymousPlayers: false, isAnonymousSpectators: false,
    rosterVisibility: { tag: 'OpenRoster' }, requireOwnership: false, costSetId: 0, disconnectPolicy: { tag: 'Standard' },
    disconnectForfeitSeconds: 60, allowMirrorPicks: false, autoRandomPick: false, refereeCanUndo: true,
    refereeCanPause: true, refereeCanSetCaptain: true, refereeCanKick: true, allowPlayerPause: true,
    refereeExclusiveConcede: true,
};
