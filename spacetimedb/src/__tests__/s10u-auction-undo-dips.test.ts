// T-S10u: in-memory tests for step S10u (DECISIONS.md A133, A134).
// A134: in the auction phase the unit of undo is the nomination round. An undo with a round open removes the Nominate
// step and every Bid step of it; an undo right after a sale (by pass, by the timer or the A81 immediate sale) removes the
// AuctionSold step with its Nominate and Bid steps and the winner's eidolon selections on that character, and gives back
// what they charged. Either way: no open nomination, nobody holds a bid, the same team nominates with a fresh clock, one
// Undo row. A133: during the draft of an Auction game an eidolon cost may spill from the character budget into the
// light-cone budget only while the character budget is above 0 before the charge; a sale is one charge (bid + default
// extra). State is built through the module's reducers; cost rows and HSR accounts are written straight into the
// in-memory datastore outside any reducer, like the earlier suites. TestClock; nothing reaches maincloud. Prices are
// non-dyadic (0.1, 0.7, 12.7, 33.3, ...) as well as integers; expected budgets are written as the f32 arithmetic the
// rules imply (Math.fround of each stored value).
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    draftDone,
    lobbyRow,
    newHarness,
    priceBanNames,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Harness,
    type Lobby,
    type SetupOpts,
} from './s4-fixtures';
import { captain, completeDraft, selectAccount } from './s7-fixtures';
import { rejection } from './s10-c2-fixtures';

// ─── Texts ───────────────────────────────────────────────────────────────────

const RAISE_AT_ZERO = 'Not enough character budget: an eidolon cost can use the light-cone budget only while character budget remains.';
const TAKE_AT_ZERO = 'Not enough character budget: at 0 character budget your team cannot take a character whose eidolon costs extra.';
const TOTAL = 'Not enough total budget: the eidolon extra for this character would exceed it.';
const NOMINATE_COST = 'Not enough budget to nominate this character.';
const CAP = 'This game has reached the limit of 300 undo steps.';
const WINDOW_OPEN = 'The confirm window has not yet expired.';

// ─── Builders ────────────────────────────────────────────────────────────────

type Side = 'Blue' | 'Red';
const f = Math.fround;
/** The largest f32 value not above x (x > 0): a cost row stores f32, so a price meant to use up a budget must not round up. */
function f32AtMost(x: number): number {
    const v = new Float32Array([x]);
    if (v[0] > x) new Uint32Array(v.buffer)[0] -= 1;
    return v[0];
}
const TURN_MS = 30_000;
const ONE_V_ONE: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['r1', 'RedPlayer']];
const TWO_V_TWO: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];
const AUCTION = { draftMode: { tag: 'Auction' } };
const other = (side: Side): Side => (side === 'Blue' ? 'Red' : 'Blue');

function lobby(args: Record<string, unknown> = {}, seats: SetupOpts['seats'] = ONE_V_ONE): Lobby {
    return setupLobby(newHarness(), { seats, lobby: { ...AUCTION, ...args } });
}

const undo = (s: Lobby) => { advance(s.test, 50); tx(s.test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId })); };
const undoBody = (s: Lobby) => (ctx: any) => M.undo_last_step(ctx, { lobbyId: s.lobbyId });
const nominatorOf = (s: Lobby) => session(s.test, s.lobbyId).nextNominatorTeam.tag as Side;
const stepsOf = (s: Lobby, tag: string) => steps(s.test, s.lobbyId).filter((x) => x.action.tag === tag);
const price = (s: Lobby, name: string, ladder: number | number[] = 0) => priceCharacters(s.test, s.lobbyId, [name], ladder);

/** The nominator's captain nominates `name` (priced first when a ladder is given). */
function nominate(s: Lobby, name: string, ladder: number | number[] = 0) {
    if (name !== 'EMPTY') price(s, name, ladder);
    advance(s.test, 300);
    tx(s.test, captain(s, nominatorOf(s)), (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: name }));
}
const nominateBody = (s: Lobby, name: string) => (ctx: any) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: name });
const bid = (s: Lobby, side: Side, bidAmount: number) => {
    advance(s.test, 300);
    tx(s.test, captain(s, side), bidBody(s, bidAmount));
};
// bidAmount is an f32 argument: the wire delivers the f32 value, so the helpers pass Math.fround of it.
const bidBody = (s: Lobby, bidAmount: number) => (ctx: any) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: f(bidAmount) });
const pass = (s: Lobby, side: Side) => { advance(s.test, 300); tx(s.test, captain(s, side), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId })); };
const expire = (s: Lobby, who: Side = 'Blue') => {
    advance(s.test, TURN_MS + 1_000);
    tx(s.test, captain(s, who), (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }));
};
const eidBody = (s: Lobby, side: Side, characterName: string, eidolon: number) =>
    (ctx: any) => M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: { tag: side } as any, characterName, eidolon });
/** set_eidolon by the side's captain, past the lineup throttle. */
const eid = (s: Lobby, side: Side, name: string, e: number) => { advance(s.test, 1_100); tx(s.test, captain(s, side), eidBody(s, side, name, e)); };
const eidRejected = (s: Lobby, side: Side, name: string, e: number) => { advance(s.test, 1_100); return rejection(s.test, captain(s, side), eidBody(s, side, name, e)); };

/** `side` wins `name` at its opening amount: a cost-0 filler sale first when the other team is to nominate. */
function buyAt(s: Lobby, side: Side, name: string, ladder: number | number[], filler: string) {
    if (nominatorOf(s) !== side) { nominate(s, filler, 0); pass(s, side); }
    nominate(s, name, ladder);
    pass(s, other(side));
}

const budgets = (s: Lobby, side: Side) => {
    const x = session(s.test, s.lobbyId);
    return side === 'Blue'
        ? { char: x.teamBlueCharBudget, lc: x.teamBlueLcBudget, won: x.blueCharactersWon }
        : { char: x.teamRedCharBudget, lc: x.teamRedLcBudget, won: x.redCharactersWon };
};
const nowMicros = (s: Lobby) => s.test.clock.now().microsSinceUnixEpoch;

// ─── The snapshot (as in s10t-undo-any-step) ─────────────────────────────────

const AUDIT_KEYS = new Set(['createdById', 'createdDate', 'lastModifiedById', 'lastModifiedDate']);
function canon(v: any): any {
    if (v === undefined || v === null) return null;
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(canon);
    if (typeof v.microsSinceUnixEpoch === 'bigint') return `ts:${v.microsSinceUnixEpoch}`;
    if (typeof v.toHexString === 'function') return `hex:${v.toHexString()}`;
    const keys = Object.keys(v);
    if ('tag' in v && keys.every((k) => k === 'tag' || k === 'value')) {
        const val = v.value;
        const unit = val === undefined || val === null
            || (typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0 && typeof val.microsSinceUnixEpoch !== 'bigint');
        return unit ? { tag: v.tag } : { tag: v.tag, value: canon(val) };
    }
    const out: Record<string, unknown> = {};
    for (const k of keys.sort()) if (!AUDIT_KEYS.has(k)) out[k] = canon(v[k]);
    return out;
}
/** The session row, the lobby row and the step rows (Undo rows left out), minus the turn clock and lastActivityAt. */
function world(s: Lobby) {
    const sess = canon(session(s.test, s.lobbyId));
    delete sess.timerState.turnStartAt;
    delete sess.timerState.accumulatedPauseMs;
    const lob = canon(lobbyRow(s.test, s.lobbyId));
    delete lob.lastActivityAt;
    const rows = steps(s.test, s.lobbyId).filter((x) => x.action.tag !== 'Undo').sort((a, b) => a.sequence - b.sequence).map(canon);
    return { session: sess, lobby: lob, steps: rows };
}

/** A134: after any auction undo: no open nomination, nobody holds a bid, a fresh turn clock. */
function expectNoRound(s: Lobby, nominator: Side) {
    const x = session(s.test, s.lobbyId);
    expect(x.currentNomination).toBeUndefined();
    expect(x.currentBidAmount).toBeUndefined();
    expect(x.currentBidTeam.tag).toBe('Spectator');
    expect(x.nextNominatorTeam.tag).toBe(nominator);
    expect(x.timerState.turnStartAt.microsSinceUnixEpoch).toBe(nowMicros(s));
    expect(x.timerState.accumulatedPauseMs).toBe(0);
}
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

/** Plays the Auction until `sales` sales: Blue's nominations cost 5 and Red passes, Red's cost 0 and Blue passes. */
function playAuction(s: Lobby, sales = 16, blueCost = 5) {
    let n = stepsOf(s, 'Nominate').length + stepsOf(s, 'Undo').length;
    while (lobbyRow(s.test, s.lobbyId).stage.tag === 'Drafting' && stepsOf(s, 'AuctionSold').length < sales) {
        const sess = session(s.test, s.lobbyId);
        const team = sess.nextNominatorTeam.tag as Side;
        const otherFull = (team === 'Blue' ? sess.redCharactersWon : sess.blueCharactersWon) >= 8;
        nominate(s, `a${++n}`, team === 'Blue' ? blueCost : 0);
        if (!otherFull) pass(s, other(team));
    }
}

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
const E6 = (x: number) => [0, 0, 0, 0, 0, 0, x];

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
