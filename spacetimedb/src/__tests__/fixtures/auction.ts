// Fixtures: Auction lobbies, rounds (nominate, bid, pass, expire), eidolons, budgets and a played Auction.
// From S10u (s10u-auction-undo-dips.test.ts); not a test file. The undo snapshot (canon, world) lives in undo.ts.
import { expect } from 'vitest';
import {
    AUCTION,
    M,
    ONE_V_ONE,
    TURN_MS,
    advance,
    lobbyRow,
    newHarness,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    other,
    type Lobby,
    type SetupOpts,
    type Side,
} from './harness';
import { captain } from './draft-and-scoring';

export const NOMINATE_COST = 'Not enough budget to nominate this character.';

// ─── Builders ────────────────────────────────────────────────────────────────

export const f = Math.fround;

export function lobby(args: Record<string, unknown> = {}, seats: SetupOpts['seats'] = ONE_V_ONE): Lobby {
    return setupLobby(newHarness(), { seats, lobby: { ...AUCTION, ...args } });
}

export const undo = (s: Lobby) => { advance(s.test, 50); tx(s.test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId })); };
export const nominatorOf = (s: Lobby) => session(s.test, s.lobbyId).nextNominatorTeam.tag as Side;
export const stepsOf = (s: Lobby, tag: string) => steps(s.test, s.lobbyId).filter((x) => x.action.tag === tag);
export const price = (s: Lobby, name: string, ladder: number | number[] = 0) => priceCharacters(s.test, s.lobbyId, [name], ladder);

/** The nominator's captain nominates `name` (priced first when a ladder is given). */
export function nominate(s: Lobby, name: string, ladder: number | number[] = 0) {
    if (name !== 'EMPTY') price(s, name, ladder);
    advance(s.test, 300);
    tx(s.test, captain(s, nominatorOf(s)), (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: name }));
}
export const bid = (s: Lobby, side: Side, bidAmount: number) => {
    advance(s.test, 300);
    tx(s.test, captain(s, side), bidBody(s, bidAmount));
};
// bidAmount is an f32 argument: the wire delivers the f32 value, so the helpers pass Math.fround of it.
export const bidBody = (s: Lobby, bidAmount: number) => (ctx: any) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: f(bidAmount) });
export const pass = (s: Lobby, side: Side) => { advance(s.test, 300); tx(s.test, captain(s, side), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId })); };
export const expire = (s: Lobby, who: Side = 'Blue') => {
    advance(s.test, TURN_MS + 1_000);
    tx(s.test, captain(s, who), (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }));
};
export const eidBody = (s: Lobby, side: Side, characterName: string, eidolon: number) =>
    (ctx: any) => M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: { tag: side } as any, characterName, eidolon });
/** set_eidolon by the side's captain, past the lineup throttle. */
export const eid = (s: Lobby, side: Side, name: string, e: number) => { advance(s.test, 1_100); tx(s.test, captain(s, side), eidBody(s, side, name, e)); };

/** `side` wins `name` at its opening amount: a cost-0 filler sale first when the other team is to nominate. */
export function buyAt(s: Lobby, side: Side, name: string, ladder: number | number[], filler: string) {
    if (nominatorOf(s) !== side) { nominate(s, filler, 0); pass(s, side); }
    nominate(s, name, ladder);
    pass(s, other(side));
}

export const budgets = (s: Lobby, side: Side) => {
    const x = session(s.test, s.lobbyId);
    return side === 'Blue'
        ? { char: x.teamBlueCharBudget, lc: x.teamBlueLcBudget, won: x.blueCharactersWon }
        : { char: x.teamRedCharBudget, lc: x.teamRedLcBudget, won: x.redCharactersWon };
};
export const nowMicros = (s: Lobby) => s.test.clock.now().microsSinceUnixEpoch;

/** A134: after any auction undo: no open nomination, nobody holds a bid, a fresh turn clock. */
export function expectNoRound(s: Lobby, nominator: Side) {
    const x = session(s.test, s.lobbyId);
    expect(x.currentNomination).toBeUndefined();
    expect(x.currentBidAmount).toBeUndefined();
    expect(x.currentBidTeam.tag).toBe('Spectator');
    expect(x.nextNominatorTeam.tag).toBe(nominator);
    expect(x.timerState.turnStartAt.microsSinceUnixEpoch).toBe(nowMicros(s));
    expect(x.timerState.accumulatedPauseMs).toBe(0);
}

/** Plays the Auction until `sales` sales: Blue's nominations cost 5 and Red passes, Red's cost 0 and Blue passes. */
export function playAuction(s: Lobby, sales = 16, blueCost = 5) {
    let n = stepsOf(s, 'Nominate').length + stepsOf(s, 'Undo').length;
    while (lobbyRow(s.test, s.lobbyId).stage.tag === 'Drafting' && stepsOf(s, 'AuctionSold').length < sales) {
        const sess = session(s.test, s.lobbyId);
        const team = sess.nextNominatorTeam.tag as Side;
        const otherFull = (team === 'Blue' ? sess.redCharactersWon : sess.blueCharactersWon) >= 8;
        nominate(s, `a${++n}`, team === 'Blue' ? blueCost : 0);
        if (!otherFull) pass(s, other(team));
    }
}
export const E6 = (x: number) => [0, 0, 0, 0, 0, 0, x];
