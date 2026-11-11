// Match session: Auction budgets (an eidolon raise dips into the light-cone budget, sales never refused, minimum
//   raise, seeded random games).
// Decisions: A133, A134
// Contracts: docs/match-session/contract.md
// From S10u (s10u-auction-undo-dips.test.ts).
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    draftDone,
    lobbyRow,
    newHarness,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Lobby,
} from '../fixtures/harness';
import { captain, selectAccount } from '../fixtures/draft-and-scoring-builders';
import { rejection } from '../fixtures/calendar-roster-rating-builders';
import {
    AUCTION,
    E6,
    NOMINATE_COST,
    ONE_V_ONE,
    TURN_MS,
    TWO_V_TWO,
    bid,
    bidBody,
    budgets,
    buyAt,
    eid,
    eidBody,
    expectNoRound,
    expire,
    f,
    lobby,
    nominate,
    nominateBody,
    nominatorOf,
    other,
    pass,
    playAuction,
    price,
    stepsOf,
    undo,
    world,
    type Side,
} from '../fixtures/auction-round-builders';

// ─── Texts ───────────────────────────────────────────────────────────────────

const RAISE_AT_ZERO = 'Not enough character budget: an eidolon cost can use the light-cone budget only while character budget remains.';
const TAKE_AT_ZERO = 'Not enough character budget: at 0 character budget your team cannot take a character whose eidolon costs extra.';
const eidRejected = (s: Lobby, side: Side, name: string, e: number) => { advance(s.test, 1_100); return rejection(s.test, captain(s, side), eidBody(s, side, name, e)); };

// ════════════════════════════════════════════════════════════════════════════
// A133: no light-cone dip at 0 character budget
// ════════════════════════════════════════════════════════════════════════════


describe('A133: an eidolon raise during the draft needs character budget above 0', () => {
    /** Budgets 12.7 / 33.3. Blue owns B (cost 0, ladder `bLadder`) and buys A at `amount`. */
    function blueSpent(amount: number, bLadder: number[] = [0, 5, 7, 7, 7, 7, 7]): Lobby {
        const s = lobby({ characterBudget: 12.7, lightconeBudget: 33.3, minimumBidRaise: 0.1 });
        buyAt(s, 'Blue', 'B', bLadder, 'f1');
        buyAt(s, 'Blue', 'A', amount, 'f2');
        return s;
    }

    it('A133: at character budget 0 a raise is refused and nothing changes', () => {
        const s = blueSpent(12.7);
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: f(33.3) });
        const before = world(s);
        expect(eidRejected(s, 'Blue', 'B', 1)).toBe(RAISE_AT_ZERO);
        expect(world(s)).toEqual(before);
    });

    it('A133: at character budget 0.1 a raise of 5 is accepted and spills; a second raise (+2) is then refused; a lowering refunds 5 to the light-cone budget', () => {
        const s = blueSpent(12.6);
        const char = f(f(12.7) - f(12.6)); // 0.1000003815
        expect(budgets(s, 'Blue')).toMatchObject({ char, lc: f(33.3) });
        eid(s, 'Blue', 'B', 1); // +5: `char` from the character budget, the rest from light cones
        const lc = f(f(33.3) - (5 - char));
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc });
        expect(eidRejected(s, 'Blue', 'B', 2)).toBe(RAISE_AT_ZERO);
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc });
        eid(s, 'Blue', 'B', 0); // A133(2): the refund of 5 goes to the light-cone budget
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: f(lc + 5) });
    });

    it('A133: below the spill a raise takes only character budget (33.3 → 33.3 - 0.7)', () => {
        const s = lobby({ characterBudget: 33.3, lightconeBudget: 12.7 });
        buyAt(s, 'Blue', 'B', [0, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7], 'f1');
        eid(s, 'Blue', 'B', 1);
        expect(budgets(s, 'Blue')).toMatchObject({ char: f(f(33.3) - f(0.7)), lc: f(12.7) });
    });

    it('A133: a team holding the bid has the held amount reserved: with its whole character budget held it cannot raise; after the sale it is at 0 and still cannot', () => {
        const s = lobby({ characterBudget: 12.7, lightconeBudget: 33.3, minimumBidRaise: 0.1 });
        buyAt(s, 'Blue', 'B', [0, 5, 5, 5, 5, 5, 5], 'f1'); // Red nominates next
        nominate(s, 'x', 0.1);
        bid(s, 'Blue', 12.7); // all of Blue's character budget
        expect(eidRejected(s, 'Blue', 'B', 1)).toBe(RAISE_AT_ZERO);
        pass(s, 'Red');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: f(33.3) });
        expect(eidRejected(s, 'Blue', 'B', 1)).toBe(RAISE_AT_ZERO);
    });

    it('A133(1): a sale whose bid empties the character budget still charges its default extra (0.7) to the light-cone budget', () => {
        const s = lobby({ requireOwnership: true, characterBudget: 33.3, lightconeBudget: 12.7, minimumBidRaise: 0.1 });
        selectAccount(s.test, s.lobbyId, s.a.b1.userId, 9001, { S: 2, f0: 0 }); // Blue's default for S: E2
        selectAccount(s.test, s.lobbyId, s.a.r1.userId, 9002, { S: 0, f0: 0 });
        if (nominatorOf(s) === 'Red') { nominate(s, 'f0'); pass(s, 'Blue'); }
        nominate(s, 'S', [0.1, 0.1, 0.8, 0.8, 0.8, 0.8, 0.8]); // Blue at 0.1; extra at E2 = 0.8 - 0.1
        bid(s, 'Red', 11);
        bid(s, 'Blue', 33.3); // the whole character budget
        pass(s, 'Red');
        const extra = f(0.8) - f(0.1);
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: f(f(12.7) - extra) });
        const sold = stepsOf(s, 'AuctionSold').find((x) => (x.payload.value as any).characterName === 'S')!.payload.value as any;
        expect([sold.eidolon, sold.eidolonCost]).toEqual([2, f(extra)]); // the payload field is an f32
    });

    it('A133(1): a team at 0 cannot nominate or bid on a character with a default extra; it can nominate a cost-0 character without extra and EMPTY', () => {
        const s = lobby({ requireOwnership: true, characterBudget: 33.3, lightconeBudget: 12.7, minimumBidRaise: 0 });
        selectAccount(s.test, s.lobbyId, s.a.b1.userId, 9001, { A: 0, Y: 1, Z: 0, f0: 0, f1: 0 }); // Blue: Y only at E1
        selectAccount(s.test, s.lobbyId, s.a.r1.userId, 9002, { A: 0, Y: 0, Z: 0, f0: 0, f1: 0 });
        price(s, 'Y', [0, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7]); // Blue's default extra 0.7, Red's 0
        price(s, 'Z', 0);
        if (nominatorOf(s) === 'Red') { nominate(s, 'f0'); pass(s, 'Blue'); }
        nominate(s, 'A', 33.3); // Blue
        pass(s, 'Red'); // Blue: 0 / 12.7
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: f(12.7) });
        nominate(s, 'f1'); // Red
        pass(s, 'Blue');
        expect(nominatorOf(s)).toBe('Blue');
        expect(rejection(s.test, captain(s, 'Blue'), nominateBody(s, 'Y'))).toBe(TAKE_AT_ZERO);
        nominate(s, 'Z'); // cost 0, no extra: accepted
        pass(s, 'Red'); // Blue wins Z at 0
        nominate(s, 'Y'); // Red (its extra is 0)
        expect(rejection(s.test, captain(s, 'Blue'), bidBody(s, 0))).toBe(TAKE_AT_ZERO); // a bid of 0 is allowed by the raise rule
        pass(s, 'Blue'); // Red wins Y
        expect(nominatorOf(s)).toBe('Blue');
        nominate(s, 'EMPTY');
        expect(session(s.test, s.lobbyId).currentNomination).toBe('EMPTY');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: f(12.7) });
    });

    it('A133(3): in the confirm window (Drafting, two budgets) the rule applies; in Equipping a raise pays from the pool as before', () => {
        const s = lobby({ characterBudget: 33.3, lightconeBudget: 12.7 });
        buyAt(s, 'Blue', 'B', [0, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7], 'f1');
        buyAt(s, 'Blue', 'A', 33.3, 'f2');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: f(12.7) });
        playAuction(s, 16, 0);
        expect(draftDone(s.test, s.lobbyId)).toBe(true);
        expect(eidRejected(s, 'Blue', 'B', 1)).toBe(RAISE_AT_ZERO);
        tx(s.test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('Equipping');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: f(12.7) });
        eid(s, 'Blue', 'B', 1);
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: f(f(12.7) - f(0.7)) });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Random games (seeded, deterministic): A133 and A134 together
// ════════════════════════════════════════════════════════════════════════════

function rng(seed: number) {
    let x = seed >>> 0;
    return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}
/** Non-dyadic ladders: E0 0.37 .. 3.29, steps of 0.41 .. 1.55 per level. */
const ladderOf = (i: number) => Array.from({ length: 7 }, (_, e) => +(0.37 + (i % 5) * 0.73 + e * (0.41 + (i % 3) * 0.57)).toFixed(2));
/**
 * Tolerance on a team's total: f32 rounding of the stored budgets. Each charge and each give-back rounds once to an f32
 * (half a unit in the last place, 2^-24 of the budget scale, about 3e-6 at 50); a game makes at most a few hundred of
 * them, so 1e-3 bounds the drift with a wide margin (review 3 measured at most 5.1e-5 over 60 games).
 */
const TOL = 1e-3;

function randomGame(seed: number, cb: number, lcb: number, ownership: boolean) {
    const test = newHarness();
    const names = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const idx = (n: string) => +n.slice(1);
    const s = setupLobby(test, {
        seats: ownership ? TWO_V_TWO : ONE_V_ONE,
        lobby: { ...AUCTION, minimumBidRaise: 0.1, characterBudget: cb, lightconeBudget: lcb, requireOwnership: ownership },
        beforeStart: (l) => names.forEach((n, i) => priceCharacters(l.test, l.lobbyId, [n], ladderOf(i))),
    });
    // Ownership: each team's first seat owns a low level, its second a higher one; the default is the low one (A64).
    const lo = (i: number, team: Side) => (i * 7 + seed + (team === 'Blue' ? 0 : 3)) % 3;
    const hi = (i: number, team: Side) => Math.min(6, lo(i, team) + 1 + ((i + seed) % 4));
    if (ownership) {
        const own = (team: Side, which: 'lo' | 'hi') => Object.fromEntries(names.map((n, i) => [n, which === 'lo' ? lo(i, team) : hi(i, team)]));
        selectAccount(test, s.lobbyId, s.a.b1.userId, 9001, own('Blue', 'lo'));
        selectAccount(test, s.lobbyId, s.a.b2.userId, 9002, own('Blue', 'hi'));
        selectAccount(test, s.lobbyId, s.a.r1.userId, 9003, own('Red', 'lo'));
        selectAccount(test, s.lobbyId, s.a.r2.userId, 9004, own('Red', 'hi'));
    }
    const r = rng(seed);
    const start = f(cb) + f(lcb);
    const extraOf = (name: string, e: number) => { const l = ladderOf(idx(name)); return Math.max(0, f(l[e]) - f(l[0])); };
    const ok = (who: any, body: (ctx: any) => unknown) => { try { tx(test, who, body); return true; } catch { return false; } };
    /** What each team holds now: name → eidolon (its sale's level, then its latest live selection). */
    const held = () => {
        const all = steps(test, s.lobbyId).sort((a, b) => a.sequence - b.sequence);
        const w: Record<Side, Record<string, { e: number; amount: number }>> = { Blue: {}, Red: {} };
        for (const st of all) {
            const v = st.payload.value as any;
            // EMPTY can be won several times: one entry per sale.
            if (st.action.tag === 'AuctionSold') w[v.winningTeam.tag as Side][v.characterName === 'EMPTY' ? `EMPTY#${st.sequence}` : v.characterName] = { e: v.eidolon, amount: v.winningAmount };
            if (st.action.tag === 'SetEidolon' && w[st.actorSlot.tag as Side][v.characterName]) w[st.actorSlot.tag as Side][v.characterName].e = v.eidolon;
        }
        return w;
    };
    // S10u fix pass (A133, review F1): the light-cone dips per team, counted per stretch without an undo that gives
    // character budget back. A dip = an accepted non-undo action after which the team's light-cone budget is lower (a
    // raise's spill or a sale's extra spill; nothing else takes from it during the draft). An undo that raises the
    // team's character budget starts a new stretch (the undone charge may be made again).
    const lastB: Record<Side, { char: number; lc: number }> = { Blue: budgets(s, 'Blue'), Red: budgets(s, 'Red') };
    const dips: Record<Side, number> = { Blue: 0, Red: 0 };
    let maxDips = 0;
    let dipTotal = 0;
    let stretchResets = 0;
    /** The rule value from prices: start minus, per held character, the winning amount and the extra at its eidolon. */
    const check = (where: string, isUndo = false) => {
        const h = held();
        for (const side of ['Blue', 'Red'] as const) {
            const b = budgets(s, side);
            const prev = lastB[side];
            if (isUndo) {
                if (b.char > prev.char) { if (dips[side] > 0) stretchResets++; dips[side] = 0; }
            } else if (b.lc < prev.lc) {
                dips[side]++;
                dipTotal++;
                maxDips = Math.max(maxDips, dips[side]);
                expect(dips[side], `${where}: ${side} dipped into the light-cone budget twice in one stretch`).toBeLessThanOrEqual(1);
            }
            lastB[side] = { char: b.char, lc: b.lc };
            expect(b.char, `${where}: ${side} character budget`).toBeGreaterThanOrEqual(0);
            expect(b.lc, `${where}: ${side} light-cone budget`).toBeGreaterThanOrEqual(0);
            let cost = 0;
            for (const [name, x] of Object.entries(h[side])) cost += x.amount + (name.startsWith('EMPTY') ? 0 : extraOf(name, x.e));
            expect(Math.abs(b.char + b.lc - (start - cost)), `${where}: ${side} total`).toBeLessThan(TOL);
        }
    };
    const undoRows = () => steps(test, s.lobbyId).filter((x) => x.action.tag === 'Undo').length;
    const hasCharacterStep = () => steps(test, s.lobbyId).some((x) => ['Ban', 'Pick', 'Nominate', 'Bid', 'AuctionSold'].includes(x.action.tag));
    let undos = 0;
    let edits = 0;
    const undoOnce = () => {
        if (!hasCharacterStep()) return;
        advance(test, 50);
        tx(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId })); // A134: never refused below the cap
        undos++;
        const x = session(test, s.lobbyId);
        expect([x.currentNomination, x.currentBidTeam.tag]).toEqual([undefined, 'Spectator']);
        check('after an undo', true);
    };
    const tryEdit = () => {
        const team: Side = r() < 0.5 ? 'Blue' : 'Red';
        const mine = Object.entries(held()[team]).filter(([n]) => !n.startsWith('EMPTY'));
        if (mine.length === 0) return;
        const [name, x] = mine[Math.floor(r() * mine.length)];
        const i = idx(name);
        let e: number;
        if (ownership) e = x.e === lo(i, team) ? hi(i, team) : lo(i, team);
        else if (x.e > 0 && r() < 0.5) e = Math.floor(r() * x.e);
        else { e = Math.floor(r() * 7); if (e === x.e) e = (e + 1) % 7; }
        if (e === x.e) return;
        const before = budgets(s, team);
        advance(test, 1_100);
        if (!ok(captain(s, team), eidBody(s, team, name, e))) return;
        edits++;
        const after = budgets(s, team);
        // A133: a raise during the draft never starts from character budget 0.
        if (after.char + after.lc < before.char + before.lc) expect(before.char, 'a raise at character budget 0').toBeGreaterThan(0);
        check(`after an edit of ${team} ${name} E${x.e}→E${e}`);
    };
    /** One draft action; false when nothing was accepted (a stuck state). */
    const forward = (): boolean => {
        advance(test, 300);
        if (r() < 0.3) tryEdit();
        const sess = session(test, s.lobbyId);
        if (!sess.currentNomination) {
            const team = sess.nextNominatorTeam.tag as Side;
            const h = held();
            const free = names.filter((n) => !h.Blue[n] && !h.Red[n]);
            for (let t = 0; t < 4 && free.length; t++) {
                const name = free[Math.floor(r() * free.length)];
                if (ok(captain(s, team), nominateBody(s, name))) { check('after a nomination'); return true; }
            }
            if (ok(captain(s, team), nominateBody(s, 'EMPTY'))) { check('after an EMPTY nomination'); return true; }
            return false;
        }
        const bidder = other(sess.currentBidTeam.tag as Side);
        if (r() < 0.55 && ok(captain(s, bidder), bidBody(s, +(sess.currentBidAmount! + 0.1 + Math.floor(r() * 23) / 10).toFixed(1)))) {
            check('after a bid');
            return true;
        }
        if (r() < 0.25) {
            advance(test, TURN_MS + 1_000);
            if (ok(captain(s, r() < 0.5 ? 'Blue' : 'Red'), (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }))) { check('after a timer sale'); return true; }
        }
        if (ok(captain(s, bidder), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }))) { check('after a sale'); return true; }
        advance(test, TURN_MS + 1_000);
        if (ok(captain(s, bidder), (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }))) { check('after a timer sale'); return true; }
        return false;
    };
    const play = () => {
        let guard = 0;
        while (!draftDone(test, s.lobbyId) && guard++ < 1_500) {
            if (r() < 0.12 && undoRows() < 250) { const k = 1 + Math.floor(r() * 4); for (let i = 0; i < k; i++) undoOnce(); }
            else expect(forward(), 'a stuck state: no nomination, bid, pass or timer expiry accepted').toBe(true);
        }
        expect(draftDone(test, s.lobbyId), 'the game finishes').toBe(true);
    };
    play();
    // In the confirm window: edits, then a few rounds walked back and replayed.
    for (let i = 0; i < 6; i++) tryEdit();
    for (let i = 0, k = 1 + Math.floor(r() * 3); i < k; i++) undoOnce();
    play();
    const expected = (() => { // the totals before the roll-over
        const b = budgets(s, 'Blue');
        const rd = budgets(s, 'Red');
        return { Blue: f(b.char) + f(b.lc), Red: f(rd.char) + f(rd.lc) };
    })();
    check('at the end of the draft');
    tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
    for (const side of ['Blue', 'Red'] as const) {
        const b = budgets(s, side);
        expect(b.char).toBe(0);
        expect(Math.abs(b.lc - expected[side])).toBeLessThan(TOL);
    }
    return { undos, edits, maxDips, dipTotal, stretchResets };
}

describe('A133 / A134: random Auction games (seeded): budgets never below 0, totals equal the prices, no stuck state, every game finishes', () => {
    const configs: Array<[number, number]> = [[100, 50], [33.3, 12.7], [21.7, 3.1]];
    for (const ownership of [false, true]) {
        for (const half of [0, 1]) {
            it(`A133 / A134: 6 games, ownership ${ownership ? 'on' : 'off'}, seeds ${half * 6 + 1}-${half * 6 + 6}`, () => {
                let undos = 0;
                let edits = 0;
                let maxDips = 0;
                let dipTotal = 0;
                let stretchResets = 0;
                for (let g = 0; g < 6; g++) {
                    const seed = half * 6 + g + 1 + (ownership ? 100 : 0);
                    const [cb, lcb] = configs[g % configs.length];
                    const res = randomGame(seed, cb, lcb, ownership);
                    undos += res.undos;
                    edits += res.edits;
                    maxDips = Math.max(maxDips, res.maxDips);
                    dipTotal += res.dipTotal;
                    stretchResets += res.stretchResets;
                }
                expect(undos).toBeGreaterThan(20);
                expect(edits).toBeGreaterThan(20);
                // A133 (S10u fix pass, review F1): at most one dip per team per stretch; dips do happen.
                expect(maxDips).toBe(1);
                expect(dipTotal).toBeGreaterThan(0);
            }, 240_000);
        }
    }
});

// ════════════════════════════════════════════════════════════════════════════
// S10u fix pass (review F1, F2, F3, F6)
// ════════════════════════════════════════════════════════════════════════════

const HOLDER_FIT = 'Not enough character budget: while you hold the bid, an eidolon cost must fit your free character budget.';

describe('A133 (review F1): a team dips into the light-cone budget at most once per stretch; a holder never spills', () => {
    it('A133 (review sequence 1, budgets 10 / 50): Blue holding 3 cannot raise A by 20 (7 free); a raise of 5 fits; after losing the round the raise of A spills once (5 / 50 → 0 / 35) and every later raise or costed nomination is refused', () => {
        const s = lobby({ characterBudget: 10, lightconeBudget: 50, minimumBidRaise: 0.1 });
        buyAt(s, 'Blue', 'A', E6(20), 'f1');
        buyAt(s, 'Blue', 'Bc', E6(10), 'f2');
        buyAt(s, 'Blue', 'C', E6(5), 'f3');
        if (nominatorOf(s) !== 'Blue') { nominate(s, 'EMPTY'); pass(s, 'Blue'); }
        expect(budgets(s, 'Blue')).toMatchObject({ char: 10, lc: 50 });
        nominate(s, 'Z', 3); // Blue holds 3: 7 free
        expect(eidRejected(s, 'Blue', 'A', 6)).toBe(HOLDER_FIT);
        expect(budgets(s, 'Blue')).toMatchObject({ char: 10, lc: 50 });
        eid(s, 'Blue', 'C', 6); // +5 <= 7 free: from the character budget only
        expect(budgets(s, 'Blue')).toMatchObject({ char: 5, lc: 50 });
        bid(s, 'Red', 3.5);
        pass(s, 'Blue'); // Red wins Z
        eid(s, 'Blue', 'A', 6); // not holding: +20 = 5 from the character budget, 15 from light cones (the one dip)
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 35 });
        expect(eidRejected(s, 'Blue', 'Bc', 6)).toBe(RAISE_AT_ZERO);
        if (nominatorOf(s) !== 'Blue') { nominate(s, 'EMPTY'); pass(s, 'Blue'); }
        price(s, 'Y', 1);
        expect(rejection(s.test, captain(s, 'Blue'), nominateBody(s, 'Y'))).toBe(NOMINATE_COST);
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 35 });
    });

    it('A133 (review sequence 2, ownership, 10 / 50): Blue holding X at 3 (default extra 4) cannot raise A by 20; the sale charges 3 + 4 from the character budget (3 / 50, no dip); the later raise of A spills once (0 / 33)', () => {
        const s = lobby({ requireOwnership: true, characterBudget: 10, lightconeBudget: 50, minimumBidRaise: 0.1 }, TWO_V_TWO);
        price(s, 'A', E6(20));
        price(s, 'X', [3, 3, 7, 7, 7, 7, 7]);
        selectAccount(s.test, s.lobbyId, s.a.b1.userId, 9001, { A: 0, X: 2, f1: 0 });
        selectAccount(s.test, s.lobbyId, s.a.b2.userId, 9002, { A: 6, X: 2, f1: 0 });
        selectAccount(s.test, s.lobbyId, s.a.r1.userId, 9003, { A: 0, X: 0, f1: 0 });
        selectAccount(s.test, s.lobbyId, s.a.r2.userId, 9004, { A: 0, X: 0, f1: 0 });
        buyAt(s, 'Blue', 'A', E6(20), 'f1');
        if (nominatorOf(s) !== 'Blue') { nominate(s, 'EMPTY'); pass(s, 'Blue'); }
        nominate(s, 'X'); // Blue at 3, default E2: extra 4
        expect(eidRejected(s, 'Blue', 'A', 6)).toBe(HOLDER_FIT);
        pass(s, 'Red');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 3, lc: 50 });
        eid(s, 'Blue', 'A', 6);
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 33 });
    });
});

describe('A133 (review F2): a sale is never refused; an extra that grew after the bid is sold at the highest affordable level', () => {
    /** 2v2 ownership, budgets 10 / 2, minimum raise 1; X costs `ladder`; b1 owns X at E0, b2 at E2; Blue nominates X at 10. */
    function grownExtra(ladder: number[], refereeCanUndo: boolean): Lobby {
        const s = lobby({ requireOwnership: true, characterBudget: 10, lightconeBudget: 2, minimumBidRaise: 1, refereeCanUndo }, TWO_V_TWO);
        price(s, 'X', ladder);
        selectAccount(s.test, s.lobbyId, s.a.b1.userId, 9001, { X: 0 });
        selectAccount(s.test, s.lobbyId, s.a.b2.userId, 9002, { X: 2 });
        selectAccount(s.test, s.lobbyId, s.a.r1.userId, 9003, { X: 0 });
        selectAccount(s.test, s.lobbyId, s.a.r2.userId, 9004, { X: 0 });
        if (nominatorOf(s) !== 'Blue') { nominate(s, 'EMPTY'); pass(s, 'Blue'); }
        nominate(s, 'X'); // Blue holds 10; its default is E0 (extra 0)
        // A roster change after the bid guard: b1's account rows go (as on a seated player's deletion); Blue's default is E2 now.
        for (const row of [...s.test.db.HsrAccountCharacter.iter()]) if (row.hsrAccountId === 9001) s.test.db.HsrAccountCharacter.delete(row);
        return s;
    }
    const soldX = (s: Lobby) => stepsOf(s, 'AuctionSold').find((x) => (x.payload.value as any).characterName === 'X')!.payload.value as any;

    for (const refereeCanUndo of [true, false]) {
        for (const how of ['pass', 'timer'] as const) {
            it(`A133(1): E2 extra 5 does not fit (light cones 2): sold at E1 (extra 1.5) by ${how}, refereeCanUndo ${refereeCanUndo}: 0 / 0.5, the total exact; the draft goes on`, () => {
                const s = grownExtra([10, 11.5, 15, 15, 15, 15, 15], refereeCanUndo);
                if (how === 'pass') pass(s, 'Red'); else expire(s, 'Red');
                expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 0.5 });
                expect([soldX(s).eidolon, soldX(s).eidolonCost, soldX(s).charCharged, soldX(s).lcCharged]).toEqual([1, 1.5, 10, 1.5]);
                expect(budgets(s, 'Blue').char + budgets(s, 'Blue').lc).toBe(12 - (10 + 1.5)); // start 12 - (bid + extra at E1)
                expect(nominatorOf(s)).toBe('Red');
                nominate(s, 'EMPTY'); // the draft continues
                expect(session(s.test, s.lobbyId).currentNomination).toBe('EMPTY');
            });
        }
    }

    it('A133(1) / A134: the undo of a step-down sale returns exactly the budgets before the nomination (10 / 2)', () => {
        const s = grownExtra([10, 11.5, 15, 15, 15, 15, 15], true);
        const won = budgets(s, 'Blue').won;
        pass(s, 'Red');
        expect(soldX(s).eidolon).toBe(1);
        undo(s);
        expect(budgets(s, 'Blue')).toEqual({ char: 10, lc: 2, won });
        expectNoRound(s, 'Blue');
        expect(stepsOf(s, 'AuctionSold').filter((x) => (x.payload.value as any).characterName === 'X')).toHaveLength(0);
    });

    it('A133(1): a later set_eidolon on a stepped-down character computes its cost from the applied level (E1 → E0 refunds 1.5, not 5)', () => {
        const s = grownExtra([10, 11.5, 15, 15, 15, 15, 15], true);
        pass(s, 'Red'); // sold at E1: 0 / 0.5
        // The E0 owner's row comes back (a direct row write; T-S10w: since A142 an Admin roster edit of a selected account is refused), so Blue owns E0 again.
        const ts = s.test.clock.now();
        s.test.db.HsrAccountCharacter.insert({ hsrAccountId: 9001, characterName: 'X', eidolonLevel: 0, createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts } as any);
        eid(s, 'Blue', 'X', 0);
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 2 });
        const edit = stepsOf(s, 'SetEidolon')[0].payload.value as any;
        expect([edit.previousEidolon, edit.eidolon, edit.costPaid, edit.charCharged, edit.lcCharged]).toEqual([1, 0, 0, 0, -1.5]);
    });

    it('A133(1): no level above E0 fits (E1 extra 3 > 2): sold at E0 with no extra: 0 / 2', () => {
        const s = grownExtra([10, 13, 15, 15, 15, 15, 15], false);
        pass(s, 'Red');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 2 });
        expect([soldX(s).eidolon, soldX(s).eidolonCost]).toEqual([0, 0]);
    });

    it('A133(1): the default extra still fits (light cones 7): sold at E2 as before', () => {
        const s = grownExtra([10, 13, 15, 15, 15, 15, 15], true);
        s.test.db.MatchSession.lobbyId.update({ ...session(s.test, s.lobbyId), teamBlueLcBudget: 7 }); // engineered: more light cones
        pass(s, 'Red');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 2 });
        expect([soldX(s).eidolon, soldX(s).eidolonCost]).toEqual([2, 5]);
    });
});

describe('A133 (review F3): a character budget that is 0 for the player counts as 0', () => {
    it('A133: budgets 0.3 / 50, Blue buys P at 0.1 and Q at 0.2 (a residue of 1.49e-8 remains): a raise is refused', () => {
        const s = lobby({ characterBudget: 0.3, lightconeBudget: 50, minimumBidRaise: 0 });
        buyAt(s, 'Blue', 'A', E6(20), 'f1');
        buyAt(s, 'Blue', 'P', 0.1, 'f2');
        buyAt(s, 'Blue', 'Q', 0.2, 'f3');
        const char = budgets(s, 'Blue').char;
        expect(char).toBe(f(f(f(0.3) - f(0.1)) - f(0.2)));
        expect(char).toBeGreaterThan(0);
        expect(char).toBeLessThan(1e-7);
        expect(eidRejected(s, 'Blue', 'A', 6)).toBe(RAISE_AT_ZERO);
        expect(budgets(s, 'Blue')).toMatchObject({ char, lc: 50 });
    });
});

describe('Minimum raise (review F6): a bid of exactly current + minimum raise is accepted in f32', () => {
    /** The largest f32 below a positive f32 value (one f32 unit below). */
    const f32Below = (x: number) => { const v = new Float32Array([x]); new Uint32Array(v.buffer)[0] -= 1; return v[0]; };
    const cases: Array<[number, number, number, number]> = [[3, 0.1, 3.1, 3.09], [0.7, 0.1, 0.8, 0.79], [3, 1, 4, 3.9]];
    for (const [opening, raise, exact, below] of cases) {
        it(`F6 / G4: opening ${opening}, minimum raise ${raise}: ${below} and one f32 unit below ${exact} are refused (the minimum printed as ${exact}), ${exact} is accepted`, () => {
            const s = lobby({ minimumBidRaise: raise });
            const nominator = nominatorOf(s);
            nominate(s, 'x', opening);
            const text = `Bid must be at least ${exact} (current bid ${opening} + minimum raise ${raise}).`;
            expect(rejection(s.test, captain(s, other(nominator)), bidBody(s, below))).toBe(text);
            expect(rejection(s.test, captain(s, other(nominator)), bidBody(s, f32Below(f(exact))))).toBe(text);
            bid(s, other(nominator), exact);
            expect(session(s.test, s.lobbyId)).toMatchObject({ currentBidAmount: f(exact), currentBidTeam: { tag: other(nominator) } });
        });
    }

    it('G4: budget 100000, current bid 50000, minimum raise 0.001 (below half an f32 unit there): an equal bid of 50000 is refused; the next f32 (50000.004) is accepted', () => {
        const s = lobby({ characterBudget: 100000, minimumBidRaise: 0.001 });
        const nominator = nominatorOf(s);
        nominate(s, 'x', 50000);
        expect(rejection(s.test, captain(s, other(nominator)), bidBody(s, 50000)))
            .toBe('Bid must be at least 50000.004 (current bid 50000 + minimum raise 0.001).');
        bid(s, other(nominator), 50000.004);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentBidAmount: 50000.00390625, currentBidTeam: { tag: other(nominator) } });
    });

    it('G4: with a minimum raise of 0 an equal bid stays legal', () => {
        const s = lobby({ minimumBidRaise: 0 });
        const nominator = nominatorOf(s);
        nominate(s, 'x', 3);
        bid(s, other(nominator), 3);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentBidAmount: 3, currentBidTeam: { tag: other(nominator) } });
    });
});

describe('A133 (review 2 G3): the zero tolerance refuses only a charge that needs the light-cone budget', () => {
    it('A133: start 100000 (tolerance 0.095), 0.046875 left: a raise of 0.04 is accepted from the character budget only; a raise of 0.05 (needs light cones) is refused', () => {
        const s = lobby({ characterBudget: 100000, lightconeBudget: 50 });
        buyAt(s, 'Blue', 'B', [0, 0.04, 0.05, 0.05, 0.05, 0.05, 0.05], 'f1');
        buyAt(s, 'Blue', 'A', 99999.953125, 'f2');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0.046875, lc: 50 });
        expect(eidRejected(s, 'Blue', 'B', 2)).toBe(RAISE_AT_ZERO);
        eid(s, 'Blue', 'B', 1);
        expect(budgets(s, 'Blue')).toMatchObject({ char: f(0.046875 - f(0.04)), lc: 50 });
    });
});
