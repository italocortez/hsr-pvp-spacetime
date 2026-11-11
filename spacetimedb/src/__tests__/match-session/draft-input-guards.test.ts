// Match session: draft input guards (eidolon and superimposition ranges, bid amounts, ban names, a full team in the
//   Auction, the lobby's ban restriction, gated actions).
// Decisions: A22, A45, A81, A122
// Contracts: docs/match-session/contract.md
// From S4, S6, S10c, S10r (s4-lobby-fixes.test.ts, s6-rules.test.ts, s10c-high-fixes.test.ts,
// s10r-triage-fixes.test.ts); merged by T-REORG2.
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    advanceToEquipping,
    draftDone,
    expectReject,
    guest,
    lobbyRow,
    newHarness,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Harness,
    type Lobby,
    type SetupOpts,
    rejection,
    AUCTION,
    snap,
    TURN_MS,
    type Team,
    AUDIT,
    dropDefaultCostCoverage,
    priceBanNames,
} from '../fixtures/harness';
import {
    blueCaptain,
    blueNames,
    captain,
    draftClassic,
    finishGame,
    insertAuctionCost,
    insertCharacterCostLadder,
    insertRoster,
    redNames,
    selectAccount,
    setRole,
    side,
    stepsOf,
    turnOf,
} from '../fixtures/draft-and-scoring';
import { recordsOfLobby } from '../fixtures/tournament-matches';

describe('F3 / A22(3): expiry and draft actions are gated', () => {
    it('a non-member cannot fire timer_expiry_classic', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const outsider = guest(test, 'outsider');
        advance(test, 31_000);
        expectReject(test, outsider, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }), /not a member/i);
        expect(steps(test, s.lobbyId)).toHaveLength(0);
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
    });

    it('Classic, paused: timer_expiry_classic, pick_character, ban_character → "Draft is paused."', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        advance(test, 31_000);

        expectReject(test, s.a.b1, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }), 'Draft is paused.');
        expectReject(test, blueCaptain(s), (ctx) => (priceCharacters(ctx, s.lobbyId, ['Acheron']), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'Acheron', eidolon: 0 })), 'Draft is paused.');
        expectReject(test, blueCaptain(s), (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'Acheron' }), 'Draft is paused.');
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
    });

    it('Auction, paused: nominate_character, place_bid, pass_bid, timer_expiry_auction → "Draft is paused."', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' } } });
        expect(session(test, s.lobbyId).isAuctionPhase).toBe(true);
        tx(test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        advance(test, 31_000);

        const cap = blueCaptain(s);
        expectReject(test, cap, (ctx) => (priceCharacters(ctx, s.lobbyId, ['Acheron']), M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'Acheron' })), 'Draft is paused.');
        expectReject(test, cap, (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 5 }), 'Draft is paused.');
        expectReject(test, cap, (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }), 'Draft is paused.');
        expectReject(test, cap, (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }), 'Draft is paused.');
    });
});

const otherTeam = (t: Team): Team => (t === 'Blue' ? 'Red' : 'Blue');

/** A light-cone cost row (cost set 0, MoC, Classic) whose cost at S`n` is `n`, so the charge shows the superimposition. */
function insertLadderLightcone(test: Harness, lightconeName: string) {
    test.db.HsrLightconeCost.insert({
        lightconeName,
        gameMode: { tag: 'MemoryOfChaos' },
        draftMode: { tag: 'Classic' },
        costs: { s1: 1, s2: 2, s3: 3, s4: 4, s5: 5 },
        costSetId: 0,
        ...AUDIT(test),
    });
}

const lineupInterval = (test: Harness) => test.db.AbuseConfig.id.find(1)!.lineupMinIntervalMs;
const pastThrottle = (test: Harness) => advance(test, lineupInterval(test) + 1);

// ════════════════════════════════════════════════════════════════════════════
// Finding 1 (draft slice): pick_character eidolon bound
// ════════════════════════════════════════════════════════════════════════════

describe('audit draft finding 1: pick_character rejects an eidolon above 6 when the argument is used', () => {
    function classicLobby(opts: SetupOpts = {}) {
        const test = newHarness();
        insertRoster(test, ['x', 'y']);
        insertCharacterCostLadder(test, 'x', 'Classic', [10, 11, 12, 13, 14, 15, 16]);
        const s = setupLobby(test, opts);
        const sess = session(test, s.lobbyId);
        const team = sess.draftSequence[sess.turnIndex].teamTurn.tag as Team;
        return { test, s, team, cap: captain(s, team) };
    }

    it('ownership off: eidolon 7 is rejected with no step and no turn change; eidolon 6 is accepted and priced at e6 (finding 1)', () => {
        const { test, s, cap } = classicLobby();
        const turn0 = session(test, s.lobbyId).turnIndex;
        const steps0 = steps(test, s.lobbyId).length;
        const msg = rejection(test, cap, (ctx) => (priceCharacters(ctx, s.lobbyId, ['x']), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'x', eidolon: 7 })));
        expect(steps(test, s.lobbyId)).toHaveLength(steps0);
        expect(session(test, s.lobbyId).turnIndex).toBe(turn0);
        expect(msg).toBe('eidolon must be between 0 and 6.');

        tx(test, cap, (ctx) => (priceCharacters(ctx, s.lobbyId, ['x']), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'x', eidolon: 6 })));
        const [pick] = stepsOf(test, s.lobbyId, 'Pick');
        expect(pick.payload.value).toMatchObject({ characterName: 'x', eidolon: 6, costPaid: 16 });
        expect(session(test, s.lobbyId).turnIndex).toBe(turn0 + 1);
    });

    it('requireOwnership: the argument is ignored, so eidolon 7 is accepted and the owned level (E3) is used and priced (finding 1, CH-S6)', () => {
        const { test, s, cap } = classicLobby({ lobby: { requireOwnership: true } });
        selectAccount(test, s.lobbyId, cap.userId, 900, { x: 3 });
        tx(test, cap, (ctx) => (priceCharacters(ctx, s.lobbyId, ['x']), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'x', eidolon: 7 })));
        const [pick] = stepsOf(test, s.lobbyId, 'Pick');
        expect(pick.payload.value).toMatchObject({ characterName: 'x', eidolon: 3, costPaid: 13 });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Finding 2 (draft slice): equip_lightcone superimposition bound
// ════════════════════════════════════════════════════════════════════════════

describe('audit draft finding 2: equip_lightcone rejects a superimposition outside 1..5', () => {
    const SUPER = 'superimposition must be between 1 and 5.';
    const equipArgs = (s: Lobby, team: Team, characterName: string, superimposition: number) => ({
        lobbyId: s.lobbyId, teamSide: side(team), characterName, lightconeName: 'lc', superimposition,
    });

    it('open game: 0 and 6 are rejected with the budget and the step log untouched; 1 and 5 are accepted and charged s1 / s5 (finding 2)', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        insertLadderLightcone(test, 'lc');
        const s = setupLobby(test);
        draftClassic(s, blueNames(), redNames());
        pastThrottle(test);
        const cap = captain(s, 'Blue');
        const budget0 = session(test, s.lobbyId).teamBlueLcBudget;

        for (const bad of [0, 6]) {
            const msg = rejection(test, cap, (ctx) => M.equip_lightcone(ctx, equipArgs(s, 'Blue', 'blue-1', bad)));
            expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(budget0);
            expect(stepsOf(test, s.lobbyId, 'EquipLightcone')).toHaveLength(0);
            expect(msg).toBe(SUPER);
        }

        tx(test, cap, (ctx) => M.equip_lightcone(ctx, equipArgs(s, 'Blue', 'blue-1', 1)));
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(budget0 - 1);
        pastThrottle(test);
        tx(test, cap, (ctx) => M.equip_lightcone(ctx, equipArgs(s, 'Blue', 'blue-2', 5)));
        expect(session(test, s.lobbyId).teamBlueLcBudget).toBe(budget0 - 6);
        expect(stepsOf(test, s.lobbyId, 'EquipLightcone').map((st) => (st.payload.value as any).superimposition)).toEqual([1, 5]);
    });

    it('the Admin closed-game path (Ranked, Submitted) rejects 0 and 6 too, and accepts 5 (finding 2, A60(7))', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        insertLadderLightcone(test, 'lc');
        const s = setupLobby(test, {
            beforeStart: (l) => {
                test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
                let accountId = 800;
                for (const name of ['b1', 'b2', 'r1', 'r2']) {
                    test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: l.a[name].userId, hsrAccountId: accountId++ });
                }
            },
        });
        draftClassic(s, blueNames(), redNames());
        finishGame(s, 'Blue');
        expect(recordsOfLobby(test, s.lobbyId)[0].status.tag).toBe('Submitted');
        const admin = guest(test, 'admin');
        setRole(test, admin.userId, 'Admin');
        const budget0 = session(test, s.lobbyId).teamRedLcBudget;
        const equips0 = stepsOf(test, s.lobbyId, 'EquipLightcone').length;

        for (const bad of [0, 6]) {
            const msg = rejection(test, admin, (ctx) => M.equip_lightcone(ctx, equipArgs(s, 'Red', 'red-1', bad)));
            expect(session(test, s.lobbyId).teamRedLcBudget).toBe(budget0);
            expect(stepsOf(test, s.lobbyId, 'EquipLightcone')).toHaveLength(equips0);
            expect(msg).toBe(SUPER);
        }
        tx(test, admin, (ctx) => M.equip_lightcone(ctx, equipArgs(s, 'Red', 'red-1', 5)));
        expect(session(test, s.lobbyId).teamRedLcBudget).toBe(budget0 - 5);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Finding 3 (draft slice): place_bid amount bound
// ════════════════════════════════════════════════════════════════════════════

describe('audit draft finding 3: place_bid rejects a non-finite or negative amount', () => {
    it('NaN, Infinity, -Infinity and -1 are rejected; budgets, the current bid and its holder are unchanged, no Bid step (finding 3)', () => {
        const test = newHarness();
        insertAuctionCost(test, 'x', [10, 10, 10, 10, 10, 10, 10]);
        const s = setupLobby(test, { lobby: AUCTION });
        const nominator = session(test, s.lobbyId).nextNominatorTeam.tag as Team;
        tx(test, captain(s, nominator), (ctx) => (priceCharacters(ctx, s.lobbyId, ['x']), M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'x' })));
        const bidder = captain(s, otherTeam(nominator));
        const state = () => {
            const ss = session(test, s.lobbyId);
            return snap(ss.teamBlueCharBudget, ss.teamRedCharBudget, ss.teamBlueLcBudget, ss.teamRedLcBudget,
                ss.currentBidAmount, ss.currentBidTeam, ss.currentNomination, stepsOf(test, s.lobbyId, 'Bid').length);
        };
        const before = state();
        expect(session(test, s.lobbyId).currentBidAmount).toBe(10);

        for (const bidAmount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
            const msg = rejection(test, bidder, (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount }));
            expect(state()).toBe(before);
            expect(msg).toBe('bidAmount must be a finite, non-negative number.');
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A81: a full Auction team sits out
// ════════════════════════════════════════════════════════════════════════════

describe('A81: a team holding charactersPerTeam characters sits out of the Auction', () => {
    const FULL = 'Your team already has all its characters.';
    const won = (test: Harness, lobbyId: number) => {
        const ss = session(test, lobbyId);
        return { Blue: ss.blueCharactersWon, Red: ss.redCharactersWon };
    };
    const lastSold = (test: Harness, lobbyId: number) => stepsOf(test, lobbyId, 'AuctionSold').at(-1)!;

    /**
     * Red wins 8 characters (Halves) by steals: Blue nominates, Red raises by 1, Blue passes; the steal keeps the
     * nomination with Blue (D-46). Blue holds 0 characters, Red's character budget drops by 8.
     */
    function redFull(): Lobby {
        const test = newHarness();
        const s = setupLobby(test, { lobby: AUCTION });
        expect(session(test, s.lobbyId).nextNominatorTeam.tag).toBe('Blue');
        for (let i = 1; i <= 8; i++) {
            tx(test, captain(s, 'Blue'), (ctx) => (priceCharacters(ctx, s.lobbyId, [`r${i}`]), M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: `r${i}` })));
            tx(test, captain(s, 'Red'), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 1 }));
            tx(test, captain(s, 'Blue'), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
        }
        expect(won(test, s.lobbyId)).toEqual({ Blue: 0, Red: 8 });
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        return s;
    }

    it('nominate_character by the full team is rejected (state unchanged); the turn sits with the team that is not full (A81(1))', () => {
        const s = redFull();
        const { test, lobbyId } = s;
        expect(session(test, lobbyId).nextNominatorTeam.tag).toBe('Blue');
        const before = snap(session(test, lobbyId), steps(test, lobbyId).length);
        const msg = rejection(test, captain(s, 'Red'), (ctx) => (priceCharacters(ctx, lobbyId, ['extra']), M.nominate_character(ctx, { lobbyId, characterName: 'extra' })));
        expect(snap(session(test, lobbyId), steps(test, lobbyId).length)).toBe(before);
        expect(msg).toBe(FULL);
    });

    it('place_bid by the full team is rejected (A81(1); engineered open nomination, which the reducers no longer leave while a team is full)', () => {
        const s = redFull();
        const { test, lobbyId } = s;
        // A81(2) sells every nomination at once while Red is full, so no reducer path leaves one open: the session row is
        // edited directly (as the S4 suites edit rows) to reach the place_bid guard.
        test.db.MatchSession.lobbyId.update({
            ...session(test, lobbyId), currentNomination: 'ghost', currentBidAmount: 0, currentBidTeam: { tag: 'Blue' } as any,
        });
        const before = snap(session(test, lobbyId), steps(test, lobbyId).length);
        const msg = rejection(test, captain(s, 'Red'), (ctx) => M.place_bid(ctx, { lobbyId, bidAmount: 1 }));
        expect(snap(session(test, lobbyId), steps(test, lobbyId).length)).toBe(before);
        expect(msg).toBe(FULL);
    });

    it('while Red is full, a Blue nomination sells to Blue at once at its base cost: AuctionSold step, budget debited, no open nomination, no bidding; Blue keeps the turn (A81(1)(2))', () => {
        const s = redFull();
        const { test, lobbyId } = s;
        insertAuctionCost(test, 'bx', [7, 7, 7, 7, 7, 7, 7]);
        const blue0 = session(test, lobbyId).teamBlueCharBudget;
        const red0 = session(test, lobbyId).teamRedCharBudget;
        const bids0 = stepsOf(test, lobbyId, 'Bid').length;

        tx(test, captain(s, 'Blue'), (ctx) => (priceCharacters(ctx, lobbyId, ['bx']), M.nominate_character(ctx, { lobbyId, characterName: 'bx' })));
        const sold = lastSold(test, lobbyId);
        expect(sold.payload.value).toMatchObject({ characterName: 'bx', winningAmount: 7, winningTeam: { tag: 'Blue' } });
        expect(stepsOf(test, lobbyId, 'Bid')).toHaveLength(bids0);
        const ss = session(test, lobbyId);
        expect(ss.currentNomination).toBeUndefined();
        expect(ss.currentBidAmount).toBeUndefined();
        expect(ss.teamBlueCharBudget).toBe(blue0 - 7);
        expect(ss.teamRedCharBudget).toBe(red0);
        expect(won(test, lobbyId)).toEqual({ Blue: 1, Red: 8 });
        // D-46 would rotate to Red (Blue nominated and won); A81(1) skips the full team.
        expect(ss.nextNominatorTeam.tag).toBe('Blue');
        // Nothing left to pass or bid on.
        expect(rejection(test, captain(s, 'Red'), (ctx) => M.pass_bid(ctx, { lobbyId }))).toBeTruthy();
        expect(won(test, lobbyId)).toEqual({ Blue: 1, Red: 8 });
    });

    it('the timer path: Blue\'s nomination turn expires while Red is full → EMPTY sold to Blue at 0 at once, by the system (A81(1)(2))', () => {
        const s = redFull();
        const { test, lobbyId } = s;
        const blue0 = session(test, lobbyId).teamBlueCharBudget;
        advance(test, 30_000 + 1);
        tx(test, captain(s, 'Blue'), (ctx) => M.timer_expiry_auction(ctx, { lobbyId }));
        const sold = lastSold(test, lobbyId);
        expect(sold.payload.value).toMatchObject({ characterName: 'EMPTY', winningAmount: 0, winningTeam: { tag: 'Blue' } });
        expect(sold.actorUserId).toBe(0);
        const ss = session(test, lobbyId);
        expect(ss.currentNomination).toBeUndefined();
        expect(ss.teamBlueCharBudget).toBe(blue0);
        expect(won(test, lobbyId)).toEqual({ Blue: 1, Red: 8 });
        expect(ss.nextNominatorTeam.tag).toBe('Blue');
    });

    it('a Blue nomination it cannot afford is still rejected while Red is full (A81(2): budget checks unchanged)', () => {
        const s = redFull();
        const { test, lobbyId } = s;
        insertAuctionCost(test, 'pricey', [500, 500, 500, 500, 500, 500, 500]);
        const before = snap(session(test, lobbyId), steps(test, lobbyId).length);
        const msg = rejection(test, captain(s, 'Blue'), (ctx) => (priceCharacters(ctx, lobbyId, ['pricey']), M.nominate_character(ctx, { lobbyId, characterName: 'pricey' })));
        expect(snap(session(test, lobbyId), steps(test, lobbyId).length)).toBe(before);
        expect(msg).toBe('Not enough budget to nominate this character.');
    });

    it('Blue fills its remaining seats by immediate sales; the auction ends in Equipping with 8 + 8 (A81(2)(3))', () => {
        const s = redFull();
        const { test, lobbyId } = s;
        for (let i = 1; lobbyRow(test, lobbyId).stage.tag === 'Drafting' && i <= 20; i++) {
            tx(test, captain(s, 'Blue'), (ctx) => (priceCharacters(ctx, lobbyId, [`b${i}`]), M.nominate_character(ctx, { lobbyId, characterName: `b${i}` })));
            const w = won(test, lobbyId);
            expect(w.Blue).toBeLessThanOrEqual(8);
            expect(w.Red).toBe(8);
            if (draftDone(test, lobbyId)) advanceToEquipping(s); // T-S10t re-alignment (A129): the last step leaves the lobby in Drafting; the referee advances it.
        }
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('Equipping');
        expect(won(test, lobbyId)).toEqual({ Blue: 8, Red: 8 });
        expect(stepsOf(test, lobbyId, 'AuctionSold')).toHaveLength(16);
    });

    it.each([['Halves', 8], ['Thirds', 12]] as const)(
        'a whole driven %s auction (sales, steals, immediate sales) never puts a team above %i and ends in Equipping when both are full (A81(1)(3))',
        (format, perTeam) => {
            const test = newHarness();
            const s = setupLobby(test, { lobby: { ...AUCTION, lineupFormat: { tag: format } } });
            const { lobbyId } = s;
            let immediate = 0;
            for (let i = 1; lobbyRow(test, lobbyId).stage.tag === 'Drafting'; i++) {
                expect(i).toBeLessThan(200);
                const ss = session(test, lobbyId);
                const nominator = ss.nextNominatorTeam.tag as Team;
                const other = otherTeam(nominator);
                const otherFull = (other === 'Blue' ? ss.blueCharactersWon : ss.redCharactersWon) >= perTeam;
                tx(test, captain(s, nominator), (ctx) => (priceCharacters(ctx, lobbyId, [`d${i}`]), M.nominate_character(ctx, { lobbyId, characterName: `d${i}` })));
                if (otherFull) {
                    immediate++;
                    expect(session(test, lobbyId).currentNomination).toBeUndefined();
                } else if (i % 3 === 1) {
                    // a steal: the other team raises, the nominator passes
                    const bidAmount = (session(test, lobbyId).currentBidAmount ?? 0) + 1; // read outside the tx
                    tx(test, captain(s, other), (ctx) => M.place_bid(ctx, { lobbyId, bidAmount }));
                    tx(test, captain(s, nominator), (ctx) => M.pass_bid(ctx, { lobbyId }));
                } else {
                    tx(test, captain(s, other), (ctx) => M.pass_bid(ctx, { lobbyId }));
                }
                const w = won(test, lobbyId);
                expect(w.Blue).toBeLessThanOrEqual(perTeam);
                expect(w.Red).toBeLessThanOrEqual(perTeam);
                if (draftDone(test, lobbyId)) advanceToEquipping(s); // T-S10t re-alignment (A129): the last step leaves the lobby in Drafting; the referee advances it.
            }
            expect(lobbyRow(test, lobbyId).stage.tag).toBe('Equipping');
            expect(won(test, lobbyId)).toEqual({ Blue: perTeam, Red: perTeam });
            expect(stepsOf(test, lobbyId, 'AuctionSold')).toHaveLength(2 * perTeam);
            expect(immediate).toBeGreaterThan(0); // the driven pattern reaches the one-team-full phase
        },
    );
});

const EMPTY_BAN_TEXT = 'EMPTY is not a character and cannot be banned.';
const NO_COST = (name: string) => `${name} has no cost in this lobby's cost set.`;

// ─── Builders ────────────────────────────────────────────────────────────────

const banBody = (s: Lobby, characterName: string) => (ctx: any) =>
    M.ban_character(ctx, { lobbyId: s.lobbyId, characterName });

// ════════════════════════════════════════════════════════════════════════════
// L32: ban names
// ════════════════════════════════════════════════════════════════════════════

describe('A122(7), L32: a ban names a real character of the lobby\'s pool; EMPTY is not a manual ban', () => {
    it('A122(7) L32: a manual EMPTY ban and a name without a cost row in the lobby\'s cost set are rejected; the turn stays', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { banMode: { tag: 'Four' } } });
        expectReject(test, captain(s, 'Blue'), banBody(s, 'EMPTY'), EMPTY_BAN_TEXT);
        expectReject(test, captain(s, 'Blue'), banBody(s, 'ghost'), NO_COST('ghost'));
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban')).toHaveLength(0);
    });

    it('A122(7) L32: a priced character is banned; the timer\'s empty ban is SKIP and a manual EMPTY pick still goes through', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { banMode: { tag: 'Four' } } });
        priceCharacters(test, s.lobbyId, ['kafka']);
        tx(test, captain(s, 'Blue'), banBody(s, 'kafka'));
        // Red's ban turn expires (autoRandomPick off): the SKIP sentinel, system actor.
        advance(test, TURN_MS);
        tx(test, s.host, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }));
        const bans = steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban').map((x) => (x.payload.value as any).characterName);
        expect(bans).toEqual(['kafka', 'SKIP']);
        expect(turnOf(s)).toMatchObject({ actionRequired: { tag: 'Pick' }, teamTurn: { tag: 'Blue' } });
        tx(test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'EMPTY', eidolon: 0 }));
        const pick = steps(test, s.lobbyId).find((x) => x.action.tag === 'Pick')!;
        expect((pick.payload.value as any).characterName).toBe('EMPTY');
    });
});

// ─── A45(2): Ban Restriction ──────────────────────────────────────────────────────────────────────────────

function seedRoles(test: Harness, roles: Record<string, 'Dps' | 'Support' | 'Sustain'>) {
    tx(test, 'internal', (ctx) => {
        for (const [name, role] of Object.entries(roles)) {
            ctx.db.HsrCharacter.insert({
                name, displayName: name, aliases: [], rarity: 5, path: { tag: 'Destruction' }, element: { tag: 'Ice' },
                role: { tag: role }, imageUrl: '', versionReleased: 1.0, treatAsVersion: 0, posX: 0, posY: 0, width: 0,
                createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
            } as any);
        }
    });
}

const ban = (s: Lobby, team: 'Blue' | 'Red', characterName: string) =>
    tx(s.test, captain(s, team), (ctx) => (priceBanNames(ctx, s.lobbyId, [characterName]), M.ban_character(ctx, { lobbyId: s.lobbyId, characterName }))); // T-S10r (A122(7), L32): a ban names a priced character
const pick = (s: Lobby, team: 'Blue' | 'Red', characterName: string) =>
    tx(s.test, captain(s, team), (ctx) => (priceCharacters(ctx, s.lobbyId, [characterName]), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 })));

describe('A45(2): Ban Restriction', () => {
    it('Max 1 DPS rejects a second DPS ban by the same team; another role and the other team are unaffected', () => {
        const test = newHarness();
        seedRoles(test, { dps1: 'Dps', dps2: 'Dps', dps3: 'Dps', sup1: 'Support' });
        const s = setupLobby(test, { lobby: { banMode: { tag: 'Four' }, banRestriction: { tag: 'MaxOneDps' } } });
        expect(lobbyRow(test, s.lobbyId).banRestriction.tag).toBe('MaxOneDps');

        ban(s, 'Blue', 'dps1');
        ban(s, 'Red', 'dps2'); // Red's first DPS ban: allowed
        pick(s, 'Blue', 'p1');
        pick(s, 'Red', 'p2');
        pick(s, 'Red', 'p3');
        pick(s, 'Blue', 'p4');
        ban(s, 'Red', 'sup1');
        expect(session(test, s.lobbyId).draftSequence[session(test, s.lobbyId).turnIndex].teamTurn.tag).toBe('Blue');
        expectReject(test, captain(s, 'Blue'), (ctx) =>
            (priceBanNames(ctx, s.lobbyId, ['dps3']), M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'dps3' })), /at most one DPS/); // T-S10r (A122(7), L32): a ban names a priced character
        ban(s, 'Blue', 'unknown-name'); // no HsrCharacter row → no role → legal
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban')).toHaveLength(4);
    });

    it('the timer-expiry auto-ban (autoRandomPick) only draws characters the acting team may still ban', () => {
        const test = newHarness();
        seedRoles(test, { dpsA: 'Dps', dpsB: 'Dps', sup1: 'Support' });
        // Ban pool = the default set's Classic MoC cost rows: dpsA, dpsB, sup1.
        tx(test, 'internal', (ctx) => {
            for (const characterName of ['dpsA', 'dpsB', 'sup1']) {
                ctx.db.HsrCharacterCost.insert({
                    characterName, gameMode: { tag: 'MemoryOfChaos' }, draftMode: { tag: 'Classic' },
                    costs: { e0: 1, e1: 1, e2: 1, e3: 1, e4: 1, e5: 1, e6: 1 }, costSetId: 0,
                    createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
                } as any);
            }
        });
        const s = setupLobby(test, {
            lobby: { banMode: { tag: 'Four' }, banRestriction: { tag: 'MaxOneDps' }, autoRandomPick: true },
            // autoRandomPick requires every player to field an account with characters (D-43b).
            // T-S10i fix pass (review F2): the set-0 coverage rows leave the ban pool once the lobby exists.
            beforeStart: (l) => { dropDefaultCostCoverage(test); tx(test, 'internal', (ctx) => {
                for (const name of ['b1', 'b2', 'r1', 'r2']) {
                    const acct = ctx.db.HsrAccount.insert({
                        id: 0, userId: l.a[name].userId, uid: '600000000', region: 'America', displayLabel: name,
                        isActive: true, isRosterPublic: false, isRatingPublic: false, isDuplicateUid: false, accountRating: 0,
                        createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
                    });
                    ctx.db.HsrAccountCharacter.insert({
                        hsrAccountId: acct.id, characterName: 'sup1', eidolonLevel: 0,
                        createdById: 0, createdDate: ctx.timestamp, lastModifiedById: 0, lastModifiedDate: ctx.timestamp,
                    } as any);
                    ctx.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: l.a[name].userId, hsrAccountId: acct.id });
                }
            }); },
        });
        ban(s, 'Blue', 'dpsA');
        ban(s, 'Red', 'x');
        pick(s, 'Blue', 'p1');
        pick(s, 'Red', 'p2');
        pick(s, 'Red', 'p3');
        pick(s, 'Blue', 'p4');
        ban(s, 'Red', 'y');
        // Blue's second ban expires: dpsB is unbanned but illegal for Blue (Max 1 DPS), so only sup1 qualifies.
        advance(test, 31_000);
        tx(test, s.a.b1, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }));
        const last = steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban').at(-1)!;
        expect(last.actorSlot.tag).toBe('Blue');
        expect(last.payload.tag === 'Ban' && last.payload.value.characterName).toBe('sup1');
    });
});
