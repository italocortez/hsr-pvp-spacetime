// Fixtures: the in-memory harness, actors and transactions, lobby setup, cost coverage and pricing, and the small
//   constants and helpers every subject shares (audit columns, seats, turn length, snapshots).
// From S4 (s4-fixtures.ts); shared constants gathered by T-REORG2.
//
// T-S4: shared builders for the S4 in-memory tests (lobby lifecycle, A22a referee-transfer check, A48 presence).
// Not a test file (no `.test.ts`). Everything runs in the SDK's in-memory datastore;
// nothing reaches maincloud. State is built through the module's own reducers; the clock is the TestClock.
import { expect } from 'vitest';
import { ConnectionId, TimeDuration, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth, TestClock } from 'spacetimedb/server/test-utils';
import spacetimedb from '@module/schema';
import * as M from '@module/index';
import { confirmHashOf, encodeBase64Url } from '@module/helpers/identity/linkCode';

export { M, TestAuth };
export const START = Timestamp.fromDate(new Date('2026-01-01T00:00:00Z'));
export const SYSTEM_USER_ID = 0;

/** The harness after `init`, with no cost rows at all (cost-set content tests that create no lobby on set 0). */
export function newBareHarness() {
    const test = createModuleTestHarness(spacetimedb, M, { clock: new TestClock(START) });
    // init as the owner: creates ServerIdentity(Owner) and the SYSTEM user the audit columns rely on.
    test.withReducerTx(TestAuth.internal(), (ctx) => M.init(ctx, {}));
    return test;
}

/** The default harness: newBareHarness plus the set-0 coverage rows (seedDefaultCostCoverage). */
export function newHarness() {
    const test = newBareHarness();
    seedDefaultCostCoverage(test);
    return test;
}
export type Harness = ReturnType<typeof newHarness>;

// ─── T-S10i fix pass (review F2, A108(2)): set-0 coverage rows ────────────────────────────────────────────────────
// The default cost set (id 0) is checked for coverage like any other set, so a lobby, preset or tournament on set 0
// needs at least one character and one light-cone cost row of its game mode and draft mode. The harness has no seed
// data, so newHarness writes one placeholder row of each for set 0 in every game mode and both draft modes, the
// minimum the selection guard reads. The character placeholder is EMPTY (always cost 0 by rule, so a manual or timer
// EMPTY pick is unchanged); the light-cone placeholder has no reference row and is never equipped. Tests that read
// the rows of set 0 (clones, row counts) or the timer pools drop them with dropDefaultCostCoverage once their lobbies
// exist, or start from newBareHarness.

export const COVERAGE_CHARACTER = 'EMPTY';
export const COVERAGE_LIGHTCONE = 'coverage-placeholder-lc';
const ALL_GAME_MODES = ['MemoryOfChaos', 'ApocalypticShadow', 'AnomalyArbitration'];
const ALL_DRAFT_MODES = ['Classic', 'Auction'];

export function seedDefaultCostCoverage(test: Harness) {
    const ts = test.clock.now();
    const audit = { createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts };
    for (const gameMode of ALL_GAME_MODES) {
        for (const draftMode of ALL_DRAFT_MODES) {
            test.db.HsrCharacterCost.insert({
                characterName: COVERAGE_CHARACTER, gameMode: { tag: gameMode }, draftMode: { tag: draftMode },
                costs: { e0: 0, e1: 0, e2: 0, e3: 0, e4: 0, e5: 0, e6: 0 }, costSetId: 0, ...audit,
            } as any);
            test.db.HsrLightconeCost.insert({
                lightconeName: COVERAGE_LIGHTCONE, gameMode: { tag: gameMode }, draftMode: { tag: draftMode },
                costs: { s1: 0, s2: 0, s3: 0, s4: 0, s5: 0 }, costSetId: 0, ...audit,
            } as any);
        }
    }
}

/** Removes the set-0 coverage rows (outside a transaction); lobbies already created on set 0 keep running. */
export function dropDefaultCostCoverage(test: Harness) {
    for (const r of [...test.db.HsrCharacterCost.cost_set_id.filter(0)]) {
        if (r.characterName === COVERAGE_CHARACTER) test.db.HsrCharacterCost.delete(r);
    }
    for (const r of [...test.db.HsrLightconeCost.cost_set_id.filter(0)]) {
        if (r.lightconeName === COVERAGE_LIGHTCONE) test.db.HsrLightconeCost.delete(r);
    }
}
/** The reducer context a `tx` body receives. */
export type Ctx = Parameters<Parameters<Harness['withReducerTx']>[1]>[0];

// ─── Shared constants and small helpers ──────────────────────────────────────────────────────────────────────────

/** The audit columns of a row written directly at `ts` (SYSTEM user). */
export const auditAt = (ts: Timestamp) => ({ createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts });
/** The audit columns of a row written directly now (the TestClock), SYSTEM user. */
export const AUDIT = (test: Harness) => {
    const ts = test.clock.now();
    return { createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts };
};

export type Team = 'Blue' | 'Red';
export type Side = Team;
export const other = (side: Side): Side => (side === 'Blue' ? 'Red' : 'Blue');
export const TURN_MS = 30_000; // DEFAULT_LOBBY_ARGS.standardTurnSeconds
export const AUCTION = { draftMode: { tag: 'Auction' } };
export const ONE_V_ONE: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['r1', 'RedPlayer']];
export const TWO_V_TWO: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];

/** A JSON snapshot of rows (bigint-safe), to prove "nothing changed" across a rejected call. */
export const snap = (...rows: unknown[]) => JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
/** Ascending numeric order (for `sort`). */
export const byId = (x: number, y: number) => x - y;

export interface Actor {
    sub: string;
    auth: TestAuth;
    identity: ReturnType<Harness['viewContext']>['sender'];
    userId: number;
}

let nextConnectionId = 1n;

/** A fresh client identity (JWT iss/sub) that logs in as a guest. */
export function guest(test: Harness, sub: string): Actor {
    const auth = TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(nextConnectionId++));
    test.withReducerTx(auth, (ctx) => M.login_as_guest(ctx, {}));
    const identity = test.viewContext(auth).sender;
    const userId = test.db.UserIdentity.identity.find(identity)!.userId;
    return { sub, auth, identity, userId };
}

export function tx<T>(test: Harness, actor: Actor | 'internal', body: (ctx: Ctx) => T): T {
    return test.withReducerTx(actor === 'internal' ? TestAuth.internal() : actor.auth, body);
}

/** Expects the reducer call to throw a message matching `msg` (the transaction is rolled back). */
export function expectReject(test: Harness, actor: Actor | 'internal', body: (ctx: Ctx) => unknown, msg: string | RegExp) {
    expect(() => tx(test, actor, body)).toThrow(msg);
}

/**
 * Runs the call, asserts it throws (the transaction is rolled back) and returns the message, so a test can check the
 * state first and the contract's exact text last: a text mismatch then reads as a text mismatch, not a behaviour one.
 */
export function rejection(test: Harness, actor: Actor | 'internal', body: (ctx: Ctx) => unknown): string {
    let message: string | undefined;
    try {
        tx(test, actor, body);
    } catch (e) {
        message = e instanceof Error ? e.message : String(e);
    }
    expect(message, 'the call was expected to be rejected').toBeDefined();
    return message!;
}

export const advance = (test: Harness, ms: number) => test.clock.advance(TimeDuration.fromMillis(ms));
export const now = (test: Harness) => test.clock.now().microsSinceUnixEpoch;

export const connect = (test: Harness, a: Actor) => tx(test, a, (ctx) => M.client_connected(ctx, {}));
export const disconnect = (test: Harness, a: Actor) => tx(test, a, (ctx) => M.client_disconnected(ctx, {}));

export function member(test: Harness, lobbyId: number, userId: number) {
    return [...test.db.LobbyMember.by_lobby_and_user.filter([lobbyId, userId])][0];
}
/**
 * T-S9c (A74): the seat number (`LobbyMember.joinSeq`) `userId` holds in the lobby; the six member-targeting reducers
 * take it. `src` is the harness outside a transaction, or the reducer `ctx` inside a `tx` body (reading `test.db`
 * inside `withReducerTx` crashes the in-memory datastore, S5 log note 6).
 */
export function seatOf(src: { db: any }, lobbyId: number, userId: number): number {
    const row = [...src.db.LobbyMember.by_lobby_and_user.filter([lobbyId, userId])][0] as { joinSeq: number } | undefined;
    if (!row) throw new Error(`seatOf: user ${userId} holds no row in lobby ${lobbyId}`);
    return row.joinSeq;
}
export const lobbyRow = (test: Harness, lobbyId: number) => test.db.Lobby.id.find(lobbyId)!;
export const session = (test: Harness, lobbyId: number) => test.db.MatchSession.lobbyId.find(lobbyId)!;
export const steps = (test: Harness, lobbyId: number) => [...test.db.MatchSessionStep.lobby_id.filter(lobbyId)];
export const pauseSteps = (test: Harness, lobbyId: number) => steps(test, lobbyId).filter((s) => s.action.tag === 'Pause');
export const checksFor = (test: Harness, lobbyId: number, userId: number) =>
    [...test.db.RefereeTransferCheck.by_lobby_and_user.filter([lobbyId, userId])];
export const refereeIds = (test: Harness, lobbyId: number) =>
    [...test.db.LobbyMember.lobby_id.filter(lobbyId)].filter((m) => m.isReferee).map((m) => m.userId);
export const captainOf = (test: Harness, lobbyId: number, slot: 'BluePlayer' | 'RedPlayer') =>
    [...test.db.LobbyMember.lobby_id.filter(lobbyId)].find((m) => m.lobbySlot.tag === slot && m.isCaptain);

type CheckRow = { scheduledId: bigint; scheduledAt: any; lobbyId: number; userId: number };

/** Fires the scheduled A22a check by hand, as the scheduler would (the row is consumed first). */
export function fireCheck(test: Harness, row: CheckRow) {
    test.db.RefereeTransferCheck.scheduledId.delete(row.scheduledId);
    tx(test, 'internal', (ctx) => M.run_referee_transfer_check(ctx, { arg: row }));
}

/** The single pending check for (lobby, user); fails the test if there is not exactly one. */
export function pendingCheck(test: Harness, lobbyId: number, userId: number): CheckRow {
    const rows = checksFor(test, lobbyId, userId);
    expect(rows).toHaveLength(1);
    return rows[0];
}

// ─── T-M5a3: signing in the real way (request, present as the linker, confirm) ───────────────────────────────────

/**
 * A stable, valid Discord id (a snowflake: 18 digits) from a readable label, so tests keep names like
 * `discordId('fresh')` instead of literals. FNV-1a 64-bit over the label, folded into [1e17, 1e18). A label that is
 * already a valid id (17 to 20 digits) is returned as it is.
 */
export function discordId(label: string): string {
    if (/^[0-9]{17,20}$/.test(label)) return label;
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < label.length; i++) {
        h ^= BigInt(label.charCodeAt(i));
        h = BigInt.asUintN(64, h * 0x100000001b3n);
    }
    return String(100_000_000_000_000_000n + (h % 900_000_000_000_000_000n));
}

/** The fixed client nonce and confirm token of linkDiscord (the code still differs per identity). */
export const TEST_CLIENT_NONCE = 'T'.repeat(42) + 'A';
export const TEST_CONFIRM_TOKEN = encodeBase64Url(new Uint8Array(32).fill(7));
export const TEST_CONFIRM_HASH = confirmHashOf(TEST_CONFIRM_TOKEN);

const linkers = new WeakMap<object, TestAuth>();

/** The harness's Linker identity (registered by the owner on first use), as the auth function would act. */
export function linkerAuth(test: Harness): TestAuth {
    let auth = linkers.get(test);
    if (!auth) {
        auth = TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub: 'linker-function' }), new ConnectionId(nextConnectionId++));
        const identityHex = test.viewContext(auth).sender.toHexString();
        test.withReducerTx(TestAuth.internal(), (ctx) => M.server_register_linker(ctx, { identityHex, label: 'vercel-link-test' }));
        linkers.set(test, auth);
    }
    return auth;
}

/**
 * T-M5a3: signs `a` in with the Discord account `providerId` the real way (the removed server_link_provider did this in
 * one call): request_link_code as `a`, linker_present_code as the linker, confirm_link as `a`. Links (Case 1a) or
 * re-points (Case 1b) `a`'s identity exactly as before; `a.userId` follows. Throws the refusal of whichever step
 * refuses (a ban or the live-game rule at presentation, an already linked account at the request).
 */
export function linkDiscord(test: Harness, a: Actor, providerId: string, name: string) {
    test.withReducerTx(a.auth, (ctx) => M.request_link_code(ctx, { clientNonce: TEST_CLIENT_NONCE }));
    const code = test.db.LinkRequest.identity.find(a.identity)!.code;
    test.withReducerTx(linkerAuth(test), (ctx) => M.linker_present_code(ctx, {
        linkCode: code, provider: 'discord', providerId, providerName: name, confirmHash: TEST_CONFIRM_HASH,
    }));
    test.withReducerTx(a.auth, (ctx) => M.confirm_link(ctx, { confirmToken: TEST_CONFIRM_TOKEN }));
    a.userId = test.db.UserIdentity.identity.find(a.identity)!.userId;
}

export const DEFAULT_LOBBY_ARGS = {
    // T-S10n (A114 / A116): joinCode and presetId are no longer create_lobby arguments.
    teamSize: 2,
    draftMode: { tag: 'Classic' },
    banMode: { tag: 'None' },
    gameMode: { tag: 'MemoryOfChaos' },
    matchType: { tag: 'Casual' },
    isPublic: true,
    password: '',
    standardTurnSeconds: 30,
    // T-S10aa (A148): 0 = no reserve, the turn-only clock these suites were written against; reserve-time tests set it.
    reserveBankSeconds: 0,
    characterBudget: 100,
    lightconeBudget: 50,
    minimumBidRaise: 1,
    rosterDiffAdvantage: 0,
    rosterThreshold: 0,
    underThresholdAdvantage: 0,
    aboveThresholdPenalty: 0,
    deathPenalty: 0,
    isAnonymousPlayers: false,
    isAnonymousSpectators: false,
    rosterVisibility: { tag: 'OpenRoster' },
    requireOwnership: false,
    costSetId: 0,
    disconnectPolicy: { tag: 'Standard' },
    disconnectForfeitSeconds: 60,
    allowMirrorPicks: false,
    autoRandomPick: false,
    refereeCanUndo: true,
    refereeCanPause: true,
    refereeCanSetCaptain: true,
    refereeCanKick: true,
    allowPlayerPause: true,
    teamBlueAlias: 'Blue',
    teamRedAlias: 'Red',
    // T-S8e (A67(2)): bestOf / refereeControlsShelving / bestOfNAdvantage are no longer create_lobby arguments.
};

export type SlotTag = 'BluePlayer' | 'BlueCoach' | 'RedPlayer' | 'RedCoach' | 'Spectator';

export interface SetupOpts {
    /** create_lobby argument overrides (enum values as `{ tag }`). */
    lobby?: Record<string, unknown>;
    /** Members joined in this order (join order = joinSeq order), with their slot. Default: b1, b2 Blue; r1, r2 Red. */
    seats?: Array<[name: string, slot: SlotTag]>;
    /** The host's own slot (default Spectator: the exclusive spectator referee). */
    hostSlot?: SlotTag;
    /** Pre-created actors to reuse by name (e.g. a user linked to two devices). */
    actors?: Record<string, Actor>;
    /** Runs in Waiting after the seats are taken, before start_draft. */
    beforeStart?: (s: Lobby) => void;
    /** Stop in Waiting (no start_draft). */
    noStart?: boolean;
}

export interface Lobby {
    test: Harness;
    lobbyId: number;
    host: Actor;
    a: Record<string, Actor>;
}

/** Host creates the lobby; seats join in order and take their slots; players confirm; host starts the draft. */
export function setupLobby(test: Harness, opts: SetupOpts = {}): Lobby {
    const seats = opts.seats ?? [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];
    const a: Record<string, Actor> = { ...(opts.actors ?? {}) };
    const host = a.host ?? guest(test, 'host');
    a.host = host;
    for (const [name] of seats) a[name] ??= guest(test, name);

    tx(test, host, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...(opts.lobby ?? {}) } as any));
    const lobbyId = [...test.db.Lobby.iter()].find((l) => l.hostUserId === host.userId)!.id;

    const takeSlot = (who: Actor, slot: SlotTag) => {
        if (slot === 'Spectator') return;
        const isCoach = slot === 'BlueCoach' || slot === 'RedCoach';
        // Coaches are assigned by the host (not self-assignable).
        // T-S9c (A74(1)): the host targets the coach's seat; a self-move omits the seat.
        tx(test, isCoach ? host : who, (ctx) =>
            M.set_team_slot(ctx, {
                lobbyId,
                ...(isCoach ? { targetJoinSeq: seatOf(ctx, lobbyId, who.userId) } : {}),
                lobbySlot: { tag: slot } as any,
            }),
        );
        if (!isCoach) tx(test, who, (ctx) => M.confirm_ready(ctx, { lobbyId }));
    };

    takeSlot(host, opts.hostSlot ?? 'Spectator');
    for (const [name, slot] of seats) {
        tx(test, a[name], (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password: '' }));
        takeSlot(a[name], slot);
    }
    const s: Lobby = { test, lobbyId, host, a };
    opts.beforeStart?.(s);
    if (!opts.noStart) tx(test, refereeActor(s), (ctx) => M.start_draft(ctx, { lobbyId }));
    return s;
}

/**
 * T-S10b (A80): the actor holding the lobby's referee flag (start_draft / advance_stage are referee powers); the host
 * when no named actor holds it.
 */
export function refereeActor(s: Lobby): Actor {
    const refId = refereeIds(s.test, s.lobbyId)[0];
    return Object.values(s.a).find((x) => x.userId === refId) ?? s.host;
}

/**
 * T-S10t (A129): the lobby's draft is complete while the stage is still Drafting (the last pick or sale no longer moves
 * the lobby): Classic, every turn of the sequence played; Auction, the auction phase open and both teams holding
 * charactersPerTeam characters (8 Halves, 12 Thirds).
 */
export function draftDone(test: Harness, lobbyId: number): boolean {
    const sess = test.db.MatchSession.lobbyId.find(lobbyId);
    const l = test.db.Lobby.id.find(lobbyId);
    if (!sess || !l || l.stage.tag !== 'Drafting') return false;
    if (l.draftMode.tag === 'Classic') return sess.turnIndex >= sess.draftSequence.length;
    const perTeam = l.lineupFormat.tag === 'Thirds' ? 12 : 8;
    return sess.isAuctionPhase && sess.blueCharactersWon >= perTeam && sess.redCharactersWon >= perTeam;
}

/** T-S10t (A129): after the last pick or sale, the referee's advance_stage moves the complete draft to Equipping. */
export function advanceToEquipping(s: Lobby, who: Actor = refereeActor(s)) {
    tx(s.test, who, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
}

// ─── T-S10i (A107(1)(5), A108): prices for the names a test drafts ────────────────────────────────────────────────
// Every pick, nomination, bid, set_eidolon and equip reads the lobby's own cost set, game mode and draft mode, and an
// entry with no row there is rejected ("<name> has no cost in this lobby's cost set."). The drivers seed the reference
// row (HsrCharacter / HsrLightcone) and an explicit cost row for every name they use, at cost 0 unless the key already
// has a row (a test that asserts prices seeds them first; a priced-at-0 entry is legal). `src` is the harness outside a
// transaction (test.db), or the reducer ctx inside a `tx` body (reading test.db inside withReducerTx crashes the
// datastore), so a local call helper can price its name in the same transaction as the call. EMPTY / SKIP are never
// seeded.

type Src = { db: any; clock?: { now(): any }; timestamp?: any };
const AUDIT0 = (src: Src) => {
    const ts = src.timestamp ?? src.clock!.now();
    return { createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts };
};

/** An HsrCharacter reference row for `name` (5-star Hunt Fire Dps), unless one exists. */
export function ensureCharacterRef(src: Src, name: string) {
    if (src.db.HsrCharacter.name.find(name)) return;
    src.db.HsrCharacter.insert({
        name, displayName: name, aliases: [], rarity: 5, path: { tag: 'Hunt' }, element: { tag: 'Fire' }, role: { tag: 'Dps' },
        imageUrl: '', versionReleased: 1, treatAsVersion: 1, posX: 0, posY: 0, width: 0, ...AUDIT0(src),
    } as any);
}

/** An HsrLightcone reference row for `name` (5-star Destruction), unless one exists. */
export function ensureLightconeRef(src: Src, name: string) {
    if (src.db.HsrLightcone.name.find(name)) return;
    src.db.HsrLightcone.insert({
        name, displayName: name, aliases: [], path: { tag: 'Destruction' }, rarity: 5, imageUrl: '', posX: 0, posY: 0, width: 0,
        ...AUDIT0(src),
    } as any);
}

export interface CostKey { costSetId: number; gameMode: string; draftMode: string }

/** The cost key a lobby reads (A107(1)): its cost set, game mode and draft mode. */
export function costKeyOf(src: Src, lobbyId: number): CostKey {
    const l = src.db.Lobby.id.find(lobbyId)!;
    return { costSetId: l.costSetId, gameMode: l.gameMode.tag, draftMode: l.draftMode.tag };
}

/** A character cost row for `key` with one cost per eidolon (`ladder[e]`), unless the key already has a row. */
export function priceCharacterAt(src: Src, key: CostKey, name: string, ladder: number[] | number = 0) {
    if (name === 'EMPTY' || name === 'SKIP') return;
    ensureCharacterRef(src, name);
    const exists = [...src.db.HsrCharacterCost.cost_set_id.filter(key.costSetId)].some(
        (r: any) => r.characterName === name && r.gameMode.tag === key.gameMode && r.draftMode.tag === key.draftMode);
    if (exists) return;
    const l = typeof ladder === 'number' ? Array(7).fill(ladder) : ladder;
    src.db.HsrCharacterCost.insert({
        characterName: name, gameMode: { tag: key.gameMode }, draftMode: { tag: key.draftMode },
        costs: { e0: l[0], e1: l[1], e2: l[2], e3: l[3], e4: l[4], e5: l[5], e6: l[6] }, costSetId: key.costSetId,
        ...AUDIT0(src),
    } as any);
}

/** A light-cone cost row for `key` (one cost per superimposition, `ladder[s - 1]`), unless the key already has a row. */
export function priceLightconeAt(src: Src, key: CostKey, name: string, ladder: number[] | number = 0) {
    ensureLightconeRef(src, name);
    const exists = [...src.db.HsrLightconeCost.cost_set_id.filter(key.costSetId)].some(
        (r: any) => r.lightconeName === name && r.gameMode.tag === key.gameMode && r.draftMode.tag === key.draftMode);
    if (exists) return;
    const l = typeof ladder === 'number' ? Array(5).fill(ladder) : ladder;
    src.db.HsrLightconeCost.insert({
        lightconeName: name, gameMode: { tag: key.gameMode }, draftMode: { tag: key.draftMode },
        costs: { s1: l[0], s2: l[1], s3: l[2], s4: l[3], s5: l[4] }, costSetId: key.costSetId,
        ...AUDIT0(src),
    } as any);
}

/** Prices characters (cost 0 unless already priced) in the lobby's cost set, game mode and draft mode (no-op without the lobby). */
export function priceCharacters(src: Src, lobbyId: number, names: string[], cost: number | number[] = 0) {
    if (!src.db.Lobby.id.find(lobbyId)) return;
    const key = costKeyOf(src, lobbyId);
    for (const n of names) priceCharacterAt(src, key, n, cost);
}

/** Prices light cones (cost 0 unless already priced) in the lobby's cost set, game mode and draft mode (no-op without the lobby). */
export function priceLightcones(src: Src, lobbyId: number, names: string[], cost: number | number[] = 0) {
    if (!src.db.Lobby.id.find(lobbyId)) return;
    const key = costKeyOf(src, lobbyId);
    for (const n of names) priceLightconeAt(src, key, n, cost);
}

/**
 * T-S10r (A122(7), L32): a ban names a character of the lobby's pool (a cost row in the lobby's cost set, game mode and
 * draft mode, as picks). Prices `names` there at 0 (unless already priced) WITHOUT writing an HsrCharacter reference
 * row, so a ban-restriction test keeps its own role rows (a name with no reference row has no role). EMPTY / SKIP are
 * never priced. `src` as for priceCharacters (test.db outside a transaction, the reducer ctx inside one).
 */
export function priceBanNames(src: Src, lobbyId: number, names: string[]) {
    if (!src.db.Lobby.id.find(lobbyId)) return;
    const key = costKeyOf(src, lobbyId);
    for (const name of names) {
        if (name === 'EMPTY' || name === 'SKIP') continue;
        const exists = [...src.db.HsrCharacterCost.cost_set_id.filter(key.costSetId)].some(
            (r: any) => r.characterName === name && r.gameMode.tag === key.gameMode && r.draftMode.tag === key.draftMode);
        if (exists) continue;
        src.db.HsrCharacterCost.insert({
            characterName: name, gameMode: { tag: key.gameMode }, draftMode: { tag: key.draftMode },
            costs: { e0: 0, e1: 0, e2: 0, e3: 0, e4: 0, e5: 0, e6: 0 }, costSetId: key.costSetId, ...AUDIT0(src),
        } as any);
    }
}

/** Adds a spectator after the draft started (new joins are allowed in Drafting as Spectator). */
export function joinAsSpectator(s: Lobby, name: string): Actor {
    const who = guest(s.test, name);
    tx(s.test, who, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
    s.a[name] = who;
    return who;
}
