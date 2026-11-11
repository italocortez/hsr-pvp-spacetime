// Shared helpers: Auction lobbies, rounds (nominate, bid, pass, expire), eidolons and budgets.
// From S10u (s10u-auction-undo-dips.test.ts); not a test file.
import { expect } from 'vitest';
import {
    M,
    advance,
    lobbyRow,
    newHarness,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Lobby,
    type SetupOpts,
} from './harness';
import { captain } from './draft-and-scoring-builders';

export const NOMINATE_COST = 'Not enough budget to nominate this character.';

// ─── Builders ────────────────────────────────────────────────────────────────

export type Side = 'Blue' | 'Red';
export const f = Math.fround;
export const TURN_MS = 30_000;
export const ONE_V_ONE: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['r1', 'RedPlayer']];
export const TWO_V_TWO: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];
export const AUCTION = { draftMode: { tag: 'Auction' } };
export const other = (side: Side): Side => (side === 'Blue' ? 'Red' : 'Blue');

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
export const nominateBody = (s: Lobby, name: string) => (ctx: any) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: name });
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

// ─── The snapshot (as in s10t-undo-any-step) ─────────────────────────────────

export const AUDIT_KEYS = new Set(['createdById', 'createdDate', 'lastModifiedById', 'lastModifiedDate']);
export function canon(v: any): any {
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
/** The session row, the lobby row and the step rows (Undo rows left out), minus the turn clock and lastActivityAt. */
export function world(s: Lobby) {
    const sess = canon(session(s.test, s.lobbyId));
    delete sess.timerState.turnStartAt;
    delete sess.timerState.accumulatedPauseMs;
    const lob = canon(lobbyRow(s.test, s.lobbyId));
    delete lob.lastActivityAt;
    const rows = steps(s.test, s.lobbyId).filter((x) => x.action.tag !== 'Undo').sort((a, b) => a.sequence - b.sequence).map(canon);
    return { session: sess, lobby: lob, steps: rows };
}

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
