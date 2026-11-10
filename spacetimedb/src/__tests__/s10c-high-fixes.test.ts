// T-S10c: in-memory tests for the S10c fixes of the 2026-11-09 backend closing audit. Draft slice findings 1-3 (input
// bounds of pick_character, equip_lightcone, place_bid), roster finding 1 (synergy names must be HsrCharacter rows,
// called "finding 9" in the step brief), and DECISIONS.md A81 (a full Auction team sits out), A82 (Auction character
// stats follow the winning team), A83 (the concede summary is staff-only), A84 (re-resolving a bracket match is refused
// while the next match is live) and A85 (lifting a disconnect auto-pause). The tests assert the decision rows and the
// audit scenarios; the code is not the reference. State is checked before the rejection text (`rejection()`).
// Builders in s4 / s7 / s8 / s8d / s10-c1 / s10-c2 fixtures; the clock is the TestClock; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import characterSeed from '../../../data/seed/characters.json';
import synergySeed from '../../../data/seed/synergies.json';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    connect,
    disconnect,
    fireCheck,
    guest,
    joinAsSpectator,
    lobbyRow,
    newHarness,
    pendingCheck,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SetupOpts,
} from './s4-fixtures';
import {
    blueNames,
    captain,
    draftAuction,
    draftClassic,
    finishGame,
    insertAuctionCost,
    insertCharacterCostLadder,
    insertRoster,
    redNames,
    selectAccount,
    setRole,
    side,
} from './s7-fixtures';
import { liveField, matchRow, resolveMatch } from './s8-fixtures';
import { byKey, openMatchLobby, playMatch, recordsOfLobby, recordsOfMatch, validate } from './s8d-fixtures';
import { bulkUpsert, costSetId, draftSyn, liveSyn, synergyRow } from './s10-c1-fixtures';
import { rejection, seedCharacters } from './s10-c2-fixtures';

type Team = 'Blue' | 'Red';
const otherTeam = (t: Team): Team => (t === 'Blue' ? 'Red' : 'Blue');
const AUCTION = { draftMode: { tag: 'Auction' } };

/** A JSON snapshot of rows (bigint-safe), to prove "nothing changed" across a rejected call. */
const snap = (...rows: unknown[]) => JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

const AUDIT = (test: Harness) => {
    const ts = test.clock.now();
    return { createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts };
};

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

const stepsOf = (test: Harness, lobbyId: number, action: string) =>
    steps(test, lobbyId).filter((st) => st.action.tag === action).sort((a, b) => a.sequence - b.sequence);

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
        const msg = rejection(test, cap, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'x', eidolon: 7 }));
        expect(steps(test, s.lobbyId)).toHaveLength(steps0);
        expect(session(test, s.lobbyId).turnIndex).toBe(turn0);
        expect(msg).toBe('eidolon must be between 0 and 6.');

        tx(test, cap, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'x', eidolon: 6 }));
        const [pick] = stepsOf(test, s.lobbyId, 'Pick');
        expect(pick.payload.value).toMatchObject({ characterName: 'x', eidolon: 6, costPaid: 16 });
        expect(session(test, s.lobbyId).turnIndex).toBe(turn0 + 1);
    });

    it('requireOwnership: the argument is ignored, so eidolon 7 is accepted and the owned level (E3) is used and priced (finding 1, CH-S6)', () => {
        const { test, s, cap } = classicLobby({ lobby: { requireOwnership: true } });
        selectAccount(test, s.lobbyId, cap.userId, 900, { x: 3 });
        tx(test, cap, (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'x', eidolon: 7 }));
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
        tx(test, captain(s, nominator), (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'x' }));
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
            tx(test, captain(s, 'Blue'), (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: `r${i}` }));
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
        const msg = rejection(test, captain(s, 'Red'), (ctx) => M.nominate_character(ctx, { lobbyId, characterName: 'extra' }));
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

        tx(test, captain(s, 'Blue'), (ctx) => M.nominate_character(ctx, { lobbyId, characterName: 'bx' }));
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
        const msg = rejection(test, captain(s, 'Blue'), (ctx) => M.nominate_character(ctx, { lobbyId, characterName: 'pricey' }));
        expect(snap(session(test, lobbyId), steps(test, lobbyId).length)).toBe(before);
        expect(msg).toBe('Not enough budget to nominate this character.');
    });

    it('Blue fills its remaining seats by immediate sales; the auction ends in Equipping with 8 + 8 (A81(2)(3))', () => {
        const s = redFull();
        const { test, lobbyId } = s;
        for (let i = 1; lobbyRow(test, lobbyId).stage.tag === 'Drafting' && i <= 20; i++) {
            tx(test, captain(s, 'Blue'), (ctx) => M.nominate_character(ctx, { lobbyId, characterName: `b${i}` }));
            const w = won(test, lobbyId);
            expect(w.Blue).toBeLessThanOrEqual(8);
            expect(w.Red).toBe(8);
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
                tx(test, captain(s, nominator), (ctx) => M.nominate_character(ctx, { lobbyId, characterName: `d${i}` }));
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
            }
            expect(lobbyRow(test, lobbyId).stage.tag).toBe('Equipping');
            expect(won(test, lobbyId)).toEqual({ Blue: perTeam, Red: perTeam });
            expect(stepsOf(test, lobbyId, 'AuctionSold')).toHaveLength(2 * perTeam);
            expect(immediate).toBeGreaterThan(0); // the driven pattern reaches the one-team-full phase
        },
    );
});

// ════════════════════════════════════════════════════════════════════════════
// A82: Auction character stats follow the winning team
// ════════════════════════════════════════════════════════════════════════════

describe('A82: Auction character stats follow the sale\'s winning team', () => {
    const charStat = (test: Harness, userId: number, characterName: string) =>
        [...test.db.PlayerCharacterStat.by_user.filter(userId)].find((r) => r.characterName === characterName);
    const globalStat = (test: Harness, characterName: string) =>
        [...test.db.GlobalCharacterStat.iter()].filter((r) => r.characterName === characterName);

    it('1v1: Blue holds the bid, Red passes, Blue wins the game: Blue has "played" with a win, Red "faced", the global stat one win (A82(1)(2))', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { ...AUCTION, teamSize: 1 }, seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer']] });
        expect(session(test, s.lobbyId).nextNominatorTeam.tag).toBe('Blue');
        tx(test, s.a.b1, (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'x' }));
        tx(test, s.a.r1, (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
        const sold = stepsOf(test, s.lobbyId, 'AuctionSold')[0];
        expect(sold.actorUserId).toBe(s.a.r1.userId); // the passer is the step's actor
        expect(sold.payload.value).toMatchObject({ characterName: 'x', winningTeam: { tag: 'Blue' } });
        draftAuction(s, blueNames(7), redNames(8));
        finishGame(s, 'Blue');

        expect(charStat(test, s.a.b1.userId, 'x')).toMatchObject({ matchesPlayed: 1, wins: 1, losses: 0, timesFaced: 0 });
        expect(charStat(test, s.a.r1.userId, 'x')).toMatchObject({ matchesPlayed: 0, wins: 0, timesFaced: 1, winsAgainst: 0, lossesAgainst: 1 });
        const g = globalStat(test, 'x');
        expect(g).toHaveLength(1);
        expect(g[0]).toMatchObject({ timesPicked: 1, matchesPlayed: 1, wins: 1, losses: 0 });
    });

    it('2v2 with a timer-resolved sale: every Blue player "played", every Red player "faced", no stat row for user 0 (A82(2)(3))', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: AUCTION });
        const blueCap = captain(s, 'Blue');
        tx(test, blueCap, (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'y' }));
        advance(test, 30_000 + 1);
        tx(test, s.host, (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }));
        const sold = stepsOf(test, s.lobbyId, 'AuctionSold')[0];
        expect(sold.actorUserId).toBe(0);
        expect(sold.payload.value).toMatchObject({ characterName: 'y', winningTeam: { tag: 'Blue' } });
        draftAuction(s, blueNames(7), redNames(8));
        finishGame(s, 'Blue');

        for (const name of ['y', 'blue-1']) {
            for (const p of [s.a.b1, s.a.b2]) expect(charStat(test, p.userId, name)).toMatchObject({ matchesPlayed: 1, wins: 1, timesFaced: 0 });
            for (const p of [s.a.r1, s.a.r2]) expect(charStat(test, p.userId, name)).toMatchObject({ matchesPlayed: 0, timesFaced: 1, lossesAgainst: 1 });
            expect(globalStat(test, name)).toHaveLength(1);
            expect(globalStat(test, name)[0]).toMatchObject({ timesPicked: 1, wins: 1, losses: 0 });
        }
        for (const p of [s.a.b1, s.a.b2]) expect(charStat(test, p.userId, 'red-1')).toMatchObject({ matchesPlayed: 0, timesFaced: 1, winsAgainst: 1 });
        for (const p of [s.a.r1, s.a.r2]) expect(charStat(test, p.userId, 'red-1')).toMatchObject({ matchesPlayed: 1, losses: 1 });
        expect([...test.db.PlayerCharacterStat.by_user.filter(0)]).toHaveLength(0);
        expect(charStat(test, s.host.userId, 'y')).toBeUndefined(); // the spectator referee
    });

    it('Classic is unchanged: a pick credits the picking captain only, not the teammate (A82(4))', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        const s = setupLobby(test);
        const cap = captain(s, 'Blue');
        const mate = [s.a.b1, s.a.b2].find((a) => a.userId !== cap.userId)!;
        draftClassic(s, blueNames(), redNames());
        finishGame(s, 'Blue');
        expect(charStat(test, cap.userId, 'blue-1')).toMatchObject({ matchesPlayed: 1, wins: 1 });
        expect(charStat(test, mate.userId, 'blue-1')).toBeUndefined();
        for (const p of [s.a.r1, s.a.r2]) expect(charStat(test, p.userId, 'blue-1')).toMatchObject({ timesFaced: 1, lossesAgainst: 1 });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A83: the concede summary is staff-only
// ════════════════════════════════════════════════════════════════════════════

describe('A83: view_my_match_result emits concedeSummary only to a Moderator or Admin', () => {
    const resultFor = (test: Harness, who: Actor, lobbyId: number) =>
        ((M as any).view_my_match_result(test.viewContext(who.auth), {}) as any[]).find((r) => r.lobbyId === lobbyId);

    it.each([false, true])('casual deferred, parked (isAnonymousPlayers %s): player and spectator get none; Moderator and Admin members get the text; the column keeps it (A83)', (anon) => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { disconnectPolicy: { tag: 'Deferred' }, isAnonymousPlayers: anon } });
        const spec = joinAsSpectator(s, 'spec');
        const mod = joinAsSpectator(s, 'modspec');
        const adm = joinAsSpectator(s, 'admspec');
        setRole(test, mod.userId, 'Moderator');
        setRole(test, adm.userId, 'Admin');
        tx(test, s.host, (ctx) => M.defer_match(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        const [stored] = recordsOfLobby(test, s.lobbyId);
        expect(stored.status.tag).toBe('Pending');
        expect(typeof stored.concedeSummary).toBe('string');
        expect(stored.concedeSummary!.length).toBeGreaterThan(0);

        for (const who of [s.a.b1, s.a.r2, spec, s.host]) {
            const row = resultFor(test, who, s.lobbyId);
            expect(row).toBeDefined();
            expect(row.concedeSummary).toBeUndefined();
        }
        for (const who of [mod, adm]) expect(resultFor(test, who, s.lobbyId).concedeSummary).toBe(stored.concedeSummary);
        expect(recordsOfLobby(test, s.lobbyId)[0].concedeSummary).toBe(stored.concedeSummary);
    });

    it('tournament concede, parked: players and the organizer (Tournament Host) get none; a member promoted to Moderator / Admin gets the text (A83)', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id);
        tx(f.test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 2 }));
        const { test } = f;
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        const [stored] = recordsOfLobby(test, s.lobbyId);
        expect(stored.matchEndReason?.tag).toBe('Concede');
        expect(stored.concedeSummary).toBeTruthy();

        for (const who of [s.a.b1, s.a.r1, s.a.r2, f.org]) expect(resultFor(test, who, s.lobbyId).concedeSummary).toBeUndefined();
        setRole(test, s.a.b2.userId, 'Moderator');
        setRole(test, s.a.r2.userId, 'Admin');
        expect(resultFor(test, s.a.b2, s.lobbyId).concedeSummary).toBe(stored.concedeSummary);
        expect(resultFor(test, s.a.r2, s.lobbyId).concedeSummary).toBe(stored.concedeSummary);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A84: re-resolving a bracket match is refused while the next match is live
// ════════════════════════════════════════════════════════════════════════════

describe('A84: resolve / rollback / override that would un-place a team from a live downstream match are refused', () => {
    const BO1 = { defaultBestOf: 1, grandFinalBestOf: 1 };
    type Field = ReturnType<typeof liveField>;

    /** 4 teams: semi m1 played (Blue wins, Validated record), semi m2 resolved by staff; the final has both teams. */
    function semisDecided(f: Field, validateM1 = false) {
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        const semi = playMatch(f, m1.id, 'Blue');
        if (validateM1) validate(f.test, f.org, semi.lobbyId);
        resolveMatch(f.test, f.org, m2.id, m2.team1Id!);
        expect(matchRow(f.test, m1.id).state.tag).toBe('Decided');
        expect(matchRow(f.test, final.id).team1Id).toBeDefined();
        expect(matchRow(f.test, final.id).team2Id).toBeDefined();
        const [semiRecord] = recordsOfLobby(f.test, semi.lobbyId);
        expect(semiRecord.status.tag).toBe('Validated');
        return { m1, m2, final, semiRecord };
    }

    const m1Slot = (f: Field, m1: any, finalId: number) => {
        const row = matchRow(f.test, finalId);
        return m1.nextWinnerSlot === 1 ? row.team1Id : row.team2Id;
    };

    /** Every un-placing call on the semi is rejected and leaves the semi, the final, its lobbies and its records as they were. */
    function expectAllRefused(f: Field, m1: any, finalId: number, semiRecordId: number) {
        const { test, org } = f;
        const state = () => snap(matchRow(test, m1.id), matchRow(test, finalId), recordsOfMatch(test, finalId), recordsOfMatch(test, m1.id),
            [...test.db.Lobby.bracket_match_id.filter(finalId)].map((l) => [l.id, l.stage.tag]));
        const before = state();
        const msgs = [
            rejection(test, org, (ctx) => M.resolve_bracket_match(ctx, { bracketMatchId: m1.id, winnerTeamId: m1.team2Id, reason: 'staff' })),
            rejection(test, org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m1.id, reason: 'replay' })),
            rejection(test, org, (ctx) => M.override_match_result(ctx, {
                matchResultId: semiRecordId, newStatusTag: 'Validated', winnerTeamSideTag: 'Red', reason: 'staff',
            })),
        ];
        expect(state()).toBe(before);
        const key = matchRow(test, finalId).positionKey;
        for (const msg of msgs) expect(msg).toBe(`${key} has a lobby or a game result; void or roll that match back first.`);
    }

    it('final Ready with a drafting lobby (Pending record): refused; after staff resolve + roll back the final, the re-resolve succeeds and the replacement team has zero games (A84; Voided does not block)', () => {
        const f = liveField(4, BO1);
        const { m1, final, semiRecord } = semisDecided(f);
        const live = openMatchLobby(f, final.id);
        expect(lobbyRow(f.test, live.lobbyId).stage.tag).toBe('Drafting');
        expect(recordsOfLobby(f.test, live.lobbyId)[0].status.tag).toBe('Pending');
        expectAllRefused(f, m1, final.id, semiRecord.id);
        expect(m1Slot(f, m1, final.id)).toBe(m1.team1Id);

        // The documented clearing path (docs/brackets/architecture.md, Phase S10c): resolve the final, then roll it back.
        resolveMatch(f.test, f.org, final.id, matchRow(f.test, final.id).team1Id!);
        tx(f.test, f.org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: final.id, reason: 'clear' }));
        expect(matchRow(f.test, final.id).state.tag).toBe('Ready');
        expect([...f.test.db.Lobby.bracket_match_id.filter(final.id)]).toHaveLength(0);
        expect(recordsOfMatch(f.test, final.id).map((r) => r.status.tag)).toEqual(['Voided']);

        resolveMatch(f.test, f.org, m1.id, m1.team2Id!);
        expect(matchRow(f.test, m1.id).winnerTeamId).toBe(m1.team2Id);
        expect(m1Slot(f, m1, final.id)).toBe(m1.team2Id);
        const after = matchRow(f.test, final.id);
        expect([after.team1Games, after.team2Games]).toEqual([0, 0]);
    });

    it('final Ready with a Submitted record (validation on): refused; after staff override it Rejected, the re-resolve succeeds with zero games (A84; Rejected does not block)', () => {
        const f = liveField(4, { ...BO1, requireResultValidation: true });
        const { m1, final, semiRecord } = semisDecided(f, true);
        const fin = playMatch(f, final.id, 'Blue');
        const [sub] = recordsOfLobby(f.test, fin.lobbyId);
        expect(sub.status.tag).toBe('Submitted');
        expect(matchRow(f.test, final.id).state.tag).toBe('Ready');
        expectAllRefused(f, m1, final.id, semiRecord.id);

        tx(f.test, f.org, (ctx) => M.override_match_result(ctx, { matchResultId: sub.id, newStatusTag: 'Rejected', winnerTeamSideTag: '', reason: 'clear' }));
        expect(f.test.db.MatchResultRecord.id.find(sub.id)!.status.tag).toBe('Rejected');

        resolveMatch(f.test, f.org, m1.id, m1.team2Id!);
        expect(m1Slot(f, m1, final.id)).toBe(m1.team2Id);
        const after = matchRow(f.test, final.id);
        expect([after.team1Games, after.team2Games]).toEqual([0, 0]);
        expect(f.test.db.MatchResultRecord.id.find(sub.id)!.status.tag).toBe('Rejected');
    });

    it('final Ready (Bo3) with one Validated game: refused, nothing changes (A84)', () => {
        const f = liveField(4, { defaultBestOf: 3, grandFinalBestOf: 3 });
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        resolveMatch(f.test, f.org, m1.id, m1.team1Id!);
        resolveMatch(f.test, f.org, m2.id, m2.team1Id!);
        const g1 = playMatch(f, final.id, 'Blue');
        expect(recordsOfLobby(f.test, g1.lobbyId)[0].status.tag).toBe('Validated');
        expect(matchRow(f.test, final.id).state.tag).toBe('Ready');
        const state = () => snap(matchRow(f.test, m1.id), matchRow(f.test, final.id), recordsOfMatch(f.test, final.id));
        const before = state();
        const msg = rejection(f.test, f.org, (ctx) => M.resolve_bracket_match(ctx, { bracketMatchId: m1.id, winnerTeamId: m1.team2Id!, reason: 'staff' }));
        const msg2 = rejection(f.test, f.org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m1.id, reason: 'replay' }));
        expect(state()).toBe(before);
        const key = matchRow(f.test, final.id).positionKey;
        expect(msg).toBe(`${key} has a lobby or a game result; void or roll that match back first.`);
        expect(msg2).toBe(`${key} has a lobby or a game result; void or roll that match back first.`);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A85: lifting a disconnect auto-pause
// ════════════════════════════════════════════════════════════════════════════

describe('A85: lifting a disconnect auto-pause', () => {
    const SEATS: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];
    const isPaused = (s: Lobby) => session(s.test, s.lobbyId).timerState.isPaused;
    const rejoin = (s: Lobby, who: Actor) => {
        connect(s.test, who);
        tx(s.test, who, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
    };
    /** `who` drops; the 15 s check fires. */
    const drop = (s: Lobby, who: Actor) => {
        disconnect(s.test, who);
        const row = pendingCheck(s.test, s.lobbyId, who.userId);
        advance(s.test, 15_000);
        fireCheck(s.test, row);
    };
    /** A 2v2 Classic draft (Blue coach bc, spectator spec, host = spectator referee) auto-paused by b2 dropping. */
    function autoPaused(): Lobby {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        joinAsSpectator(s, 'spec');
        drop(s, s.a.b2);
        expect(isPaused(s)).toBe(true);
        const pauses = stepsOf(test, s.lobbyId, 'Pause');
        expect(pauses).toHaveLength(1);
        expect(pauses[0].payload).toMatchObject({ tag: 'Pause', value: { isAutoPause: true } });
        return s;
    }

    it('join_lobby by a spectator, the coach and a Red player does not resume; the away Blue player\'s return does (A85(1))', () => {
        const s = autoPaused();
        for (const who of [s.a.spec, s.a.bc, s.a.r1]) {
            tx(s.test, who, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
            expect(isPaused(s)).toBe(true);
        }
        rejoin(s, s.a.b2);
        expect(isPaused(s)).toBe(false);
    });

    it('two seated players away: the first return does not resume, the second does (A85(1))', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        drop(s, s.a.b2);
        drop(s, s.a.r2);
        expect(isPaused(s)).toBe(true);
        expect(stepsOf(test, s.lobbyId, 'Pause')).toHaveLength(1);
        rejoin(s, s.a.b2);
        expect(isPaused(s)).toBe(true);
        rejoin(s, s.a.r2);
        expect(isPaused(s)).toBe(false);
    });

    it.each(['host', 'r1', 'b1'])('resume_draft on the auto-pause by %s (referee / seated Red / seated Blue) is accepted (A85(2))', (name) => {
        const s = autoPaused();
        tx(s.test, s.a[name], (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
        expect(isPaused(s)).toBe(false);
    });

    it.each(['bc', 'spec'])('resume_draft on the auto-pause by %s (coach / non-referee spectator) is rejected, the draft stays paused (A85(2))', (name) => {
        const s = autoPaused();
        const before = snap(session(s.test, s.lobbyId).timerState);
        const msg = rejection(s.test, s.a[name], (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
        expect(snap(session(s.test, s.lobbyId).timerState)).toBe(before);
        expect(isPaused(s)).toBe(true);
        expect(msg).toBe('Only the referee or a seated player can resume an auto-paused draft.');
    });

    /** A 2v2 Classic draft auto-paused by b2's Leave (away, A68(1)(2)); the 15 s check fires. */
    function autoPausedByLeave(): Lobby {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        tx(test, s.a.b2, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
        const row = pendingCheck(test, s.lobbyId, s.a.b2.userId);
        advance(test, 15_000);
        fireCheck(test, row);
        expect(isPaused(s)).toBe(true);
        expect(stepsOf(test, s.lobbyId, 'Pause')[0].payload).toMatchObject({ tag: 'Pause', value: { isAutoPause: true } });
        return s;
    }

    it.each(['away', 'abandoned'])('resume_draft on the auto-pause by a seated player whose row is %s is rejected, the draft stays paused; a present seated player resumes (A85(2))', (state) => {
        const s = autoPausedByLeave();
        if (state === 'abandoned') {
            tx(s.test, s.a.b2, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));
        }
        const row = [...s.test.db.LobbyMember.by_lobby_and_user.filter([s.lobbyId, s.a.b2.userId])][0];
        expect(row.leftAt).toBeDefined();
        if (state === 'abandoned') expect(row.abandonedAt).toBeDefined();
        else expect(row.abandonedAt).toBeUndefined();
        const before = snap(session(s.test, s.lobbyId).timerState);
        const msg = rejection(s.test, s.a.b2, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
        expect(snap(session(s.test, s.lobbyId).timerState)).toBe(before);
        expect(isPaused(s)).toBe(true);
        expect(msg).toBe('Only the referee or a seated player can resume an auto-paused draft.');
        tx(s.test, s.a.r1, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
        expect(isPaused(s)).toBe(false);
    });

    it('a manual pause keeps D-62: another seated player (teammate or opponent) is rejected with the old text; the pauser resumes (A85(2))', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        tx(test, s.a.b1, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        expect(isPaused(s)).toBe(true);
        for (const who of [s.a.r1, s.a.b2]) {
            const msg = rejection(test, who, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
            expect(isPaused(s)).toBe(true);
            expect(msg).toBe('Only the referee or the player who paused can resume the draft.');
        }
        tx(test, s.a.b1, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
        expect(isPaused(s)).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Roster finding 1 (brief "finding 9"): synergy names must be HsrCharacter rows
// ════════════════════════════════════════════════════════════════════════════

describe('audit roster finding 1: a synergy naming an unknown character is rejected', () => {
    it('admin_bulk_upsert(HsrSynergyCost) rejects a pair with an unknown name; no row is written (finding 9)', () => {
        const test = newHarness();
        seedCharacters(test, ['kafka']);
        const msg = rejection(test, 'internal', (ctx) => M.admin_bulk_upsert(ctx, {
            tableName: 'HsrSynergyCost', jsonData: JSON.stringify([synergyRow('kafka', 'trailblaizerharmony', 'Classic', 1)]),
        }));
        expect([...test.db.HsrSynergyCost.iter()]).toHaveLength(0);
        expect(msg).toBe('Character trailblaizerharmony not found.');
        // Both names known: accepted.
        seedCharacters(test, ['trailblazerharmony']);
        bulkUpsert(test, 'HsrSynergyCost', [synergyRow('kafka', 'trailblazerharmony', 'Classic', 1)]);
        expect([...test.db.HsrSynergyCost.iter()]).toHaveLength(1);
    });

    it('edit_draft_synergy_cost rejects an unknown name; no draft row is written (finding 9)', () => {
        const test = newHarness();
        seedCharacters(test, ['kafka']);
        tx(test, 'internal', (ctx) => M.create_cost_set(ctx, { name: 'syn', sourceSetId: 0, gameModeTag: 'MemoryOfChaos' }));
        const id = costSetId(test, 'syn');
        const edit = (targetName: string) => (ctx: any) => M.edit_draft_synergy_cost(ctx, {
            costSetId: id, sourceName: 'kafka', targetName, gameModeTag: 'MemoryOfChaos', draftModeTag: 'Classic', costModifier: 1,
        });
        const msg = rejection(test, 'internal', edit('nobody'));
        expect(draftSyn(test, id)).toHaveLength(0);
        expect(liveSyn(test, id)).toHaveLength(0);
        expect(msg).toBe('Character nobody not found.');
    });

    it('every name in data/seed/synergies.json exists in data/seed/characters.json (finding 9)', () => {
        const names = new Set((characterSeed as Array<{ name: string }>).map((c) => c.name));
        const unknown = (synergySeed as Array<{ source_name: string; target_name: string }>)
            .flatMap((p) => [p.source_name, p.target_name])
            .filter((n) => !names.has(n));
        expect(unknown).toEqual([]);
    });
});
