// Stats: character stats credit the side that owns the character (manual picks, timer picks, Auction sales, shapes,
//   concedes); Auction stats follow the winning team; played stats on the tournament path.
// Decisions: A82, A106, A110
// Contracts: docs/mmr/contract.md, docs/player-stats/contract.md
// From S10c, S10i, S10k, S10q (s10c-high-fixes.test.ts, s10i-draft-cost.test.ts, s10k-ownership-stats.test.ts,
// s10q-gap-coverage.test.ts); merged by T-REORG2.
//
// T-S10k: in-memory tests for DECISIONS.md A110 (character "played" stats follow ownership), which supersedes A82(2),
// A82(4) and A106 for the played stat. Spec: the A110 row and the "Phase S10k execution" notes of
// docs/{player-stats,match-results}/architecture.md. For a manual Classic pick, a Classic timer auto-pick and an Auction
// sale alike: the non-coach players of the owning side who own the character on any HSR account (selected or not) get
// "played"; no owner and one player: that player; no owner and two or more: nobody; faced and global rows unchanged;
// EMPTY / SKIP nothing; never the system user; ownership read at finalization. Ownership is written straight into the
// datastore (HsrAccount + HsrAccountCharacter through ownedAccount) outside any transaction, like the other builders.
// Everything runs through the module's reducers on the in-memory datastore and TestClock; nothing reaches maincloud.
//
// Titles starting "pins current behaviour (row silent)": the decision row says nothing about the case, so the test
// records today's behaviour rather than a rule; the owner accepted these pins (A145). A later decision on the case
// replaces the pin with a rule test.
import { describe, expect, it } from 'vitest';
import {
    priceBanNames,
    M,
    dropDefaultCostCoverage,
    lobbyRow,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    newHarness,
    type Harness,
    type Lobby,
    type SetupOpts,
    type Team,
    byId,
    snap,
    DEFAULT_LOBBY_ARGS,
    advance,
    member,
    priceCharacterAt,
    AUCTION,
} from '../fixtures/harness';
import { ownedAccount } from '../fixtures/roster';
import { key0, ladder } from '../fixtures/cost-sets';
import {
    blueNames,
    captain,
    completeDraft,
    draftClassic,
    finishGame,
    insertRoster,
    redNames,
    expireTurn,
    draftAuction,
    stepsOf,
    blueMate,
    lastStepOf,
    nominateBody,
    passBody,
    payloadOf,
    withAccounts,
} from '../fixtures/draft-and-scoring';
import { advanceStage } from '../fixtures/tournaments';
import {
    seedElo,
    byKey,
    captainActor,
    draftGame,
    drain,
    duel,
    openMatchLobby,
    recordsOfLobby,
    validate,
} from '../fixtures/tournament-matches';
import { rankedHook } from '../fixtures/ranked';

const SEATS_1V1: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['r1', 'RedPlayer']];

const statRows = (test: Harness, name: string) =>
    [...test.db.PlayerCharacterStat.iter()].filter((r) => r.characterName === name);
const charStat = (test: Harness, userId: number, name: string) =>
    [...test.db.PlayerCharacterStat.by_user.filter(userId)].find((r) => r.characterName === name);
/** Users with the played stat of `name` (matchesPlayed > 0), sorted. */
const playedBy = (test: Harness, name: string) => statRows(test, name).filter((r) => r.matchesPlayed > 0).map((r) => r.userId).sort(byId);
/** Users with the faced stat of `name` (timesFaced > 0), sorted. */
const facedBy = (test: Harness, name: string) => statRows(test, name).filter((r) => r.timesFaced > 0).map((r) => r.userId).sort(byId);
const globalRows = (test: Harness, name: string) =>
    [...test.db.GlobalCharacterStat.iter()].filter((r) => r.characterName === name);
const ids = (s: Lobby, ...names: string[]) => names.map((n) => s.a[n].userId).sort(byId);

/** A110(1): an extra HSR account of `who` owning `chars`, never selected for any lobby. */
const own = (s: Lobby, who: string, chars: string[]) => ownedAccount(s.test, s.a[who].userId, `own-${who}-${chars.join('-')}`, chars);

/** The non-captain Blue player of a 2v2 lobby (by actor name). */
const blueMateName = (s: Lobby) => (captain(s, 'Blue').userId === s.a.b1.userId ? 'b2' : 'b1');
const blueCapName = (s: Lobby) => (blueMateName(s) === 'b1' ? 'b2' : 'b1');

/** Faced rows of `name` for every player of the other side, the global row once with the owning side's win flag. */
function expectFacedAndGlobal(s: Lobby, name: string, otherSide: string[], ownerWon: boolean) {
    expect(facedBy(s.test, name)).toEqual(ids(s, ...otherSide));
    for (const n of otherSide) {
        expect(charStat(s.test, s.a[n].userId, name)).toMatchObject({ timesFaced: 1, winsAgainst: ownerWon ? 0 : 1, lossesAgainst: ownerWon ? 1 : 0 });
    }
    const g = globalRows(s.test, name);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ timesPicked: 1, wins: ownerWon ? 1 : 0, losses: ownerWon ? 0 : 1 });
}

/** A casual Classic MoC game drafted by hand (each pick by its captain), `beforeFinish` then the host closes it for Blue. */
function classicGame(opts: SetupOpts, beforeFinish: (s: Lobby) => void = () => {}): Lobby {
    const test = newHarness();
    insertRoster(test, [...blueNames(), ...redNames()]);
    const s = setupLobby(test, opts);
    draftClassic(s, blueNames(), redNames());
    beforeFinish(s);
    finishGame(s, 'Blue');
    expect(test.db.MatchSessionHistory.count()).toBe(1n); // casual: finalized at the close
    return s;
}

/**
 * beforeStart for autoRandomPick lobbies (start_draft needs every player to hold a selected account with characters):
 * each player seat selects a real account owning one unpriced filler `filler-<name>` (no pool ever draws it); the set-0
 * coverage rows leave the timer pools.
 */
const selectFillerAccounts = (test: Harness) => (l: Lobby) => {
    dropDefaultCostCoverage(test);
    for (const [name, who] of Object.entries(l.a)) {
        const m = [...test.db.LobbyMember.by_lobby_and_user.filter([l.lobbyId, who.userId])][0];
        if (!m || (m.lobbySlot.tag !== 'BluePlayer' && m.lobbySlot.tag !== 'RedPlayer')) continue;
        const id = ownedAccount(test, who.userId, `sel-${name}`, [`filler-${name}`]);
        test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: who.userId, hsrAccountId: id });
    }
};

const lastStep = (test: Harness, lobbyId: number, action: string) =>
    steps(test, lobbyId).filter((st) => st.action.tag === action).sort((a, b) => b.sequence - a.sequence)[0];

/** A casual 2v2 Classic game whose first Blue pick is the timer's auto-pick of `solo` (the only priced name then). */
function timerPickGame(owned: Record<string, string[]>): Lobby {
    const test = newHarness();
    const s = setupLobby(test, { lobby: { autoRandomPick: true }, beforeStart: selectFillerAccounts(test) });
    const step = session(test, s.lobbyId).draftSequence[session(test, s.lobbyId).turnIndex];
    expect([step.actionRequired.tag, step.teamTurn.tag]).toEqual(['Pick', 'Blue']);
    priceCharacters(test, s.lobbyId, ['solo']);
    expireTurn(s);
    expect(lastStep(test, s.lobbyId, 'Pick')).toMatchObject({ actorUserId: 0, actorSlot: { tag: 'Blue' } });
    expect(lastStep(test, s.lobbyId, 'Pick').payload.value).toMatchObject({ characterName: 'solo' });
    completeDraft(s);
    for (const [who, chars] of Object.entries(owned)) own(s, who, chars);
    finishGame(s, 'Blue');
    return s;
}

/** A casual 2v2 Auction game whose first sale (`sold`, nominated by Blue, passed by Red) goes to Blue. */
function auctionSaleGame(owned: Record<string, string[]>): Lobby {
    const test = newHarness();
    const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' } } });
    expect(session(test, s.lobbyId).nextNominatorTeam.tag).toBe('Blue');
    priceCharacters(test, s.lobbyId, ['sold'], 1);
    tx(test, captain(s, 'Blue'), (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'sold' }));
    tx(test, captain(s, 'Red'), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
    expect(lastStep(test, s.lobbyId, 'AuctionSold').payload.value).toMatchObject({ characterName: 'sold', winningTeam: { tag: 'Blue' } });
    completeDraft(s);
    for (const [who, chars] of Object.entries(owned)) own(s, who, chars);
    finishGame(s, 'Blue');
    return s;
}

// ════════════════════════════════════════════════════════════════════════════
// Manual Classic pick
// ════════════════════════════════════════════════════════════════════════════

describe('A110: a manual Classic pick credits by ownership', () => {
    it('1v1, the player owns the character: credited with the win; Red has it as faced; one global row (A110(1)(4))', () => {
        const s = classicGame({ seats: SEATS_1V1 }, (l) => own(l, 'b1', ['blue-1']));
        expect(playedBy(s.test, 'blue-1')).toEqual(ids(s, 'b1'));
        expect(charStat(s.test, s.a.b1.userId, 'blue-1')).toMatchObject({ matchesPlayed: 1, wins: 1, losses: 0, timesFaced: 0 });
        expectFacedAndGlobal(s, 'blue-1', ['r1'], true);
    });

    it('1v1, a guest with no roster at all: still credited, the side has one player (A110(2))', () => {
        const s = classicGame({ seats: SEATS_1V1 });
        expect([...s.test.db.HsrAccount.user_id.filter(s.a.b1.userId)]).toHaveLength(0);
        expect([...s.test.db.HsrAccount.user_id.filter(s.a.r1.userId)]).toHaveLength(0);
        expect(playedBy(s.test, 'blue-1')).toEqual(ids(s, 'b1'));
        expect(charStat(s.test, s.a.b1.userId, 'blue-1')).toMatchObject({ matchesPlayed: 1, wins: 1 });
        expect(playedBy(s.test, 'red-1')).toEqual(ids(s, 'r1'));
        expect(charStat(s.test, s.a.r1.userId, 'red-1')).toMatchObject({ matchesPlayed: 1, wins: 0, losses: 1 });
        expectFacedAndGlobal(s, 'blue-1', ['r1'], true);
    });

    it('2v2, the captain picks a character only the teammate owns: the teammate is credited, the captain is not (A110(1))', () => {
        let mate = '';
        let cap = '';
        const s = classicGame({}, (l) => {
            mate = blueMateName(l);
            cap = blueCapName(l);
            own(l, mate, ['blue-1']);
        });
        expect(playedBy(s.test, 'blue-1')).toEqual(ids(s, mate));
        expect(charStat(s.test, s.a[mate].userId, 'blue-1')).toMatchObject({ matchesPlayed: 1, wins: 1, losses: 0 });
        expect(charStat(s.test, s.a[cap].userId, 'blue-1')).toBeUndefined();
        expectFacedAndGlobal(s, 'blue-1', ['r1', 'r2'], true);
    });

    it('2v2, both Blue players own it: both credited (A110(1))', () => {
        const s = classicGame({}, (l) => {
            own(l, 'b1', ['blue-1']);
            own(l, 'b2', ['blue-1']);
        });
        expect(playedBy(s.test, 'blue-1')).toEqual(ids(s, 'b1', 'b2'));
        for (const n of ['b1', 'b2']) expect(charStat(s.test, s.a[n].userId, 'blue-1')).toMatchObject({ matchesPlayed: 1, wins: 1 });
        expectFacedAndGlobal(s, 'blue-1', ['r1', 'r2'], true);
    });

    it('2v2, neither owns it: nobody credited; the faced rows and the global row are still written (A110(3)(4))', () => {
        const s = classicGame({}, (l) => own(l, 'b1', ['blue-2'])); // b1 owns something else
        expect(playedBy(s.test, 'blue-1')).toEqual([]);
        for (const n of ['b1', 'b2']) expect(charStat(s.test, s.a[n].userId, 'blue-1')).toBeUndefined();
        expectFacedAndGlobal(s, 'blue-1', ['r1', 'r2'], true);
        // Red side, nobody owns anything either: no played row for any Red pick, Blue still has them as faced.
        expect(playedBy(s.test, 'red-1')).toEqual([]);
        expectFacedAndGlobal(s, 'red-1', ['b1', 'b2'], false);
    });

    it('ownership on an account that was NOT selected for the match counts (A110(1))', () => {
        let mate = '';
        let unselectedId = 0;
        const s = classicGame({}, (l) => {
            mate = blueMateName(l);
            const userId = l.a[mate].userId;
            // The teammate plays on a selected account without blue-1 and owns blue-1 on another one.
            const selectedId = ownedAccount(l.test, userId, `sel-${mate}`, ['something-else']);
            l.test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId, hsrAccountId: selectedId });
            unselectedId = own(l, mate, ['blue-1']);
            const selected = [...l.test.db.LobbyMemberAccount.by_lobby_and_user.filter([l.lobbyId, userId])].map((r) => r.hsrAccountId);
            expect(selected).toContain(selectedId);
            expect(selected).not.toContain(unselectedId);
        });
        expect(unselectedId).toBeGreaterThan(0);
        expect(playedBy(s.test, 'blue-1')).toEqual(ids(s, mate));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Classic timer auto-pick and Auction sale
// ════════════════════════════════════════════════════════════════════════════

describe('A110: a Classic timer auto-pick (actor 0) credits the acting side by ownership', () => {
    it('one owner (b2): only b2 credited with Blue\'s win; Red faced; one global row; no row for user 0 (A110(1)(4))', () => {
        const s = timerPickGame({ b2: ['solo'] });
        expect(playedBy(s.test, 'solo')).toEqual(ids(s, 'b2'));
        expect(charStat(s.test, s.a.b2.userId, 'solo')).toMatchObject({ matchesPlayed: 1, wins: 1, losses: 0 });
        expect(charStat(s.test, s.a.b1.userId, 'solo')).toBeUndefined();
        expectFacedAndGlobal(s, 'solo', ['r1', 'r2'], true);
        expect([...s.test.db.PlayerCharacterStat.by_user.filter(0)]).toHaveLength(0);
    });

    it('both own it: both credited (A110(1))', () => {
        const s = timerPickGame({ b1: ['solo'], b2: ['solo'] });
        expect(playedBy(s.test, 'solo')).toEqual(ids(s, 'b1', 'b2'));
        expectFacedAndGlobal(s, 'solo', ['r1', 'r2'], true);
    });

    it('nobody owns it: nobody credited; faced and global still written (A110(3)(4))', () => {
        const s = timerPickGame({ r1: ['solo'] }); // an owner on the other side does not count
        expect(playedBy(s.test, 'solo')).toEqual([]);
        expectFacedAndGlobal(s, 'solo', ['r1', 'r2'], true);
    });
});

describe('A110: an Auction sale credits the winning team by ownership', () => {
    it('one owner (b1): only b1 credited with Blue\'s win; Red faced; one global row (A110(1)(4))', () => {
        const s = auctionSaleGame({ b1: ['sold'] });
        expect(playedBy(s.test, 'sold')).toEqual(ids(s, 'b1'));
        expect(charStat(s.test, s.a.b1.userId, 'sold')).toMatchObject({ matchesPlayed: 1, wins: 1 });
        expectFacedAndGlobal(s, 'sold', ['r1', 'r2'], true);
    });

    it('both own it: both credited (A110(1))', () => {
        const s = auctionSaleGame({ b1: ['sold'], b2: ['sold'] });
        expect(playedBy(s.test, 'sold')).toEqual(ids(s, 'b1', 'b2'));
        expectFacedAndGlobal(s, 'sold', ['r1', 'r2'], true);
    });

    it('nobody owns it: nobody credited; faced and global still written (A110(3)(4))', () => {
        const s = auctionSaleGame({});
        expect(playedBy(s.test, 'sold')).toEqual([]);
        expectFacedAndGlobal(s, 'sold', ['r1', 'r2'], true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Team shapes, coaches, the system user, sentinels
// ════════════════════════════════════════════════════════════════════════════

describe('A110: team shapes, coaches, the system user and the sentinels', () => {
    it('3v3 with one owner: only that player is credited; a pick nobody owns credits none of the three (A110(1)(3))', () => {
        const seats: SetupOpts['seats'] = [
            ['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['b3', 'BluePlayer'],
            ['r1', 'RedPlayer'], ['r2', 'RedPlayer'], ['r3', 'RedPlayer'],
        ];
        const s = classicGame({ lobby: { teamSize: 3 }, seats }, (l) => own(l, 'b3', ['blue-1']));
        expect(playedBy(s.test, 'blue-1')).toEqual(ids(s, 'b3'));
        expectFacedAndGlobal(s, 'blue-1', ['r1', 'r2', 'r3'], true);
        expect(playedBy(s.test, 'blue-2')).toEqual([]);
        expectFacedAndGlobal(s, 'blue-2', ['r1', 'r2', 'r3'], true);
    });

    it('a coach who owns the character is never credited: 2v2 with only the coach owning it credits nobody; 1v1 with a coach owner credits the lone player (A110(1)(2)(3))', () => {
        const twoVTwo = classicGame(
            { seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] },
            (l) => own(l, 'bc', ['blue-1']),
        );
        expect(playedBy(twoVTwo.test, 'blue-1')).toEqual([]);
        expect(charStat(twoVTwo.test, twoVTwo.a.bc.userId, 'blue-1')).toBeUndefined();
        expectFacedAndGlobal(twoVTwo, 'blue-1', ['r1', 'r2'], true);

        const oneVOne = classicGame(
            { seats: [['b1', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer']] },
            (l) => own(l, 'bc', ['blue-1']),
        );
        expect(playedBy(oneVOne.test, 'blue-1')).toEqual(ids(oneVOne, 'b1'));
        expect([...oneVOne.test.db.PlayerCharacterStat.by_user.filter(oneVOne.a.bc.userId)]).toHaveLength(0);
    });

    it('the system user never gets a row; a timer EMPTY pick and a timer SKIP ban write nothing, even with an "owner" of those names (A110(4))', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { autoRandomPick: true, banMode: { tag: 'Four' } }, beforeStart: selectFillerAccounts(test) });
        expireTurn(s); // Blue ban, nothing priced → SKIP
        expect(lastStep(test, s.lobbyId, 'Ban').payload.value).toMatchObject({ characterName: 'SKIP' });
        tx(test, captain(s, 'Red'), (ctx) => (priceBanNames(ctx, s.lobbyId, ['red-ban']), M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'red-ban' }))); // T-S10r (A122(7), L32): a ban names a priced character
        expireTurn(s); // Blue pick, nothing priced → EMPTY
        expect(lastStep(test, s.lobbyId, 'Pick')).toMatchObject({ actorUserId: 0 });
        expect(lastStep(test, s.lobbyId, 'Pick').payload.value).toMatchObject({ characterName: 'EMPTY' });
        completeDraft(s);
        own(s, 'b1', ['EMPTY', 'SKIP']);
        finishGame(s, 'Blue');
        expect(test.db.MatchSessionHistory.count()).toBe(1n);
        for (const sentinel of ['EMPTY', 'SKIP']) {
            expect(statRows(test, sentinel)).toHaveLength(0);
            expect(globalRows(test, sentinel)).toHaveLength(0);
        }
        const systemUser = test.db.User.username.find('SYSTEM')!;
        expect(systemUser).toBeTruthy();
        for (const userId of [0, systemUser.id]) expect([...test.db.PlayerCharacterStat.by_user.filter(userId)]).toHaveLength(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// requireOwnership, concede flags, finalization-time read
// ════════════════════════════════════════════════════════════════════════════

describe('A110: requireOwnership, concedes and the finalization-time read', () => {
    it('a requireOwnership lobby behaves the same way: every pick has an owner (the captain), the owning teammate shares it, the non-owner does not (A110(1))', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        const s = setupLobby(test, { lobby: { requireOwnership: true } });
        // Engineered after start_draft (the captains are known then): each captain plays on a selected account owning
        // the side's names; the Blue teammate owns blue-1 on an unselected account; the Red teammate owns nothing.
        for (const team of ['Blue', 'Red'] as Team[]) {
            const cap = captain(s, team);
            const names = team === 'Blue' ? blueNames() : redNames();
            const id = ownedAccount(test, cap.userId, `sel-${team}`, names);
            test.db.LobbyMemberAccount.insert({ lobbyId: s.lobbyId, userId: cap.userId, hsrAccountId: id });
        }
        const capName = blueCapName(s);
        const mateName = blueMateName(s);
        const redCap = captain(s, 'Red').userId;
        own(s, mateName, ['blue-1']);
        draftClassic(s, blueNames(), redNames());
        finishGame(s, 'Blue');
        expect(playedBy(test, 'blue-1')).toEqual(ids(s, capName, mateName));
        for (const name of blueNames().slice(1)) expect(playedBy(test, name)).toEqual(ids(s, capName));
        for (const name of redNames()) expect(playedBy(test, name)).toEqual([redCap]);
        for (const name of [...blueNames(), ...redNames()]) expect(playedBy(test, name).length).toBeGreaterThan(0);
    });

    /** A Ranked Classic lobby (EloConfig seeded) the host referee concedes for Red at `stage`, `beforeConcede` first. */
    function rankedConcede(stage: 'Drafting' | 'Equipping', beforeConcede: (s: Lobby) => void, ranked = true): Lobby {
        const test = newHarness();
        seedElo(test);
        insertRoster(test, [...blueNames(), ...redNames()]);
        const s = setupLobby(test, { beforeStart: ranked ? rankedHook(test) : undefined });
        if (stage === 'Equipping') {
            draftClassic(s, blueNames(), redNames());
        } else {
            priceCharacters(test, s.lobbyId, ['blue-1']);
            tx(test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'blue-1', eidolon: 0 }));
        }
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe(stage);
        beforeConcede(s);
        tx(test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 2 }));
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy(); // non-tournament concede: finalized inline
        return s;
    }

    it('a Ranked concede at Equipping (character stats on) credits by ownership, like a played game (A110(1)(3)(4))', () => {
        const s = rankedConcede('Equipping', (l) => own(l, 'b2', ['blue-1']));
        expect(playedBy(s.test, 'blue-1')).toEqual(ids(s, 'b2'));
        expect(charStat(s.test, s.a.b2.userId, 'blue-1')).toMatchObject({ matchesPlayed: 1, wins: 1 });
        expectFacedAndGlobal(s, 'blue-1', ['r1', 'r2'], true);
        expect(playedBy(s.test, 'blue-2')).toEqual([]);
        expectFacedAndGlobal(s, 'blue-2', ['r1', 'r2'], true);
    });

    it('a Ranked concede in Drafting and a casual concede at Equipping (character stats off) write no character row at all, owners or not', () => {
        for (const s of [
            rankedConcede('Drafting', (l) => own(l, 'b1', ['blue-1'])),
            rankedConcede('Equipping', (l) => { own(l, 'b1', ['blue-1']); own(l, 'b2', ['blue-1']); }, false),
        ]) {
            expect([...s.test.db.PlayerCharacterStat.iter()]).toHaveLength(0);
            expect([...s.test.db.GlobalCharacterStat.iter()]).toHaveLength(0);
        }
    });

    it('ownership changed after finalization does not alter the stored rows; the next match reads the new ownership (A110(5))', () => {
        let mate = '';
        const s = classicGame({}, (l) => {
            mate = blueMateName(l);
            own(l, mate, ['blue-1']);
        });
        const { test } = s;
        const before = snap([...test.db.PlayerCharacterStat.iter()].sort((a, b) => a.userId - b.userId || a.characterName.localeCompare(b.characterName)));
        // The teammate's accounts lose blue-1; the captain gains it.
        for (const acct of [...test.db.HsrAccount.user_id.filter(s.a[mate].userId)]) {
            for (const row of [...test.db.HsrAccountCharacter.hsr_account_id.filter(acct.id)]) test.db.HsrAccountCharacter.delete(row);
        }
        const cap = mate === 'b1' ? 'b2' : 'b1';
        own(s, cap, ['blue-1']);
        expect(snap([...test.db.PlayerCharacterStat.iter()].sort((a, b) => a.userId - b.userId || a.characterName.localeCompare(b.characterName)))).toBe(before);

        // A second match with the same players reads the new ownership at its own finalization.
        const s2 = setupLobby(test, { actors: s.a });
        draftClassic(s2, blueNames(), redNames());
        finishGame(s2, 'Blue');
        expect(charStat(test, s.a[mate].userId, 'blue-1')).toMatchObject({ matchesPlayed: 1, wins: 1 });
        expect(charStat(test, s.a[cap].userId, 'blue-1')).toMatchObject({ matchesPlayed: 1, wins: 1 });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A82: Auction character stats follow the winning team
// ════════════════════════════════════════════════════════════════════════════

describe('A82: Auction character stats follow the sale\'s winning team', () => {
    const charStat = (test: Harness, userId: number, characterName: string) =>
        [...test.db.PlayerCharacterStat.by_user.filter(userId)].find((r) => r.characterName === characterName);
    const globalStat = (test: Harness, characterName: string) =>
        [...test.db.GlobalCharacterStat.iter()].filter((r) => r.characterName === characterName);

    // T-S10k re-alignment (A110 supersedes A82(2)(4) for the played stat): the played stat follows ownership on the
    // owning side (A82(1) still names that side); faced and global rows are unchanged (A82(3), A110(4)).
    it('1v1: Blue holds the bid, Red passes, Blue wins the game: Blue (the lone player, owner or not) has "played" with a win, Red "faced", the global stat one win (A82(1), A110(2))', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { ...AUCTION, teamSize: 1 }, seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer']] });
        expect(session(test, s.lobbyId).nextNominatorTeam.tag).toBe('Blue');
        tx(test, s.a.b1, (ctx) => (priceCharacters(ctx, s.lobbyId, ['x']), M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'x' })));
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

    it('2v2 with a timer-resolved sale: the Blue owner "played" (the non-owner not), both Red owners of red-1 "played", nobody for an unowned sale, every other-side player "faced", no stat row for user 0 (A82(1)(3), A110(1)(3)(4))', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: AUCTION });
        const blueCap = captain(s, 'Blue');
        tx(test, blueCap, (ctx) => (priceCharacters(ctx, s.lobbyId, ['y']), M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'y' })));
        advance(test, 30_000 + 1);
        tx(test, s.host, (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }));
        const sold = stepsOf(test, s.lobbyId, 'AuctionSold')[0];
        expect(sold.actorUserId).toBe(0);
        expect(sold.payload.value).toMatchObject({ characterName: 'y', winningTeam: { tag: 'Blue' } });
        draftAuction(s, blueNames(7), redNames(8));
        // A110(1): ownership on unselected accounts, read at finalization.
        ownedAccount(test, s.a.b1.userId, 'own-b1', ['y', 'blue-1']);
        ownedAccount(test, s.a.r1.userId, 'own-r1', ['red-1']);
        ownedAccount(test, s.a.r2.userId, 'own-r2', ['red-1']);
        finishGame(s, 'Blue');

        for (const name of ['y', 'blue-1']) {
            expect(charStat(test, s.a.b1.userId, name)).toMatchObject({ matchesPlayed: 1, wins: 1, timesFaced: 0 });
            expect(charStat(test, s.a.b2.userId, name)).toBeUndefined();
            for (const p of [s.a.r1, s.a.r2]) expect(charStat(test, p.userId, name)).toMatchObject({ matchesPlayed: 0, timesFaced: 1, lossesAgainst: 1 });
            expect(globalStat(test, name)).toHaveLength(1);
            expect(globalStat(test, name)[0]).toMatchObject({ timesPicked: 1, wins: 1, losses: 0 });
        }
        // blue-2: nobody of the two Blue players owns it, so nobody "played" (A110(3)); faced and global still written.
        for (const p of [s.a.b1, s.a.b2]) expect(charStat(test, p.userId, 'blue-2')).toBeUndefined();
        for (const p of [s.a.r1, s.a.r2]) expect(charStat(test, p.userId, 'blue-2')).toMatchObject({ timesFaced: 1, lossesAgainst: 1 });
        expect(globalStat(test, 'blue-2')).toHaveLength(1);
        for (const p of [s.a.b1, s.a.b2]) expect(charStat(test, p.userId, 'red-1')).toMatchObject({ matchesPlayed: 0, timesFaced: 1, winsAgainst: 1 });
        for (const p of [s.a.r1, s.a.r2]) expect(charStat(test, p.userId, 'red-1')).toMatchObject({ matchesPlayed: 1, losses: 1 });
        expect([...test.db.PlayerCharacterStat.by_user.filter(0)]).toHaveLength(0);
        expect(charStat(test, s.host.userId, 'y')).toBeUndefined(); // the spectator referee
    });

    it('Classic follows ownership too: a captain\'s pick of a character only the teammate owns credits the teammate, not the captain (A110(1), supersedes A82(4))', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        const s = setupLobby(test);
        const cap = captain(s, 'Blue');
        const mate = [s.a.b1, s.a.b2].find((a) => a.userId !== cap.userId)!;
        draftClassic(s, blueNames(), redNames());
        ownedAccount(test, mate.userId, 'own-mate', ['blue-1']);
        finishGame(s, 'Blue');
        expect(charStat(test, mate.userId, 'blue-1')).toMatchObject({ matchesPlayed: 1, wins: 1 });
        expect(charStat(test, cap.userId, 'blue-1')).toBeUndefined();
        for (const p of [s.a.r1, s.a.r2]) expect(charStat(test, p.userId, 'blue-1')).toMatchObject({ timesFaced: 1, lossesAgainst: 1 });
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

/** The first Pick step of `team` in the lobby (its character name). */
const firstPickOf = (test: Harness, lobbyId: number, team: 'Blue' | 'Red') =>
    (steps(test, lobbyId)
        .filter((st) => st.action.tag === 'Pick' && st.actorSlot.tag === team)
        .sort((a, b) => a.sequence - b.sequence)[0].payload.value as any).characterName as string;

// ════════════════════════════════════════════════════════════════════════════
// Gap 1. A110 (S10k review N3 (a), (c), (e))
// ════════════════════════════════════════════════════════════════════════════

/**
 * A 2-team tournament (Bo1 final) whose final lobby is drafted and closed for Blue, then validated when needed; the
 * lobby parks in AwaitingResult and nothing derived is written until the tournament completes (A24(4)). Returns the
 * Blue captain and mate of the lobby and the first character Blue picked.
 */
function tournamentGameParked() {
    const f = duel({ defaultBestOf: 1, grandFinalBestOf: 1 });
    const { test } = f;
    const m = byKey(test, f.id, 'W-R1-M1');
    const s = openMatchLobby(f, m.id);
    draftGame(s, 'q');
    const blueCap = captainActor(s, 'Blue');
    const blueMate = [s.a.b1, s.a.b2].find((a) => a.userId !== blueCap.userId)!;
    const reds = [s.a.r1, s.a.r2];
    const pick = firstPickOf(test, s.lobbyId, 'Blue');
    finishGame(s, 'Blue');
    expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
    if (recordsOfLobby(test, s.lobbyId)[0].status.tag !== 'Validated') validate(test, f.org, s.lobbyId);
    return { f, test, s, blueCap, blueMate, reds, pick };
}

describe('Gap 1, A110: played stats on the tournament path, with a deleted, abandoned or inactive-account player (S10k review N3)', () => {
    it('A110(1)(5), A115(5) (N3a): a tournament game writes no character stat until the tournament completes; at completion the played stat follows the ownership read then (an owner added after the game is credited, the picking captain is not)', () => {
        const { f, test, blueCap, blueMate, reds, pick } = tournamentGameParked();
        expect(statRows(test, pick)).toEqual([]); // deferred: nothing derived before Completed
        ownedAccount(test, blueMate.userId, 'late-owner', [pick]); // the owner gets the character after the game

        advanceStage(test, f.org, f.id, 'Completed');
        drain(test, f.id);

        expect(playedBy(test, pick)).toEqual([blueMate.userId]);
        expect(charStat(test, blueMate.userId, pick)).toMatchObject({ matchesPlayed: 1, wins: 1, losses: 0 });
        expect(charStat(test, blueCap.userId, pick)).toBeUndefined();
        expect(facedBy(test, pick)).toEqual(reds.map((r) => r.userId).sort(byId));
        expect(globalRows(test, pick)).toHaveLength(1);
    });

    it('pins current behaviour (row silent): A110(3) (N3c, review N2): on the tournament path, the only owner of a Blue pick is deleted before the tournament completes; at completion nobody is credited (the deleted player still counts as one of the side\'s two players and owns nothing any more); faced and global rows are written', () => {
        const { f, test, blueCap, blueMate, reds, pick } = tournamentGameParked();
        ownedAccount(test, blueMate.userId, 'doomed-owner', [pick]);
        const username = test.db.User.id.find(blueMate.userId)!.username;
        tx(test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));
        expect(test.db.User.id.find(blueMate.userId)).toBeFalsy();
        expect([...test.db.HsrAccount.user_id.filter(blueMate.userId)]).toEqual([]);

        advanceStage(test, f.org, f.id, 'Completed');
        drain(test, f.id);

        expect(playedBy(test, pick)).toEqual([]);
        expect(charStat(test, blueCap.userId, pick)).toBeUndefined();
        expect(facedBy(test, pick)).toEqual(reds.map((r) => r.userId).sort(byId));
        expect(globalRows(test, pick)).toHaveLength(1);
    });

    it('pins current behaviour (row silent): A110(1) (N3c): a Blue player who abandoned the match (left, then took another lobby with abandonCurrentMatch) and owns the pick is still credited at finalization; the picking captain is not', () => {
        let mate = '';
        const s = classicGame({}, (l) => {
            mate = blueMateName(l);
            ownedAccount(l.test, l.a[mate].userId, `own-${mate}`, ['blue-1']);
            tx(l.test, l.a[mate], (ctx) => M.leave_lobby(ctx, { lobbyId: l.lobbyId }));
            tx(l.test, l.a[mate], (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));
            expect(member(l.test, l.lobbyId, l.a[mate].userId)!.abandonedAt).toBeDefined();
        });
        const cap = mate === 'b1' ? 'b2' : 'b1';
        expect(playedBy(s.test, 'blue-1')).toEqual([s.a[mate].userId]);
        expect(charStat(s.test, s.a[mate].userId, 'blue-1')).toMatchObject({ matchesPlayed: 1, wins: 1 });
        expect(charStat(s.test, s.a[cap].userId, 'blue-1')).toBeUndefined();
    });

    it('A110(1) (N3e): ownership on an account with isActive = false counts ("any of their HSR accounts"): the owner is credited, the captain who picked is not', () => {
        let mate = '';
        let inactiveId = 0;
        const s = classicGame({}, (l) => {
            mate = blueMateName(l);
            inactiveId = ownedAccount(l.test, l.a[mate].userId, `inactive-${mate}`, ['blue-1'], false);
        });
        expect(s.test.db.HsrAccount.id.find(inactiveId)!.isActive).toBe(false);
        const cap = mate === 'b1' ? 'b2' : 'b1';
        expect(playedBy(s.test, 'blue-1')).toEqual([s.a[mate].userId]);
        expect(charStat(s.test, s.a[cap].userId, 'blue-1')).toBeUndefined();
    });
});
