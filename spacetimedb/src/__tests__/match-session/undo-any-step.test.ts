// Match session: undo of any step (bids, sales, full teams, eidolon selections, chains back to the first step).
// Decisions: A81, A127, A132, A134
// Contracts: docs/match-session/contract.md
// From S10t (s10t-undo-any-step.test.ts).
import { describe, expect, it } from 'vitest';
import { teamDraft } from '@module/helpers/results/scoringHelpers';
import {
    M,
    advance,
    checksFor,
    disconnect,
    dropDefaultCostCoverage,
    fireCheck,
    lobbyRow,
    member,
    newHarness,
    priceBanNames,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Harness,
    type Lobby,
    rejection,
    AUCTION,
    ONE_V_ONE,
    TURN_MS,
    other,
    type Side,
} from '../fixtures/harness';
import { captain, completeDraft, selectAccount, setEidolon } from '../fixtures/draft-and-scoring';
import { budgets, nominatorOf, stepsOf } from '../fixtures/auction';
import { FINISHED, lobby, nominate, pass, playClassic, stage, undo, undoBody, world } from '../fixtures/undo';
import { seedElo } from '../fixtures/tournament-matches';
import { rankedHook } from '../fixtures/ranked';

const PAUSED = 'Nothing to undo right now.';
const NOT_REFEREE = 'Only referees with undo permission can undo.';
const AWAY = 'You are away from this match. Return to it before acting.'; // A98, A146
const CAP = 'This game has reached the limit of 300 undo steps.';
const NO_STEPS = 'No steps to undo.';
const bid = (s: Lobby, side: Side, bidAmount: number) =>
    tx(s.test, captain(s, side), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount }));
const expireAuction = (s: Lobby, who: Side = 'Blue') => {
    advance(s.test, TURN_MS + 1_000);
    tx(s.test, captain(s, who), (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }));
};

// ════════════════════════════════════════════════════════════════════════════
// Bids
// ════════════════════════════════════════════════════════════════════════════

// T-S10u re-alignment (A134): in the auction phase an undo removes the whole nomination round; no undo restores an
// earlier bidder as holder. The sale tests below now expect the state before the nomination.
describe('A127 / A134: undo of a bid removes the whole round', () => {
    it('A134: the first bid: the bid and the nomination go; nobody holds a bid; the nominator nominates again', () => {
        const s = lobby(AUCTION);
        const before = world(s);
        nominate(s, 'x', 10); // Blue nominates at the E0 cost 10
        bid(s, 'Red', 15);
        undo(s);
        expect(world(s)).toEqual(before);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: undefined, currentBidAmount: undefined, currentBidTeam: { tag: 'Spectator' } });
        expect(stepsOf(s, 'Bid')).toHaveLength(0);
        expect((stepsOf(s, 'Undo')[0].payload.value as any).originalSequenceId).toBeGreaterThan(0);
    });

    it('A134: a bid over an earlier bid: one undo removes both bids and the nomination; the round then plays again', () => {
        const s = lobby(AUCTION);
        const before = world(s);
        nominate(s, 'x', 10);
        bid(s, 'Red', 15);
        bid(s, 'Blue', 20.5);
        undo(s);
        expect(world(s)).toEqual(before);
        expect(stepsOf(s, 'Undo')).toHaveLength(1);
        // The nominator nominates again and the bidding goes on normally.
        nominate(s, 'x', 10);
        bid(s, 'Red', 12);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentBidAmount: 12, currentBidTeam: { tag: 'Red' } });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Sales
// ════════════════════════════════════════════════════════════════════════════

describe('A127 / A134: undo of a sale returns to the state before its nomination', () => {
    it('A134: a sale by pass: the round goes; budgets, won count and next nominator restored; the replay sells again the same way', () => {
        const s = lobby(AUCTION);
        const beforeSale = world(s); // T-S10u: the state before the nomination
        nominate(s, 'x', 10);
        bid(s, 'Red', 15);
        pass(s, 'Blue'); // Red wins at 15 (a steal: Blue nominates again)
        const sold = world(s);
        expect(budgets(s, 'Red')).toEqual({ char: 85, lc: 50, won: 1 });
        undo(s);
        expect(world(s)).toEqual(beforeSale);
        expect(budgets(s, 'Red')).toEqual({ char: 100, lc: 50, won: 0 });
        nominate(s, 'x', 10);
        bid(s, 'Red', 15);
        pass(s, 'Blue');
        expect(world(s).session).toEqual(sold.session);
        expect(world(s).lobby).toEqual(sold.lobby);
    });

    it('A134: a sale made by the timer (actor 0) is undone the same way', () => {
        const s = lobby(AUCTION);
        const beforeSale = world(s); // T-S10u: the state before the nomination
        nominate(s, 'x', 10);
        bid(s, 'Red', 15);
        expireAuction(s);
        const sale = stepsOf(s, 'AuctionSold')[0];
        expect([sale.actorUserId, sale.actorSlot.tag]).toEqual([0, 'Spectator']);
        undo(s);
        expect(world(s)).toEqual(beforeSale);
    });

    it('A127: a sale whose eidolon extra spills from the character budget into the light-cone budget restores both budgets', () => {
        const s = lobby({ ...AUCTION, requireOwnership: true });
        selectAccount(s.test, s.lobbyId, s.a.b1.userId, 9001, { spill: 2 }); // Blue owns E2 only: default eidolon 2
        selectAccount(s.test, s.lobbyId, s.a.r1.userId, 9002, { spill: 0 });
        const beforeSale = world(s); // T-S10u: the state before the nomination
        nominate(s, 'spill', [10, 20, 40, 40, 40, 40, 40]); // extra at E2 = 30
        bid(s, 'Red', 11);
        bid(s, 'Blue', 90);
        pass(s, 'Red');
        // 100 - 90 = 10 left; the extra 30 takes those 10, then 20 from the light-cone budget.
        expect(budgets(s, 'Blue')).toEqual({ char: 0, lc: 30, won: 1 });
        undo(s);
        expect(world(s)).toEqual(beforeSale);
        expect(budgets(s, 'Blue')).toEqual({ char: 100, lc: 50, won: 0 });
    });

    it('A127: a sale that leaves the character budget at 0 is restored exactly', () => {
        const s = lobby(AUCTION);
        const beforeSale = world(s); // T-S10u: the state before the nomination
        nominate(s, 'all', 0);
        bid(s, 'Red', 1);
        bid(s, 'Blue', 100);
        pass(s, 'Red');
        expect(budgets(s, 'Blue')).toEqual({ char: 0, lc: 50, won: 1 });
        undo(s);
        expect(world(s)).toEqual(beforeSale);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A full team: the A81 immediate sale and the sale that filled the team
// ════════════════════════════════════════════════════════════════════════════

/** Blue wins 7 characters (Red nominates, Blue steals at 1) and holds the 8th at 1, Red to respond. */
function blueOneShortOfFull(s: Lobby): void {
    let n = 0;
    nominate(s, `fill-${++n}`); // Blue nominates first
    pass(s, 'Red'); // Blue wins at 0; Red nominates next
    while (budgets(s, 'Blue').won < 7) {
        nominate(s, `fill-${++n}`); // Red nominates
        bid(s, 'Blue', 1);
        pass(s, 'Red'); // a steal: Red nominates again
    }
    nominate(s, `fill-${++n}`);
    bid(s, 'Blue', 1);
    expect(nominatorOf(s)).toBe('Red');
}

describe('A127 / A81: undo with a full team', () => {
    it('A127 / A81(2): the immediate sale (nomination and sale in one call) is undone in one call: no nomination, the same nominator', () => {
        const s = lobby(AUCTION);
        blueOneShortOfFull(s);
        pass(s, 'Red'); // Blue full (8)
        const full = world(s);
        nominate(s, 'late'); // Red: Blue is full, so it sells to Red at once
        expect(budgets(s, 'Red').won).toBe(1);
        const sale = stepsOf(s, 'AuctionSold').sort((a, b) => b.sequence - a.sequence)[0];
        undo(s);
        expect(world(s)).toEqual(full);
        const undoRows = stepsOf(s, 'Undo');
        expect(undoRows).toHaveLength(1);
        expect((undoRows[0].payload.value as any).originalSequenceId).toBe(sale.sequence);
        // The timer's immediate EMPTY sale is undone the same way.
        expireAuction(s, 'Red');
        expect(stepsOf(s, 'AuctionSold').some((x) => (x.payload.value as any).characterName === 'EMPTY')).toBe(true);
        undo(s);
        expect(world(s)).toEqual(full);
    });

    // T-S10u re-alignment (A134): the undo of the filling sale removes its round too (no reopened nomination).
    it('A127 / A81(1) / A134: undoing the sale that filled a team: won counts and next nominator come back, no nomination is open; the replay fills it again and A81 holds', () => {
        const s = lobby(AUCTION);
        blueOneShortOfFull(s);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentBidTeam: { tag: 'Blue' }, currentBidAmount: 1 });
        const lastName = (session(s.test, s.lobbyId).currentNomination)!;
        pass(s, 'Red');
        const full = world(s);
        expect(budgets(s, 'Blue').won).toBe(8);
        nominate(s, 'late'); // immediate sale to Red
        undo(s); // the immediate sale and its nomination
        expect(world(s)).toEqual(full);
        undo(s); // the sale that filled Blue, with its nomination and bid
        expect(budgets(s, 'Blue').won).toBe(7);
        expect(nominatorOf(s)).toBe('Red');
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: undefined, currentBidTeam: { tag: 'Spectator' } });
        // Blue is no longer full: Red nominates again and Blue may bid on it.
        nominate(s, lastName);
        bid(s, 'Blue', 1);
        pass(s, 'Red'); // fills Blue again
        expect(world(s).session).toEqual(full.session);
        // A full team sits out again: Red's nomination sells at once.
        nominate(s, 'late-2');
        expect(budgets(s, 'Red').won).toBe(1);
        expect(session(s.test, s.lobbyId).currentNomination).toBeUndefined();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A132: eidolon selections go with their character
// ════════════════════════════════════════════════════════════════════════════

/**
 * A132 invariant: a team's two budgets add up to its starting budgets minus the cost of what it still holds, where a
 * held character costs what its sale charged (charCharged + lcCharged) plus what its remaining eidolon edits charged.
 * Only before the D-50 roll-over is the split between the two budgets meaningful; the total holds in both states.
 * Review 2 G1: both budgets are also bounded (at least 0; see the bounds below).
 */
function expectBudgetInvariant(s: Lobby, side: Side) {
    const l = lobbyRow(s.test, s.lobbyId);
    const all = steps(s.test, s.lobbyId);
    let held = 0;
    for (const st of all) {
        const v = st.payload.value as any;
        if (st.action.tag === 'AuctionSold' && v.winningTeam.tag === side) held += v.charCharged + v.lcCharged;
        if (st.action.tag === 'SetEidolon' && st.actorSlot.tag === side) held += v.charCharged + v.lcCharged;
    }
    const b = budgets(s, side);
    expect(b.char + b.lc).toBeCloseTo(l.characterBudget + l.lightconeBudget - held, 4);
    // S10t review 2 G1: neither budget is ever below 0; the character budget never exceeds its start, the light-cone
    // budget never exceeds both starts together (refunds land there). 1e-3 absorbs the f32 noise of L1.
    expect(b.char).toBeGreaterThanOrEqual(0);
    expect(b.lc).toBeGreaterThanOrEqual(0);
    expect(b.char).toBeLessThanOrEqual(l.characterBudget + 1e-3);
    expect(b.lc).toBeLessThanOrEqual(l.characterBudget + l.lightconeBudget + 1e-3);
}

describe('A132: an eidolon selection goes with its character', () => {
    it("A132: the owner's example (Classic): pick #1, #2, #3, edit #1; undo removes #3 (#1 keeps its eidolon), then #2, then #1 with its edit", () => {
        const s = lobby();
        priceCharacters(s.test, s.lobbyId, ['p1', 'p2', 'p3'], [1, 2, 3, 4, 5, 6, 7]);
        const pick = (side: Side, name: string) =>
            tx(s.test, captain(s, side), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: name, eidolon: 0 }));
        pick('Blue', 'p1'); // turn order None: B R R B ...
        const afterOne = world(s);
        pick('Red', 'p2');
        const afterTwo = world(s);
        pick('Red', 'p3');
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'p1', 5);
        expect(teamDraft(s.test as any, s.lobbyId, 'Blue').eidolons).toEqual([{ name: 'p1', eidolon: 5 }]);

        undo(s); // #3 goes; #1 keeps E5 and its SetEidolon row
        expect(stepsOf(s, 'Pick').map((x) => (x.payload.value as any).characterName).sort()).toEqual(['p1', 'p2']);
        expect(stepsOf(s, 'SetEidolon')).toHaveLength(1);
        expect(teamDraft(s.test as any, s.lobbyId, 'Blue').eidolons).toEqual([{ name: 'p1', eidolon: 5 }]);
        expect({ ...world(s), steps: [] }).toEqual({ ...afterTwo, steps: [] }); // the session and lobby after #2; the edit of #1 kept

        undo(s); // #2 goes
        expect(stepsOf(s, 'Pick').map((x) => (x.payload.value as any).characterName)).toEqual(['p1']);
        expect(stepsOf(s, 'SetEidolon')).toHaveLength(1);
        expect(world(s).session).toEqual(afterOne.session);

        undo(s); // #1 goes with its eidolon selection, one Undo row
        expect(stepsOf(s, 'Pick')).toHaveLength(0);
        expect(stepsOf(s, 'SetEidolon')).toHaveLength(0);
        expect(stepsOf(s, 'Undo')).toHaveLength(3);
        expect(session(s.test, s.lobbyId).turnIndex).toBe(0);
        expect(rejection(s.test, s.host, undoBody(s))).toBe(NO_STEPS);
    });

    it('A132: an edit is never the target of an undo and never blocks one, even as the most recent step', () => {
        const s = lobby(AUCTION);
        nominate(s, 'own', [0, 0, 0, 30, 30, 30, 30]);
        pass(s, 'Red'); // Blue owns 'own'; Red nominates next
        nominate(s, 'x', 4); // Red
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'own', 3); // the most recent step, on another character
        const edit = stepsOf(s, 'SetEidolon')[0];
        undo(s); // the nomination of x goes; the edit stays with its charge
        expect(stepsOf(s, 'Nominate').map((x) => (x.payload.value as any).characterName)).toEqual(['own']);
        expect(stepsOf(s, 'SetEidolon').map((x) => x.id)).toEqual([edit.id]);
        expect(session(s.test, s.lobbyId).currentNomination).toBeUndefined();
        expect(budgets(s, 'Blue')).toMatchObject({ char: 70, lc: 50 });
        expectBudgetInvariant(s, 'Blue');
    });

    it('A132: undoing a sale gives back exactly what the character cost, its own edits included (a raise spilling into light cones and a lowering refund)', () => {
        const s = lobby(AUCTION);
        const beforeSale = world(s); // T-S10u (A134): the state before the nomination
        nominate(s, 'eid', [0, 0, 0, 30, 30, 30, 30]);
        bid(s, 'Red', 1);
        bid(s, 'Blue', 95);
        pass(s, 'Red'); // Blue: char 5, lc 50
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'eid', 3); // extra 30: 5 from the character budget, 25 from light cones
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 25 });
        expectBudgetInvariant(s, 'Blue');
        advance(s.test, 5_000); // the lineup throttle
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'eid', 0); // a decrease is refunded to the light-cone budget
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 55 });
        expectBudgetInvariant(s, 'Blue');
        undo(s); // the sale and both edits, one Undo row
        expect(world(s)).toEqual(beforeSale);
        expect(stepsOf(s, 'SetEidolon')).toHaveLength(0);
        expect(stepsOf(s, 'Undo')).toHaveLength(1);
        expectBudgetInvariant(s, 'Blue');
    });

    // T-S10u re-alignment (A133): a raise at character budget 0 is refused now, so A costs 8 and the raise of B spills
    // (2 from the character budget, 3 from light cones); (A134) the undo leaves no nomination open.
    it('A132: an edit on another character keeps its charge: character budget 10, light cones 50, buy A for 8, raise B for 5 (2 + 3 from light cones), undo the sale of A → 8 / 47', () => {
        const s = lobby({ ...AUCTION, characterBudget: 10, lightconeBudget: 50 });
        nominate(s, 'B', [0, 5, 5, 5, 5, 5, 5]); // Blue
        pass(s, 'Red'); // Blue owns B at 0; Red nominates next
        nominate(s, 'rx', 0); // Red
        pass(s, 'Blue'); // Red owns rx; Blue nominates next
        nominate(s, 'A', 8); // Blue at its E0 cost 8
        pass(s, 'Red'); // Blue buys A for 8
        expect(budgets(s, 'Blue')).toMatchObject({ char: 2, lc: 50 });
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'B', 1); // +5: 2 from the character budget, 3 from light cones
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 47 });
        expectBudgetInvariant(s, 'Blue');
        undo(s); // the sale of A; the edit of B stays as charged
        expect(budgets(s, 'Blue')).toEqual({ char: 8, lc: 47, won: 1 });
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: undefined, currentBidTeam: { tag: 'Spectator' }, nextNominatorTeam: { tag: 'Blue' } });
        expect(stepsOf(s, 'SetEidolon')).toHaveLength(1);
        expect(teamDraft(s.test as any, s.lobbyId, 'Blue').eidolons).toEqual([{ name: 'B', eidolon: 1 }]);
        expectBudgetInvariant(s, 'Blue');
    });

    it('A132 / review F1: in a short confirm window many edits cannot bury the last pick: one undo removes it (with its edits), one Undo row; the edit cap counts only live edits', () => {
        const s = lobby({ confirmWindowSeconds: 10 });
        priceCharacters(s.test, s.lobbyId, ['red-15'], [0, 0, 0, 0, 0, 0, 0]);
        playClassic(s); // the last turn (16) is Red's: 'red-15'
        const lastPick = stepsOf(s, 'Pick').sort((a, b) => b.sequence - a.sequence)[0];
        expect((lastPick.payload.value as any).characterName).toBe('red-15');
        const other = stepsOf(s, 'Pick').find((x) => x.actorSlot.tag === 'Red' && x.id !== lastPick.id)!;
        const otherName = (other.payload.value as any).characterName;
        for (let i = 0; i < 8; i++) { // 8 edits in 8 s, inside the 10 s window; set_eidolon stays allowed there
            setEidolon(s, captain(s, 'Red'), 'Red', i % 2 === 0 ? 'red-15' : otherName, 1 + (i % 5));
            advance(s.test, 1_000);
        }
        expect(stepsOf(s, 'SetEidolon')).toHaveLength(8);
        undo(s);
        expect(stepsOf(s, 'Pick').some((x) => x.id === lastPick.id)).toBe(false);
        expect(stepsOf(s, 'SetEidolon').map((x) => (x.payload.value as any).characterName)).toEqual(Array(4).fill(otherName));
        expect(stepsOf(s, 'Undo')).toHaveLength(1);
        expect(stage(s)).toBe('Drafting');
        expect(session(s.test, s.lobbyId).turnIndex).toBe(15);
        // The removed edits leave the per-side edit cap's count (it counts live SetEidolon steps of the side): 4 remain.
        expect(stepsOf(s, 'SetEidolon').filter((x) => x.actorSlot.tag === 'Red')).toHaveLength(4);
    });
});

describe('A127 / A132: a chain of steps undone one by one back to the first step', () => {
    it('A127 / A132 / A134: Auction with bans: rounds and bans undone in reverse against the snapshots taken on the way (an edit goes with its sale); the draft then finishes normally', () => {
        const s = lobby({ ...AUCTION, banMode: { tag: 'Four' } });
        const { test, lobbyId } = s;
        const snaps: Array<ReturnType<typeof world>> = [];
        const step = (action: () => void) => {
            snaps.push(world(s));
            action();
        };
        for (const name of ['ban-a', 'ban-b', 'ban-c', 'ban-d']) {
            step(() => {
                const sess = session(test, lobbyId);
                const team = sess.draftSequence[sess.turnIndex].teamTurn.tag as Side;
                priceBanNames(test, lobbyId, [name]);
                tx(test, captain(s, team), (ctx) => M.ban_character(ctx, { lobbyId, characterName: name }));
            });
        }
        expect(session(test, lobbyId).isAuctionPhase).toBe(true);
        step(() => nominate(s, 'n1', [10, 10, 25, 25, 25, 25, 25])); // Blue
        step(() => bid(s, 'Red', 12));
        step(() => bid(s, 'Blue', 30));
        step(() => pass(s, 'Red')); // Blue wins n1 at 30; Red nominates next
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'n1', 2); // extra 15: not a step of its own (A132)
        step(() => nominate(s, 'n2', 5)); // Red
        step(() => bid(s, 'Blue', 6));
        step(() => expireAuction(s)); // the timer sells n2 to Blue at 6 (a steal: Red nominates again)
        step(() => nominate(s, 'n3', 0)); // Red
        step(() => pass(s, 'Blue')); // Red wins n3 at 0
        const end = world(s);
        expect(budgets(s, 'Blue')).toEqual({ char: 100 - 30 - 15 - 6, lc: 50, won: 2 });
        expectBudgetInvariant(s, 'Blue');

        // T-S10u re-alignment (A134): one undo per round in the auction phase (back to the snapshot before its
        // nomination: steps 11, 8 and 4), then one per ban.
        const targets = [11, 8, 4, 3, 2, 1, 0];
        for (const i of targets) {
            undo(s);
            expect(world(s), `after undoing back to step ${i}`).toEqual(snaps[i]);
            expectBudgetInvariant(s, 'Blue');
            expectBudgetInvariant(s, 'Red');
        }
        expect(rejection(test, s.host, undoBody(s))).toBe(NO_STEPS);
        expect(stepsOf(s, 'Undo')).toHaveLength(targets.length);
        expect(end.steps.length).toBe(snaps.length + 1); // the edit row was removed with the sale of n1

        // Forward again: the bans, one priced sale, then the rest of the draft at cost 0.
        for (const name of ['ban-a', 'ban-b', 'ban-c', 'ban-d']) {
            const sess = session(test, lobbyId);
            tx(test, captain(s, sess.draftSequence[sess.turnIndex].teamTurn.tag as Side), (ctx) => M.ban_character(ctx, { lobbyId, characterName: name }));
        }
        nominate(s, 'n1');
        bid(s, 'Red', 12);
        bid(s, 'Blue', 30);
        pass(s, 'Red');
        completeDraft(s);
        const blue = teamDraft(test as any, lobbyId, 'Blue');
        const red = teamDraft(test as any, lobbyId, 'Red');
        expect([blue.characters.length, red.characters.length]).toEqual([8, 8]);
        const sess = session(test, lobbyId);
        // D-50 rollover: no character budget left; Blue spent 30 of its 150, Red nothing.
        expect([sess.teamBlueCharBudget, sess.teamRedCharBudget, sess.teamBlueLcBudget, sess.teamRedLcBudget]).toEqual([0, 0, 120, 150]);
        expect([sess.blueCharactersWon, sess.redCharactersWon]).toEqual([8, 8]);
        expectBudgetInvariant(s, 'Blue');
    });

    it('A127 / A132: Classic with bans: picks and bans undone to the start against the snapshots taken on the way (an edit goes with its pick)', () => {
        const s = lobby({ banMode: { tag: 'Four' } });
        const { test, lobbyId } = s;
        const snaps: Array<ReturnType<typeof world>> = [];
        for (let i = 0; i < 10; i++) {
            snaps.push(world(s));
            const sess = session(test, lobbyId);
            const turn = sess.draftSequence[sess.turnIndex];
            const team = turn.teamTurn.tag as Side;
            if (turn.actionRequired.tag === 'Ban') {
                priceBanNames(test, lobbyId, [`ban-${i}`]);
                tx(test, captain(s, team), (ctx) => M.ban_character(ctx, { lobbyId, characterName: `ban-${i}` }));
            } else {
                priceCharacters(test, lobbyId, [`pick-${i}`], [1, 2, 3, 4, 5, 6, 7]);
                tx(test, captain(s, team), (ctx) => M.pick_character(ctx, { lobbyId, characterName: `pick-${i}`, eidolon: i % 3 }));
            }
            if (i === 5) {
                const picked = stepsOf(s, 'Pick').sort((a, b) => b.sequence - a.sequence)[0];
                advance(test, 5_000);
                setEidolon(s, captain(s, picked.actorSlot.tag as Side), picked.actorSlot.tag as Side, (picked.payload.value as any).characterName, 6);
            }
        }
        expect(stepsOf(s, 'Ban').length).toBeGreaterThan(0);
        expect(stepsOf(s, 'SetEidolon')).toHaveLength(1);
        for (let i = snaps.length - 1; i >= 0; i--) {
            undo(s);
            expect(world(s), `after undoing step ${i}`).toEqual(snaps[i]);
        }
        expect(stepsOf(s, 'SetEidolon')).toHaveLength(0);
        expect(session(test, lobbyId).turnIndex).toBe(0);
        expect(rejection(test, s.host, undoBody(s))).toBe(NO_STEPS);
        completeDraft(s);
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('Equipping');
    });

    it('A127 / A117(3): a timer auto-pick is undone exactly and the same turn re-rolls', () => {
        const pool = Array.from({ length: 12 }, (_, i) => `pool${i}`);
        const s = lobby({ autoRandomPick: true });
        priceCharacters(s.test, s.lobbyId, pool);
        dropDefaultCostCoverage(s.test);
        tx(s.test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'pool0', eidolon: 0 }));
        const before = world(s);
        const drawn: string[] = [];
        for (let i = 0; i < 10; i++) {
            advance(s.test, TURN_MS);
            tx(s.test, s.host, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }));
            const auto = stepsOf(s, 'Pick').sort((a, b) => b.sequence - a.sequence)[0];
            expect(auto.actorUserId).toBe(0);
            drawn.push((auto.payload.value as any).characterName);
            undo(s);
            expect(world(s)).toEqual(before);
        }
        expect(new Set(drawn).size).toBeGreaterThanOrEqual(2);
        for (const name of drawn) expect(pool.filter((n) => n !== 'pool0')).toContain(name);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// The end of the draft
// ════════════════════════════════════════════════════════════════════════════

describe('A127: undo stops when the draft is finished', () => {
    it('A127 / A129: Classic: once advance_stage has moved the complete draft to Equipping, the undo is refused and nothing changes', () => {
        const s = lobby();
        completeDraft(s);
        const done = world(s);
        expect(rejection(s.test, s.host, undoBody(s))).toBe(FINISHED);
        expect(world(s)).toEqual(done);
    });

    it('A127 / A129: Auction: once advance_stage has moved the complete draft to Equipping (with the D-50 rollover), the undo is refused', () => {
        const s = lobby(AUCTION);
        completeDraft(s);
        const done = world(s);
        expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('Equipping');
        expect(rejection(s.test, s.host, undoBody(s))).toBe(FINISHED);
        expect(world(s)).toEqual(done);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Refusals (unchanged rules)
// ════════════════════════════════════════════════════════════════════════════

describe('A127: who may undo and when is unchanged', () => {
    function withBid(): Lobby {
        const s = lobby(AUCTION);
        nominate(s, 'x', 10);
        bid(s, 'Red', 15);
        return s;
    }

    it('A127 / F9: while paused the undo is refused and nothing changes', () => {
        const s = withBid();
        tx(s.test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        const paused = world(s);
        expect(rejection(s.test, s.host, undoBody(s))).toBe(PAUSED);
        expect(world(s)).toEqual(paused);
    });

    it('A127 / A98: an away referee is refused', () => {
        // A seated referee (the host in a Blue seat): a seated player's leave in Drafting keeps the row, away (A68(2));
        // a spectator's leave deletes it.
        const s = setupLobby(newHarness(), { seats: ONE_V_ONE, hostSlot: 'BluePlayer', lobby: AUCTION });
        nominate(s, 'x', 10);
        tx(s.test, s.host, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
        expect(member(s.test, s.lobbyId, s.host.userId)).toMatchObject({ isReferee: true });
        expect(member(s.test, s.lobbyId, s.host.userId).leftAt).toBeDefined();
        const before = world(s);
        expect(rejection(s.test, s.host, undoBody(s))).toBe(AWAY);
        expect(world(s)).toEqual(before);
    });

    it('A127 / D-60: a player who is not a referee is refused', () => {
        const s = withBid();
        const before = world(s);
        expect(rejection(s.test, captain(s, 'Blue'), undoBody(s))).toBe(NOT_REFEREE);
        expect(world(s)).toEqual(before);
    });

    it('A127 / A122(10): the cap of 300 Undo rows covers the auction steps; 299 still allow one more', () => {
        const insertUndoRows = (test: Harness, lobbyId: number, n: number) => {
            const ts = test.clock.now();
            const audit = { createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts };
            for (let i = 0; i < n; i++) {
                test.db.MatchSessionStep.insert({
                    id: 0, lobbyId, sequence: 10_000 + i, actorUserId: 0, anonymousLabel: undefined, actorSlot: { tag: 'Spectator' },
                    action: { tag: 'Undo' }, payload: { tag: 'Undo', value: { originalSequenceId: 0 } }, timestamp: ts, ...audit,
                } as any);
            }
        };
        const s = withBid();
        insertUndoRows(s.test, s.lobbyId, 300);
        const before = world(s);
        expect(rejection(s.test, s.host, undoBody(s))).toBe(CAP);
        expect(world(s)).toEqual(before);

        const t = withBid();
        insertUndoRows(t.test, t.lobbyId, 299);
        undo(t);
        expect(stepsOf(t, 'Bid')).toHaveLength(0);
        expect(stepsOf(t, 'Undo')).toHaveLength(300);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Review 2: G1 (no negative budget after a sale undo), G2 (a bid undo needs a backed holder), L3 (mirror picks, forfeit)
// ════════════════════════════════════════════════════════════════════════════

describe('A132 / S10t review 2 G1: a sale undo never leaves a budget below 0', () => {
    // T-S10u re-alignment (A134): the undo leaves no nomination open; Blue nominates again.
    it('A132 G1: buy B for 5 and A for 5.5, raise A +30, lower A (refund 30 to light cones), raise B +139, undo the sale of A → 6 / 0 (the shortfall comes from the character budget); Blue nominates again and buys C for 1 → 5 / 0', () => {
        const s = lobby(AUCTION); // budgets 100 / 50
        nominate(s, 'B', [5, 5, 5, 5, 5, 5, 144]); // Blue
        pass(s, 'Red'); // Blue buys B for 5; Red nominates next
        nominate(s, 'rx', 0); // Red
        pass(s, 'Blue'); // Red buys rx; Blue nominates next
        nominate(s, 'A', [5.5, 5.5, 5.5, 5.5, 5.5, 5.5, 35.5]);
        pass(s, 'Red'); // Blue buys A for 5.5
        expect(budgets(s, 'Blue')).toEqual({ char: 89.5, lc: 50, won: 2 });
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'A', 6); // +30 from the character budget
        expect(budgets(s, 'Blue')).toMatchObject({ char: 59.5, lc: 50 });
        advance(s.test, 1_000);
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'A', 0); // refund 30 to the light-cone budget
        expect(budgets(s, 'Blue')).toMatchObject({ char: 59.5, lc: 80 });
        advance(s.test, 1_000);
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'B', 6); // +139: 59.5 from the character budget, 79.5 from light cones
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 0.5 });
        expectBudgetInvariant(s, 'Blue');
        undo(s); // the sale of A with both of its edits: back 35.5 / -30, the light-cone shortfall 29.5 from the character budget
        expect(budgets(s, 'Blue')).toEqual({ char: 6, lc: 0, won: 1 });
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: undefined, currentBidTeam: { tag: 'Spectator' }, nextNominatorTeam: { tag: 'Blue' } });
        expectBudgetInvariant(s, 'Blue');
        nominate(s, 'C', 1);
        pass(s, 'Red'); // Blue buys C for 1
        expect(budgets(s, 'Blue')).toEqual({ char: 5, lc: 0, won: 2 });
        expectBudgetInvariant(s, 'Blue');
        expectBudgetInvariant(s, 'Red');
    });
});

// T-S10u re-alignment (A134): the G2 refusal ("Cannot undo this bid: ...") is removed: the undo removes the whole round,
// so no earlier bidder is restored as holder, and the draft goes on from "before the nomination".
describe('A134 (formerly S10t review 2 G2): the round is undone even when the outbid team can no longer cover its bid', () => {
    /** Budgets 20 / 10. Red buys R for 1; Blue nominates N; Red bids 12, Blue bids 13; Red raises R by `raise`. */
    function outbidThenRaise(raise: number): Lobby {
        const s = lobby({ ...AUCTION, characterBudget: 20, lightconeBudget: 10 });
        nominate(s, 'R', [0, raise, raise, raise, raise, raise, raise]); // Blue
        bid(s, 'Red', 1);
        pass(s, 'Blue'); // Red buys R for 1 (a steal: Blue nominates again)
        nominate(s, 'N', 0);
        bid(s, 'Red', 12);
        bid(s, 'Blue', 13);
        setEidolon(s, captain(s, 'Red'), 'Red', 'R', 1); // Red does not hold the bid: nothing is reserved
        return s;
    }

    it('A134: Red raised R by 20 (character budget 19 → 0): the undo removes the round; Blue nominates N again, Red cannot bid, Blue wins N at 0', () => {
        const s = outbidThenRaise(20);
        expect(budgets(s, 'Red')).toMatchObject({ char: 0, lc: 9 });
        undo(s);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: undefined, currentBidTeam: { tag: 'Spectator' }, nextNominatorTeam: { tag: 'Blue' } });
        expect(stepsOf(s, 'Bid').filter((x) => (x.payload.value as any).targetCharacter === 'N')).toHaveLength(0);
        nominate(s, 'N', 0);
        expect(rejection(s.test, captain(s, 'Red'), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 1 }))).toBe('Bid exceeds your remaining character budget.');
        pass(s, 'Red'); // Blue wins N at 0
        expect(budgets(s, 'Blue')).toMatchObject({ char: 20, won: 1 });
        expectBudgetInvariant(s, 'Blue');
        expectBudgetInvariant(s, 'Red');
    });

    it('A134: the timer path also goes on after the undo (Blue nominates N again; the timer sells it to Blue at 0)', () => {
        const s = outbidThenRaise(20);
        undo(s);
        nominate(s, 'N', 0);
        expireAuction(s, 'Red');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 20, won: 1 });
    });

    it('A134: Red raised R by 5 (character budget 19 → 14): the undo removes the round; Red bids 12 again and wins N at 12', () => {
        const s = outbidThenRaise(5);
        expect(budgets(s, 'Red')).toMatchObject({ char: 14, lc: 10 });
        undo(s);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: undefined, nextNominatorTeam: { tag: 'Blue' } });
        nominate(s, 'N', 0);
        bid(s, 'Red', 12);
        pass(s, 'Blue'); // Red wins N at 12
        expect(budgets(s, 'Red')).toMatchObject({ char: 2, lc: 10, won: 2 });
        expectBudgetInvariant(s, 'Red');
    });
});

describe('A132 / S10t review 2 L3: mirror picks and a forfeit in the window', () => {
    const pickBy = (s: Lobby, side: Side, name: string) =>
        tx(s.test, captain(s, side), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: name, eidolon: 0 }));
    const editsOf = (s: Lobby, side: Side) => stepsOf(s, 'SetEidolon').filter((x) => x.actorSlot.tag === side).map((x) => (x.payload.value as any).eidolon);

    it('A132 (mirror picks): Blue picks X, Red picks X, both edit X; undoing Red\'s pick removes only Red\'s edit; Blue keeps X at its eidolon', () => {
        const s = lobby({ allowMirrorPicks: true });
        priceCharacters(s.test, s.lobbyId, ['X'], [1, 2, 3, 4, 5, 6, 7]);
        pickBy(s, 'Blue', 'X'); // turn 0
        pickBy(s, 'Red', 'X'); // turn 1
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'X', 2);
        setEidolon(s, captain(s, 'Red'), 'Red', 'X', 4);
        undo(s);
        expect(stepsOf(s, 'Pick').map((x) => x.actorSlot.tag)).toEqual(['Blue']);
        expect([editsOf(s, 'Blue'), editsOf(s, 'Red')]).toEqual([[2], []]);
        expect(teamDraft(s.test as any, s.lobbyId, 'Blue').eidolons).toEqual([{ name: 'X', eidolon: 2 }]);
    });

    it('A132 (mirror picks, the other direction): Red picks X, later Blue picks X, both edit X; undoing Blue\'s pick removes only Blue\'s edit', () => {
        const s = lobby({ allowMirrorPicks: true });
        priceCharacters(s.test, s.lobbyId, ['a', 'b', 'X'], [1, 2, 3, 4, 5, 6, 7]);
        pickBy(s, 'Blue', 'a'); // turn 0
        pickBy(s, 'Red', 'X'); // turn 1
        pickBy(s, 'Red', 'b'); // turn 2
        pickBy(s, 'Blue', 'X'); // turn 3
        setEidolon(s, captain(s, 'Red'), 'Red', 'X', 3);
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'X', 5);
        undo(s);
        expect(stepsOf(s, 'Pick').filter((x) => (x.payload.value as any).characterName === 'X').map((x) => x.actorSlot.tag)).toEqual(['Red']);
        expect([editsOf(s, 'Blue'), editsOf(s, 'Red')]).toEqual([[], [3]]);
        expect(teamDraft(s.test as any, s.lobbyId, 'Red').eidolons).toContainEqual({ name: 'X', eidolon: 3 });
    });

    it('S10t F2: a Ranked forfeit by disconnect in the confirm window counts the character stats like a concede there (32 / 16 rows)', () => {
        const test = newHarness();
        seedElo(test);
        const s = setupLobby(test, { lobby: { refereeExclusiveConcede: false, disconnectForfeitSeconds: 60 }, beforeStart: rankedHook(test) });
        playClassic(s);
        disconnect(test, s.a.r1);
        disconnect(test, s.a.r2);
        for (const who of [s.a.r1, s.a.r2]) {
            const rows = checksFor(test, s.lobbyId, who.userId);
            advance(test, 15_000);
            for (const r of rows) fireCheck(test, r as any);
        }
        expect(stage(s)).toBe('Drafting');
        advance(test, 200_000);
        tx(test, s.a.b1, (ctx) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 0 }));
        expect(test.db.MatchSessionHistory.count()).toBe(1n);
        expect([...test.db.PlayerCharacterStat.iter()]).toHaveLength(32);
        expect([...test.db.GlobalCharacterStat.iter()]).toHaveLength(16);
    });
});
