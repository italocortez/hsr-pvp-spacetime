// Stats: character stats credit the side that owns the character (manual picks, timer picks, Auction sales, shapes,
//   concedes).
// Decisions: A110
// Contracts: docs/mmr/contract.md, docs/player-stats/contract.md
// From S10k (s10k-ownership-stats.test.ts).
//
// T-S10k: in-memory tests for DECISIONS.md A110 (character "played" stats follow ownership), which supersedes A82(2),
// A82(4) and A106 for the played stat. Spec: the A110 row and the "Phase S10k execution" notes of
// docs/{player-stats,match-results}/architecture.md. For a manual Classic pick, a Classic timer auto-pick and an Auction
// sale alike: the non-coach players of the owning side who own the character on any HSR account (selected or not) get
// "played"; no owner and one player: that player; no owner and two or more: nobody; faced and global rows unchanged;
// EMPTY / SKIP nothing; never the system user; ownership read at finalization. Ownership is written straight into the
// datastore (HsrAccount + HsrAccountCharacter through ownedAccount) outside any transaction, like the other builders.
// Everything runs through the module's reducers on the in-memory datastore and TestClock; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    priceBanNames,
    M,
    advance,
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
} from '../fixtures/harness';
import { blueNames, captain, completeDraft, draftClassic, finishGame, insertRoster, redNames } from '../fixtures/draft-and-scoring-builders';
import { seedElo } from '../fixtures/tournament-match-builders';
import { ownedAccount, rankedHook } from '../fixtures/ranked-game-builders';

type Team = 'Blue' | 'Red';
const TURN_MS = 30_000; // DEFAULT_LOBBY_ARGS.standardTurnSeconds
const SEATS_1V1: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['r1', 'RedPlayer']];

const byId = (x: number, y: number) => x - y;
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
const snap = (rows: unknown[]) => JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

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

function expireTurn(s: Lobby) {
    advance(s.test, TURN_MS);
    tx(s.test, s.host, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }));
}

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
