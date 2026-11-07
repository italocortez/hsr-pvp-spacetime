// T-S7b: in-memory tests for A61 (Auction eidolon economics): nominations and bids at E0, ownership on nominations and
// bids, the total-budget guard, the eidolon extra charged at the sale (both sale paths), the roster cost (amount +
// extra), and set_eidolon paying / refunding the difference. Cost ladders have distinct e0..e6. TestClock; no maincloud.
import { describe, expect, it } from 'vitest';
import { M, advance, expectReject, lobbyRow, newHarness, session, setupLobby, steps, tx, type Harness, type Lobby } from './s4-fixtures';
import {
    H,
    arrange,
    blueNames,
    captain,
    draftAuction,
    gameRow,
    halves,
    insertAuctionCost,
    lineup,
    record,
    recordScores,
    redNames,
    selectAccount,
    setEidolon,
} from './s7-fixtures';

const AUCTION = { draftMode: { tag: 'Auction' } };
const NOT_OWNED = 'Your team does not own this character on any selected account.';
const OVER_TOTAL = 'Not enough total budget: the eidolon extra for this character would exceed it.';

const nominate = (s: Lobby, team: 'Blue' | 'Red', characterName: string) => (ctx: any) =>
    M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName });
const bid = (s: Lobby, bidAmount: number) => (ctx: any) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount });
const pass = (s: Lobby) => (ctx: any) => M.pass_bid(ctx, { lobbyId: s.lobbyId });
const budgets = (test: Harness, lobbyId: number) => {
    const ss = session(test, lobbyId);
    return { blueChar: ss.teamBlueCharBudget, blueLc: ss.teamBlueLcBudget, redChar: ss.teamRedCharBudget, redLc: ss.teamRedLcBudget };
};
const lastSold = (test: Harness, lobbyId: number) =>
    steps(test, lobbyId).filter((st) => st.action.tag === 'AuctionSold').sort((a, b) => b.sequence - a.sequence)[0].payload.value as
        { characterName: string; winningAmount: number; eidolon: number; eidolonCost: number; winningTeam: { tag: string } };
/** The non-captain Blue player (ownership is a team property: any player seat's selected accounts count). */
const blueMate = (s: Lobby) => [s.a.b1, s.a.b2].find((a) => a.userId !== captain(s, 'Blue').userId)!;

describe('A61(1): nominations at the E0 base cost', () => {
    it('nominate_character(lobbyId, characterName) opens at e0; the Nominate payload carries no eidolon', () => {
        const test = newHarness();
        insertAuctionCost(test, 'x', [10, 12, 15, 20, 25, 30, 40]);
        const s = setupLobby(test, { lobby: AUCTION });
        tx(test, captain(s, 'Blue'), nominate(s, 'Blue', 'x'));
        expect(session(test, s.lobbyId).currentBidAmount).toBe(10);
        const nom = steps(test, s.lobbyId).find((st) => st.action.tag === 'Nominate')!;
        expect(nom.payload.value).toEqual({ characterName: 'x' });
    });
});

describe('A61(2): ownership on nominations and bids', () => {
    it('requireOwnership: unowned nominations and bids are rejected, an owned one is accepted, EMPTY is exempt', () => {
        const test = newHarness();
        insertAuctionCost(test, 'x', [10, 12, 15, 20, 25, 30, 40]);
        const s = setupLobby(test, { lobby: { ...AUCTION, requireOwnership: true } });
        selectAccount(test, s.lobbyId, blueMate(s).userId, 900, { x: 2 });
        selectAccount(test, s.lobbyId, captain(s, 'Red').userId, 901, { 'red-1': 0 });

        expectReject(test, captain(s, 'Blue'), nominate(s, 'Blue', 'y'), NOT_OWNED);
        tx(test, captain(s, 'Blue'), nominate(s, 'Blue', 'x'));
        expectReject(test, captain(s, 'Red'), bid(s, 11), NOT_OWNED);
        tx(test, captain(s, 'Red'), pass(s));

        // Sold to Blue: default eidolon = the team's highest owned level (E2), extra = 15 - 10 = 5 (A61(3)).
        const sold = lastSold(test, s.lobbyId);
        expect(sold).toMatchObject({ characterName: 'x', winningAmount: 10, eidolon: 2, eidolonCost: 5 });
        expect(budgets(test, s.lobbyId)).toMatchObject({ blueChar: 85, blueLc: 50 });

        // Red's turn: a character it does not own is rejected, EMPTY is exempt.
        expect(session(test, s.lobbyId).nextNominatorTeam.tag).toBe('Red');
        expectReject(test, captain(s, 'Red'), nominate(s, 'Red', 'y'), NOT_OWNED);
        tx(test, captain(s, 'Red'), nominate(s, 'Red', 'EMPTY'));
        expect(session(test, s.lobbyId).currentNomination).toBe('EMPTY');
    });
});

describe('A61(4): the total-budget guard', () => {
    it('a bid within the character budget but over character + light-cone budget with the extra is rejected', () => {
        const test = newHarness();
        insertAuctionCost(test, 'z', [10, 10, 10, 10, 10, 10, 70]); // extra at E6 = 60
        const s = setupLobby(test, { lobby: { ...AUCTION, requireOwnership: true } });
        selectAccount(test, s.lobbyId, captain(s, 'Blue').userId, 900, { z: 6 });
        selectAccount(test, s.lobbyId, captain(s, 'Red').userId, 901, { z: 0 });

        tx(test, captain(s, 'Blue'), nominate(s, 'Blue', 'z')); // 10 + 60 ≤ 100 + 50
        tx(test, captain(s, 'Red'), bid(s, 95)); // Red's extra is 0
        expectReject(test, captain(s, 'Blue'), bid(s, 96), OVER_TOTAL); // 96 ≤ 100, but 96 + 60 > 150
        expectReject(test, captain(s, 'Blue'), bid(s, 101), 'Bid exceeds your remaining character budget.');
        tx(test, captain(s, 'Blue'), pass(s));
        expect(lastSold(test, s.lobbyId)).toMatchObject({ winningTeam: { tag: 'Red' }, winningAmount: 95, eidolon: 0, eidolonCost: 0 });
        expect(budgets(test, s.lobbyId)).toMatchObject({ redChar: 5, redLc: 50 });
    });

    it('a nomination whose base cost + extra exceeds the total is rejected', () => {
        const test = newHarness();
        insertAuctionCost(test, 'z', [10, 10, 10, 10, 10, 10, 200]); // 10 + 190 > 150
        const s = setupLobby(test, { lobby: { ...AUCTION, requireOwnership: true } });
        selectAccount(test, s.lobbyId, captain(s, 'Blue').userId, 900, { z: 6 });
        expectReject(test, captain(s, 'Blue'), nominate(s, 'Blue', 'z'), OVER_TOTAL);
    });

    it('without ownership the extra is 0 (default eidolon E0)', () => {
        const test = newHarness();
        insertAuctionCost(test, 'z', [10, 20, 30, 40, 50, 60, 200]);
        const s = setupLobby(test, { lobby: AUCTION });
        tx(test, captain(s, 'Blue'), nominate(s, 'Blue', 'z'));
        tx(test, captain(s, 'Red'), pass(s));
        expect(lastSold(test, s.lobbyId)).toMatchObject({ eidolon: 0, eidolonCost: 0 });
        expect(budgets(test, s.lobbyId)).toMatchObject({ blueChar: 90, blueLc: 50 });
    });
});

describe('A61(5): the extra is charged at the sale, character budget first', () => {
    /** Blue owns w at E6 (extra 100) and nominates it at 10; Red owns red-1 only. */
    function wLobby(test: Harness) {
        insertAuctionCost(test, 'w', [10, 10, 10, 10, 10, 10, 110]);
        const s = setupLobby(test, { lobby: { ...AUCTION, requireOwnership: true } });
        selectAccount(test, s.lobbyId, captain(s, 'Blue').userId, 900, { w: 6 });
        selectAccount(test, s.lobbyId, captain(s, 'Red').userId, 901, { 'red-1': 0 });
        tx(test, captain(s, 'Blue'), nominate(s, 'Blue', 'w'));
        return s;
    }
    const expectCharged = (test: Harness, s: Lobby) => {
        expect(lastSold(test, s.lobbyId)).toMatchObject({ characterName: 'w', winningAmount: 10, eidolon: 6, eidolonCost: 100 });
        // 100 - 10 = 90 character budget; the extra 100 takes it to 0 and the remaining 10 leaves the light-cone budget.
        expect(budgets(test, s.lobbyId)).toMatchObject({ blueChar: 0, blueLc: 40 });
    };

    it('pass_bid path; a depleted team can still nominate EMPTY; the D-50 rollover carries the leftovers', () => {
        const test = newHarness();
        const s = wLobby(test);
        tx(test, captain(s, 'Red'), pass(s));
        expectCharged(test, s);

        tx(test, captain(s, 'Red'), nominate(s, 'Red', 'red-1'));
        tx(test, captain(s, 'Blue'), pass(s));
        expect(session(test, s.lobbyId).nextNominatorTeam.tag).toBe('Blue');
        tx(test, captain(s, 'Blue'), nominate(s, 'Blue', 'EMPTY')); // cost 0 ≤ character budget 0
        tx(test, captain(s, 'Red'), pass(s));

        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId })); // D-50 rollover
        expect(budgets(test, s.lobbyId)).toEqual({ blueChar: 0, blueLc: 40, redChar: 0, redLc: 150 });
    });

    it('timer_expiry_auction path (the bidding team auto-passes after standardTurnSeconds)', () => {
        const test = newHarness();
        const s = wLobby(test);
        advance(test, 30 * 1000 + 1);
        tx(test, captain(s, 'Red'), (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }));
        expectCharged(test, s);
    });
});

describe('A61(7): roster cost = winning amount + extra', () => {
    it('feeds tie-break 1 on an engineered tie', () => {
        const test = newHarness();
        insertAuctionCost(test, 'w', [10, 10, 10, 10, 10, 10, 110]);
        const s = setupLobby(test, { lobby: { ...AUCTION, requireOwnership: true } });
        const blue = ['w', ...blueNames(7)];
        selectAccount(test, s.lobbyId, captain(s, 'Blue').userId, 900, Object.fromEntries(blue.map((n) => [n, n === 'w' ? 6 : 0])));
        selectAccount(test, s.lobbyId, captain(s, 'Red').userId, 901, Object.fromEntries(redNames().map((n) => [n, 0])));
        draftAuction(s, blue, redNames());
        arrange(s, captain(s, 'Blue'), 'Blue', halves(blue));
        arrange(s, captain(s, 'Red'), 'Red', halves(redNames()));
        expect(lineup(test, s.lobbyId, 'Blue').rosterCost).toBe(H(110));
        recordScores(s, s.host, 'Blue', [H(5), H(5)]);
        recordScores(s, s.host, 'Red', [H(5), H(5)]);
        const g = gameRow(test, record(test, s.lobbyId).id);
        expect(g.tieBreakLevel).toBe(1);
        expect(g.winnerTeamSide.tag).toBe('Red');
    });
});

describe('A61(6): set_eidolon in Auction pays or refunds the difference', () => {
    it('raise: character budget first while drafting, light-cone budget after the rollover; lower: refund to light cones; over the total: rejected', () => {
        const test = newHarness();
        insertAuctionCost(test, 'v', [10, 20, 30, 40, 50, 60, 200]); // extras: E1 10, E2 20, E3 30, E6 190
        const s = setupLobby(test, { lobby: AUCTION });
        const blueCap = captain(s, 'Blue');
        tx(test, blueCap, nominate(s, 'Blue', 'v'));
        tx(test, captain(s, 'Red'), pass(s));
        expect(budgets(test, s.lobbyId)).toMatchObject({ blueChar: 90, blueLc: 50 }); // E0, no extra without ownership

        setEidolon(s, blueCap, 'Blue', 'v', 2); // +20 from the character budget
        expect(budgets(test, s.lobbyId)).toMatchObject({ blueChar: 70, blueLc: 50 });
        const costPaid = () => steps(test, s.lobbyId).filter((st) => st.action.tag === 'SetEidolon')
            .sort((a, b) => b.sequence - a.sequence)[0].payload.value as { costPaid: number; eidolon: number; previousEidolon: number };
        expect(costPaid()).toMatchObject({ eidolon: 2, previousEidolon: 0, costPaid: 20 });

        advance(test, 300);
        setEidolon(s, blueCap, 'Blue', 'v', 1); // -10 refunded to the light-cone budget, never to bidding power
        expect(budgets(test, s.lobbyId)).toMatchObject({ blueChar: 70, blueLc: 60 });
        expect(costPaid().costPaid).toBe(10);

        advance(test, 300);
        expectReject(test, blueCap, (ctx) =>
            M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' }, characterName: 'v', eidolon: 6 }),
            'Not enough budget for that eidolon.'); // +180 > 70 + 60

        // Finish the auction (D-50 rollover: 70 + 60 = 130 light-cone budget), then raise to E3 from the light cones.
        draftAuction(s, blueNames(7), redNames());
        expect(budgets(test, s.lobbyId)).toMatchObject({ blueChar: 0, blueLc: 130 });
        advance(test, 300);
        setEidolon(s, blueCap, 'Blue', 'v', 3); // +20
        expect(budgets(test, s.lobbyId)).toMatchObject({ blueChar: 0, blueLc: 110 });

        // The roster cost uses the latest level: 10 (winning amount) + 30 (extra at E3).
        advance(test, 300);
        arrange(s, blueCap, 'Blue', halves(['v', ...blueNames(7)]));
        expect(lineup(test, s.lobbyId, 'Blue').rosterCost).toBe(H(40));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
    });
});

describe('A61(4)/(5) review fix: set_eidolon reserves the bid the team currently holds', () => {
    it('a raise that would eat into the held bid is rejected; a smaller one keeps the character budget at the bid; the sale goes through', () => {
        const test = newHarness();
        insertAuctionCost(test, 'a', [10, 20, 30, 40, 50, 110, 130]); // extras: E5 100, E6 120
        insertAuctionCost(test, 'b', [30, 30, 30, 30, 30, 30, 30]);
        const s = setupLobby(test, { lobby: AUCTION });
        const blueCap = captain(s, 'Blue');
        tx(test, blueCap, nominate(s, 'Blue', 'a'));
        tx(test, captain(s, 'Red'), pass(s));
        tx(test, captain(s, 'Red'), nominate(s, 'Red', 'red-1'));
        tx(test, blueCap, pass(s));
        tx(test, blueCap, nominate(s, 'Blue', 'b')); // Blue holds the bid at 30
        expect(budgets(test, s.lobbyId)).toMatchObject({ blueChar: 90, blueLc: 50 });
        expect(session(test, s.lobbyId).currentBidTeam.tag).toBe('Blue');

        // Total 140, commitment 30 (+ extra 0 without ownership): 110 spendable; E6 costs +120.
        expectReject(test, blueCap, (ctx) =>
            M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' }, characterName: 'a', eidolon: 6 }),
            'Not enough budget for that eidolon: your current bid is reserved.');
        expect(budgets(test, s.lobbyId)).toMatchObject({ blueChar: 90, blueLc: 50 });

        // E5 costs +100: 60 from the character budget (90 - the 30 bid), the remaining 40 from the light cones.
        setEidolon(s, blueCap, 'Blue', 'a', 5);
        expect(budgets(test, s.lobbyId)).toMatchObject({ blueChar: 30, blueLc: 10 });

        // The sale takes the bid from the character budget it was reserved in: no clamp, no invariant throw.
        tx(test, captain(s, 'Red'), pass(s));
        expect(lastSold(test, s.lobbyId)).toMatchObject({ characterName: 'b', winningAmount: 30, eidolonCost: 0 });
        expect(budgets(test, s.lobbyId)).toMatchObject({ blueChar: 0, blueLc: 10 });
    });
});
