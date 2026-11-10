// T-S10t: in-memory tests for step S10t (DECISIONS.md A127, A132): undo_last_step removes the last character step of the
// game (ban, pick, nomination, bid, sale by pass, by the timer or the A81 immediate sale; an eidolon selection goes with its
// character, A132), and restores the state before it, one step per call, until the draft is finished. Every restore is
// checked against a snapshot taken before the step: the full MatchSession row, the Lobby row and the remaining
// MatchSessionStep rows, ignoring only the audit columns, the turn clock (timerState.turnStartAt / accumulatedPauseMs),
// Lobby.lastActivityAt and the Undo rows. State is built through the module's reducers; HSR accounts and cost rows are
// written straight into the in-memory datastore outside any reducer, like the earlier suites. TestClock; nothing
// reaches maincloud. The last block covers A128 (approve_stand_in refuses a disqualified player); its enrolment rows are
// written straight into the datastore.
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    disconnect,
    dropDefaultCostCoverage,
    fireCheck,
    guest,
    lobbyRow,
    member,
    newHarness,
    checksFor,
    pendingCheck,
    priceBanNames,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SetupOpts,
} from './s4-fixtures';
import { captain, completeDraft, selectAccount, setEidolon } from './s7-fixtures';
import { rejection } from './s10-c2-fixtures';
import { verified } from './s8-fixtures';
import { byKey, createTournamentLobby, duel, seedElo } from './s8d-fixtures';
import { rankedHook } from './s10-a2-fixtures';
import { presetArgs, presetNamed, settingsArgs, updatePresetArgs } from './s10-a1-fixtures';
import { teamDraft } from '@module/helpers/results/scoringHelpers';

// ─── Texts ───────────────────────────────────────────────────────────────────

const FINISHED = 'The draft is finished: undo works only while the lobby is in the draft stage.';
const PAUSED = 'Nothing to undo right now.';
const NOT_REFEREE = 'Only referees with undo permission can undo.';
const AWAY = 'You are away from this lobby. Return to it before acting.'; // A98
const CAP = 'This game has reached the limit of 300 undo steps.';
const NO_STEPS = 'No steps to undo.';

// ─── Builders ────────────────────────────────────────────────────────────────

type Side = 'Blue' | 'Red';
const TURN_MS = 30_000; // DEFAULT_LOBBY_ARGS.standardTurnSeconds
const ONE_V_ONE: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['r1', 'RedPlayer']];
const AUCTION = { draftMode: { tag: 'Auction' } };
const other = (side: Side): Side => (side === 'Blue' ? 'Red' : 'Blue');

function lobby(lobbyArgs: Record<string, unknown> = {}): Lobby {
    return setupLobby(newHarness(), { seats: ONE_V_ONE, lobby: lobbyArgs });
}

const undo = (s: Lobby) => tx(s.test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId }));
const undoBody = (s: Lobby) => (ctx: any) => M.undo_last_step(ctx, { lobbyId: s.lobbyId });
const nominatorOf = (s: Lobby) => session(s.test, s.lobbyId).nextNominatorTeam.tag as Side;
const stepsOf = (s: Lobby, tag: string) => steps(s.test, s.lobbyId).filter((x) => x.action.tag === tag);

/** The nominator's captain nominates `name`, priced in the lobby's set first (`ladder[e]` = cost at E`e`). */
function nominate(s: Lobby, name: string, ladder: number | number[] = 0) {
    priceCharacters(s.test, s.lobbyId, [name], ladder);
    tx(s.test, captain(s, nominatorOf(s)), (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: name }));
}
const bid = (s: Lobby, side: Side, bidAmount: number) =>
    tx(s.test, captain(s, side), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount }));
const pass = (s: Lobby, side: Side) => tx(s.test, captain(s, side), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
const expireAuction = (s: Lobby, who: Side = 'Blue') => {
    advance(s.test, TURN_MS + 1_000);
    tx(s.test, captain(s, who), (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }));
};

// ─── The snapshot ────────────────────────────────────────────────────────────

const AUDIT_KEYS = new Set(['createdById', 'createdDate', 'lastModifiedById', 'lastModifiedDate']);

/** A comparable copy of a row: timestamps and bigints as strings, a unit enum as `{ tag }`, audit columns dropped. */
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

/** The session row, the lobby row and the draft's step rows (Undo rows left out), minus the turn clock and lastActivityAt. */
function world(s: Lobby) {
    const sess = canon(session(s.test, s.lobbyId));
    delete sess.timerState.turnStartAt;
    delete sess.timerState.accumulatedPauseMs;
    const lob = canon(lobbyRow(s.test, s.lobbyId));
    delete lob.lastActivityAt;
    const rows = steps(s.test, s.lobbyId)
        .filter((x) => x.action.tag !== 'Undo')
        .sort((a, b) => a.sequence - b.sequence)
        .map(canon);
    return { session: sess, lobby: lob, steps: rows };
}

const budgets = (s: Lobby, side: Side) => {
    const x = session(s.test, s.lobbyId);
    return side === 'Blue'
        ? { char: x.teamBlueCharBudget, lc: x.teamBlueLcBudget, won: x.blueCharactersWon }
        : { char: x.teamRedCharBudget, lc: x.teamRedLcBudget, won: x.redCharactersWon };
};

// ════════════════════════════════════════════════════════════════════════════
// Bids
// ════════════════════════════════════════════════════════════════════════════

describe('A127: undo of a bid restores the previous holder and amount', () => {
    it('A127: the first bid: the nominator holds the nomination again at its opening amount', () => {
        const s = lobby(AUCTION);
        nominate(s, 'x', 10); // Blue nominates at the E0 cost 10
        const opened = world(s);
        bid(s, 'Red', 15);
        undo(s);
        expect(world(s)).toEqual(opened);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: 'x', currentBidAmount: 10, currentBidTeam: { tag: 'Blue' } });
        expect(stepsOf(s, 'Bid')).toHaveLength(0);
        expect((stepsOf(s, 'Undo')[0].payload.value as any).originalSequenceId).toBeGreaterThan(0);
    });

    it('A127: a bid over an earlier bid: the earlier holder and amount come back; a second undo reaches the opening state', () => {
        const s = lobby(AUCTION);
        nominate(s, 'x', 10);
        const opened = world(s);
        bid(s, 'Red', 15);
        const afterFirst = world(s);
        bid(s, 'Blue', 20.5);
        undo(s);
        expect(world(s)).toEqual(afterFirst);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentBidAmount: 15, currentBidTeam: { tag: 'Red' } });
        undo(s);
        expect(world(s)).toEqual(opened);
        // The bidding goes on normally after the undo: the other team bids again.
        bid(s, 'Red', 12);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentBidAmount: 12, currentBidTeam: { tag: 'Red' } });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Sales
// ════════════════════════════════════════════════════════════════════════════

describe('A127: undo of a sale reopens the nomination as it stood before the sale', () => {
    it('A127: a sale by pass: nomination, highest bid and holder, budgets, won count and next nominator restored; the replay sells again the same way', () => {
        const s = lobby(AUCTION);
        nominate(s, 'x', 10);
        bid(s, 'Red', 15);
        const beforeSale = world(s);
        pass(s, 'Blue'); // Red wins at 15 (a steal: Blue nominates again)
        const sold = world(s);
        expect(budgets(s, 'Red')).toEqual({ char: 85, lc: 50, won: 1 });
        undo(s);
        expect(world(s)).toEqual(beforeSale);
        expect(budgets(s, 'Red')).toEqual({ char: 100, lc: 50, won: 0 });
        pass(s, 'Blue');
        expect(world(s).session).toEqual(sold.session);
        expect(world(s).lobby).toEqual(sold.lobby);
    });

    it('A127: a sale made by the timer (actor 0) is undone the same way', () => {
        const s = lobby(AUCTION);
        nominate(s, 'x', 10);
        bid(s, 'Red', 15);
        const beforeSale = world(s);
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
        nominate(s, 'spill', [10, 20, 40, 40, 40, 40, 40]); // extra at E2 = 30
        bid(s, 'Red', 11);
        bid(s, 'Blue', 90);
        const beforeSale = world(s);
        pass(s, 'Red');
        // 100 - 90 = 10 left; the extra 30 takes those 10, then 20 from the light-cone budget.
        expect(budgets(s, 'Blue')).toEqual({ char: 0, lc: 30, won: 1 });
        undo(s);
        expect(world(s)).toEqual(beforeSale);
        expect(budgets(s, 'Blue')).toEqual({ char: 100, lc: 50, won: 0 });
    });

    it('A127: a sale that leaves the character budget at 0 is restored exactly', () => {
        const s = lobby(AUCTION);
        nominate(s, 'all', 0);
        bid(s, 'Red', 1);
        bid(s, 'Blue', 100);
        const beforeSale = world(s);
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

    it('A127 / A81(1): undoing the sale that filled a team: won counts, next nominator and the open nomination come back; the replay fills it again and A81 holds', () => {
        const s = lobby(AUCTION);
        blueOneShortOfFull(s);
        const beforeFill = world(s);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentBidTeam: { tag: 'Blue' }, currentBidAmount: 1 });
        pass(s, 'Red');
        const full = world(s);
        expect(budgets(s, 'Blue').won).toBe(8);
        nominate(s, 'late'); // immediate sale to Red
        undo(s); // the immediate sale and its nomination
        expect(world(s)).toEqual(full);
        undo(s); // the sale that filled Blue
        expect(world(s)).toEqual(beforeFill);
        expect(budgets(s, 'Blue').won).toBe(7);
        expect(nominatorOf(s)).toBe('Red');
        // Blue is no longer full: Red may outbid it on the reopened nomination, and Blue may bid back.
        bid(s, 'Red', 2);
        bid(s, 'Blue', 3);
        undo(s);
        undo(s);
        expect(world(s)).toEqual(beforeFill);
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
        nominate(s, 'eid', [0, 0, 0, 30, 30, 30, 30]);
        bid(s, 'Red', 1);
        bid(s, 'Blue', 95);
        const beforeSale = world(s);
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

    it('A132: an edit on another character keeps its charge: character budget 10, light cones 50, buy A for 10, raise B for 5 (from light cones), undo the sale of A → 10 / 45', () => {
        const s = lobby({ ...AUCTION, characterBudget: 10, lightconeBudget: 50 });
        nominate(s, 'B', [0, 5, 5, 5, 5, 5, 5]); // Blue
        pass(s, 'Red'); // Blue owns B at 0; Red nominates next
        nominate(s, 'rx', 0); // Red
        pass(s, 'Blue'); // Red owns rx; Blue nominates next
        nominate(s, 'A', 10); // Blue at its E0 cost 10
        pass(s, 'Red'); // Blue buys A for 10
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 50 });
        setEidolon(s, captain(s, 'Blue'), 'Blue', 'B', 1); // +5, the character budget is 0: from light cones
        expect(budgets(s, 'Blue')).toMatchObject({ char: 0, lc: 45 });
        expectBudgetInvariant(s, 'Blue');
        undo(s); // the sale of A; the edit of B stays as charged
        expect(budgets(s, 'Blue')).toEqual({ char: 10, lc: 45, won: 1 });
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: 'A', currentBidAmount: 10, currentBidTeam: { tag: 'Blue' } });
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
    it('A127 / A132: Auction with bans: bans, nominations, bids and sales undone in reverse against the snapshots taken on the way (an edit goes with its sale); the draft then finishes normally', () => {
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

        for (let i = snaps.length - 1; i >= 0; i--) {
            undo(s);
            expect(world(s), `after undoing step ${i}`).toEqual(snaps[i]);
            expectBudgetInvariant(s, 'Blue');
            expectBudgetInvariant(s, 'Red');
        }
        expect(rejection(test, s.host, undoBody(s))).toBe(NO_STEPS);
        expect(stepsOf(s, 'Undo')).toHaveLength(snaps.length);
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
// A128: a disqualified player cannot be a stand-in
// ════════════════════════════════════════════════════════════════════════════

describe('A128: approve_stand_in refuses a player disqualified from the tournament', () => {
    const DQ_PLAYER = 'A disqualified player cannot be a stand-in.';
    const approveBody = (bracketMatchId: number, teamId: number, userId: number) =>
        (ctx: any) => M.approve_stand_in(ctx, { bracketMatchId, teamId, userId });
    const standInsOf = (test: Harness, bracketMatchId: number) => [...test.db.TournamentStandIn.bracket_match_id.filter(bracketMatchId)];
    /** An enrolment row for `userId` in the tournament with `status`, written straight into the datastore (no team). */
    function enrol(test: Harness, tournamentId: number, userId: number, status: 'Disqualified' | 'Withdrawn') {
        const ts = test.clock.now();
        test.db.TournamentEnrolled.insert({
            tournamentId, userId, status: { tag: status }, anonymousAlias: undefined, isWaitlisted: false,
            allowRandomTeamAssignment: false, approvedByToAt: undefined,
            createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts,
        } as any);
    }

    it('A128: a player whose enrolment is Disqualified is refused as a stand-in for a team of the match; nothing is written', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const banned = verified(f.test, 'dq-sub');
        enrol(f.test, f.id, banned.userId, 'Disqualified');
        expect(rejection(f.test, f.org, approveBody(m.id, m.team1Id!, banned.userId))).toBe(DQ_PLAYER);
        expect(rejection(f.test, f.org, approveBody(m.id, m.team2Id!, banned.userId))).toBe(DQ_PLAYER);
        expect(standInsOf(f.test, m.id)).toEqual([]);
    });

    it('A128: a withdrawn player and a player never enrolled are still accepted, as before', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const withdrawn = verified(f.test, 'wd-sub');
        enrol(f.test, f.id, withdrawn.userId, 'Withdrawn');
        const outsider = verified(f.test, 'new-sub');
        tx(f.test, f.org, approveBody(m.id, m.team1Id!, withdrawn.userId));
        tx(f.test, f.org, approveBody(m.id, m.team2Id!, outsider.userId));
        expect(standInsOf(f.test, m.id).map((r) => r.userId).sort((a, b) => a - b))
            .toEqual([withdrawn.userId, outsider.userId].sort((a, b) => a - b));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A129 / A130 / A131: the complete draft waits in Drafting for the referee or the confirm window
// ════════════════════════════════════════════════════════════════════════════

const COMPLETE = 'The draft is complete. It moves to Equipping when the referee advances it or the confirm window ends.';
const WINDOW_OPEN = 'The confirm window has not yet expired.';
const WINDOW_RANGE = 'confirmWindowSeconds must be between 0 and 300.';
const WINDOW_MS = 60_000; // the default confirm window (A131)
const CHAT_LINE = 'Draft complete. Stage: Equipping';

const stage = (s: Lobby) => lobbyRow(s.test, s.lobbyId).stage.tag;
const chatLines = (s: Lobby) => [...s.test.db.ChatMessage.lobby_id.filter(s.lobbyId)].filter((m) => m.content === CHAT_LINE).length;
const expireClassic = (s: Lobby, who: Actor) => tx(s.test, who, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }));
const expireAuctionBy = (s: Lobby, who: Actor) => tx(s.test, who, (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }));
const advanceBody = (s: Lobby) => (ctx: any) => M.advance_stage(ctx, { lobbyId: s.lobbyId });

/** One Classic turn by the acting captain: a priced pick (cost 3 for Blue, 0 for Red) or a priced ban. */
function classicTurn(s: Lobby) {
    const sess = session(s.test, s.lobbyId);
    const turn = sess.draftSequence[sess.turnIndex];
    const team = turn.teamTurn.tag as Side;
    const name = `${team.toLowerCase()}-${sess.turnIndex}`;
    if (turn.actionRequired.tag === 'Ban') {
        priceBanNames(s.test, s.lobbyId, [name]);
        tx(s.test, captain(s, team), (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: name }));
    } else {
        priceCharacters(s.test, s.lobbyId, [name], team === 'Blue' ? 3 : 0);
        tx(s.test, captain(s, team), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: name, eidolon: 0 }));
    }
}
/** Plays the Classic sequence until `left` turns remain (stops early if the lobby left Drafting). */
function playClassic(s: Lobby, left = 0) {
    while (stage(s) === 'Drafting' && session(s.test, s.lobbyId).turnIndex < session(s.test, s.lobbyId).draftSequence.length - left) classicTurn(s);
}
/**
 * Plays the Auction until `sales` sales are made: Blue's nominations cost 5 and Red passes, Red's cost 0 and Blue
 * passes, so the sales alternate (Blue's 8th is sale 15). The 16th sale is always an A81(2) immediate sale: before it
 * one team is full and a full team never nominates.
 */
function playAuction(s: Lobby, sales = 16) {
    let n = stepsOf(s, 'Nominate').length + stepsOf(s, 'Undo').length;
    while (stage(s) === 'Drafting' && stepsOf(s, 'AuctionSold').length < sales) {
        const sess = session(s.test, s.lobbyId);
        const team = sess.nextNominatorTeam.tag as Side;
        const otherFull = (team === 'Blue' ? sess.redCharactersWon : sess.blueCharactersWon) >= 8;
        nominate(s, `a${++n}`, team === 'Blue' ? 5 : 0);
        if (!otherFull) pass(s, other(team));
    }
}

describe('A129: the last pick or sale leaves the lobby in Drafting with the draft complete', () => {
    it('A129: Classic: after the last manual pick the stage is Drafting, no roll-over, picks / bans / the turn timer do nothing; undo reopens the last turn; advance_stage rolls over once', () => {
        const s = lobby();
        playClassic(s, 1);
        const beforeLast = world(s);
        classicTurn(s);
        expect(stage(s)).toBe('Drafting');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 100, lc: 50 });
        const complete = world(s);
        priceCharacters(s.test, s.lobbyId, ['late']);
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'late', eidolon: 0 }))).toBe(COMPLETE);
        expect(rejection(s.test, captain(s, 'Red'), (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'late' }))).toBe(COMPLETE);
        advance(s.test, TURN_MS + 1_000); // a turn's length has passed, the window has not
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }))).toBe(WINDOW_OPEN);
        expect(world(s)).toEqual(complete);

        undo(s); // the last pick: its turn reopens with a fresh clock
        expect(world(s)).toEqual(beforeLast);
        expect(session(s.test, s.lobbyId).timerState.turnStartAt.microsSinceUnixEpoch).toBe(s.test.clock.now().microsSinceUnixEpoch);
        classicTurn(s);
        expect(stage(s)).toBe('Drafting');

        tx(s.test, s.host, advanceBody(s));
        expect(stage(s)).toBe('Equipping');
        // D-50 roll-over (Classic charges no budget during the draft): 100 + 50 on each side.
        expect([budgets(s, 'Blue'), budgets(s, 'Red')]).toEqual([{ char: 0, lc: 150, won: 0 }, { char: 0, lc: 150, won: 0 }]);
        expect(chatLines(s)).toBe(1);
        expect(rejection(s.test, s.host, undoBody(s))).toBe(FINISHED);
    });

    it('A129: Classic: the last pick made by the timer also leaves the lobby in Drafting', () => {
        const s = lobby();
        playClassic(s, 1);
        advance(s.test, TURN_MS + 1_000);
        expireClassic(s, captain(s, 'Red'));
        expect(stepsOf(s, 'Pick')).toHaveLength(16);
        expect(stage(s)).toBe('Drafting');
        expect(budgets(s, 'Red')).toMatchObject({ char: 100, lc: 50 });
    });

    it('A129: Auction: after the last sale (an A81 immediate sale) the stage is Drafting, no roll-over; nominate / bid / pass / the timer do nothing; undo reopens the nomination turn', () => {
        const s = lobby(AUCTION);
        playAuction(s, 15);
        const beforeLast = world(s);
        playAuction(s, 16);
        expect(stage(s)).toBe('Drafting');
        expect(budgets(s, 'Blue')).toEqual({ char: 60, lc: 50, won: 8 });
        expect(budgets(s, 'Red')).toEqual({ char: 100, lc: 50, won: 8 });
        const complete = world(s);
        priceCharacters(s.test, s.lobbyId, ['late']);
        expect(rejection(s.test, captain(s, 'Red'), (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'late' }))).toBe(COMPLETE);
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 1 }))).toBe(COMPLETE);
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }))).toBe(COMPLETE);
        advance(s.test, TURN_MS + 1_000);
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }))).toBe(WINDOW_OPEN);
        expect(world(s)).toEqual(complete);

        undo(s); // the immediate sale and its nomination
        expect(world(s)).toEqual(beforeLast);
        playAuction(s, 16);
        tx(s.test, s.host, advanceBody(s));
        expect(stage(s)).toBe('Equipping');
        expect([budgets(s, 'Blue'), budgets(s, 'Red')]).toEqual([{ char: 0, lc: 110, won: 8 }, { char: 0, lc: 150, won: 8 }]);
        expect(rejection(s.test, s.host, undoBody(s))).toBe(FINISHED);
    });

    it('A129: Auction: the last sale made through the timer (its EMPTY nomination sells at once) also leaves the lobby in Drafting', () => {
        const s = lobby(AUCTION);
        playAuction(s, 15);
        advance(s.test, TURN_MS + 1_000);
        expireAuctionBy(s, captain(s, 'Blue'));
        expect(stepsOf(s, 'AuctionSold')).toHaveLength(16);
        expect(stage(s)).toBe('Drafting');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 60, lc: 50 });
    });

    it('A129 / A100 / A80: advance_stage before the draft is complete is refused; a player who is not the referee cannot advance', () => {
        const s = lobby();
        playClassic(s, 1);
        expect(rejection(s.test, s.host, advanceBody(s))).toMatch(/^The draft is not finished: Blue holds \d of 8 characters and Red holds \d of 8\.$/);
        classicTurn(s);
        rejection(s.test, captain(s, 'Blue'), advanceBody(s));
        expect(stage(s)).toBe('Drafting');
        tx(s.test, s.host, advanceBody(s));
        expect(stage(s)).toBe('Equipping');
    });
});

describe('A130: the confirm window after the last step', () => {
    for (const mode of ['Classic', 'Auction'] as const) {
        const finish = (s: Lobby) => (mode === 'Classic' ? playClassic(s) : playAuction(s));
        const expire = (s: Lobby, who: Actor) => (mode === 'Classic' ? expireClassic(s, who) : expireAuctionBy(s, who));
        const args = mode === 'Classic' ? {} : AUCTION;

        it(`A130 (${mode}): nobody can end the window early; at 60 s any present member moves the lobby to Equipping with the same state as the referee's advance`, () => {
            const s = lobby(args);
            finish(s);
            advance(s.test, WINDOW_MS - 1);
            for (const who of [s.host, captain(s, 'Blue'), captain(s, 'Red')]) {
                expect(rejection(s.test, who, (ctx) => (mode === 'Classic' ? M.timer_expiry_classic : M.timer_expiry_auction)(ctx, { lobbyId: s.lobbyId }))).toBe(WINDOW_OPEN);
            }
            expect(stage(s)).toBe('Drafting');
            advance(s.test, 1);
            expire(s, captain(s, 'Red'));
            expect(stage(s)).toBe('Equipping');
            expect(chatLines(s)).toBe(1);
            const byWindow = world(s);

            const t = lobby(args); // the same draft, advanced by the referee at once
            finish(t);
            tx(t.test, t.host, advanceBody(t));
            expect(world(t)).toEqual(byWindow);
            expect(chatLines(t)).toBe(1);
        });

        it(`A130 (${mode}): a pause holds the window (paused time does not count)`, () => {
            const s = lobby(args);
            finish(s);
            advance(s.test, 30_000);
            tx(s.test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
            advance(s.test, 120_000);
            expect(rejection(s.test, s.host, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }))).toBe('Draft is paused.');
            tx(s.test, s.host, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
            advance(s.test, 29_000);
            expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }))).toBe(WINDOW_OPEN);
            advance(s.test, 1_000);
            expire(s, captain(s, 'Blue'));
            expect(stage(s)).toBe('Equipping');
        });

        it(`A130 (${mode}): an undo in the window ends it; finishing the draft again starts a fresh window`, () => {
            const s = lobby(args);
            finish(s);
            advance(s.test, 50_000);
            undo(s);
            expect(stage(s)).toBe('Drafting');
            finish(s);
            advance(s.test, 50_000);
            expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }))).toBe(WINDOW_OPEN);
            advance(s.test, 10_000);
            expire(s, captain(s, 'Blue'));
            expect(stage(s)).toBe('Equipping');
        });
    }

    it('A130: the referee may advance at any time in the window', () => {
        const s = lobby(AUCTION);
        playAuction(s);
        advance(s.test, 1_000);
        tx(s.test, s.host, advanceBody(s));
        expect(stage(s)).toBe('Equipping');
    });
});

describe('A131: the confirm window is a lobby setting (0-300 s, default 60)', () => {
    it('A131: default 60 on a new lobby and a new preset; a preset update without the key keeps it', () => {
        const s = lobby();
        expect(lobbyRow(s.test, s.lobbyId).confirmWindowSeconds).toBe(60);
        tx(s.test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('window-default')));
        expect(presetNamed(s.test, 'window-default')!.confirmWindowSeconds).toBe(60);
        tx(s.test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('window-20', { confirmWindowSeconds: 20 })));
        const p = presetNamed(s.test, 'window-20')!;
        expect(p.confirmWindowSeconds).toBe(20);
        tx(s.test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(p.id, 'window-20')));
        expect(presetNamed(s.test, 'window-20')!.confirmWindowSeconds).toBe(20);
    });

    it('A131: a lobby set to 10 s moves at 10 s and not before', () => {
        const s = lobby({ confirmWindowSeconds: 10 });
        playClassic(s);
        advance(s.test, 9_999);
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }))).toBe(WINDOW_OPEN);
        advance(s.test, 1);
        expireClassic(s, captain(s, 'Blue'));
        expect(stage(s)).toBe('Equipping');
    });

    it('A131: 0 = no window: the last pick and the last sale move to Equipping in the same call (with the roll-over), so they cannot be undone', () => {
        const c = lobby({ confirmWindowSeconds: 0 });
        playClassic(c);
        expect(stage(c)).toBe('Equipping');
        expect(budgets(c, 'Blue')).toMatchObject({ char: 0, lc: 150 });
        expect(chatLines(c)).toBe(1);
        expect(rejection(c.test, c.host, undoBody(c))).toBe(FINISHED);

        const a = lobby({ ...AUCTION, confirmWindowSeconds: 0 });
        playAuction(a);
        expect(stage(a)).toBe('Equipping');
        expect([budgets(a, 'Blue'), budgets(a, 'Red')]).toEqual([{ char: 0, lc: 110, won: 8 }, { char: 0, lc: 150, won: 8 }]);
    });

    it('A131: 301, negative and fractional values are refused on create_lobby, update_lobby_settings and the preset reducers', () => {
        const test = newHarness();
        const host = guest(test, 'h');
        for (const bad of [301, -1, 2.5]) {
            expect(rejection(test, host, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, confirmWindowSeconds: bad } as any))).toBe(WINDOW_RANGE);
            expect(rejection(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs(`bad-${bad}`, { confirmWindowSeconds: bad })))).toBe(WINDOW_RANGE);
        }
        const s = setupLobby(test, { seats: ONE_V_ONE, noStart: true });
        expect(rejection(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { confirmWindowSeconds: 301 })))).toBe(WINDOW_RANGE);
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { confirmWindowSeconds: 300 })));
        expect(lobbyRow(test, s.lobbyId).confirmWindowSeconds).toBe(300);
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId))); // omitted = unchanged
        expect(lobbyRow(test, s.lobbyId).confirmWindowSeconds).toBe(300);
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('ok')));
        const p = presetNamed(test, 'ok')!;
        expect(rejection(test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(p.id, 'ok', { confirmWindowSeconds: -5 })))).toBe(WINDOW_RANGE);
    });

    it('A131: the setting cannot change after the draft started (the D-28 rule of every setting)', () => {
        const s = lobby();
        expect(rejection(s.test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { confirmWindowSeconds: 5 }))))
            .toBe('This action is not allowed in the current lobby stage (Drafting).');
        expect(lobbyRow(s.test, s.lobbyId).confirmWindowSeconds).toBe(60);
    });

    it("A131: a tournament lobby takes the window from the tournament's preset", () => {
        const f = duel();
        const presetId = f.test.db.Tournament.id.find(f.id)!.lobbyPresetId;
        const preset = f.test.db.LobbyPreset.id.find(presetId)!;
        f.test.db.LobbyPreset.id.update({ ...preset, confirmWindowSeconds: 25 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const lobbyId = createTournamentLobby(f.test, f.org, m.id);
        expect(lobbyRow(f.test, lobbyId).confirmWindowSeconds).toBe(25);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Review F2 and F3 (S10t fix pass)
// ════════════════════════════════════════════════════════════════════════════

describe('S10t review F2 (A129): a concede in the confirm window counts like an Equipping concede for Ranked character stats', () => {
    function rankedLobby(): Lobby {
        const test = newHarness();
        seedElo(test); // a standalone concede finalizes inline (MMR for Ranked)
        return setupLobby(test, { lobby: { refereeExclusiveConcede: false }, beforeStart: rankedHook(test) });
    }
    const concede = (s: Lobby) => tx(s.test, s.a.b1, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 0 }));

    it('S10t F2 / A129: Ranked, conceded in the window (draft complete, stage Drafting): the character stats are counted', () => {
        const s = rankedLobby();
        playClassic(s);
        expect(stage(s)).toBe('Drafting');
        concede(s);
        expect(s.test.db.MatchSessionHistory.count()).toBe(1n);
        expect([...s.test.db.PlayerCharacterStat.iter()]).toHaveLength(32); // 2v2 Halves: 16 characters, each played by its side's 2 players and faced by the other side's
        expect([...s.test.db.GlobalCharacterStat.iter()]).toHaveLength(16);
    });

    it('S10t F2 / D-79: Ranked, conceded mid-draft: the character stats are still skipped', () => {
        const s = rankedLobby();
        playClassic(s, 8);
        concede(s);
        expect(s.test.db.MatchSessionHistory.count()).toBe(1n);
        expect([...s.test.db.PlayerCharacterStat.iter()]).toEqual([]);
        expect([...s.test.db.GlobalCharacterStat.iter()]).toEqual([]);
    });
});

describe('S10t review F3 (A130): the move to Equipping ends a pause that held the window', () => {
    it('S10t F3: a manual pause in the window, then the referee advances: Equipping is not paused; the pause counters and the Pause row stay', () => {
        const s = lobby({ allowPlayerPause: true });
        playClassic(s);
        tx(s.test, captain(s, 'Blue'), (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        expect(session(s.test, s.lobbyId)).toMatchObject({ pausesUsedBlue: 1, timerState: { isPaused: true } });
        tx(s.test, s.host, advanceBody(s));
        expect(stage(s)).toBe('Equipping');
        expect(session(s.test, s.lobbyId)).toMatchObject({ pausesUsedBlue: 1, pausesUsedRed: 0, timerState: { isPaused: false, accumulatedPauseMs: 0 } });
        expect(stepsOf(s, 'Pause')).toHaveLength(1);
    });

    it('S10t F3: a disconnect auto-pause in the window, then the referee advances: Equipping is not paused', () => {
        const s = setupLobby(newHarness(), { lobby: AUCTION });
        playAuction(s);
        disconnect(s.test, s.a.b2);
        const row = pendingCheck(s.test, s.lobbyId, s.a.b2.userId);
        advance(s.test, 15_000);
        fireCheck(s.test, row);
        expect(session(s.test, s.lobbyId).timerState).toMatchObject({ isPaused: true, accumulatedPauseMs: WINDOW_MS - 15_000 });
        expect((stepsOf(s, 'Pause')[0].payload.value as any).isAutoPause).toBe(true);
        tx(s.test, s.host, advanceBody(s));
        expect(stage(s)).toBe('Equipping');
        expect(session(s.test, s.lobbyId).timerState).toMatchObject({ isPaused: false, accumulatedPauseMs: 0 });
        expect(stepsOf(s, 'Pause')).toHaveLength(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Review 2: G1 (no negative budget after a sale undo), G2 (a bid undo needs a backed holder), L3 (mirror picks, forfeit)
// ════════════════════════════════════════════════════════════════════════════

describe('A132 / S10t review 2 G1: a sale undo never leaves a budget below 0', () => {
    it('A132 G1: buy B for 5 and A for 5.5, raise A +30, lower A (refund 30 to light cones), raise B +139, undo the sale of A → 6 / 0 (the shortfall comes from the character budget); Red outbids on A, Blue buys C for 1 → 5 / 0', () => {
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
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: 'A', currentBidAmount: 5.5, currentBidTeam: { tag: 'Blue' } });
        expectBudgetInvariant(s, 'Blue');
        bid(s, 'Red', 6.5);
        pass(s, 'Blue'); // Red wins A (a steal: Blue nominates again)
        nominate(s, 'C', 1);
        pass(s, 'Red'); // Blue buys C for 1
        expect(budgets(s, 'Blue')).toEqual({ char: 5, lc: 0, won: 2 });
        expectBudgetInvariant(s, 'Blue');
        expectBudgetInvariant(s, 'Red');
    });
});

describe('A127 / S10t review 2 G2: a bid undo is refused when the previous bidder can no longer cover their bid', () => {
    const CANNOT = 'Cannot undo this bid: the previous bidder can no longer cover their bid.';
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

    it('A127 G2: Red raised R by 20 (character budget 19 → 0): the undo of Blue\'s bid is refused, nothing changes, and the draft goes on with Blue holding 13', () => {
        const s = outbidThenRaise(20);
        expect(budgets(s, 'Red')).toMatchObject({ char: 0, lc: 9 });
        const before = world(s);
        expect(rejection(s.test, s.host, undoBody(s))).toBe(CANNOT);
        expect(world(s)).toEqual(before);
        pass(s, 'Red'); // Blue wins N at 13
        expect(budgets(s, 'Blue')).toMatchObject({ char: 7, won: 1 });
        expectBudgetInvariant(s, 'Blue');
        expectBudgetInvariant(s, 'Red');
    });

    it('A127 G2: the timer path also goes on after the refusal (Blue holds 13; the timer sells to Blue)', () => {
        const s = outbidThenRaise(20);
        expect(rejection(s.test, s.host, undoBody(s))).toBe(CANNOT);
        expireAuction(s, 'Red');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 7, won: 1 });
    });

    it('A127 G2 neighbour: Red raised R by 5 (character budget 19 → 14 ≥ 12): the undo of Blue\'s bid works, Red holds 12 again', () => {
        const s = outbidThenRaise(5);
        expect(budgets(s, 'Red')).toMatchObject({ char: 14, lc: 10 });
        undo(s);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: 'N', currentBidAmount: 12, currentBidTeam: { tag: 'Red' } });
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
