// Match session: Auction undo removes the whole round and returns to the moment before the nomination.
// Decisions: A122, A123, A130, A134
// Contracts: docs/match-session/contract.md
// From S10u (s10u-auction-undo-dips.test.ts).
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    draftDone,
    lobbyRow,
    priceBanNames,
    session,
    tx,
    type Harness,
    type Lobby,
} from '../fixtures/harness';
import { captain, completeDraft, selectAccount } from '../fixtures/draft-and-scoring-builders';
import { rejection } from '../fixtures/calendar-roster-rating-builders';
import {
    E6,
    NOMINATE_COST,
    TWO_V_TWO,
    bid,
    bidBody,
    budgets,
    buyAt,
    canon,
    eid,
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

const TOTAL = 'Not enough total budget: the eidolon extra for this character would exceed it.';
const CAP = 'This game has reached the limit of 300 undo steps.';
const WINDOW_OPEN = 'The confirm window has not yet expired.';
/** The largest f32 value not above x (x > 0): a cost row stores f32, so a price meant to use up a budget must not round up. */
function f32AtMost(x: number): number {
    const v = new Float32Array([x]);
    if (v[0] > x) new Uint32Array(v.buffer)[0] -= 1;
    return v[0];
}
const undoBody = (s: Lobby) => (ctx: any) => M.undo_last_step(ctx, { lobbyId: s.lobbyId });
const expectNonNegative = (s: Lobby) => {
    for (const side of ['Blue', 'Red'] as const) {
        const b = budgets(s, side);
        expect(b.char, `${side} character budget`).toBeGreaterThanOrEqual(0);
        expect(b.lc, `${side} light-cone budget`).toBeGreaterThanOrEqual(0);
    }
};

// ════════════════════════════════════════════════════════════════════════════
// A134: an open round
// ════════════════════════════════════════════════════════════════════════════

describe('A134: an undo with a nomination open removes the whole round', () => {
    it('A134: an open nomination without bids (12.7): the Nominate step goes; no nomination, the same nominator, a fresh clock, one Undo row', () => {
        const s = lobby();
        const nominator = nominatorOf(s);
        const before = world(s);
        nominate(s, 'x', 12.7);
        const nom = stepsOf(s, 'Nominate')[0];
        undo(s);
        expect(world(s)).toEqual(before);
        expectNoRound(s, nominator);
        const rows = stepsOf(s, 'Undo');
        expect(rows).toHaveLength(1);
        expect((rows[0].payload.value as any).originalSequenceId).toBe(nom.sequence);
    });

    it('A134: one bid (0.7 opened, Red 33.3): the nomination and the bid go in one undo; budgets identical bit for bit', () => {
        const s = lobby({ minimumBidRaise: 0.1 });
        const nominator = nominatorOf(s);
        const before = world(s);
        const b0 = [budgets(s, 'Blue'), budgets(s, 'Red')];
        nominate(s, 'x', 0.7);
        bid(s, other(nominator), 33.3);
        undo(s);
        expect(world(s)).toEqual(before);
        const b1 = [budgets(s, 'Blue'), budgets(s, 'Red')];
        for (let i = 0; i < 2; i++) {
            expect(Object.is(b1[i].char, b0[i].char)).toBe(true);
            expect(Object.is(b1[i].lc, b0[i].lc)).toBe(true);
        }
        expect(b1).toEqual([{ char: 100, lc: 50, won: 0 }, { char: 100, lc: 50, won: 0 }]);
        expect([stepsOf(s, 'Nominate'), stepsOf(s, 'Bid')]).toEqual([[], []]);
        expect(stepsOf(s, 'Undo')).toHaveLength(1);
        expectNoRound(s, nominator);
    });

    it('A134: several bids (0.1 opened; 0.7, 12.7, 33.3): every Bid step and the Nominate step go in one undo; the nominator nominates again', () => {
        const s = lobby({ minimumBidRaise: 0.1 });
        const nominator = nominatorOf(s);
        const before = world(s);
        nominate(s, 'x', 0.1);
        bid(s, other(nominator), 0.7);
        bid(s, nominator, 12.7);
        bid(s, other(nominator), 33.3);
        const lastBid = stepsOf(s, 'Bid').sort((a, b) => b.sequence - a.sequence)[0];
        expect(stepsOf(s, 'Bid')).toHaveLength(3);
        undo(s);
        expect(world(s)).toEqual(before);
        expectNoRound(s, nominator);
        expect(stepsOf(s, 'Undo')).toHaveLength(1);
        expect((stepsOf(s, 'Undo')[0].payload.value as any).originalSequenceId).toBe(lastBid.sequence);
        // The same team nominates again, and the round plays normally.
        nominate(s, 'x');
        bid(s, other(nominator), 0.7);
        pass(s, nominator);
        expect(budgets(s, other(nominator))).toEqual({ char: f(100 - 0.7), lc: 50, won: 1 });
    });

    it("A134: the timer's EMPTY nomination with a bid on it is removed the same way", () => {
        const s = lobby({ minimumBidRaise: 0.1 });
        const nominator = nominatorOf(s);
        const before = world(s);
        expire(s, 'Blue');
        expect(session(s.test, s.lobbyId).currentNomination).toBe('EMPTY');
        bid(s, other(nominator), 0.1);
        undo(s);
        expect(world(s)).toEqual(before);
        expectNoRound(s, nominator);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A134: right after a sale
// ════════════════════════════════════════════════════════════════════════════

/** Blue wins 7 characters (cost 0) and holds the 8th at 1, Red to respond. */
function blueOneShortOfFull(s: Lobby): void {
    let n = 0;
    if (nominatorOf(s) === 'Red') { nominate(s, `fill-${++n}`); pass(s, 'Blue'); }
    nominate(s, `fill-${++n}`); // Blue
    pass(s, 'Red'); // Blue wins at 0; Red nominates next
    while (budgets(s, 'Blue').won < 7) {
        nominate(s, `fill-${++n}`); // Red
        bid(s, 'Blue', 1);
        pass(s, 'Red'); // a steal: Red nominates again
    }
    nominate(s, `fill-${++n}`);
    bid(s, 'Blue', 1);
}

describe('A134: an undo right after a sale returns to the moment before that nomination', () => {
    it('A134: a sale by pass (12.7 opened, a steal at 33.3): the state equals the snapshot taken before the nomination', () => {
        const s = lobby({ minimumBidRaise: 0.1 });
        const nominator = nominatorOf(s);
        const before = world(s);
        nominate(s, 'x', 12.7);
        bid(s, other(nominator), 33.3);
        pass(s, nominator); // a steal
        expect(budgets(s, other(nominator))).toEqual({ char: f(100 - 33.3), lc: 50, won: 1 });
        const sale = stepsOf(s, 'AuctionSold')[0];
        undo(s);
        expect(world(s)).toEqual(before);
        expect(budgets(s, other(nominator))).toEqual({ char: 100, lc: 50, won: 0 });
        expectNoRound(s, nominator);
        expect(stepsOf(s, 'Undo').map((x) => (x.payload.value as any).originalSequenceId)).toEqual([sale.sequence]);
    });

    it('A134: a sale by the timer (0.7 opened, Red 12.7): the same', () => {
        const s = lobby({ characterBudget: 33.3, lightconeBudget: 12.7, minimumBidRaise: 0.1 });
        const nominator = nominatorOf(s);
        const before = world(s);
        nominate(s, 'x', 0.7);
        bid(s, other(nominator), 12.7);
        expire(s, nominator);
        expect(budgets(s, other(nominator))).toEqual({ char: f(f(33.3) - f(12.7)), lc: f(12.7), won: 1 });
        undo(s);
        expect(world(s)).toEqual(before);
        expect(budgets(s, other(nominator))).toEqual({ char: f(33.3), lc: f(12.7), won: 0 });
        expectNoRound(s, nominator);
    });

    it('A134: a sale where the default extra spilled into light cones (ownership, E2 extra 30 on a bid of 90): both budgets come back', () => {
        const s = lobby({ requireOwnership: true });
        selectAccount(s.test, s.lobbyId, s.a.b1.userId, 9001, { spill: 2, f0: 0 });
        selectAccount(s.test, s.lobbyId, s.a.r1.userId, 9002, { spill: 0, f0: 0 });
        if (nominatorOf(s) === 'Red') { nominate(s, 'f0'); pass(s, 'Blue'); }
        const before = world(s);
        nominate(s, 'spill', [10, 20, 40, 40, 40, 40, 40]); // Blue at 10, default E2 → extra 30
        bid(s, 'Red', 11);
        bid(s, 'Blue', 90);
        pass(s, 'Red');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 30, won: before.session.blueCharactersWon + 1 });
        undo(s);
        expect(world(s)).toEqual(before);
        expectNoRound(s, 'Blue');
    });

    it('A134 / A81(2): the immediate sale (the other team full) is undone the same way; the timer\'s immediate EMPTY sale too', () => {
        const s = lobby();
        blueOneShortOfFull(s);
        pass(s, 'Red'); // Blue full (8)
        const full = world(s);
        nominate(s, 'late', 12.7); // Red: sold to Red at once
        expect(budgets(s, 'Red')).toMatchObject({ char: f(100 - 12.7), won: 1 });
        undo(s);
        expect(world(s)).toEqual(full);
        expectNoRound(s, 'Red');
        expire(s, 'Red');
        expect(stepsOf(s, 'AuctionSold').some((x) => (x.payload.value as any).characterName === 'EMPTY')).toBe(true);
        undo(s);
        expect(world(s)).toEqual(full);
        expect(stepsOf(s, 'Undo')).toHaveLength(2);
    });

    it('A134: undoing the sale that filled a team removes its round too: won 7, nobody holds the 8th, the nominator (Red) nominates again', () => {
        const s = lobby();
        blueOneShortOfFull(s);
        const nominates = stepsOf(s, 'Nominate').length;
        const held = budgets(s, 'Blue'); // bids charge nothing: the budgets before the round that fills Blue
        pass(s, 'Red'); // fills Blue
        undo(s);
        expect(budgets(s, 'Blue')).toEqual({ ...held, won: 7 });
        expect(held.char).toBe(100 - 6); // six steals at 1, the first sale at 0
        expect(stepsOf(s, 'Nominate')).toHaveLength(nominates - 1);
        expectNoRound(s, 'Red');
    });

    it('A134 / A132: the winner\'s selections on the sold character go with it; a selection on another character made during the round stays with its cost', () => {
        const s = lobby({ minimumBidRaise: 0.1 });
        buyAt(s, 'Blue', 'B', [0, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7], 'f1'); // Blue owns B at 0; Red nominates next
        expect(nominatorOf(s)).toBe('Red');
        const before = world(s);
        nominate(s, 'X', [0.1, 12.8, 12.8, 12.8, 12.8, 12.8, 12.8]); // Red at 0.1
        bid(s, 'Blue', 12.7);
        eid(s, 'Blue', 'B', 1); // during the round, on another character: +0.7 from the character budget (Blue holds 12.7)
        expect(budgets(s, 'Blue')).toMatchObject({ char: f(100 - 0.7), lc: 50 });
        pass(s, 'Red'); // Blue buys X at 12.7
        eid(s, 'Blue', 'X', 1); // +12.7 on the sold character
        expect(budgets(s, 'Blue')).toMatchObject({ char: f(f(f(100 - 0.7) - f(12.7)) - (12.8 - 0.1)), lc: 50 });
        undo(s);
        // X, its round and its edit are gone; B's edit and its 0.7 stand.
        expect(budgets(s, 'Blue')).toEqual({ char: f(100 - 0.7), lc: 50, won: 1 });
        expect(stepsOf(s, 'SetEidolon').map((x) => (x.payload.value as any).characterName)).toEqual(['B']);
        expect(world(s).steps).toEqual([...before.steps, canon(stepsOf(s, 'SetEidolon')[0])]);
        expectNoRound(s, 'Red');
    });

    it('A134 / A132: an open round undone with a selection on another character in it: the selection and its cost stay', () => {
        const s = lobby({ minimumBidRaise: 0.1 });
        buyAt(s, 'Blue', 'B', [0, 33.3, 33.3, 33.3, 33.3, 33.3, 33.3], 'f1');
        nominate(s, 'X', 0.1); // Red
        bid(s, 'Blue', 0.7);
        eid(s, 'Blue', 'B', 1); // +33.3
        undo(s);
        expect(budgets(s, 'Blue')).toEqual({ char: f(100 - 33.3), lc: 50, won: 1 });
        expect(stepsOf(s, 'SetEidolon')).toHaveLength(1);
        expectNoRound(s, 'Red');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Review 3 sequences: F1 (deadlock), F2 (budget created), F3 (negative light-cone budget)
// ════════════════════════════════════════════════════════════════════════════

describe('A134: the review 3 F1 deadlock sequence ends in a playable state', () => {
    it('A134 (review 3 D1): Blue 0.7 wins X, Red spilled on Rr while outbid, Blue empties its character budget on Bx, the sale is undone: Red nominates again; bid, pass and the timer all work', () => {
        const s = lobby({ minimumBidRaise: 0.1 }); // 100 / 50
        const E6 = [0, 0, 0, 0, 0, 0, 120];
        buyAt(s, 'Blue', 'Bx', E6, 'f1');
        buyAt(s, 'Red', 'Rr', E6, 'f2');
        if (nominatorOf(s) !== 'Red') { nominate(s, 'f3'); pass(s, 'Red'); }
        nominate(s, 'X', 0.1); // Red
        bid(s, 'Blue', 0.7);
        eid(s, 'Red', 'Rr', 6); // Red, outbid: 100 from the character budget, 20 from light cones
        expect(budgets(s, 'Red')).toMatchObject({ char: 0, lc: 30 });
        pass(s, 'Red'); // Blue wins X at 0.7
        const blueChar = f(100 - 0.7);
        expect(budgets(s, 'Blue')).toMatchObject({ char: blueChar, lc: 50 });
        eid(s, 'Blue', 'Bx', 6); // 99.3000031 from the character budget, the rest from light cones
        const blueLc = f(50 - (120 - blueChar));
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: blueLc });
        const blueWon = budgets(s, 'Blue').won;
        const redWon = budgets(s, 'Red').won;

        undo(s); // the sale of X with its round
        expectNoRound(s, 'Red');
        expect(budgets(s, 'Blue')).toEqual({ char: 100 - blueChar, lc: blueLc, won: blueWon - 1 });
        expect(budgets(s, 'Red')).toMatchObject({ char: 0, lc: 30 });
        expect(stepsOf(s, 'Bid')).toHaveLength(0);

        // Red (character budget 0) cannot nominate X at 0.1 but nominates EMPTY; Blue bids 0.5 (it has 0.69999695).
        expect(rejection(s.test, captain(s, 'Red'), nominateBody(s, 'X'))).toBe(NOMINATE_COST);
        nominate(s, 'EMPTY');
        bid(s, 'Blue', 0.5);
        pass(s, 'Red'); // Blue wins EMPTY at 0.5 (a steal: Red nominates again)
        expect(budgets(s, 'Blue')).toMatchObject({ char: f((100 - blueChar) - 0.5), won: blueWon });
        nominate(s, 'z', 0); // Red
        expire(s, 'Blue'); // the timer sells z to Red at 0
        expect(budgets(s, 'Red').won).toBe(redWon + 1);
        nominate(s, 'X'); // Blue at 0.1 (0.19999695 left)
        pass(s, 'Red');
        expect(budgets(s, 'Blue')).toMatchObject({ char: f(f((100 - blueChar) - 0.5) - f(0.1)), won: blueWon + 1 });
        expectNonNegative(s);
    });
});

describe('A134: the review 3 F2 sequence cannot create budget', () => {
    it('A134 (review 3 A1, ownership): Red bids 12 (+ extra 8), is outbid at 13, raises R by 5; the undo removes the round; Red can then bid only what bid + extra fits (9) and ends at 0 / 0, the rule value', () => {
        const s = lobby({ requireOwnership: true, characterBudget: 20, lightconeBudget: 3, minimumBidRaise: 1 }, TWO_V_TWO);
        price(s, 'R', [1, 1, 1, 6, 6, 6, 6]);
        price(s, 'N', [0, 4, 8, 8, 8, 8, 8]);
        selectAccount(s.test, s.lobbyId, s.a.b1.userId, 9001, { R: 0, N: 0, f: 0 });
        selectAccount(s.test, s.lobbyId, s.a.b2.userId, 9002, { R: 0, N: 0, f: 0 });
        selectAccount(s.test, s.lobbyId, s.a.r1.userId, 9003, { R: 0, N: 2, f: 0 }); // Red's default for N: E2, extra 8
        selectAccount(s.test, s.lobbyId, s.a.r2.userId, 9004, { R: 3, N: 2, f: 0 }); // R at E3: +5
        buyAt(s, 'Red', 'R', [1, 1, 1, 6, 6, 6, 6], 'f'); // Red buys R at 1: 19 / 3
        expect(budgets(s, 'Red')).toMatchObject({ char: 19, lc: 3 });
        expect(nominatorOf(s)).toBe('Blue');
        nominate(s, 'N'); // Blue at 0
        bid(s, 'Red', 12); // 12 + 8 = 20 <= 22
        bid(s, 'Blue', 13);
        eid(s, 'Red', 'R', 3); // Red, outbid: +5 → 14 / 3, total 17
        expect(budgets(s, 'Red')).toMatchObject({ char: 14, lc: 3 });
        undo(s);
        expectNoRound(s, 'Blue');
        expect(budgets(s, 'Red')).toMatchObject({ char: 14, lc: 3, won: 1 });
        nominate(s, 'N'); // Blue again
        expect(rejection(s.test, captain(s, 'Red'), bidBody(s, 12))).toBe(TOTAL); // 12 + 8 > 17
        bid(s, 'Red', 9); // 9 + 8 = 17
        pass(s, 'Blue');
        // Red: start 23 - (R: 1 + 5) - (N: 9 + 8) = 0.
        expect(budgets(s, 'Red')).toEqual({ char: 0, lc: 0, won: 2 });
        const sold = stepsOf(s, 'AuctionSold').find((x) => (x.payload.value as any).characterName === 'N')!.payload.value as any;
        expect([sold.winningAmount, sold.eidolonCost, sold.charCharged, sold.lcCharged]).toEqual([9, 8, 14, 3]);
    });
});

describe('A134: both budgets stay at least 0 after a sale undo (review 3 F3)', () => {
    it('A134 (review 3 D2): buy Bx and X, raise X, lower X, spend everything on Bx, undo the sale of X: no budget below 0, the total equals the rule value', () => {
        let cases = 0;
        for (const cb of [33.3, 21.7]) for (const lcb of [12.7, 3.1]) for (const up of [0.1, 0.3, 0.7, 1.83, 7.77]) for (const w of [0, 0.1]) {
            const raise = f(w + up) - f(w); // the extra at E1, from the stored f32 costs
            const c2 = f(f(f(cb) - f(w)) - raise);
            const l2 = f(f(lcb) + raise);
            const total = f32AtMost(c2 + l2); // everything Blue has left after the lowering (an f32 cost, not above it)
            const s = lobby({ characterBudget: cb, lightconeBudget: lcb, minimumBidRaise: 0.1 });
            buyAt(s, 'Blue', 'Bx', [0, 0, 0, 0, 0, 0, total], 'f1');
            buyAt(s, 'Blue', 'X', [w, w + up, w + up, w + up, w + up, w + up, w + up], 'f2');
            eid(s, 'Blue', 'X', 1);
            eid(s, 'Blue', 'X', 0);
            expect(budgets(s, 'Blue')).toMatchObject({ char: c2, lc: l2 });
            eid(s, 'Blue', 'Bx', 6);
            undo(s); // the sale of X with both edits
            const b = budgets(s, 'Blue');
            expect(b.char).toBeGreaterThanOrEqual(0);
            expect(b.lc).toBeGreaterThanOrEqual(0);
            // Rule: Blue holds f1-or-nothing at 0 and Bx at 0 + extra `total`.
            expect(Math.abs(b.char + b.lc - (f(cb) + f(lcb) - total))).toBeLessThan(1e-5);
            expectNonNegative(s);
            cases++;
        }
        expect(cases).toBe(40);
    }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════
// A134: several rounds, the ban phase, the confirm window, the cap
// ════════════════════════════════════════════════════════════════════════════

describe('A134: rounds undone in a row reach back into the ban phase (A123); the draft then finishes normally', () => {
    it('A134: an open round, a timer sale and a sale by pass undone against the snapshots; the next undo removes the last ban; replayed to the end', () => {
        const s = lobby({ banMode: { tag: 'Four' }, minimumBidRaise: 0.1 });
        const { test, lobbyId } = s;
        const ban = (name: string) => {
            const sess = session(test, lobbyId);
            priceBanNames(test, lobbyId, [name]);
            tx(test, captain(s, sess.draftSequence[sess.turnIndex].teamTurn.tag as Side), (ctx) => M.ban_character(ctx, { lobbyId, characterName: name }));
        };
        for (const name of ['ban-a', 'ban-b', 'ban-c', 'ban-d']) ban(name);
        expect(session(test, lobbyId).isAuctionPhase).toBe(true);
        const n0 = nominatorOf(s);
        const s0 = world(s);
        nominate(s, 'n1', 12.7);
        bid(s, other(n0), 33.3);
        pass(s, n0); // a steal: n0 nominates again
        const s1 = world(s);
        nominate(s, 'n2', 0.7);
        expire(s, n0); // the timer sells n2 to n0 at 0.7; the other team nominates next
        const s2 = world(s);
        nominate(s, 'n3', 0.1);
        bid(s, n0, 12.7);
        bid(s, other(n0), 33.3); // the round stays open

        undo(s);
        expect(world(s)).toEqual(s2);
        expectNoRound(s, other(n0));
        undo(s);
        expect(world(s)).toEqual(s1);
        expectNoRound(s, n0);
        undo(s);
        expect(world(s)).toEqual(s0);
        expectNoRound(s, n0);
        undo(s); // A123: the last ban
        expect(session(test, lobbyId)).toMatchObject({ isAuctionPhase: false, turnIndex: 3 });
        expect(stepsOf(s, 'Ban')).toHaveLength(3);
        expect(stepsOf(s, 'Undo')).toHaveLength(4);
        for (const side of ['Blue', 'Red'] as const) expect(budgets(s, side)).toEqual({ char: 100, lc: 50, won: 0 });

        ban('ban-d');
        completeDraft(s);
        expect([session(test, lobbyId).blueCharactersWon, session(test, lobbyId).redCharactersWon]).toEqual([8, 8]);
    });
});

describe('A134 / A130: undo in the confirm window', () => {
    it('A134: undoing the last sale returns to before that nomination with its nominator to act; finishing again starts a fresh window', () => {
        const s = lobby();
        playAuction(s, 15);
        const beforeLast = world(s);
        const nominator = nominatorOf(s);
        playAuction(s, 16);
        expect(draftDone(s.test, s.lobbyId)).toBe(true);
        advance(s.test, 50_000);
        undo(s);
        expect(world(s)).toEqual(beforeLast);
        expectNoRound(s, nominator);
        playAuction(s, 16);
        advance(s.test, 50_000);
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }))).toBe(WINDOW_OPEN);
        advance(s.test, 10_000);
        tx(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('Equipping');
    });
});

describe('A134 / A122(10): the cap of 300 Undo rows', () => {
    const insertUndoRows = (test: Harness, lobbyId: number, n: number) => {
        const ts = test.clock.now();
        for (let i = 0; i < n; i++) {
            test.db.MatchSessionStep.insert({
                id: 0, lobbyId, sequence: 10_000 + i, actorUserId: 0, anonymousLabel: undefined, actorSlot: { tag: 'Spectator' },
                action: { tag: 'Undo' }, payload: { tag: 'Undo', value: { originalSequenceId: 0 } }, timestamp: ts,
                createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts,
            } as any);
        }
    };
    function openRound(): Lobby {
        const s = lobby({ minimumBidRaise: 0.1 });
        nominate(s, 'x', 0.7);
        bid(s, other(nominatorOf(s)), 12.7);
        return s;
    }

    it('A134: at 300 Undo rows the round undo is refused and nothing changes; at 299 it removes the whole round with the 300th row', () => {
        const s = openRound();
        insertUndoRows(s.test, s.lobbyId, 300);
        const before = world(s);
        expect(rejection(s.test, s.host, undoBody(s))).toBe(CAP);
        expect(world(s)).toEqual(before);

        const t = openRound();
        insertUndoRows(t.test, t.lobbyId, 299);
        undo(t);
        expect([stepsOf(t, 'Nominate'), stepsOf(t, 'Bid')]).toEqual([[], []]);
        expect(stepsOf(t, 'Undo')).toHaveLength(300);
    });
});
