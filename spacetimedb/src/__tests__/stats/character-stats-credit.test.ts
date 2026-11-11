// Stats: Auction stats follow the winning team; a timer auto-pick credits by ownership; played stats on the
//   tournament path.
// Decisions: A82, A106, A110
// Contracts: docs/mmr/contract.md, docs/player-stats/contract.md
// From S10c, S10i, S10q (s10c-high-fixes.test.ts, s10i-draft-cost.test.ts, s10q-gap-coverage.test.ts).
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    lobbyRow,
    member,
    newHarness,
    priceBanNames,
    priceCharacterAt,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Harness,
    type Lobby,
    type SetupOpts,
} from '../fixtures/harness';
import {
    blueNames,
    captain,
    completeDraft,
    draftAuction,
    draftClassic,
    finishGame,
    insertRoster,
    redNames,
} from '../fixtures/draft-and-scoring-builders';
import { ownedAccount } from '../fixtures/ranked-game-builders';
import { AUCTION, stepsOf } from '../fixtures/draft-snapshot-helpers';
import {
    blueMate,
    expireTurn,
    key0,
    ladder,
    lastStepOf,
    nominateBody,
    passBody,
    payloadOf,
    withAccounts,
} from '../fixtures/cost-set-pricing-builders';
import { advanceStage } from '../fixtures/tournament-builders';
import {
    byKey,
    captainActor,
    draftGame,
    drain,
    duel,
    openMatchLobby,
    recordsOfLobby,
    validate,
} from '../fixtures/tournament-match-builders';
import { byId } from '../fixtures/guest-sign-in-builders';

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

const statRows = (test: Harness, name: string) =>
    [...test.db.PlayerCharacterStat.iter()].filter((r) => r.characterName === name);
/** Users with the played stat of `name` (matchesPlayed > 0), sorted. */
const playedBy = (test: Harness, name: string) => statRows(test, name).filter((r) => r.matchesPlayed > 0).map((r) => r.userId).sort(byId);
/** Users with the faced stat of `name` (timesFaced > 0), sorted. */
const facedBy = (test: Harness, name: string) => statRows(test, name).filter((r) => r.timesFaced > 0).map((r) => r.userId).sort(byId);
const charStat = (test: Harness, userId: number, name: string) =>
    [...test.db.PlayerCharacterStat.by_user.filter(userId)].find((r) => r.characterName === name);
const globalRows = (test: Harness, name: string) => [...test.db.GlobalCharacterStat.iter()].filter((r) => r.characterName === name);

/** The first Pick step of `team` in the lobby (its character name). */
const firstPickOf = (test: Harness, lobbyId: number, team: 'Blue' | 'Red') =>
    (steps(test, lobbyId)
        .filter((st) => st.action.tag === 'Pick' && st.actorSlot.tag === team)
        .sort((a, b) => a.sequence - b.sequence)[0].payload.value as any).characterName as string;

// ════════════════════════════════════════════════════════════════════════════
// Gap 1. A110 (S10k review N3 (a), (c), (e))
// ════════════════════════════════════════════════════════════════════════════

/** A casual 2v2 Classic MoC game drafted by hand (each pick by its captain), `beforeFinish`, then the host closes it for Blue. */
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
/** The non-captain Blue player of a standalone 2v2 lobby (by actor name). */
const blueMateName = (s: Lobby) => (captain(s, 'Blue').userId === s.a.b1.userId ? 'b2' : 'b1');

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
