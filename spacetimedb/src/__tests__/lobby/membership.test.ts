// Lobby: membership (Leave as a disconnect, away and abandoned rows, kicks, bans, spectators, the GC presence
//   test).
// Decisions: A22, A68
// Contracts: docs/lobby/contract.md
// From S8f (s8f-membership.test.ts).
//
// T-S8f: in-memory tests for step S8f, the lobby membership rules of DECISIONS A68 (with A22 / A22a, A48, A67(1),
// A70(1)). Leave in a live stage is a disconnect (away row, leftAt); no automatic forfeit; an away player may take
// another lobby at the cost of the first (abandonCurrentMatch → abandonedAt); spectators / coaches are free when they
// leave; players are never removed after the draft starts; a lobby with members always has a host and a referee;
// spectators may join while a match runs, up to Lobby.maxSpectators; the GC presence test covers Waiting.
// Everything runs through the module's reducers on the SDK's in-memory datastore and TestClock; the A22a scheduler is
// driven by hand (fireCheck), as in the S4 suites. Builders: s4 / s7 / s8 / s8d fixtures. Nothing reaches maincloud.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    captainOf,
    checksFor,
    connect,
    disconnect,
    expectReject,
    fireCheck,
    guest,
    joinAsSpectator,
    lobbyRow,
    member,
    newHarness,
    now,
    pendingCheck,
    refereeIds,
    session,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SetupOpts,
    seatOf,
} from '../fixtures/harness';
import { verified, displayName } from '../fixtures/identity';
import { completeDraft, recordOf } from '../fixtures/draft-and-scoring';
import {
    join,
    NO_PLAYER_REMOVAL,
    leave,
    lmaRows,
    members,
    settingsArgs,
    PRESET_ARGS,
    NOT_ELIGIBLE_START,
} from '../fixtures/lobby';
import { liveField, matchRow, tRow } from '../fixtures/tournaments';
import {
    byKey,
    deferredDuel,
    duel,
    playLobbyGame,
    createTournamentLobby,
    openMatchLobby,
    recordsOfLobby,
    sidesOf,
    SEAT,
} from '../fixtures/tournament-matches';
import { parkedLobby } from '../fixtures/ranked';

// ─── Messages (the module code is the truth) ─────────────────────────────────

const ALREADY_IN = 'You are already in a lobby. Leave it before creating or joining another.';
const PROMPT = (code: string) => `You left lobby ${code} mid-match. Joining here means you cannot return to it.`;
const GONE = 'You abandoned this match and cannot return.';
const MAX_SPEC_RANGE = 'maxSpectators must be between 0 and 12.';
const SPEC_FULL = (n: number) => `Spectator slots are full (max ${n}).`;
const LEAVE_FIRST = 'Leave your lobby before deleting your account.';

// ─── Builders ────────────────────────────────────────────────────────────────

const rejoin = (test: Harness, who: Actor, lobbyId: number, abandonCurrentMatch?: boolean) =>
    tx(test, who, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password: '', abandonCurrentMatch }));
const createCasual = (test: Harness, who: Actor, over: Record<string, unknown> = {}) =>
    tx(test, who, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...over } as any));
const hostedBy = (test: Harness, who: Actor) => [...test.db.Lobby.iter()].filter((l) => l.hostUserId === who.userId);
const claim = (test: Harness, who: Actor, lobbyId: number, side = 0) =>
    tx(test, who, (ctx) => M.claim_forfeit(ctx, { lobbyId, forfeitingTeamSide: side }));
const advanceStageOf = (test: Harness, s: Lobby) => tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
const kick = (test: Harness, by: Actor, lobbyId: number, target: Actor) =>
    tx(test, by, (ctx) => M.kick_member(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, target.userId) }));
const ban = (test: Harness, by: Actor, lobbyId: number, target: Actor) =>
    tx(test, by, (ctx) => M.ban_member(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, target.userId) }));
const gc = (test: Harness) => tx(test, 'internal', (ctx) => M.admin_gc_lobbies(ctx, {}));
const chat = (test: Harness, lobbyId: number) => [...test.db.ChatMessage.lobby_id.filter(lobbyId)].map((c) => c.content);

/** One HSR account link per named member, written straight into the datastore (guests own no accounts). */
function giveAccounts(s: Lobby, names: string[]) {
    let id = 900;
    for (const n of names) s.test.db.LobbyMemberAccount.insert({ lobbyId: s.lobbyId, userId: s.a[n].userId, hsrAccountId: id++ });
}

/** The host plays Red, so there is no exclusive spectator referee and players may claim / defer (D-81). */
const noReferee = (over: SetupOpts = {}): SetupOpts => ({
    hostSlot: 'RedPlayer',
    seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer']],
    ...over,
});

// T-S10d (A91(2)): parkedLobby (s10-a2-fixtures) parks a standalone lobby through a submitted Ranked game; the local
// Deferred + defer_match builder is gone (Deferred is tournament-only).

/**
 * T-S10d (A91(2)): a live lobby under `policy`: a casual setupLobby for Standard / NoAction; for Deferred, the lobby of
 * a Deferred tournament (deferredDuel: b1 / b2 Blue, r1 / r2 Red, the organizer as host and Spectator referee).
 * `b1` replaces the Blue captain's actor in a casual lobby (a tournament player is already verified).
 */
function policyLobby(policy: 'Standard' | 'Deferred' | 'NoAction', b1?: (test: Harness) => Actor): { test: Harness; s: Lobby } {
    if (policy === 'Deferred') {
        const { f, s } = deferredDuel();
        return { test: f.test, s };
    }
    const test = newHarness();
    const actors = b1 ? { b1: b1(test) } : undefined;
    return { test, s: setupLobby(test, { actors, lobby: { disconnectPolicy: { tag: policy } } }) };
}

/** A68(7): a lobby that keeps members always has a host (a member) and exactly one referee. */
function expectFlagsHeld(test: Harness, lobbyId: number) {
    const lobby = test.db.Lobby.id.find(lobbyId);
    if (!lobby) return;
    const ms = members(test, lobbyId);
    if (ms.length === 0) return;
    expect(ms.some((m) => m.userId === lobby.hostUserId), 'host is a member').toBe(true);
    expect(ms.filter((m) => m.isReferee), 'one referee').toHaveLength(1);
}

/** Moves a lobby to a live stage by the host referee (A67(1)). */
function toStage(test: Harness, s: Lobby, stage: 'Drafting' | 'Equipping' | 'Scoring') {
    const order = ['Drafting', 'Equipping', 'Scoring'];
    while (lobbyRow(test, s.lobbyId).stage.tag !== stage) {
        expect(order.indexOf(lobbyRow(test, s.lobbyId).stage.tag)).toBeLessThan(order.indexOf(stage));
        // T-S10i (A100): the draft is finished through the reducers (automatic Drafting → Equipping); only
        // Equipping → Scoring is a manual advance.
        if (lobbyRow(test, s.lobbyId).stage.tag === 'Drafting') completeDraft(s);
        else advanceStageOf(test, s);
    }
}

// ─── A68(1)(2): Leave is a disconnect ────────────────────────────────────────

describe('A68(1)(2): a player\'s Leave in a live stage is a disconnect', () => {
    for (const stage of ['Drafting', 'Equipping', 'Scoring'] as const) {
        for (const policy of ['Standard', 'Deferred', 'NoAction'] as const) {
            it(`${stage} / ${policy}: row kept, offline, leftAt; disconnectedAt ${policy === 'NoAction' ? 'not ' : ''}stamped; 15 s check; LMA rows and count unchanged`, () => {
                const { test, s } = policyLobby(policy); // T-S10d (A91(2)): Deferred = a Deferred tournament's lobby
                giveAccounts(s, ['b1', 'b2', 'r1', 'r2']);
                toStage(test, s, stage);
                const countBefore = lobbyRow(test, s.lobbyId).currentPlayerCount;
                advance(test, 2_000);

                leave(test, s.a.b1, s.lobbyId);

                const m = member(test, s.lobbyId, s.a.b1.userId);
                expect(m).toBeDefined();
                expect(m.lobbySlot.tag).toBe('BluePlayer');
                expect(m.isOnline).toBe(false);
                expect(m.leftAt?.microsSinceUnixEpoch).toBe(now(test));
                expect(m.abandonedAt).toBeUndefined();
                if (policy === 'NoAction') expect(m.disconnectedAt).toBeUndefined();
                else expect(m.disconnectedAt?.microsSinceUnixEpoch).toBe(now(test));
                pendingCheck(test, s.lobbyId, s.a.b1.userId);
                expect(lmaRows(test, s.lobbyId, s.a.b1.userId)).toHaveLength(1);
                expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(countBefore);
                expect(lobbyRow(test, s.lobbyId).stage.tag).toBe(stage);
                expect(chat(test, s.lobbyId)).toContain(`${displayName(test, s.a.b1)} left the match.`);
            });
        }
    }

    it('the last players of a team leaving never concede (A68(3)): match live, record Pending, no Concede', () => {
        const test = newHarness();
        const s = setupLobby(test);
        leave(test, s.a.b1, s.lobbyId);
        leave(test, s.a.b2, s.lobbyId);
        for (const n of ['b1', 'b2']) {
            advance(test, 15_000);
            fireCheck(test, pendingCheck(test, s.lobbyId, s.a[n].userId));
        }
        advance(test, 10 * 60_000);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        const rec = recordOf(test, s.lobbyId);
        expect(rec.status.tag).toBe('Pending');
        expect(rec.matchEndReason).toBeUndefined();
        expect(rec.winnerTeamSide).toBeUndefined();
    });

    it('after 15 s away the flags move (A22(5)): host + referee + captain of a host who plays Blue go to the first online Blue player', () => {
        const test = newHarness();
        const s = setupLobby(test, { hostSlot: 'BluePlayer', seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] });
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(s.host.userId);
        leave(test, s.host, s.lobbyId);
        // Nothing moves at the Leave itself (A68(7): an away player loses the flags through the 15 s check).
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.host.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);

        advance(test, 15_000);
        fireCheck(test, pendingCheck(test, s.lobbyId, s.host.userId));
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.b1.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b1.userId]);
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(s.a.b1.userId);
        expectFlagsHeld(test, s.lobbyId);
    });

    it('the pool drains while away: return after 5 s through join_lobby → pool charged, leftAt cleared, online, "{name} is back."', () => {
        const test = newHarness();
        const s = setupLobby(test);
        leave(test, s.a.b1, s.lobbyId);
        advance(test, 5_000);
        rejoin(test, s.a.b1, s.lobbyId);
        const m = member(test, s.lobbyId, s.a.b1.userId);
        expect(m.isOnline).toBe(true);
        expect(m.leftAt).toBeUndefined();
        expect(m.disconnectedAt).toBeUndefined();
        expect(m.disconnectPoolRemainingMs).toBe(300_000 - 5_000);
        expect(chat(test, s.lobbyId)).toContain(`${displayName(test, s.a.b1)} is back.`);
    });

    it('client_connected does not restore an away row; the 15 s check still treats it offline (pause, captain moves); join_lobby returns and auto-resumes', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const cap = captainOf(test, s.lobbyId, 'BluePlayer')!;
        const leaver = cap.userId === s.a.b1.userId ? s.a.b1 : s.a.b2;
        const mate = leaver === s.a.b1 ? s.a.b2 : s.a.b1;

        leave(test, leaver, s.lobbyId);
        connect(test, leaver); // the leaver reloads the site: a live presence row
        expect(test.db.UserPresence.identity.find(leaver.identity)?.isOnline).toBe(true);
        const m = member(test, s.lobbyId, leaver.userId);
        expect(m.isOnline).toBe(false);
        expect(m.leftAt).toBeDefined();
        expect(checksFor(test, s.lobbyId, leaver.userId)).toHaveLength(1);

        advance(test, 15_000);
        fireCheck(test, pendingCheck(test, s.lobbyId, leaver.userId));
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(true);
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(mate.userId);

        rejoin(test, leaver, s.lobbyId);
        expect(member(test, s.lobbyId, leaver.userId).isOnline).toBe(true);
        expect(member(test, s.lobbyId, leaver.userId).leftAt).toBeUndefined();
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(false);
        // Flags never return automatically to the original holder.
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(mate.userId);
    });

    it('client_disconnected leaves an away row alone (its stamp and pending check are kept)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        leave(test, s.a.b1, s.lobbyId);
        const stamp = member(test, s.lobbyId, s.a.b1.userId).disconnectedAt!.microsSinceUnixEpoch;
        const check = pendingCheck(test, s.lobbyId, s.a.b1.userId);
        advance(test, 4_000);
        disconnect(test, s.a.b1);
        expect(member(test, s.lobbyId, s.a.b1.userId).disconnectedAt!.microsSinceUnixEpoch).toBe(stamp);
        expect(pendingCheck(test, s.lobbyId, s.a.b1.userId).scheduledId).toBe(check.scheduledId);
    });
});

describe('A68(5): a spectator\'s or coach\'s Leave deletes the row in every stage', () => {
    const coachOpts = (test: Harness, opts: SetupOpts = {}): SetupOpts => ({
        ...opts,
        beforeStart: (l) => {
            for (const name of ['spec', 'coach']) {
                l.a[name] = guest(test, name);
                rejoin(test, l.a[name], l.lobbyId);
            }
            tx(test, l.host, (ctx) => M.set_team_slot(ctx, { lobbyId: l.lobbyId, targetJoinSeq: seatOf(ctx, l.lobbyId, l.a.coach.userId), lobbySlot: { tag: 'BlueCoach' } as any }));
            giveAccounts(l, ['spec', 'coach']);
        },
    });
    const withCoach = (test: Harness, opts: SetupOpts = {}) => setupLobby(test, coachOpts(test, opts));

    const expectGone = (test: Harness, s: Lobby) => {
        for (const name of ['spec', 'coach']) {
            const count = lobbyRow(test, s.lobbyId).currentPlayerCount;
            leave(test, s.a[name], s.lobbyId);
            expect(member(test, s.lobbyId, s.a[name].userId), name).toBeUndefined();
            expect(lmaRows(test, s.lobbyId, s.a[name].userId), name).toHaveLength(0);
            expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(count - 1);
            expectFlagsHeld(test, s.lobbyId);
        }
        // Free at once (A68(5)): each may create a lobby of their own.
        for (const name of ['spec', 'coach']) createCasual(test, s.a[name]);
    };

    it('Waiting', () => {
        const test = newHarness();
        expectGone(test, withCoach(test, { noStart: true }));
    });
    it('Drafting', () => {
        const test = newHarness();
        expectGone(test, withCoach(test));
    });
    it('Scoring', () => {
        const test = newHarness();
        const s = withCoach(test);
        toStage(test, s, 'Scoring');
        expectGone(test, s);
    });
    it('AwaitingResult', () => {
        const test = newHarness();
        const s = parkedLobby(test, coachOpts(test)); // T-S10d (A91(2)): parked through a submitted Ranked game
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expectGone(test, s);
    });
});

// ─── A68(3): no automatic forfeit ────────────────────────────────────────────

describe('A68(3): absence runs only through claim_forfeit / defer_match / concede', () => {
    it('every Blue player away: an opposing player\'s claim is rejected inside the grace, accepted after it', () => {
        const test = newHarness();
        const s = setupLobby(test, noReferee());
        leave(test, s.a.b1, s.lobbyId);
        leave(test, s.a.b2, s.lobbyId);
        advance(test, 30_000);
        expectReject(test, s.a.r1, (ctx) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 0 }), NOT_ELIGIBLE_START);
        advance(test, 31_000);
        claim(test, s.a.r1, s.lobbyId);
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy(); // a casual concede finalizes inline
    });

    it('pool 0: eligible at once, before the grace (the pool was spent on an earlier absence)', () => {
        const test = newHarness();
        const s = setupLobby(test, noReferee({ lobby: { disconnectForfeitSeconds: 600 } }));
        for (const n of ['b1', 'b2']) leave(test, s.a[n], s.lobbyId);
        advance(test, 301_000);
        for (const n of ['b1', 'b2']) rejoin(test, s.a[n], s.lobbyId);
        for (const n of ['b1', 'b2']) expect(member(test, s.lobbyId, s.a[n].userId).disconnectPoolRemainingMs).toBe(0);
        for (const n of ['b1', 'b2']) leave(test, s.a[n], s.lobbyId);
        advance(test, 1_000);
        claim(test, s.a.r1, s.lobbyId);
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
    });

    it('the exclusive referee naming the side is accepted after the grace', () => {
        const test = newHarness();
        const s = setupLobby(test);
        leave(test, s.a.b1, s.lobbyId);
        leave(test, s.a.b2, s.lobbyId);
        expectReject(test, s.a.r1, (ctx) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 0 }),
            'Only the referee can claim forfeit when referee exclusive concede is active.');
        advance(test, 61_000);
        claim(test, s.host, s.lobbyId, 1);
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
    });

    it('Deferred: the other team may defer_match to staff while the Blue team is away', () => {
        // T-S10d (A91(1)(2)): a Deferred tournament's lobby created by the Red captain (seated referee: no exclusive
        // Spectator referee, so a player may defer); the Blue team is away past the grace before the defer.
        const f = duel({ defaultBestOf: 1, grandFinalBestOf: 1, disconnectPolicy: 'Deferred' });
        const { test } = f;
        const m = byKey(test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id, { creator: sidesOf(f, m.id).red.captain });
        expect(s.a.r1.userId).toBe(s.host.userId);
        leave(test, s.a.b1, s.lobbyId);
        leave(test, s.a.b2, s.lobbyId);
        advance(test, 61_000);
        tx(test, s.a.r1, (ctx) => M.defer_match(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(recordOf(test, s.lobbyId).concedeSummary).toContain(`User#${s.a.b1.userId}`);
    });

    it('NoAction: claim_forfeit is rejected, nothing happens', () => {
        const test = newHarness();
        const s = setupLobby(test, noReferee({ lobby: { disconnectPolicy: { tag: 'NoAction' } } }));
        leave(test, s.a.b1, s.lobbyId);
        leave(test, s.a.b2, s.lobbyId);
        advance(test, 10 * 60_000);
        expectReject(test, s.a.r1, (ctx) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 0 }),
            'Forfeit claim is only available under Standard disconnect policy.');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
    });

    it('an abandoned row counts as an offline player for the test', () => {
        const test = newHarness();
        const s = setupLobby(test, noReferee());
        leave(test, s.a.b1, s.lobbyId);
        leave(test, s.a.b2, s.lobbyId);
        createCasual(test, s.a.b1, { abandonCurrentMatch: true });
        expect(member(test, s.lobbyId, s.a.b1.userId).abandonedAt).toBeDefined();
        advance(test, 61_000);
        claim(test, s.a.r1, s.lobbyId);
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
    });

    it('one online Blue player and one away Blue player: not eligible', () => {
        const test = newHarness();
        const s = setupLobby(test, noReferee());
        leave(test, s.a.b1, s.lobbyId);
        advance(test, 120_000);
        expectReject(test, s.a.r1, (ctx) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 0 }), NOT_ELIGIBLE_START);
    });
});

// ─── A68(4): another lobby at the cost of the first ──────────────────────────

describe('A68(4): an away player may take another lobby only with abandonCurrentMatch', () => {
    function awayB1() {
        const test = newHarness();
        const s = setupLobby(test);
        leave(test, s.a.b1, s.lobbyId);
        return { test, s, code: lobbyRow(test, s.lobbyId).joinCode };
    }

    it('create_lobby: without the flag → the prompt naming the lobby code; with it → created, the old row abandoned', () => {
        const { test, s, code } = awayB1();
        expectReject(test, s.a.b1, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any), PROMPT(code));
        expect(member(test, s.lobbyId, s.a.b1.userId).abandonedAt).toBeUndefined();

        createCasual(test, s.a.b1, { abandonCurrentMatch: true });
        expect(hostedBy(test, s.a.b1)).toHaveLength(1);
        const old = member(test, s.lobbyId, s.a.b1.userId);
        expect(old.abandonedAt?.microsSinceUnixEpoch).toBe(now(test));
        expect(old.leftAt).toBeDefined();
        expect(old.isOnline).toBe(false);
        expect(old.disconnectedAt).toBeDefined();
        expect(old.lobbySlot.tag).toBe('BluePlayer');
    });

    it('join_lobby: the prompt, then the switch; the old lobby refuses the return; the abandoned row no longer blocks D-22', () => {
        const { test, s, code } = awayB1();
        const other = setupLobby(test, { actors: { host: guest(test, 'host2') }, seats: [], noStart: true });
        expectReject(test, s.a.b1, (ctx) => M.join_lobby(ctx, { lobbyId: other.lobbyId, joinCode: '', password: '' }), PROMPT(code));

        rejoin(test, s.a.b1, other.lobbyId, true);
        expect(member(test, other.lobbyId, s.a.b1.userId)).toBeDefined();
        expect(member(test, s.lobbyId, s.a.b1.userId).abandonedAt).toBeDefined();

        leave(test, s.a.b1, other.lobbyId); // Waiting: the row goes
        expectReject(test, s.a.b1, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }), GONE);
        createCasual(test, s.a.b1); // no flag needed: the abandoned row is free
        expect(hostedBy(test, s.a.b1)).toHaveLength(1);
    });

    it('create_tournament_lobby: the prompt, then the switch (the organizer was away from a casual match)', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const casual = setupLobby(f.test, { actors: { b1: f.org } });
        leave(f.test, f.org, casual.lobbyId);
        const code = lobbyRow(f.test, casual.lobbyId).joinCode;
        expectReject(f.test, f.org, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: m.id }), PROMPT(code));
        tx(f.test, f.org, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: m.id, abandonCurrentMatch: true }));
        expect([...f.test.db.Lobby.bracket_match_id.filter(m.id)]).toHaveLength(1);
        expect(member(f.test, casual.lobbyId, f.org.userId).abandonedAt).toBeDefined();
    });

    it('fix pass (A68(4)(7)): abandoning moves the flags still on the away row (nobody online at the 15 s check → then any member)', () => {
        const test = newHarness();
        const s = setupLobby(test, { hostSlot: 'BluePlayer', seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] });
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(s.host.userId);
        for (const n of ['b1', 'r1', 'r2']) disconnect(test, s.a[n]);
        leave(test, s.host, s.lobbyId);
        advance(test, 15_000);
        fireCheck(test, pendingCheck(test, s.lobbyId, s.host.userId));
        // A22a: nobody online → the flags stay on the away row.
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.host.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);

        createCasual(test, s.host, { abandonCurrentMatch: true });
        const old = member(test, s.lobbyId, s.host.userId);
        expect(old.abandonedAt).toBeDefined();
        expect(old.isReferee).toBe(false);
        expect(old.isCaptain).toBe(false);
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.b1.userId); // A22(5): first Blue player, any member
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b1.userId]);
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(s.a.b1.userId);
    });

    it('an online player in a live lobby: today\'s rejection even with the flag (create_lobby, join_lobby)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const other = setupLobby(test, { actors: { host: guest(test, 'host2') }, seats: [], noStart: true });
        expectReject(test, s.a.b1, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any), ALREADY_IN);
        expectReject(test, s.a.b1, (ctx) => M.join_lobby(ctx, { lobbyId: other.lobbyId, joinCode: '', password: '', abandonCurrentMatch: true }), ALREADY_IN);
        expect(member(test, s.lobbyId, s.a.b1.userId).abandonedAt).toBeUndefined();
    });

    it('a Waiting row is held: rejected even with the flag', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        expectReject(test, s.a.b1, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any), ALREADY_IN);
    });

    it('view_my_lobbies lists the lobby the user is away from and drops it once abandoned (A68(4)(10))', () => {
        const { test, s } = awayB1();
        const mine = () => ((M as any).view_my_lobbies(test.viewContext(s.a.b1.auth), {}) as any[]).map((l) => l.id);
        expect(mine()).toContain(s.lobbyId);
        createCasual(test, s.a.b1, { abandonCurrentMatch: true });
        expect(mine()).not.toContain(s.lobbyId);
        expect(mine()).toContain(hostedBy(test, s.a.b1)[0].id);
    });

    it('delete_my_account: an away membership blocks; an abandoned one does not', () => {
        const test = newHarness();
        const b1 = verified(test, 'b1');
        const s = setupLobby(test, { actors: { b1 } });
        leave(test, b1, s.lobbyId);
        expectReject(test, b1, (ctx) => M.delete_my_account(ctx, {}), LEAVE_FIRST);
        createCasual(test, b1, { abandonCurrentMatch: true });
        const fresh = hostedBy(test, b1)[0].id;
        leave(test, b1, fresh); // the one-member Waiting lobby is deleted
        tx(test, b1, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.User.id.find(b1.userId)?.isGuest ?? false).toBe(false);
        expect(test.db.UserIdentity.identity.find(b1.identity)).toBeFalsy();
    });

    it('AwaitingResult rows never block: create_lobby without the flag and delete_my_account succeed', () => {
        const test = newHarness();
        const b1 = verified(test, 'b1');
        const s = parkedLobby(test, { actors: { b1 } });
        createCasual(test, b1);
        leave(test, b1, hostedBy(test, b1)[0].id);
        tx(test, b1, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.UserIdentity.identity.find(b1.identity)).toBeFalsy();
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
    });
});

// ─── A68(6): removals ────────────────────────────────────────────────────────

describe('A68(6): kick / ban', () => {
    for (const stage of ['Waiting', 'AwaitingResult'] as const) {
        it(`${stage}: kick a player and ban a spectator — row and LMA rows gone, LobbyBan on the ban, count decremented`, () => {
            const test = newHarness();
            const opts: SetupOpts = {
                beforeStart: (l) => {
                    l.a.spec = guest(test, 'spec');
                    rejoin(test, l.a.spec, l.lobbyId);
                    giveAccounts(l, ['b1', 'spec']);
                },
            };
            const s = stage === 'Waiting' ? setupLobby(test, { ...opts, noStart: true }) : parkedLobby(test, opts);
            const count = lobbyRow(test, s.lobbyId).currentPlayerCount;

            kick(test, s.host, s.lobbyId, s.a.b1);
            expect(member(test, s.lobbyId, s.a.b1.userId)).toBeUndefined();
            expect(lmaRows(test, s.lobbyId, s.a.b1.userId)).toHaveLength(0);

            ban(test, s.host, s.lobbyId, s.a.spec);
            expect(member(test, s.lobbyId, s.a.spec.userId)).toBeUndefined();
            expect(lmaRows(test, s.lobbyId, s.a.spec.userId)).toHaveLength(0);
            expect([...test.db.LobbyBan.by_lobby_and_user.filter([s.lobbyId, s.a.spec.userId])]).toHaveLength(1);
            expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(count - 2);
            expectFlagsHeld(test, s.lobbyId);
            // The kicked player is free at once (no LobbyMemberAccount lock left behind).
            createCasual(test, s.a.b1);
        });
    }

    it('Waiting: banning the player who holds the referee flag moves it (A68(7))', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        ban(test, s.host, s.lobbyId, s.a.r1);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]); // the host tier, online
        expectFlagsHeld(test, s.lobbyId);
    });

    for (const stage of ['Drafting', 'Equipping', 'Scoring'] as const) {
        it(`${stage}: a player target is rejected (kick and ban); a spectator and a coach are removed`, () => {
            const test = newHarness();
            const s = setupLobby(test, {
                beforeStart: (l) => {
                    l.a.coach = guest(test, 'coach');
                    rejoin(test, l.a.coach, l.lobbyId);
                    tx(test, l.host, (ctx) => M.set_team_slot(ctx, { lobbyId: l.lobbyId, targetJoinSeq: seatOf(ctx, l.lobbyId, l.a.coach.userId), lobbySlot: { tag: 'RedCoach' } as any }));
                },
            });
            toStage(test, s, stage);
            const spec = joinAsSpectator(s, 'spec');

            expectReject(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) }), NO_PLAYER_REMOVAL);
            expectReject(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r2.userId) }), NO_PLAYER_REMOVAL);
            expect(member(test, s.lobbyId, s.a.b1.userId)).toBeDefined();
            expect(member(test, s.lobbyId, s.a.r2.userId)).toBeDefined();
            expect([...test.db.LobbyBan.by_lobby_and_user.filter([s.lobbyId, s.a.r2.userId])]).toHaveLength(0);

            kick(test, s.host, s.lobbyId, spec);
            ban(test, s.host, s.lobbyId, s.a.coach);
            expect(member(test, s.lobbyId, spec.userId)).toBeUndefined();
            expect(member(test, s.lobbyId, s.a.coach.userId)).toBeUndefined();
            expect([...test.db.LobbyBan.by_lobby_and_user.filter([s.lobbyId, s.a.coach.userId])]).toHaveLength(1);
            expectFlagsHeld(test, s.lobbyId);
        });
    }

    it('Drafting: kicking the spectator referee moves the flag to the host (A68(7))', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const ref = joinAsSpectator(s, 'ref');
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, ref.userId) }));
        kick(test, s.host, s.lobbyId, ref);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
        expectFlagsHeld(test, s.lobbyId);
    });
});

describe('A68(6): dq_participant', () => {
    it('a DQ of one player during a live lobby leaves the lobby untouched; the player cannot be seated in the next lobby', () => {
        const f = liveField(2, { defaultBestOf: 3, grandFinalBestOf: 3 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id);
        const victim = s.a.b2;
        tx(f.test, f.org, (ctx) => M.dq_participant(ctx, { tournamentId: f.id, userId: victim.userId, reason: 'test' }));

        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('Drafting');
        const row = member(f.test, s.lobbyId, victim.userId);
        expect(row).toBeDefined();
        expect(row.lobbySlot.tag).toBe('BluePlayer');
        expect(recordsOfLobby(f.test, s.lobbyId)[0].status.tag).toBe('Pending');
        expect(recordsOfLobby(f.test, s.lobbyId)[0].matchEndReason).toBeUndefined();

        // The game plays on with them; the DQ bites from the next lobby (no team membership → Spectator only).
        playLobbyGame(s, 'Blue');
        expect(matchRow(f.test, m.id).state.tag).toBe('Ready');
        const next = createTournamentLobby(f.test, f.org, m.id);
        join(f.test, sidesOf(f, m.id).blue.captain, next);
        join(f.test, victim, next);
        expect(member(f.test, next, victim.userId).lobbySlot.tag).toBe('Spectator');
        expectReject(f.test, victim, (ctx) =>
            M.set_team_slot(ctx, { lobbyId: next, targetJoinSeq: seatOf(ctx, next, victim.userId), lobbySlot: { tag: 'BluePlayer' } as any }), SEAT);
    });

    it('a whole-team DQ still settles the bracket and force-concedes the live lobby with the team\'s colour', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id);
        const blue = sidesOf(f, m.id).blue;
        tx(f.test, f.org, (ctx) => M.dq_participant(ctx, { tournamentId: f.id, userId: blue.captain.userId, reason: 'no-show', dqWholeTeam: true }));
        const [rec] = recordsOfLobby(f.test, s.lobbyId);
        expect(rec.status.tag).toBe('Validated');
        expect(rec.matchEndReason?.tag).toBe('Concede');
        expect(rec.winnerTeamSide?.tag).toBe('Red');
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Dq');
        expect(after.winnerTeamId).toBe(m.team2Id);
    });
});

// ─── A68(7): flags always held ───────────────────────────────────────────────

describe('A68(7): host, captain and referee move on every removal (A22(5) order, online first, then any)', () => {
    it('host (spectator referee) leaves in Waiting: host and referee go to the first ONLINE candidate (b1 offline → b2)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true, seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer']] });
        disconnect(test, s.a.b1);
        leave(test, s.host, s.lobbyId);
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.b2.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b2.userId]);
        expectFlagsHeld(test, s.lobbyId);
    });

    it('nobody online: host and referee go to the first member in the A22(5) order (b1)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true, seats: [['r1', 'RedPlayer'], ['b1', 'BluePlayer'], ['b2', 'BluePlayer']] });
        for (const n of ['b1', 'b2', 'r1']) disconnect(test, s.a[n]);
        leave(test, s.host, s.lobbyId);
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.b1.userId); // Blue before Red, whatever the join order
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b1.userId]);
        expectFlagsHeld(test, s.lobbyId);
    });

    it('a captain who is also referee leaves in Waiting: captain to the teammate, referee to the online host', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        tx(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) }));
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) }));
        leave(test, s.a.b1, s.lobbyId);
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(s.a.b2.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
        expectFlagsHeld(test, s.lobbyId);
    });

    it('a player leaves in AwaitingResult: the row goes and its referee flag moves', () => {
        const test = newHarness();
        const s = parkedLobby(test);
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        leave(test, s.a.r1, s.lobbyId);
        expect(member(test, s.lobbyId, s.a.r1.userId)).toBeUndefined();
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
        expectFlagsHeld(test, s.lobbyId);
    });

    it('user deletion while a member: the referee + captain of a deleted guest move; a deleted guest host hands over the host', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        tx(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) }));
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) }));
        tx(test, s.a.b1, (ctx) => M.delete_my_account(ctx, {}));
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(s.a.b2.userId);

        tx(test, s.host, (ctx) => M.delete_my_account(ctx, {}));
        expect(lobbyRow(test, s.lobbyId).hostUserId).not.toBe(s.host.userId);
        expect(refereeIds(test, s.lobbyId)).not.toContain(s.host.userId);
    });

    it('A68(7): user deletion in Waiting removes the row, so a deleted user never receives the host / referee flag', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        giveAccounts(s, ['b1']);
        tx(test, s.a.b1, (ctx) => M.delete_my_account(ctx, {})); // b1 (first Blue player) deleted: row removed
        expect(member(test, s.lobbyId, s.a.b1.userId)).toBeUndefined();
        expect(lmaRows(test, s.lobbyId, s.a.b1.userId)).toHaveLength(0);
        tx(test, s.host, (ctx) => M.delete_my_account(ctx, {}));
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.b2.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b2.userId]);
        expect(lobbyRow(test, s.lobbyId).hostUserId).not.toBe(s.a.b1.userId);
        expectFlagsHeld(test, s.lobbyId);
    });

    it('reclaim_referee: nobody holds the flag → the calling member takes it; a held flag keeps today\'s host rule', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        const hostRow = member(test, s.lobbyId, s.host.userId);
        test.db.LobbyMember.by_lobby_and_user.delete([s.lobbyId, s.host.userId]);
        test.db.LobbyMember.insert({ ...hostRow, isReferee: false });
        expect(refereeIds(test, s.lobbyId)).toEqual([]);

        tx(test, s.a.r1, (ctx) => M.reclaim_referee(ctx, { lobbyId: s.lobbyId }));
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.r1.userId]);

        expectReject(test, s.a.b1, (ctx) => M.reclaim_referee(ctx, { lobbyId: s.lobbyId }), 'Only the lobby host can reclaim the referee flag.');
        tx(test, s.host, (ctx) => M.reclaim_referee(ctx, { lobbyId: s.lobbyId }));
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
    });
});

// ─── A68(7): user deletion is a row removal (fix pass 2) ─────────────────────

/**
 * The admin path that reaches performUserDeletion for a user in a live lobby: admin_ban_user (internal owner = SYSTEM
 * Admin) on the user's Discord id soft-deletes them and schedules a UserDeletionJob; the job row is consumed and
 * run_user_deletion fired by hand, as the scheduler would. (admin_delete_user refuses lobby members.)
 */
function adminDelete(test: Harness, who: Actor) {
    const providerId = test.db.UserPrivate.userId.find(who.userId)!.providerId;
    tx(test, 'internal', (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId, reason: 'S8f test' }));
    const jobs = [...test.db.UserDeletionJob.iter()].filter((j) => j.userId === who.userId);
    expect(jobs).toHaveLength(1);
    test.db.UserDeletionJob.scheduledId.delete(jobs[0].scheduledId);
    tx(test, 'internal', (ctx) => M.run_user_deletion(ctx, { arg: jobs[0] }));
}

describe('A68(7): user deletion removes the membership like a leave; a live player row stays away and abandoned', () => {
    it('Waiting: row and LMA rows gone, count decremented, referee + captain moved (A22(5), online first)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        giveAccounts(s, ['b1', 'b2']);
        tx(test, s.host, (ctx) => M.set_captain(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) }));
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b1.userId) }));
        const countBefore = lobbyRow(test, s.lobbyId).currentPlayerCount;

        tx(test, s.a.b1, (ctx) => M.delete_my_account(ctx, {}));

        expect(member(test, s.lobbyId, s.a.b1.userId)).toBeUndefined();
        expect(lmaRows(test, s.lobbyId, s.a.b1.userId)).toHaveLength(0);
        expect(lmaRows(test, s.lobbyId, s.a.b2.userId)).toHaveLength(1);
        expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(countBefore - 1);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(s.a.b2.userId);
        expectFlagsHeld(test, s.lobbyId);
    });

    it('Waiting: a lobby emptied by the deletion is hard-deleted', () => {
        const test = newHarness();
        const solo = guest(test, 'solo');
        createCasual(test, solo);
        const lobbyId = hostedBy(test, solo)[0].id;
        tx(test, solo, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.Lobby.id.find(lobbyId)).toBeFalsy();
        expect(members(test, lobbyId)).toHaveLength(0);
    });

    it('AwaitingResult: the row goes; the finished game\'s MatchResultParticipant row is untouched', () => {
        const test = newHarness();
        const s = parkedLobby(test);
        giveAccounts(s, ['b1']);
        const record = recordOf(test, s.lobbyId);
        const participant = test.db.MatchResultParticipant.by_result_and_user.filter([record.id, s.a.b1.userId]);
        const before = [...participant];
        expect(before).toHaveLength(1);
        const countBefore = lobbyRow(test, s.lobbyId).currentPlayerCount;

        tx(test, s.a.b1, (ctx) => M.delete_my_account(ctx, {}));

        expect(member(test, s.lobbyId, s.a.b1.userId)).toBeUndefined();
        expect(lmaRows(test, s.lobbyId, s.a.b1.userId)).toHaveLength(0);
        expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(countBefore - 1);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expect([...test.db.MatchResultParticipant.by_result_and_user.filter([record.id, s.a.b1.userId])]).toEqual(before);
        expectFlagsHeld(test, s.lobbyId);
    });

    for (const policy of ['Standard', 'Deferred', 'NoAction'] as const) {
        it(`Drafting / ${policy}: an admin-deleted player keeps the row, offline, leftAt + abandonedAt; disconnectedAt ${policy === 'NoAction' ? 'not ' : ''}stamped; LMA rows and count unchanged`, () => {
            // T-S10d (A91(2)): Deferred = a Deferred tournament's lobby (its b1, the Blue captain, is verified).
            const { test, s } = policyLobby(policy, (t) => verified(t, 'b1'));
            const b1 = s.a.b1;
            giveAccounts(s, ['b1']);
            const countBefore = lobbyRow(test, s.lobbyId).currentPlayerCount;
            advance(test, 2_000);

            adminDelete(test, b1);

            const m = member(test, s.lobbyId, b1.userId);
            expect(m).toBeDefined();
            expect(m.lobbySlot.tag).toBe('BluePlayer');
            expect(m.isOnline).toBe(false);
            expect(m.leftAt?.microsSinceUnixEpoch).toBe(now(test));
            expect(m.abandonedAt?.microsSinceUnixEpoch).toBe(now(test));
            if (policy === 'NoAction') expect(m.disconnectedAt).toBeUndefined();
            else expect(m.disconnectedAt?.microsSinceUnixEpoch).toBe(now(test));
            expect(m.isReferee).toBe(false);
            expect(m.isCaptain).toBe(false);
            // S10e review F3: the abandoned row keeps its LobbyMemberAccount rows (the roster guards ignore them).
            expect(lmaRows(test, s.lobbyId, b1.userId)).toHaveLength(1);
            expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(countBefore);
            expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
            expect(test.db.UserIdentity.identity.find(b1.identity)).toBeFalsy();
        });
    }

    it('Drafting: the stamps already on an away row are kept (the grace clock does not restart)', () => {
        const test = newHarness();
        const b1 = verified(test, 'b1');
        const s = setupLobby(test, { actors: { b1 } });
        leave(test, b1, s.lobbyId);
        const leftAt = now(test);
        advance(test, 20_000);
        adminDelete(test, b1);
        const m = member(test, s.lobbyId, b1.userId);
        expect(m.leftAt?.microsSinceUnixEpoch).toBe(leftAt);
        expect(m.disconnectedAt?.microsSinceUnixEpoch).toBe(leftAt);
        expect(m.abandonedAt?.microsSinceUnixEpoch).toBe(now(test));
    });

    it('Drafting: the deleted player counts as an offline player for claim_forfeit (rejected inside the grace, accepted after)', () => {
        const test = newHarness();
        const b1 = verified(test, 'b1');
        const s = setupLobby(test, noReferee({ actors: { b1 } }));
        leave(test, s.a.b2, s.lobbyId);
        adminDelete(test, b1);
        advance(test, 30_000);
        expectReject(test, s.a.r1, (ctx) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 0 }), NOT_ELIGIBLE_START);
        advance(test, 31_000);
        claim(test, s.a.r1, s.lobbyId);
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
    });

    it('Drafting: the deleted host\'s host + referee + captain move to a live member at once and never come back to the row', () => {
        const test = newHarness();
        const host = verified(test, 'host');
        const s = setupLobby(test, {
            actors: { host },
            hostSlot: 'BluePlayer',
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        });
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(host.userId);

        adminDelete(test, host);

        expect(member(test, s.lobbyId, host.userId)).toBeDefined();
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.a.b1.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b1.userId]);
        expect(captainOf(test, s.lobbyId, 'BluePlayer')?.userId).toBe(s.a.b1.userId);
        expectFlagsHeld(test, s.lobbyId);

        // b1 leaves too: after the 15 s check the flags go to an online Red player, never to the deleted host's row.
        leave(test, s.a.b1, s.lobbyId);
        advance(test, 15_000);
        fireCheck(test, pendingCheck(test, s.lobbyId, s.a.b1.userId));
        expect(lobbyRow(test, s.lobbyId).hostUserId).not.toBe(host.userId);
        expect(refereeIds(test, s.lobbyId)).not.toContain(host.userId);
        expect([s.a.r1.userId, s.a.r2.userId]).toContain(lobbyRow(test, s.lobbyId).hostUserId);
        expect(member(test, s.lobbyId, host.userId).isReferee).toBe(false);
        expect(member(test, s.lobbyId, host.userId).isCaptain).toBe(false);
        expectFlagsHeld(test, s.lobbyId);
    });

    it('Drafting: an admin-deleted spectator is removed (A68(5)); count decremented', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const spec = verified(test, 'spec');
        tx(test, spec, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        expect(member(test, s.lobbyId, spec.userId).lobbySlot.tag).toBe('Spectator');
        const countBefore = lobbyRow(test, s.lobbyId).currentPlayerCount;
        adminDelete(test, spec);
        expect(member(test, s.lobbyId, spec.userId)).toBeUndefined();
        expect(lobbyRow(test, s.lobbyId).currentPlayerCount).toBe(countBefore - 1);
        expectFlagsHeld(test, s.lobbyId);
    });
});

// ─── A68(8): spectators ──────────────────────────────────────────────────────

describe('A68(8): spectator joins and maxSpectators', () => {
    it('new joins in Drafting, Equipping and Scoring land on Spectator; AwaitingResult stays closed', () => {
        const test = newHarness();
        const s = setupLobby(test);
        for (const stage of ['Drafting', 'Equipping', 'Scoring'] as const) {
            toStage(test, s, stage);
            const who = joinAsSpectator(s, `spec-${stage}`);
            expect(member(test, s.lobbyId, who.userId).lobbySlot.tag).toBe('Spectator');
        }
        const parked = parkedLobby(test, { actors: { host: guest(test, 'host2') }, seats: [['x1', 'BluePlayer'], ['y1', 'RedPlayer']] });
        const late = verified(test, 'late'); // T-S10d: the parked lobby is Ranked, which turns a guest away first (D-23)
        expectReject(test, late, (ctx) => M.join_lobby(ctx, { lobbyId: parked.lobbyId, joinCode: '', password: '' }),
            'Cannot join a lobby in stage: AwaitingResult');
    });

    it('maxSpectators 0 in a live stage: every spectator join is rejected; the host spectator is unaffected', () => {
        const test = newHarness();
        const s = setupLobby(test, {
            beforeStart: (l) => {
                tx(test, l.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(l.lobbyId, { maxSpectators: 0 })));
                // A38(4): a settings change resets every confirmation.
                for (const n of ['b1', 'b2', 'r1', 'r2']) tx(test, l.a[n], (ctx) => M.confirm_ready(ctx, { lobbyId: l.lobbyId }));
            },
        });
        expect(lobbyRow(test, s.lobbyId).maxSpectators).toBe(0);
        expect(member(test, s.lobbyId, s.host.userId).lobbySlot.tag).toBe('Spectator');
        const late = guest(test, 'late');
        expectReject(test, late, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }), SPEC_FULL(0));
    });

    it('maxSpectators 0 in a tournament lobby: team players are seated, every other joiner is rejected', () => {
        const f = liveField(2);
        const sys = [...f.test.db.LobbyPreset.iter()].find((p) => p.isSystemPreset)!;
        const own = f.test.db.LobbyPreset.insert({ ...sys, id: 0, isSystemPreset: false, name: 'nospec', creatorUserId: f.org.userId, maxSpectators: 0 });
        f.test.db.Tournament.id.update({ ...tRow(f.test, f.id), lobbyPresetId: own.id });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id, { noStart: true });
        expect(lobbyRow(f.test, s.lobbyId).maxSpectators).toBe(0);
        for (const n of ['b1', 'b2', 'r1', 'r2']) expect(member(f.test, s.lobbyId, s.a[n].userId).lobbySlot.tag).not.toBe('Spectator');
        const late = guest(f.test, 'late');
        expectReject(f.test, late, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }), SPEC_FULL(0));
    });

    it('maxSpectators 3 in a live stage (the host spectator counts): the fourth spectator is rejected', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { maxSpectators: 3 } });
        for (const n of ['j1', 'j2']) joinAsSpectator(s, n);
        const j3 = guest(test, 'j3');
        expectReject(test, j3, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }), SPEC_FULL(3));
        expect(members(test, s.lobbyId).filter((m) => m.lobbySlot.tag === 'Spectator')).toHaveLength(3);
    });

    it('fix pass (A68(8) watchers only): a casual Waiting joiner is a seat candidate and is never counted, even with maxSpectators 0', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        createCasual(test, host, { maxSpectators: 0 });
        const lobbyId = hostedBy(test, host)[0].id;
        for (const n of ['j1', 'j2', 'j3']) rejoin(test, guest(test, n), lobbyId);
        expect(members(test, lobbyId).filter((m) => m.lobbySlot.tag === 'Spectator')).toHaveLength(4);
    });

    it('the 20-member cap still applies (teamSize 3, S10e lobby audit #10 rejects 4; coaches and spectators fill the rest)', () => {
        const test = newHarness();
        const seats: SetupOpts['seats'] = [
            ['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['b3', 'BluePlayer'],
            ['r1', 'RedPlayer'], ['r2', 'RedPlayer'], ['r3', 'RedPlayer'],
            ['bc', 'BlueCoach'], ['rc', 'RedCoach'],
            ...Array.from({ length: 11 }, (_, i) => [`s${i}`, 'Spectator'] as [string, 'Spectator']),
        ];
        const s = setupLobby(test, { noStart: true, lobby: { teamSize: 3 }, seats });
        expect(members(test, s.lobbyId)).toHaveLength(20);
        const extra = guest(test, 'extra');
        expectReject(test, extra, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }), 'Lobby is full (max 20 members).');
    });

    it('a lower setting applied later evicts nobody; live-stage joins follow it; casual Waiting moves into Spectator are not capped', () => {
        const test = newHarness();
        const s = setupLobby(test, {
            seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer'], ['s1', 'Spectator'], ['s2', 'Spectator']],
            beforeStart: (l) => {
                tx(test, l.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(l.lobbyId, { maxSpectators: 1 })));
                // Fix pass: a casual Waiting lobby's Spectator slot holds seat candidates (D-27) and is not capped.
                tx(test, l.a.b2, (ctx) => M.set_team_slot(ctx, { lobbyId: l.lobbyId, targetJoinSeq: seatOf(ctx, l.lobbyId, l.a.b2.userId), lobbySlot: { tag: 'Spectator' } as any }));
                tx(test, l.a.b2, (ctx) => M.set_team_slot(ctx, { lobbyId: l.lobbyId, targetJoinSeq: seatOf(ctx, l.lobbyId, l.a.b2.userId), lobbySlot: { tag: 'BluePlayer' } as any }));
                for (const n of ['b1', 'b2', 'r1', 'r2']) tx(test, l.a[n], (ctx) => M.confirm_ready(ctx, { lobbyId: l.lobbyId }));
            },
        });
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        expect(members(test, s.lobbyId).filter((m) => m.lobbySlot.tag === 'Spectator')).toHaveLength(3);
        const late = guest(test, 'late');
        expectReject(test, late, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }), SPEC_FULL(1));
    });

    it('create_lobby / update_lobby_settings: 13 rejected; 0 and 12 accepted; omitted = 12 on create, unchanged on update', () => {
        const test = newHarness();
        const a = guest(test, 'a');
        expectReject(test, a, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, maxSpectators: 13 } as any), MAX_SPEC_RANGE);
        createCasual(test, a, { maxSpectators: 0 });
        expect(hostedBy(test, a)[0].maxSpectators).toBe(0);
        const b = guest(test, 'b');
        createCasual(test, b, { maxSpectators: 12 });
        expect(hostedBy(test, b)[0].maxSpectators).toBe(12);
        const c = guest(test, 'c');
        createCasual(test, c);
        const lobbyId = hostedBy(test, c)[0].id;
        expect(lobbyRow(test, lobbyId).maxSpectators).toBe(12);

        expectReject(test, c, (ctx) => M.update_lobby_settings(ctx, settingsArgs(lobbyId, { maxSpectators: 13 })), MAX_SPEC_RANGE);
        tx(test, c, (ctx) => M.update_lobby_settings(ctx, settingsArgs(lobbyId, { maxSpectators: 0 })));
        expect(lobbyRow(test, lobbyId).maxSpectators).toBe(0);
        tx(test, c, (ctx) => M.update_lobby_settings(ctx, settingsArgs(lobbyId)));
        expect(lobbyRow(test, lobbyId).maxSpectators).toBe(0);
        tx(test, c, (ctx) => M.update_lobby_settings(ctx, settingsArgs(lobbyId, { maxSpectators: 12 })));
        expect(lobbyRow(test, lobbyId).maxSpectators).toBe(12);
    });

    it('presets: 13 rejected on create and update; 0 and 12 accepted; omitted = 12 on create, unchanged on update', () => {
        const test = newHarness();
        const preset = (name: string) => [...test.db.LobbyPreset.iter()].find((p) => p.name === name)!;
        expectReject(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'p13', maxSpectators: 13 } as any), MAX_SPEC_RANGE);
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'p0', maxSpectators: 0 } as any));
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'pdef' } as any));
        expect(preset('p0').maxSpectators).toBe(0);
        expect(preset('pdef').maxSpectators).toBe(12);

        const id = preset('p0').id;
        expectReject(test, 'internal', (ctx) => M.update_lobby_preset(ctx, { ...PRESET_ARGS, presetId: id, name: 'p0', maxSpectators: 13 } as any), MAX_SPEC_RANGE);
        tx(test, 'internal', (ctx) => M.update_lobby_preset(ctx, { ...PRESET_ARGS, presetId: id, name: 'p0' } as any));
        expect(preset('p0').maxSpectators).toBe(0);
        tx(test, 'internal', (ctx) => M.update_lobby_preset(ctx, { ...PRESET_ARGS, presetId: id, name: 'p0', maxSpectators: 12 } as any));
        expect(preset('p0').maxSpectators).toBe(12);
    });

    it('the system preset has 12; a tournament lobby takes the preset\'s value', () => {
        const f = liveField(4);
        const sys = [...f.test.db.LobbyPreset.iter()].find((p) => p.isSystemPreset)!;
        expect(sys.maxSpectators).toBe(12);
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        expect(lobbyRow(f.test, createTournamentLobby(f.test, f.org, m1.id)).maxSpectators).toBe(12);

        const own = f.test.db.LobbyPreset.insert({ ...sys, id: 0, isSystemPreset: false, name: 'five', creatorUserId: f.org.userId, maxSpectators: 5 });
        f.test.db.Tournament.id.update({ ...tRow(f.test, f.id), lobbyPresetId: own.id });
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        expect(lobbyRow(f.test, createTournamentLobby(f.test, sidesOf(f, m2.id).blue.captain, m2.id)).maxSpectators).toBe(5);
    });
});

// ─── A68(9): GC ──────────────────────────────────────────────────────────────

describe('A68(9): the lobby GC applies the presence test to Waiting lobbies', () => {
    it('Waiting idle > 30 min with one online member survives; with every member offline it is deleted', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        for (const n of ['b1', 'b2', 'r1', 'r2']) disconnect(test, s.a[n]);
        advance(test, 31 * 60_000);
        gc(test);
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeTruthy();
        disconnect(test, s.host);
        gc(test);
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
    });

    it('live stage: away rows count as offline even while the leaver is on the site; one online member keeps it', () => {
        const test = newHarness();
        const s = setupLobby(test);
        for (const n of ['b1', 'b2', 'r1']) leave(test, s.a[n], s.lobbyId); // away, presence still online
        disconnect(test, s.host);
        advance(test, 31 * 60_000);
        gc(test);
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeTruthy(); // r2 is online
        leave(test, s.a.r2, s.lobbyId);
        advance(test, 31 * 60_000);
        expect(test.db.UserPresence.identity.find(s.a.r2.identity)?.isOnline).toBe(true);
        gc(test);
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
    });

    it('AwaitingResult is never collected, whoever is online', () => {
        const test = newHarness();
        const s = parkedLobby(test);
        for (const who of Object.values(s.a)) disconnect(test, who);
        advance(test, 48 * 60 * 60_000);
        gc(test);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
    });
});

// ─── Schema (type level) ─────────────────────────────────────────────────────

describe('A68(2)(4)(8): schema', () => {
    type MemberRow = ReturnType<typeof member>;
    type LobbyRow = ReturnType<typeof lobbyRow>;
    type PresetRow = NonNullable<ReturnType<Harness['db']['LobbyPreset']['id']['find']>>;

    it('LobbyMember has leftAt / abandonedAt and no voluntarilyLeft; Lobby and LobbyPreset have maxSpectators', () => {
        expectTypeOf<MemberRow>().toHaveProperty('leftAt');
        expectTypeOf<MemberRow>().toHaveProperty('abandonedAt');
        expectTypeOf<MemberRow>().not.toHaveProperty('voluntarilyLeft');
        expectTypeOf<LobbyRow>().toHaveProperty('maxSpectators');
        expectTypeOf<PresetRow>().toHaveProperty('maxSpectators');

        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        const row = member(test, s.lobbyId, s.a.b1.userId);
        expect('voluntarilyLeft' in row).toBe(false);
        expect(row.leftAt).toBeUndefined();
        expect(row.abandonedAt).toBeUndefined();
    });
});

// ─── Not drivable in memory ──────────────────────────────────────────────────

describe('A68: outside the in-memory harness', () => {
    // A68(10) / S9: the member presence state (online / offline / away / gone) landed in S9a; covered by s9a-views.test.ts (T-S9a).
    it.todo('A68 / S14: the client prompt "join here and give up lobby {code}?" and the Leave confirmation copy (UI, not the module)');
    it.todo('A22a / A68(1): the real scheduler firing the 15 s RefereeTransferCheck (the harness fires the row by hand; live residue on test1)');
});
