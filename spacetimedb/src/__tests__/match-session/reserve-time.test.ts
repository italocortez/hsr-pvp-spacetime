// Match session: reserve time in the draft clock, undo giving back reserve, late turn actions, the automatic pause
//   lifted by hand, the client formula for every viewer role, and a seeded model-based random walk.
// Decisions: A148, A149, A150, A151, A153, A154, A155
// Contracts: docs/match-session/contract.md (superseded lines listed in the S10aa hand-back)
// T-S10aa; the fix pass adds A153 (who resumes an automatic pause), A154 (a pause on a spent turn, pinned) and the
// review F4 cases (reserve above 0 under the system preset and in a tournament lobby, more walk configurations).
// T-S10ab adds A155 (a referee seated on the other team counts as a player) and Red as the paused team for A153.
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    connect,
    disconnect,
    draftDone,
    dropDefaultCostCoverage,
    expectReject,
    fireCheck,
    joinAsSpectator,
    lobbyRow,
    newHarness,
    pendingCheck,
    priceBanNames,
    priceCharacters,
    rejection,
    seatOf,
    session,
    setupLobby,
    snap,
    steps,
    tx,
    TURN_MS,
    type Actor,
    type Lobby,
    type SetupOpts,
    type Side,
} from '../fixtures/harness';
import { captain } from '../fixtures/draft-and-scoring';
import { verified } from '../fixtures/identity';
import { join, systemPreset } from '../fixtures/lobby';
import { liveField } from '../fixtures/tournaments';
import { byKey, createTournamentLobby, openMatchLobby, sidesOf } from '../fixtures/tournament-matches';

const NOT_EXPIRED = 'Turn timer has not yet expired.';
const PAUSED_TEAM_ONLY = 'Only the paused team or a referee can resume this pause.';
const TIME_UP = 'Time is up for this turn.';
const PAUSED = 'Draft is paused.';
const AWAY = 'You are away from this match. Return to it before acting.';
const RESERVE_MS = 20_000;
const SEATS: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];

// ─── Builders and readers ────────────────────────────────────────────────────

function reserveLobby(lobby: Record<string, unknown> = {}, opts: SetupOpts = {}): Lobby {
    return setupLobby(newHarness(), { ...opts, lobby: { reserveBankSeconds: RESERVE_MS / 1000, ...lobby } });
}

const timer = (s: Lobby) => session(s.test, s.lobbyId).timerState as any;
const reserves = (s: Lobby) => ({ Blue: timer(s).teamBlueReserveMs, Red: timer(s).teamRedReserveMs });
const nowMs = (s: Lobby) => s.test.clock.now().microsSinceUnixEpoch;
const lastStep = (s: Lobby) => steps(s.test, s.lobbyId).sort((a, b) => b.sequence - a.sequence)[0];

let nameCounter = 0;
const fresh = (prefix: string) => `${prefix}-${++nameCounter}`;

const pickBody = (s: Lobby, name = fresh('p')) => (ctx: any) =>
    (priceCharacters(ctx, s.lobbyId, [name]), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: name, eidolon: 0 }));
const banBody = (s: Lobby, name = fresh('b')) => (ctx: any) =>
    (priceBanNames(ctx, s.lobbyId, [name]), M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: name }));
const nominateBody = (s: Lobby, name = fresh('n')) => (ctx: any) =>
    (priceCharacters(ctx, s.lobbyId, [name]), M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: name }));
// The session is read before the transaction: reading test.db inside withReducerTx crashes the in-memory datastore.
const bidBody = (s: Lobby) => {
    const bidAmount = Math.fround((session(s.test, s.lobbyId).currentBidAmount ?? 0) + 1);
    return (ctx: any) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount });
};
const passBody = (s: Lobby) => (ctx: any) => M.pass_bid(ctx, { lobbyId: s.lobbyId });
const expireBody = (s: Lobby) => session(s.test, s.lobbyId).isAuctionPhase
    ? (ctx: any) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId })
    : (ctx: any) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId });
const pause = (s: Lobby, who: Actor = s.host) => tx(s.test, who, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
const resume = (s: Lobby, who: Actor = s.host) => tx(s.test, who, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
const undo = (s: Lobby) => tx(s.test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId }));

/**
 * The client formula (docs/match-session/architecture.md "Turn clock", S10aa), computed from what `viewer` receives in
 * view_my_match_session and view_my_lobby only. Written here independently of helpers/draft/turnClock.ts.
 */
function clientClock(s: Lobby, viewer: Actor = s.a.r1): { team: Side | null; turn: number; reserve: number } {
    const vctx = s.test.viewContext(viewer.auth);
    const sess = ((M as any).view_my_match_session(vctx, {}) as any[]).find((r) => r.lobbyId === s.lobbyId);
    const lob = ((M as any).view_my_lobby(vctx, {}) as any[]).find((r) => r.id === s.lobbyId);
    const perTeam = lob.lineupFormat.tag === 'Thirds' ? 12 : 8;
    const complete = lob.draftMode.tag === 'Classic'
        ? sess.turnIndex >= sess.draftSequence.length
        : sess.isAuctionPhase && sess.blueCharactersWon >= perTeam && sess.redCharactersWon >= perTeam;
    let team: Side | null = null;
    if (lob.stage.tag === 'Drafting' && !complete) {
        if (!sess.isAuctionPhase) team = sess.draftSequence[sess.turnIndex].teamTurn.tag;
        else if (sess.currentNomination !== undefined) team = sess.currentBidTeam.tag === 'Blue' ? 'Red' : 'Blue';
        else {
            const n = sess.nextNominatorTeam.tag as Side;
            const full = (n === 'Blue' ? sess.blueCharactersWon : sess.redCharactersWon) >= perTeam;
            team = full ? (n === 'Blue' ? 'Red' : 'Blue') : n;
        }
    }
    const ts = sess.timerState;
    const full = (complete ? lob.confirmWindowSeconds : lob.standardTurnSeconds) * 1000;
    const budget = ts.inReserve ? 0 : ts.accumulatedPauseMs > 0 ? ts.accumulatedPauseMs : full;
    const start = team === 'Blue' ? ts.teamBlueReserveMs : team === 'Red' ? ts.teamRedReserveMs : 0;
    const reserveAt = Math.max(0, start - ts.reserveUsedMs);
    const elapsed = ts.isPaused ? 0 : Number(s.test.clock.now().microsSinceUnixEpoch - ts.turnStartAt.microsSinceUnixEpoch) / 1000;
    return {
        team,
        turn: Math.max(0, budget - elapsed),
        reserve: Math.max(0, reserveAt - Math.max(0, elapsed - budget)),
    };
}

/** The running turn has `turn` ms of turn time and `reserve` ms of reserve left; the expiry opens exactly at the sum. */
function expectExpiresAfter(s: Lobby, turn: number, reserve: number) {
    expect(clientClock(s)).toMatchObject({ turn, reserve });
    advance(s.test, turn + reserve - 1);
    expectReject(s.test, s.host, expireBody(s), NOT_EXPIRED);
    advance(s.test, 1);
    expect(clientClock(s)).toMatchObject({ turn: 0, reserve: 0 });
    tx(s.test, s.host, expireBody(s));
}

// ════════════════════════════════════════════════════════════════════════════
// A148: reserve time
// ════════════════════════════════════════════════════════════════════════════

describe('A148: the reserve drains only after the turn time, per team, and is never refilled', () => {
    it('Classic picks: the reserve is untouched during the turn time; a pick charges exactly the overtime to the acting team only', () => {
        const s = reserveLobby();
        expect(reserves(s)).toEqual({ Blue: RESERVE_MS, Red: RESERVE_MS });
        advance(s.test, TURN_MS - 1);
        expect(clientClock(s)).toEqual({ team: 'Blue', turn: 1, reserve: RESERVE_MS });
        advance(s.test, 1 + 5_000);
        expect(clientClock(s)).toEqual({ team: 'Blue', turn: 0, reserve: RESERVE_MS - 5_000 });
        tx(s.test, captain(s, 'Blue'), pickBody(s));
        expect(reserves(s)).toEqual({ Blue: 15_000, Red: RESERVE_MS });
        // Red's turn (Pick, Red) inside its turn time: nothing charged.
        advance(s.test, 10_000);
        tx(s.test, captain(s, 'Red'), pickBody(s));
        expect(reserves(s)).toEqual({ Blue: 15_000, Red: RESERVE_MS });
        // Red again (turn 2), 7 s of overtime.
        advance(s.test, TURN_MS + 7_000);
        tx(s.test, captain(s, 'Red'), pickBody(s));
        expect(reserves(s)).toEqual({ Blue: 15_000, Red: 13_000 });
        // Blue (turn 3) inside its turn time: not refilled.
        advance(s.test, 1_000);
        tx(s.test, captain(s, 'Blue'), pickBody(s));
        expect(reserves(s)).toEqual({ Blue: 15_000, Red: 13_000 });
        expect(timer(s)).toMatchObject({ accumulatedPauseMs: 0, reserveUsedMs: 0, inReserve: false, isPaused: false });
    });

    it('Classic: the expiry is refused 1 ms before turn time + reserve are used up and accepted at that moment; the reserve is then 0 and the next turn has only the turn time', () => {
        const s = reserveLobby();
        expectExpiresAfter(s, TURN_MS, RESERVE_MS);
        expect(lastStep(s)).toMatchObject({ actorUserId: 0, actorSlot: { tag: 'Blue' } });
        expect((lastStep(s).payload.value as any).characterName).toBe('EMPTY');
        expect(reserves(s)).toEqual({ Blue: 0, Red: RESERVE_MS });
        // Red (turn 1) still has its whole reserve.
        expectExpiresAfter(s, TURN_MS, RESERVE_MS);
        expect(reserves(s)).toEqual({ Blue: 0, Red: 0 });
        // Red (turn 2): turn time only.
        expectExpiresAfter(s, TURN_MS, 0);
        // Blue (turn 3): turn time only.
        expectExpiresAfter(s, TURN_MS, 0);
        expect(reserves(s)).toEqual({ Blue: 0, Red: 0 });
    });

    it('reserveBankSeconds 0: every expiry at exactly the turn length, the reserve fields stay 0, no reserve mark (behaviour before A148)', () => {
        const s = reserveLobby({ reserveBankSeconds: 0 });
        for (let i = 0; i < 4; i++) expectExpiresAfter(s, TURN_MS, 0);
        expect(reserves(s)).toEqual({ Blue: 0, Red: 0 });
        expect(timer(s).reserveMarks).toEqual([]);
    });

    it('the auto-play after reserve follows the lobby setting: autoRandomPick on draws from the pool, off records EMPTY', () => {
        const pool = ['ra', 'rb', 'rc'];
        const on = reserveLobby({ autoRandomPick: true });
        priceCharacters(on.test, on.lobbyId, pool);
        dropDefaultCostCoverage(on.test);
        expectExpiresAfter(on, TURN_MS, RESERVE_MS);
        expect(pool).toContain((lastStep(on).payload.value as any).characterName);
        expect(reserves(on).Blue).toBe(0);

        const off = reserveLobby({ autoRandomPick: false });
        priceCharacters(off.test, off.lobbyId, pool);
        expectExpiresAfter(off, TURN_MS, RESERVE_MS);
        expect((lastStep(off).payload.value as any).characterName).toBe('EMPTY');
        expect(reserves(off).Blue).toBe(0);
    });

    it('Classic bans: a ban charges the overtime; an expired ban turn waits for the reserve and records SKIP', () => {
        const s = reserveLobby({ banMode: { tag: 'Four' } });
        expect(clientClock(s).team).toBe('Blue');
        advance(s.test, TURN_MS + 4_000);
        tx(s.test, captain(s, 'Blue'), banBody(s));
        expect(reserves(s)).toEqual({ Blue: 16_000, Red: RESERVE_MS });
        expectExpiresAfter(s, TURN_MS, RESERVE_MS); // Red's ban
        expect(lastStep(s)).toMatchObject({ action: { tag: 'Ban' }, actorUserId: 0, actorSlot: { tag: 'Red' } });
        expect((lastStep(s).payload.value as any).characterName).toBe('SKIP');
        expect(reserves(s)).toEqual({ Blue: 16_000, Red: 0 });
    });

    it('Auction: the nominating team, then the team that must answer the bid, is on the clock and pays its own overtime', () => {
        const s = reserveLobby({ draftMode: { tag: 'Auction' } });
        expect(clientClock(s).team).toBe('Blue');
        advance(s.test, TURN_MS + 2_000);
        tx(s.test, captain(s, 'Blue'), nominateBody(s));
        expect(reserves(s)).toEqual({ Blue: 18_000, Red: RESERVE_MS });
        expect(clientClock(s)).toMatchObject({ team: 'Red', turn: TURN_MS, reserve: RESERVE_MS });
        advance(s.test, TURN_MS + 3_000);
        tx(s.test, captain(s, 'Red'), bidBody(s));
        expect(reserves(s)).toEqual({ Blue: 18_000, Red: 17_000 });
        expect(clientClock(s)).toMatchObject({ team: 'Blue', turn: TURN_MS, reserve: 18_000 });
        advance(s.test, TURN_MS + 1_000);
        tx(s.test, captain(s, 'Blue'), passBody(s)); // Red wins the character; Blue paid 1 s
        expect(reserves(s)).toEqual({ Blue: 17_000, Red: 17_000 });
        expect(lastStep(s).action.tag).toBe('AuctionSold');
        // Steal: Blue nominated, Red won: Blue nominates again.
        expect(clientClock(s)).toMatchObject({ team: 'Blue', turn: TURN_MS, reserve: 17_000 });
    });

    it('Auction: an expired bid answer waits for the answering team\'s reserve, then sells to the holder', () => {
        const s = reserveLobby({ draftMode: { tag: 'Auction' } });
        tx(s.test, captain(s, 'Blue'), nominateBody(s));
        expectExpiresAfter(s, TURN_MS, RESERVE_MS); // Red must answer
        expect(lastStep(s).action.tag).toBe('AuctionSold');
        expect((lastStep(s).payload.value as any).winningTeam.tag).toBe('Blue');
        expect(reserves(s)).toEqual({ Blue: RESERVE_MS, Red: 0 });
        // Blue won, so Red nominates; its reserve is gone: the nomination expires at the turn length.
        expectExpiresAfter(s, TURN_MS, 0);
        expect(lastStep(s)).toMatchObject({ action: { tag: 'Nominate' }, actorUserId: 0 });
    });

    it('Auction ban phase: the banning team is on the clock (the Classic expiry reducer)', () => {
        const s = reserveLobby({ draftMode: { tag: 'Auction' }, banMode: { tag: 'Four' } });
        expect(clientClock(s).team).toBe('Blue');
        expectExpiresAfter(s, TURN_MS, RESERVE_MS);
        expect(reserves(s)).toEqual({ Blue: 0, Red: RESERVE_MS });
    });

    it('the confirm window has no reserve: it ends at confirmWindowSeconds whatever reserve is left', () => {
        const s = reserveLobby({ draftMode: { tag: 'Auction' } }, { seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer']] });
        // Fill both teams through immediate expiries until the draft is complete (each turn waits only once for reserve).
        let guard = 0;
        while (!draftDone(s.test, s.lobbyId) && guard++ < 200) {
            const c = clientClock(s);
            advance(s.test, c.turn + c.reserve);
            tx(s.test, s.host, expireBody(s));
        }
        expect(draftDone(s.test, s.lobbyId)).toBe(true);
        const window = lobbyRow(s.test, s.lobbyId).confirmWindowSeconds * 1000;
        expect(clientClock(s)).toEqual({ team: null, turn: window, reserve: 0 });
        advance(s.test, window - 1);
        expectReject(s.test, s.host, expireBody(s), 'The confirm window has not yet expired.');
        advance(s.test, 1);
        tx(s.test, s.host, expireBody(s));
        expect(lobbyRow(s.test, s.lobbyId).stage.tag).toBe('Equipping');
    });
});

describe('A148: pause and resume freeze both clocks exactly', () => {
    it('a pause during turn time keeps the turn remainder and the full reserve', () => {
        const s = reserveLobby();
        advance(s.test, 12_000);
        pause(s);
        expect(timer(s)).toMatchObject({ isPaused: true, accumulatedPauseMs: 18_000, inReserve: false, reserveUsedMs: 0 });
        advance(s.test, 300_000);
        expect(clientClock(s)).toMatchObject({ turn: 18_000, reserve: RESERVE_MS });
        resume(s);
        expectExpiresAfter(s, 18_000, RESERVE_MS);
        expect(reserves(s).Blue).toBe(0);
    });

    it('a pause during reserve time does not hand back a turn clock: turn 0, the reserve left frozen, the Pause step logs 0 turn time', () => {
        const s = reserveLobby();
        advance(s.test, TURN_MS + 6_000);
        pause(s);
        expect(timer(s)).toMatchObject({ isPaused: true, accumulatedPauseMs: 0, inReserve: true, reserveUsedMs: 6_000 });
        const p = steps(s.test, s.lobbyId).find((x) => x.action.tag === 'Pause')!;
        expect(p.payload.value).toEqual({ timeRemainingMs: 0, isAutoPause: false });
        expect(reserves(s)).toEqual({ Blue: RESERVE_MS, Red: RESERVE_MS }); // turn-start values until the turn ends
        advance(s.test, 999_000);
        expect(clientClock(s)).toMatchObject({ turn: 0, reserve: 14_000 });
        expectReject(s.test, s.host, expireBody(s), PAUSED);
        resume(s);
        expectExpiresAfter(s, 0, 14_000);
        expect(reserves(s)).toEqual({ Blue: 0, Red: RESERVE_MS });
    });

    it('a pause in turn time, then one in reserve time: only un-paused time counts; 26 s of overtime on a 20 s reserve is late', () => {
        const s = reserveLobby();
        advance(s.test, 10_000);
        pause(s); // 20 s of turn left
        expect(timer(s)).toMatchObject({ accumulatedPauseMs: 20_000, inReserve: false });
        advance(s.test, 50_000);
        resume(s);
        advance(s.test, 35_000); // 15 s into the reserve
        pause(s);
        expect(timer(s)).toMatchObject({ inReserve: true, reserveUsedMs: 15_000 });
        advance(s.test, 40_000);
        resume(s);
        expect(clientClock(s)).toMatchObject({ turn: 0, reserve: 5_000 });
        advance(s.test, 11_000); // 26 s of reserve time: overdue by 6 s
        expect(clientClock(s)).toMatchObject({ turn: 0, reserve: 0 });
        expect(rejection(s.test, captain(s, 'Blue'), pickBody(s))).toBe(TIME_UP);
    });

    it('three un-paused stretches of reserve time (3 s, 10 s, 2 s) around two pauses: the pick charges exactly 15 s', () => {
        const s = reserveLobby();
        advance(s.test, TURN_MS + 3_000);
        pause(s);
        expect(timer(s)).toMatchObject({ inReserve: true, reserveUsedMs: 3_000 });
        advance(s.test, 20_000);
        resume(s);
        advance(s.test, 10_000);
        pause(s);
        expect(timer(s)).toMatchObject({ inReserve: true, reserveUsedMs: 13_000 });
        advance(s.test, 7_777);
        resume(s);
        advance(s.test, 2_000);
        expect(clientClock(s)).toMatchObject({ turn: 0, reserve: 5_000 });
        tx(s.test, captain(s, 'Blue'), pickBody(s));
        expect(reserves(s)).toEqual({ Blue: 5_000, Red: RESERVE_MS });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A149: undo gives the reserve back
// ════════════════════════════════════════════════════════════════════════════

describe('A149: undo returns both reserves to the start of the turn the draft goes back to; that turn has a full clock', () => {
    it('Classic: two charged picks undone one by one, with reserve used by the turn in progress returned as well', () => {
        const s = reserveLobby();
        advance(s.test, TURN_MS + 5_000);
        tx(s.test, captain(s, 'Blue'), pickBody(s)); // Blue 15 s
        advance(s.test, TURN_MS + 4_000);
        tx(s.test, captain(s, 'Red'), pickBody(s)); // Red 16 s
        expect(reserves(s)).toEqual({ Blue: 15_000, Red: 16_000 });
        expect(timer(s).reserveMarks).toHaveLength(2);
        // Red's turn 2 runs 3 s into its reserve, is paused there and resumed: 3 s used, not yet charged.
        advance(s.test, TURN_MS + 3_000);
        pause(s);
        resume(s);
        advance(s.test, 1_000);
        expect(clientClock(s)).toMatchObject({ team: 'Red', turn: 0, reserve: 12_000 });
        undo(s); // removes Red's pick of turn 1
        expect(reserves(s)).toEqual({ Blue: 15_000, Red: RESERVE_MS });
        expect(timer(s)).toMatchObject({ accumulatedPauseMs: 0, reserveUsedMs: 0, inReserve: false, isPaused: false });
        expect(timer(s).turnStartAt.microsSinceUnixEpoch).toBe(nowMs(s));
        expect(clientClock(s)).toEqual({ team: 'Red', turn: TURN_MS, reserve: RESERVE_MS });
        undo(s); // removes Blue's pick of turn 0
        expect(reserves(s)).toEqual({ Blue: RESERVE_MS, Red: RESERVE_MS });
        expect(timer(s).reserveMarks).toEqual([]);
        expect(clientClock(s)).toEqual({ team: 'Blue', turn: TURN_MS, reserve: RESERVE_MS });
    });

    it('Classic: undoing a pick that charged nothing keeps the earlier charges', () => {
        const s = reserveLobby();
        advance(s.test, TURN_MS + 5_000);
        tx(s.test, captain(s, 'Blue'), pickBody(s)); // Blue 15 s
        advance(s.test, 1_000);
        tx(s.test, captain(s, 'Red'), pickBody(s)); // no charge
        undo(s);
        expect(reserves(s)).toEqual({ Blue: 15_000, Red: RESERVE_MS });
        expect(timer(s).reserveMarks).toHaveLength(1);
    });

    it('Auction: a sold round (nomination, bid and pass all in overtime) is undone to the reserves at the round\'s start', () => {
        const s = reserveLobby({ draftMode: { tag: 'Auction' } });
        advance(s.test, TURN_MS + 2_000);
        tx(s.test, captain(s, 'Blue'), nominateBody(s));
        advance(s.test, TURN_MS + 3_000);
        tx(s.test, captain(s, 'Red'), bidBody(s));
        advance(s.test, TURN_MS + 1_000);
        tx(s.test, captain(s, 'Blue'), passBody(s));
        expect(reserves(s)).toEqual({ Blue: 17_000, Red: 17_000 });
        undo(s);
        expect(reserves(s)).toEqual({ Blue: RESERVE_MS, Red: RESERVE_MS });
        expect(timer(s).reserveMarks).toEqual([]);
        expect(clientClock(s)).toEqual({ team: 'Blue', turn: TURN_MS, reserve: RESERVE_MS });
    });

    it('Auction: an open round (the last step a bid) is undone the same way; an earlier round\'s charge stays', () => {
        const s = reserveLobby({ draftMode: { tag: 'Auction' } });
        tx(s.test, captain(s, 'Blue'), nominateBody(s));
        advance(s.test, TURN_MS + 4_000);
        tx(s.test, captain(s, 'Red'), passBody(s)); // round 1: Blue wins; Red paid 4 s
        expect(reserves(s)).toEqual({ Blue: RESERVE_MS, Red: 16_000 });
        advance(s.test, TURN_MS + 2_500);
        tx(s.test, captain(s, 'Red'), nominateBody(s)); // round 2: Red nominates, 2.5 s
        advance(s.test, TURN_MS + 1_500);
        tx(s.test, captain(s, 'Blue'), bidBody(s)); // Blue 1.5 s
        expect(reserves(s)).toEqual({ Blue: 18_500, Red: 13_500 });
        undo(s);
        expect(reserves(s)).toEqual({ Blue: RESERVE_MS, Red: 16_000 });
        expect(clientClock(s)).toEqual({ team: 'Red', turn: TURN_MS, reserve: 16_000 });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A150: late turn actions
// ════════════════════════════════════════════════════════════════════════════

interface LateCase {
    name: string;
    lobby: Record<string, unknown>;
    /** Brings the lobby to the turn under test and returns the acting side. */
    prepare: (s: Lobby) => Side;
    body: (s: Lobby) => (ctx: any) => unknown;
}

const LATE_CASES: LateCase[] = [
    { name: 'pick_character', lobby: {}, prepare: () => 'Blue', body: (s) => pickBody(s) },
    { name: 'ban_character', lobby: { banMode: { tag: 'Four' } }, prepare: () => 'Blue', body: (s) => banBody(s) },
    { name: 'nominate_character', lobby: { draftMode: { tag: 'Auction' } }, prepare: () => 'Blue', body: (s) => nominateBody(s) },
    {
        name: 'place_bid', lobby: { draftMode: { tag: 'Auction' } },
        prepare: (s) => { tx(s.test, captain(s, 'Blue'), nominateBody(s)); return 'Red'; },
        body: (s) => bidBody(s),
    },
    {
        name: 'pass_bid', lobby: { draftMode: { tag: 'Auction' } },
        prepare: (s) => { tx(s.test, captain(s, 'Blue'), nominateBody(s)); return 'Red'; },
        body: (s) => passBody(s),
    },
];

describe.each(LATE_CASES)('A150: $name after the time is up', (c) => {
    it('accepted 1000 ms after turn time and reserve ran out (the reserve ends at 0)', () => {
        const s = reserveLobby(c.lobby);
        const team = c.prepare(s);
        advance(s.test, TURN_MS + RESERVE_MS + 1_000);
        tx(s.test, captain(s, team), c.body(s));
        expect(reserves(s)[team]).toBe(0);
    });

    it('refused 1001 ms after, with nothing changed', () => {
        const s = reserveLobby(c.lobby);
        const team = c.prepare(s);
        advance(s.test, TURN_MS + RESERVE_MS + 1_001);
        const before = snap(session(s.test, s.lobbyId), steps(s.test, s.lobbyId));
        expect(rejection(s.test, captain(s, team), c.body(s))).toBe(TIME_UP);
        expect(snap(session(s.test, s.lobbyId), steps(s.test, s.lobbyId))).toBe(before);
    });

    it('reserve 0: the same tolerance counts from the end of the turn time', () => {
        const s = reserveLobby({ ...c.lobby, reserveBankSeconds: 0 });
        const team = c.prepare(s);
        advance(s.test, TURN_MS + 1_001);
        expect(rejection(s.test, captain(s, team), c.body(s))).toBe(TIME_UP);
        const t = reserveLobby({ ...c.lobby, reserveBankSeconds: 0 });
        const team2 = c.prepare(t);
        advance(t.test, TURN_MS + 1_000);
        tx(t.test, captain(t, team2), c.body(t));
    });

    it('a paused clock never refuses: paused 500 ms after the end, an hour later resumed, the action 1001 ms after the resume is accepted (1 ms frozen + 1000 ms)', () => {
        const s = reserveLobby(c.lobby);
        const team = c.prepare(s);
        advance(s.test, TURN_MS + RESERVE_MS + 500);
        pause(s);
        advance(s.test, 3_600_000);
        resume(s);
        advance(s.test, 1_001);
        tx(s.test, captain(s, team), c.body(s));
        expect(reserves(s)[team]).toBe(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A151: the automatic pause is lifted by hand; the expiry callers; the client formula per viewer role
// ════════════════════════════════════════════════════════════════════════════

/** b2 drops 25 s into Blue's turn of a SEATS lobby with reserve; the 15 s check auto-pauses 10 s into the reserve. */
function autoPausedInReserve(): Lobby {
    const s = reserveLobby({}, { seats: SEATS });
    advance(s.test, 25_000);
    disconnect(s.test, s.a.b2);
    const row = pendingCheck(s.test, s.lobbyId, s.a.b2.userId);
    advance(s.test, 15_000);
    fireCheck(s.test, row);
    expect(timer(s)).toMatchObject({ isPaused: true, inReserve: true, reserveUsedMs: 10_000 });
    return s;
}

describe('A151: a disconnect auto-pause stays until resumed by hand', () => {
    it('the return (client_connected and join_lobby) leaves it paused with the exact frozen reserve; the returned player resumes it', () => {
        const s = autoPausedInReserve();
        connect(s.test, s.a.b2);
        tx(s.test, s.a.b2, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        advance(s.test, 60_000);
        expect(timer(s).isPaused).toBe(true);
        expect(clientClock(s)).toMatchObject({ turn: 0, reserve: 10_000 });
        resume(s, s.a.b2);
        expectExpiresAfter(s, 0, 10_000);
    });

    it('a referee resumes it; the coach and a spectator are refused as before', () => {
        const s = autoPausedInReserve();
        const spec = joinAsSpectator(s, 'spec');
        connect(s.test, s.a.b2);
        for (const who of [s.a.bc, spec]) {
            expect(rejection(s.test, who, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId })))
                .toBe('Only the referee or a seated player can resume an auto-paused draft.');
        }
        expect(timer(s).isPaused).toBe(true);
        resume(s, s.host);
        expect(timer(s).isPaused).toBe(false);
        expect(clientClock(s)).toMatchObject({ turn: 0, reserve: 10_000 });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A153: who resumes an automatic pause (fix pass)
// ════════════════════════════════════════════════════════════════════════════

describe('A153: an automatic pause is resumed by the dropped player\'s team or a referee, not by the opponent', () => {
    const tryResume = (s: Lobby, who: Actor) => rejection(s.test, who, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));

    it('the Pause step records the dropped player\'s team in actorSlot', () => {
        const s = autoPausedInReserve();
        const p = steps(s.test, s.lobbyId).find((x) => x.action.tag === 'Pause')!;
        expect(p).toMatchObject({ actorUserId: 0, actorSlot: { tag: 'Blue' }, payload: { value: { isAutoPause: true } } });
    });

    it('both opponents are refused with nothing changed, while the dropped player is away and after their return', () => {
        const s = autoPausedInReserve();
        const before = snap(session(s.test, s.lobbyId));
        for (const who of [s.a.r1, s.a.r2]) expect(tryResume(s, who)).toBe(PAUSED_TEAM_ONLY);
        connect(s.test, s.a.b2);
        for (const who of [s.a.r1, s.a.r2]) expect(tryResume(s, who)).toBe(PAUSED_TEAM_ONLY);
        expect(snap(session(s.test, s.lobbyId))).toBe(before);
    });

    it('the teammate resumes while the dropped player is still away; the frozen reserve runs from there', () => {
        const s = autoPausedInReserve();
        advance(s.test, 30_000);
        resume(s, s.a.b1);
        expect(timer(s).isPaused).toBe(false);
        expectExpiresAfter(s, 0, 10_000);
    });

    it('the returned player resumes', () => {
        const s = autoPausedInReserve();
        connect(s.test, s.a.b2);
        resume(s, s.a.b2);
        expect(timer(s).isPaused).toBe(false);
    });

    it('a referee resumes while the dropped player is away; the coach and a spectator keep the old refusal', () => {
        const s = autoPausedInReserve();
        const spec = joinAsSpectator(s, 'spec');
        for (const who of [s.a.bc, spec]) {
            expect(tryResume(s, who)).toBe('Only the referee or a seated player can resume an auto-paused draft.');
        }
        resume(s, s.host);
        expect(timer(s).isPaused).toBe(false);
    });

    it('a manual pause is unchanged: a teammate and an opponent are refused with the D-62 text; the pauser resumes', () => {
        const s = reserveLobby({}, { seats: SEATS });
        pause(s, s.a.r1);
        for (const who of [s.a.r2, s.a.b1]) {
            expect(tryResume(s, who)).toBe('Only the referee or the player who paused can resume the draft.');
        }
        resume(s, s.a.r1);
        expect(timer(s).isPaused).toBe(false);
    });

    it('the dropped player abandons (joins another lobby): the teammate still resumes, the opponent is still refused', () => {
        const s = autoPausedInReserve();
        connect(s.test, s.a.b2);
        tx(s.test, s.a.b2, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
        tx(s.test, s.a.b2, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));
        expect(tryResume(s, s.a.b2)).toBe('You abandoned this match and can no longer act in it.');
        expect(tryResume(s, s.a.r1)).toBe(PAUSED_TEAM_ONLY);
        resume(s, s.a.b1);
        expect(timer(s).isPaused).toBe(false);
    });

    it('a Red player drops second while Blue\'s pause holds: the pause stays Blue\'s, Red\'s players are refused', () => {
        const s = autoPausedInReserve();
        disconnect(s.test, s.a.r2);
        const row = pendingCheck(s.test, s.lobbyId, s.a.r2.userId);
        advance(s.test, 15_000);
        fireCheck(s.test, row);
        expect(steps(s.test, s.lobbyId).filter((x) => x.action.tag === 'Pause')).toHaveLength(1);
        connect(s.test, s.a.r2);
        for (const who of [s.a.r1, s.a.r2]) expect(tryResume(s, who)).toBe(PAUSED_TEAM_ONLY);
        resume(s, s.a.b1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A155: a referee seated on the other team counts as a player (T-S10ab; also Red as the paused team for A153)
// ════════════════════════════════════════════════════════════════════════════

describe('A155: on an automatic pause, a referee seated on the other team counts as a player', () => {
    const tryResume = (s: Lobby, who: Actor) => rejection(s.test, who, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
    const SEAT_ONLY = 'Only the referee or a seated player can resume an auto-paused draft.';

    /** `who` drops; the 15 s check runs (moving a referee flag the dropped member held) and pauses for their team. */
    function dropAndCheck(s: Lobby, who: Actor, team: Side) {
        disconnect(s.test, who);
        const row = pendingCheck(s.test, s.lobbyId, who.userId);
        advance(s.test, 15_000);
        fireCheck(s.test, row);
        expect(timer(s).isPaused).toBe(true);
        const p = steps(s.test, s.lobbyId).filter((x) => x.action.tag === 'Pause').sort((a, b) => b.sequence - a.sequence)[0];
        expect(p).toMatchObject({ actorSlot: { tag: team }, payload: { value: { isAutoPause: true } } });
    }
    const refIds = (s: Lobby) => [...s.test.db.LobbyMember.lobby_id.filter(s.lobbyId)].filter((m) => m.isReferee).map((m) => m.userId);

    describe('1v1, the host plays Blue and holds the flag, then drops', () => {
        const hostBlue1v1 = () => {
            const s = reserveLobby({}, { hostSlot: 'BluePlayer', seats: [['r1', 'RedPlayer']] });
            expect(refIds(s)).toEqual([s.host.userId]);
            dropAndCheck(s, s.host, 'Blue');
            expect(refIds(s)).toEqual([s.a.r1.userId]); // the 15 s check moved the flag to the opponent
            return s;
        };

        it('r1 now holds the flag and is refused with nothing changed; after the forfeit grace r1 claims the forfeit', () => {
            const s = hostBlue1v1();
            const before = snap(session(s.test, s.lobbyId));
            expect(tryResume(s, s.a.r1)).toBe(PAUSED_TEAM_ONLY);
            expect(snap(session(s.test, s.lobbyId))).toBe(before);
            advance(s.test, 46_000); // 61 s since the drop, past disconnectForfeitSeconds 60
            tx(s.test, s.a.r1, (ctx) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 0 }));
            expect(s.test.db.Lobby.id.find(s.lobbyId)).toBeFalsy(); // a casual forfeit finalizes inline
        });

        it('the host returns and resumes (a player of the paused team, without the flag)', () => {
            const s = hostBlue1v1();
            connect(s.test, s.host);
            expect(tryResume(s, s.a.r1)).toBe(PAUSED_TEAM_ONLY);
            resume(s, s.host);
            expect(timer(s).isPaused).toBe(false);
        });
    });

    it('2v2, the host plays Red and holds the flag, drops: the flag goes to a Blue player, who is refused; the Red teammate resumes', () => {
        const s = reserveLobby({}, { hostSlot: 'RedPlayer', seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer']] });
        dropAndCheck(s, s.host, 'Red');
        expect(refIds(s)).toEqual([s.a.b1.userId]);
        const before = snap(session(s.test, s.lobbyId));
        for (const who of [s.a.b1, s.a.b2]) expect(tryResume(s, who)).toBe(PAUSED_TEAM_ONLY);
        expect(snap(session(s.test, s.lobbyId))).toBe(before);
        resume(s, s.a.r1);
        expect(timer(s).isPaused).toBe(false);
    });

    it('2v2, the host plays Blue, drops: the flag goes to the Blue teammate, who resumes; the Red players are refused', () => {
        const s = reserveLobby({}, { hostSlot: 'BluePlayer', seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] });
        dropAndCheck(s, s.host, 'Blue');
        expect(refIds(s)).toEqual([s.a.b1.userId]);
        for (const who of [s.a.r1, s.a.r2]) expect(tryResume(s, who)).toBe(PAUSED_TEAM_ONLY);
        resume(s, s.a.b1);
        expect(timer(s).isPaused).toBe(false);
    });

    for (const team of ['Blue', 'Red'] as const) {
        it(`a spectator referee resumes a pause of ${team}`, () => {
            const s = reserveLobby({}, { seats: SEATS });
            dropAndCheck(s, team === 'Blue' ? s.a.b2 : s.a.r2, team);
            expect(refIds(s)).toEqual([s.host.userId]);
            resume(s, s.host);
            expect(timer(s).isPaused).toBe(false);
        });

        it(`a referee in the Blue coach seat resumes a pause of ${team}`, () => {
            const s = reserveLobby({}, {
                seats: SEATS,
                beforeStart: (l) => tx(l.test, l.host, (ctx) =>
                    M.transfer_referee(ctx, { lobbyId: l.lobbyId, targetJoinSeq: seatOf(ctx, l.lobbyId, l.a.bc.userId) })),
            });
            expect(refIds(s)).toEqual([s.a.bc.userId]);
            dropAndCheck(s, team === 'Blue' ? s.a.b2 : s.a.r2, team);
            resume(s, s.a.bc);
            expect(timer(s).isPaused).toBe(false);
        });
    }

    describe('A153 with Red as the paused team', () => {
        const redPaused = () => {
            const s = reserveLobby({}, { seats: SEATS });
            dropAndCheck(s, s.a.r2, 'Red');
            return s;
        };

        it('both Blue players are refused with nothing changed, while r2 is away and after the return; the coach keeps the old text', () => {
            const s = redPaused();
            const before = snap(session(s.test, s.lobbyId));
            for (const who of [s.a.b1, s.a.b2]) expect(tryResume(s, who)).toBe(PAUSED_TEAM_ONLY);
            expect(tryResume(s, s.a.bc)).toBe(SEAT_ONLY);
            connect(s.test, s.a.r2);
            for (const who of [s.a.b1, s.a.b2]) expect(tryResume(s, who)).toBe(PAUSED_TEAM_ONLY);
            expect(snap(session(s.test, s.lobbyId))).toBe(before);
        });

        it('the Red teammate resumes while r2 is away', () => {
            const s = redPaused();
            resume(s, s.a.r1);
            expect(timer(s).isPaused).toBe(false);
        });

        it('the returned r2 resumes', () => {
            const s = redPaused();
            connect(s.test, s.a.r2);
            resume(s, s.a.r2);
            expect(timer(s).isPaused).toBe(false);
        });
    });

    it('a manual pause is unchanged for a seated referee: the host (Blue, flag) resumes r1\'s pause; r1 cannot resume the host\'s', () => {
        const s = reserveLobby({}, { hostSlot: 'BluePlayer', seats: [['r1', 'RedPlayer']] });
        pause(s, s.a.r1);
        resume(s, s.host);
        expect(timer(s).isPaused).toBe(false);
        advance(s.test, 11_000);
        pause(s, s.host);
        expect(tryResume(s, s.a.r1)).toBe('Only the referee or the player who paused can resume the draft.');
        resume(s, s.host);
        expect(timer(s).isPaused).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A154: a pause on a spent turn (pinned, no code change)
// ════════════════════════════════════════════════════════════════════════════

describe('A154: a pause taken after all time is gone stays allowed and freezes 1 ms', () => {
    /** Blue's turn and reserve spent 45 s ago, nobody fired the expiry: the pick is late; b1 pauses, an hour, b1 resumes. */
    function spentPausedResumed(): Lobby {
        const s = reserveLobby();
        advance(s.test, TURN_MS + RESERVE_MS + 45_000);
        expect(rejection(s.test, captain(s, 'Blue'), pickBody(s))).toBe(TIME_UP);
        pause(s, s.a.b1);
        expect(timer(s)).toMatchObject({ isPaused: true, accumulatedPauseMs: 1 });
        expect(clientClock(s)).toMatchObject({ team: 'Blue', turn: 1, reserve: 0 });
        advance(s.test, 3_600_000);
        resume(s, s.a.b1);
        return s;
    }

    it('after the resume the 1 ms runs out, then a pick within 1000 ms is accepted (the reserve stays 0)', () => {
        const s = spentPausedResumed();
        advance(s.test, 1 + 1_000);
        tx(s.test, captain(s, 'Blue'), pickBody(s));
        expect(reserves(s)).toEqual({ Blue: 0, Red: RESERVE_MS });
    });

    it('a pick at 1001 ms after the 1 ms ran out is refused, with nothing changed', () => {
        const s = spentPausedResumed();
        advance(s.test, 1 + 1_001);
        const before = snap(session(s.test, s.lobbyId), steps(s.test, s.lobbyId));
        expect(rejection(s.test, captain(s, 'Blue'), pickBody(s))).toBe(TIME_UP);
        expect(snap(session(s.test, s.lobbyId), steps(s.test, s.lobbyId))).toBe(before);
    });

    it('the expiry is refused right at the resume and accepted 1 ms after it', () => {
        const s = spentPausedResumed();
        expectReject(s.test, s.host, expireBody(s), NOT_EXPIRED);
        advance(s.test, 1);
        tx(s.test, s.host, expireBody(s));
        expect(lastStep(s)).toMatchObject({ actorUserId: 0, actorSlot: { tag: 'Blue' } });
        expect(reserves(s)).toEqual({ Blue: 0, Red: RESERVE_MS });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Review F4: reserve above 0 under the system preset and in a tournament lobby
// ════════════════════════════════════════════════════════════════════════════

describe('Review F4: drafting with reserve under the system preset (120 s) and in a tournament lobby', () => {
    it('a casual lobby with the system preset\'s clock (60 s turns, 120 s reserve, Classic, ban Four): the reserve drains after the turn time, the exact overtime is charged, the expiry is due only at turn + reserve', () => {
        const preset = systemPreset(newHarness());
        expect(preset).toMatchObject({ standardTurnSeconds: 60, reserveBankSeconds: 120, draftMode: { tag: 'Classic' }, banMode: { tag: 'Four' } });
        const s = reserveLobby({
            standardTurnSeconds: preset.standardTurnSeconds, reserveBankSeconds: preset.reserveBankSeconds,
            draftMode: preset.draftMode, banMode: preset.banMode,
        });
        const T = 60_000;
        const R = 120_000;
        expect(reserves(s)).toEqual({ Blue: R, Red: R });
        // Turn 0, Blue ban: 5 s into the reserve.
        advance(s.test, T + 5_000);
        expect(clientClock(s)).toEqual({ team: 'Blue', turn: 0, reserve: R - 5_000 });
        tx(s.test, captain(s, 'Blue'), banBody(s));
        expect(reserves(s)).toEqual({ Blue: 115_000, Red: R });
        // Turn 1, Red ban inside the turn time: nothing charged.
        advance(s.test, T - 1);
        tx(s.test, captain(s, 'Red'), banBody(s));
        expect(reserves(s)).toEqual({ Blue: 115_000, Red: R });
        // Turn 2, Blue pick: 100 s of overtime.
        advance(s.test, T + 100_000);
        tx(s.test, captain(s, 'Blue'), pickBody(s));
        expect(reserves(s)).toEqual({ Blue: 15_000, Red: R });
        // Turn 3, Red pick: the expiry waits for the whole 120 s reserve.
        expectExpiresAfter(s, T, R);
        expect(reserves(s)).toEqual({ Blue: 15_000, Red: 0 });
        // Turn 4, Red pick: turn time only.
        expectExpiresAfter(s, T, 0);
        // Turn 5, Blue pick: Blue's 15 s left.
        expectExpiresAfter(s, T, 15_000);
        expect(reserves(s)).toEqual({ Blue: 0, Red: 0 });
    });

    it('a tournament lobby (free set from the system preset): the same reserve rules, Classic with bans', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id);
        expect(lobbyRow(s.test, s.lobbyId)).toMatchObject({ standardTurnSeconds: 60, reserveBankSeconds: 120 });
        const T = 60_000;
        const R = 120_000;
        expect(reserves(s)).toEqual({ Blue: R, Red: R });
        advance(s.test, T + 7_250);
        tx(s.test, captain(s, 'Blue'), banBody(s));
        expect(reserves(s)).toEqual({ Blue: R - 7_250, Red: R });
        expectExpiresAfter(s, T, R); // Red's ban
        expect(lastStep(s)).toMatchObject({ action: { tag: 'Ban' }, actorUserId: 0, actorSlot: { tag: 'Red' } });
        expect(reserves(s)).toEqual({ Blue: R - 7_250, Red: 0 });
        // Blue's pick 1 s past turn + reserve left: refused (A150); the expiry then plays it.
        advance(s.test, T + R - 7_250 + 1_001);
        expect(rejection(s.test, captain(s, 'Blue'), pickBody(s))).toBe(TIME_UP);
        tx(s.test, s.host, expireBody(s));
        expect(reserves(s)).toEqual({ Blue: 0, Red: 0 });
    });

    it('a tournament lobby with a stand-in: the stand-in drops, the auto-pause is Blue\'s; Red is refused, the Blue captain resumes', () => {
        const f = liveField(2);
        const { test } = f;
        const m = byKey(test, f.id, 'W-R1-M1');
        const { blue, red } = sidesOf(f, m.id);
        const sub = verified(test, 'sub');
        tx(test, f.org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team1Id!, userId: sub.userId }));
        const lobbyId = createTournamentLobby(test, f.org, m.id);
        for (const who of [blue.captain, sub, red.captain, red.mate]) {
            join(test, who, lobbyId);
            tx(test, who, (ctx) => M.confirm_ready(ctx, { lobbyId }));
        }
        tx(test, f.org, (ctx) => M.start_draft(ctx, { lobbyId }));
        const s: Lobby = { test, lobbyId, host: f.org, a: { b1: blue.captain, sub, r1: red.captain, r2: red.mate } };
        advance(test, 70_000); // 10 s into Blue's 120 s reserve
        disconnect(test, sub);
        const row = pendingCheck(test, lobbyId, sub.userId);
        advance(test, 15_000);
        fireCheck(test, row);
        expect(timer(s)).toMatchObject({ isPaused: true, inReserve: true, reserveUsedMs: 25_000 });
        expect(steps(test, lobbyId).find((x) => x.action.tag === 'Pause')).toMatchObject({ actorSlot: { tag: 'Blue' } });
        for (const who of [red.captain, red.mate]) {
            expect(rejection(test, who, (ctx) => M.resume_draft(ctx, { lobbyId }))).toBe(PAUSED_TEAM_ONLY);
        }
        resume(s, blue.captain);
        expectExpiresAfter(s, 0, 95_000);
    });
});

describe('Timer review gaps: the expiry callers and the client formula for every viewer role', () => {
    it('a spectator and a coach may fire a due expiry; an away member is refused with the A98 text', () => {
        const s = reserveLobby({}, { seats: SEATS });
        const spec = joinAsSpectator(s, 'spec');
        tx(s.test, s.a.r2, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId })); // r2 away (no 15 s check fired)
        advance(s.test, TURN_MS + RESERVE_MS - 1);
        for (const who of [spec, s.a.bc]) expectReject(s.test, who, expireBody(s), NOT_EXPIRED);
        advance(s.test, 1);
        expectReject(s.test, s.a.r2, expireBody(s), AWAY);
        tx(s.test, spec, expireBody(s)); // Blue's turn 0
        advance(s.test, TURN_MS + RESERVE_MS);
        expectReject(s.test, s.a.r2, expireBody(s), AWAY);
        tx(s.test, s.a.bc, expireBody(s)); // Red's turn 1
        expect(reserves(s)).toEqual({ Blue: 0, Red: 0 });
    });

    it('host referee, players, coach, spectator, late spectator and an away member compute the same two countdowns', () => {
        const s = reserveLobby({}, { seats: SEATS });
        const spec = joinAsSpectator(s, 'spec');
        tx(s.test, s.a.r2, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
        advance(s.test, TURN_MS + 4_000);
        tx(s.test, captain(s, 'Blue'), pickBody(s)); // Blue reserve 16 s
        const late = joinAsSpectator(s, 'late');
        const viewers = [s.host, s.a.b1, s.a.b2, s.a.bc, s.a.r1, s.a.r2, spec, late];
        const all = () => viewers.map((v) => clientClock(s, v));
        const expectAll = (x: { team: Side | null; turn: number; reserve: number }) => {
            for (const c of all()) expect(c).toEqual(x);
        };
        advance(s.test, 10_000);
        expectAll({ team: 'Red', turn: 20_000, reserve: RESERVE_MS }); // Red's turn time
        advance(s.test, 25_000);
        expectAll({ team: 'Red', turn: 0, reserve: 15_000 }); // Red's reserve time
        pause(s);
        advance(s.test, 9_000);
        expectAll({ team: 'Red', turn: 0, reserve: 15_000 }); // paused in reserve
        resume(s);
        advance(s.test, 15_000);
        expectAll({ team: 'Red', turn: 0, reserve: 0 });
        tx(s.test, s.host, expireBody(s));
        expectAll({ team: 'Red', turn: TURN_MS, reserve: 0 }); // Red's turn 2: no reserve left
        advance(s.test, TURN_MS);
        tx(s.test, late, expireBody(s));
        expectAll({ team: 'Blue', turn: TURN_MS, reserve: 16_000 });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Seeded model-based random walk (Classic and Auction)
// ════════════════════════════════════════════════════════════════════════════

/** mulberry32: a small seeded generator (fixed seeds, reproducible). */
function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The independent model: the time the current turn has left on its turn clock, the on-clock team's reserve used in it,
 * the time past the end, both reserves at the start of the turn, and a stack of restore points (Classic turns and
 * Auction bans: one per turn; Auction nominations: one per round) holding the reserves at their start.
 */
interface Model {
    reserves: Record<Side, number>;
    turnLeft: number;
    spent: number;
    overdue: number;
    paused: boolean;
    stack: Array<Record<Side, number>>;
    lastManualPause: number;
}

const other = (x: Side): Side => (x === 'Blue' ? 'Red' : 'Blue');

interface WalkOpts {
    /** reserveBankSeconds (default 15). */
    reserveSec?: number;
    /** The lobby's autoRandomPick (default false: EMPTY / SKIP); on, a small priced pool feeds the auto-play. */
    autoRandomPick?: boolean;
}

function runWalk(mode: 'Classic' | 'Auction', seed: number, actions: number, opts: WalkOpts = {}) {
    const rand = rng(seed);
    const reserveSec = opts.reserveSec ?? 15;
    const autoRandomPick = opts.autoRandomPick ?? false;
    const s = reserveLobby({ draftMode: { tag: mode }, banMode: { tag: seed % 2 === 0 ? 'Four' : 'None' }, reserveBankSeconds: reserveSec, autoRandomPick },
        { seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] });
    if (autoRandomPick) priceCharacters(s.test, s.lobbyId, Array.from({ length: 24 }, (_, i) => `pool-${seed}-${i}`));
    const R = reserveSec * 1000;
    const windowMs = lobbyRow(s.test, s.lobbyId).confirmWindowSeconds * 1000;
    const m: Model = { reserves: { Blue: R, Red: R }, turnLeft: TURN_MS, spent: 0, overdue: 0, paused: false, stack: [], lastManualPause: -1e12 };
    let tMs = 0;
    const mate = captain(s, 'Blue').userId === s.a.b1.userId ? s.a.b2 : s.a.b1;
    let away = false; // the mate dropped and has not come back yet (A153: the teammate or the referee resumes)

    const onClock = () => clientClock(s).team; // the on-clock team from the view rows (the client rule)
    const complete = () => draftDone(s.test, s.lobbyId);
    const reserveLeft = () => { const t = onClock(); return t ? m.reserves[t] - m.spent : 0; };
    const timePasses = (dt: number) => {
        tMs += dt;
        advance(s.test, dt);
        if (m.paused) return;
        const a = Math.min(dt, m.turnLeft); m.turnLeft -= a; dt -= a;
        const b = Math.min(dt, reserveLeft()); m.spent += b; dt -= b;
        m.overdue += dt;
    };
    /** A turn ended: the on-clock team (taken before the action) pays what it used; the next turn starts full. */
    const endTurn = (team: Side | null, push: boolean) => {
        const startReserves = { ...m.reserves };
        if (team) m.reserves[team] -= m.spent;
        if (push) m.stack.push(startReserves);
        m.turnLeft = complete() ? windowMs : TURN_MS;
        m.spent = 0;
        m.overdue = 0;
    };
    const check = (label: string) => {
        const c = clientClock(s);
        const want = { turn: m.turnLeft, reserve: reserveLeft() };
        expect({ turn: c.turn, reserve: c.reserve }, `${mode} seed ${seed} ${label}`).toEqual(want);
        expect(reserves(s), `${mode} seed ${seed} ${label} reserves`).toEqual(m.reserves);
        expect(timer(s).isPaused, `${mode} seed ${seed} ${label} paused`).toBe(m.paused);
    };
    const attempt = (who: Actor, body: (ctx: any) => unknown): string | null => {
        try { tx(s.test, who, body); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
    };
    /** The referee's undo: refused while paused or with nothing to undo; else the last restore point comes back. */
    const doUndo = (): string => {
        const err = attempt(s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId }));
        const label = `undo ${err ?? 'ok'}`;
        if (m.paused) expect(err, label).toBe('Nothing to undo right now.');
        else if (m.stack.length === 0) expect(err, label).toBe('No steps to undo.');
        else {
            expect(err, label).toBeNull();
            m.reserves = m.stack.pop()!;
            m.turnLeft = TURN_MS;
            m.spent = 0;
            m.overdue = 0;
        }
        return label;
    };
    /**
     * Resume by whoever may. Manual pause: the referee. Automatic pause (always Blue's: only the Blue mate drops):
     * sometimes a Red player tries first and is refused (A153); then the returned mate, the Blue captain or the
     * referee, drawn at random (the mate only once back, A151).
     */
    const doResume = () => {
        const lastPause = steps(s.test, s.lobbyId).filter((x) => x.action.tag === 'Pause').sort((a, b) => b.sequence - a.sequence)[0];
        const auto = (lastPause.payload.value as any).isAutoPause;
        if (!auto) {
            resume(s, s.host);
            m.paused = false;
            return 'resume (manual, by the referee)';
        }
        let tried = '';
        if (rand() < 0.3) {
            const opp = rand() < 0.5 ? s.a.r1 : s.a.r2;
            expect(attempt(opp, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId })), 'opponent resume').toBe(PAUSED_TEAM_ONLY);
            tried = 'opponent refused, then ';
        }
        const who: Array<[string, Actor]> = [['teammate', captain(s, 'Blue')], ['referee', s.host]];
        if (!away) who.push(['returned player', mate]);
        const [name, actor] = who[Math.floor(rand() * who.length)];
        resume(s, actor);
        m.paused = false;
        return `resume (auto, ${tried}by the ${name}${away ? ', mate still away' : ''})`;
    };

    let accepted = 0;
    for (let i = 0; i < actions; i++) {
        if (lobbyRow(s.test, s.lobbyId).stage.tag !== 'Drafting') break;
        const r = rand();
        const team = onClock();
        const sess = session(s.test, s.lobbyId);
        const isNomination = !!sess.isAuctionPhase && sess.currentNomination === undefined;
        let label = '';
        if (complete() && !m.paused && r >= 0.30 && r < 0.70) {
            // the confirm window: go back into the draft (an expiry here would end the walk; turn actions are refused)
            label = `${doUndo()} (window)`;
        } else if (r < 0.30) {
            // time jump: often onto a boundary (turn end, inside the reserve, reserve end, end + 1000, end + 1001)
            const toEnd = m.turnLeft + reserveLeft();
            const inReserve = m.turnLeft + Math.floor(rand() * Math.max(1, reserveLeft()));
            const choices = [1, 999, 1_000, 1_001, toEnd - 1, toEnd, toEnd + 1_000, toEnd + 1_001, m.turnLeft, inReserve, inReserve, Math.floor(rand() * 40_000)];
            const dt = Math.max(0, choices[Math.floor(rand() * choices.length)]);
            label = `jump ${dt}`;
            timePasses(dt);
        } else if (r < 0.58) {
            // a turn action by the acting captain
            if (!team) { timePasses(500); label = 'idle (window, paused)'; }
            else {
                let body: (ctx: any) => unknown;
                if (!sess.isAuctionPhase) body = sess.draftSequence[sess.turnIndex].actionRequired.tag === 'Ban' ? banBody(s) : pickBody(s);
                else if (isNomination) body = nominateBody(s);
                else {
                    const budget = team === 'Blue' ? sess.teamBlueCharBudget : sess.teamRedCharBudget;
                    body = rand() < 0.5 && budget >= (sess.currentBidAmount ?? 0) + 2 ? bidBody(s) : passBody(s);
                }
                const err = attempt(captain(s, team), body);
                label = `action ${team} ${err ?? 'ok'}`;
                if (m.paused) expect(err, label).toBe(PAUSED);
                else if (m.overdue > 1_000) expect(err, label).toBe(TIME_UP);
                else {
                    expect(err, label).toBeNull();
                    accepted++;
                    endTurn(team, !sess.isAuctionPhase || isNomination);
                }
            }
        } else if (r < 0.70) {
            // an expiry call (not in the confirm window: that would end the walk)
            if (!team) { timePasses(500); label = 'idle (window, paused)'; }
            else {
                const due = !m.paused && m.turnLeft === 0 && reserveLeft() === 0; // before the call moves the clock
                const err = attempt(s.host, expireBody(s));
                label = `expiry ${team} ${err ?? 'ok'}`;
                if (due) { expect(err, label).toBeNull(); endTurn(team, !sess.isAuctionPhase || isNomination); }
                else expect(err, label).toBe(m.paused ? PAUSED : NOT_EXPIRED);
            }
        } else if (r < 0.85) {
            if (m.paused) label = doResume();
            else if (tMs - m.lastManualPause >= 10_000) {
                pause(s);
                m.lastManualPause = tMs;
                m.paused = true;
                if (m.turnLeft === 0 && reserveLeft() === 0) { m.turnLeft = 1; m.overdue = 0; } // the 1 ms freeze
                label = m.turnLeft === 0 ? 'pause (in reserve time or spent)' : 'pause';
            } else { timePasses(1_000); label = 'wait'; }
        } else if (r < 0.95) {
            label = doUndo();
        } else if (away) {
            // the mate who stayed away comes back (the pause, if any, stays, A151)
            connect(s.test, mate);
            away = false;
            label = 'late return';
        } else {
            // the non-captain Blue player drops; the 15 s check fires; the player returns at once or stays away for a
            // while (the pause stays either way, A151)
            disconnect(s.test, mate);
            const row = pendingCheck(s.test, s.lobbyId, mate.userId);
            timePasses(15_000);
            const wasPaused = m.paused;
            fireCheck(s.test, row);
            if (!wasPaused) {
                m.paused = true;
                if (m.turnLeft === 0 && reserveLeft() === 0) { m.turnLeft = 1; m.overdue = 0; }
            }
            if (rand() < 0.5) {
                connect(s.test, mate);
                label = `drop and return (paused before: ${wasPaused})`;
            } else {
                away = true;
                label = `drop, stays away (paused before: ${wasPaused})`;
            }
        }
        check(`#${i} ${label}`);
    }
    return accepted;
}

describe('A148 to A151, A153: a seeded model-based random walk (turn actions, expiries, pause, resume, undo, drop and return, time jumps)', () => {
    it.each([
        ['Classic', 11], ['Classic', 12], ['Auction', 21], ['Auction', 22],
    ] as const)('%s, seed %i: 1500 actions, the turn clock, the reserve and both stored reserves match the model after every action', (mode, seed) => {
        const accepted = runWalk(mode, seed, 1_500);
        expect(accepted).toBeGreaterThan(100);
    }, 240_000);

    // T-S10aa fix pass (review F4): reserve 0 and 120 s, random-pick auto-play.
    it.each([
        ['Classic', 31, 0, true], ['Auction', 41, 0, false],
        ['Classic', 32, 120, true], ['Auction', 42, 120, true],
    ] as const)('%s, seed %i, reserve %i s, autoRandomPick %s: 1000 actions match the model', (mode, seed, reserveSec, autoRandomPick) => {
        const accepted = runWalk(mode, seed, 1_000, { reserveSec, autoRandomPick });
        expect(accepted).toBeGreaterThan(50);
    }, 240_000);
});
