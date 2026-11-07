// T-S4: shared builders for the S4 in-memory tests (lobby lifecycle, A22a referee-transfer check, A48 presence).
// Not a test file (no `.test.ts`): imported by s4-*.test.ts. Everything runs in the SDK's in-memory datastore;
// nothing reaches maincloud. State is built through the module's own reducers; the clock is the TestClock.
import { expect } from 'vitest';
import { ConnectionId, TimeDuration, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth, TestClock } from 'spacetimedb/server/test-utils';
import spacetimedb from '../schema';
import * as M from '../index';

export { M, TestAuth };
export const START = Timestamp.fromDate(new Date('2026-01-01T00:00:00Z'));
export const SYSTEM_USER_ID = 0;

export function newHarness() {
    const test = createModuleTestHarness(spacetimedb, M, { clock: new TestClock(START) });
    // init as the owner: creates ServerIdentity(Owner) and the SYSTEM user the audit columns rely on.
    test.withReducerTx(TestAuth.internal(), (ctx) => M.init(ctx, {}));
    return test;
}
export type Harness = ReturnType<typeof newHarness>;
type Ctx = Parameters<Parameters<Harness['withReducerTx']>[1]>[0];

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

export const advance = (test: Harness, ms: number) => test.clock.advance(TimeDuration.fromMillis(ms));
export const now = (test: Harness) => test.clock.now().microsSinceUnixEpoch;

export const connect = (test: Harness, a: Actor) => tx(test, a, (ctx) => M.client_connected(ctx, {}));
export const disconnect = (test: Harness, a: Actor) => tx(test, a, (ctx) => M.client_disconnected(ctx, {}));

export function member(test: Harness, lobbyId: number, userId: number) {
    return [...test.db.LobbyMember.by_lobby_and_user.filter([lobbyId, userId])][0];
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

/** server_link_provider as the owner: links (or re-points) `a`'s identity to the user that owns `providerId`. */
export function linkDiscord(test: Harness, a: Actor, providerId: string, name: string) {
    tx(test, 'internal', (ctx) =>
        M.server_link_provider(ctx, {
            callerIdentityHex: a.identity.toHexString(),
            provider: 'discord',
            providerId,
            providerName: name,
        }),
    );
    a.userId = test.db.UserIdentity.identity.find(a.identity)!.userId;
}

export const DEFAULT_LOBBY_ARGS = {
    joinCode: '',
    presetId: 0,
    teamSize: 2,
    draftMode: { tag: 'Classic' },
    banMode: { tag: 'None' },
    gameMode: { tag: 'MemoryOfChaos' },
    matchType: { tag: 'Casual' },
    isPublic: true,
    password: '',
    standardTurnSeconds: 30,
    reserveBankSeconds: 60,
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
    bestOf: 1,
    refereeControlsShelving: true,
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
        tx(test, isCoach ? host : who, (ctx) =>
            M.set_team_slot(ctx, { lobbyId, targetUserId: who.userId, lobbySlot: { tag: slot } as any }),
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
    if (!opts.noStart) tx(test, host, (ctx) => M.start_draft(ctx, { lobbyId }));
    return s;
}

/** Adds a spectator after the draft started (new joins are allowed in Drafting as Spectator). */
export function joinAsSpectator(s: Lobby, name: string): Actor {
    const who = guest(s.test, name);
    tx(s.test, who, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
    s.a[name] = who;
    return who;
}
