// Fixtures: undo (calls, the comparable snapshot of a lobby's draft), Classic turns and nominations of the undo and
//   draft-completion tests.
// From S10t (s10t-undo-any-step.test.ts); not a test file. Auction round helpers (nominatorOf, stepsOf, budgets) live
// in auction.ts.
import {
    M,
    lobbyRow,
    newHarness,
    priceBanNames,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Lobby,
    ONE_V_ONE,
    type Side,
} from './harness';
import { captain } from './draft-and-scoring';
import { nominatorOf } from './auction';

// ─── Texts ───────────────────────────────────────────────────────────────────

export const FINISHED = 'The draft is finished: undo works only while the lobby is in the draft stage.';

// ─── Builders ────────────────────────────────────────────────────────────────

export function lobby(lobbyArgs: Record<string, unknown> = {}): Lobby {
    return setupLobby(newHarness(), { seats: ONE_V_ONE, lobby: lobbyArgs });
}

export const undo = (s: Lobby) => tx(s.test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId }));
export const undoBody = (s: Lobby) => (ctx: any) => M.undo_last_step(ctx, { lobbyId: s.lobbyId });

/** The nominator's captain nominates `name`, priced in the lobby's set first (`ladder[e]` = cost at E`e`). */
export function nominate(s: Lobby, name: string, ladder: number | number[] = 0) {
    priceCharacters(s.test, s.lobbyId, [name], ladder);
    tx(s.test, captain(s, nominatorOf(s)), (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: name }));
}
export const pass = (s: Lobby, side: Side) => tx(s.test, captain(s, side), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));

// ─── The snapshot ────────────────────────────────────────────────────────────

const AUDIT_KEYS = new Set(['createdById', 'createdDate', 'lastModifiedById', 'lastModifiedDate']);

/** A comparable copy of a row: timestamps and bigints as strings, a unit enum as `{ tag }`, audit columns dropped. */
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

/** The session row, the lobby row and the draft's step rows (Undo rows left out), minus the turn clock and lastActivityAt. */
export function world(s: Lobby) {
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

export const stage = (s: Lobby) => lobbyRow(s.test, s.lobbyId).stage.tag;

/** One Classic turn by the acting captain: a priced pick (cost 3 for Blue, 0 for Red) or a priced ban. */
export function classicTurn(s: Lobby) {
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
export function playClassic(s: Lobby, left = 0) {
    while (stage(s) === 'Drafting' && session(s.test, s.lobbyId).turnIndex < session(s.test, s.lobbyId).draftSequence.length - left) classicTurn(s);
}
