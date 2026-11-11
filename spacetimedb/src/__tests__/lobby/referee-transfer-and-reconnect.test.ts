// Lobby: reconnect, the referee-transfer grace window, auto-pause, multi-device presence, a host leaving mid-draft
//   and the forfeiting side of claim_forfeit.
// Decisions: A22, A22a, A48
// Contracts: docs/lobby/contract.md
// From S4 (s4-referee-transfer.test.ts, s4-lobby-fixes.test.ts).
import { describe, expect, it } from 'vitest';
import { ScheduleAt } from 'spacetimedb';
import {
    M,
    SYSTEM_USER_ID,
    advance,
    captainOf,
    checksFor,
    connect,
    disconnect,
    expectReject,
    fireCheck,
    guest,
    joinAsSpectator,
    linkDiscord,
    lobbyRow,
    member,
    newHarness,
    now,
    pauseSteps,
    pendingCheck,
    priceCharacters,
    refereeIds,
    seatOf,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SetupOpts,
} from '../fixtures/harness';

const GRACE_MICROS = 15_000_000n;

describe('A22a grace window: a refresh inside 15 s keeps every flag', () => {
    it('referee disconnects, reconnects after 10 s: check cancelled, still referee, no pause; the stale row is a no-op', () => {
        const test = newHarness();
        const { lobbyId, host } = setupLobby(test);
        expect(member(test, lobbyId, host.userId).isReferee).toBe(true);
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('Drafting');

        disconnect(test, host);
        const m1 = member(test, lobbyId, host.userId);
        expect(m1.isOnline).toBe(false);
        expect(m1.disconnectedAt?.microsSinceUnixEpoch).toBe(now(test));
        const row = pendingCheck(test, lobbyId, host.userId);
        expect(row.scheduledAt).toEqual(ScheduleAt.time(now(test) + GRACE_MICROS));

        advance(test, 10_000);
        connect(test, host);

        expect(checksFor(test, lobbyId, host.userId)).toHaveLength(0);
        const m2 = member(test, lobbyId, host.userId);
        expect(m2.isOnline).toBe(true);
        expect(m2.disconnectedAt).toBeUndefined();
        expect(m2.isReferee).toBe(true);
        expect(refereeIds(test, lobbyId)).toEqual([host.userId]);
        expect(session(test, lobbyId).timerState.isPaused).toBe(false);
        expect(pauseSteps(test, lobbyId)).toHaveLength(0);

        // The row fires anyway (e.g. a race with the scheduler): the subject is online, nothing moves.
        advance(test, 10_000);
        fireCheck(test, row);
        expect(refereeIds(test, lobbyId)).toEqual([host.userId]);
        expect(lobbyRow(test, lobbyId).hostUserId).toBe(host.userId);
        expect(session(test, lobbyId).timerState.isPaused).toBe(false);
        expect(pauseSteps(test, lobbyId)).toHaveLength(0);
    });
});

describe('A22a / A22(5): the referee flag moves after 20 s, in candidate order', () => {
    // The referee is a spectator S who is not the host, so the host tier is observable.
    function withSpectatorReferee(opts: SetupOpts & { test?: Harness } = {}) {
        const test = opts.test ?? newHarness();
        const s = setupLobby(test, {
            ...opts,
            beforeStart: (l) => {
                const ref = guest(test, 'ref');
                tx(test, ref, (ctx) => M.join_lobby(ctx, { lobbyId: l.lobbyId, joinCode: '', password: '' }));
                l.a.ref = ref;
                tx(test, l.host, (ctx) => M.transfer_referee(ctx, { lobbyId: l.lobbyId, targetJoinSeq: seatOf(ctx, l.lobbyId, ref.userId) }));
                opts.beforeStart?.(l);
            },
        });
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.ref.userId]);
        return s;
    }

    function refereeDropsFor20s(s: ReturnType<typeof withSpectatorReferee>) {
        const { test, lobbyId, a } = s;
        disconnect(test, a.ref);
        const row = pendingCheck(test, lobbyId, a.ref.userId);
        advance(test, 20_000);
        fireCheck(test, row);
    }

    function expectFlagMovedTo(s: ReturnType<typeof withSpectatorReferee>, toUserId: number) {
        const { test, lobbyId, a } = s;
        expect(refereeIds(test, lobbyId)).toEqual([toUserId]);
        expect(member(test, lobbyId, toUserId).lastModifiedById).toBe(SYSTEM_USER_ID);
        expect(member(test, lobbyId, a.ref.userId).lastModifiedById).toBe(SYSTEM_USER_ID);
        expect(member(test, lobbyId, a.ref.userId).isReferee).toBe(false);
    }

    it('host online → the host', () => {
        const s = withSpectatorReferee();
        refereeDropsFor20s(s);
        expectFlagMovedTo(s, s.host.userId);
    });

    it('host offline → the first Blue player by joinSeq (not by userId)', () => {
        const test = newHarness();
        // b1 logs in first (lower userId) but b2 joins the lobby first (lower joinSeq).
        const pre = { b1: guest(test, 'b1'), b2: guest(test, 'b2') };
        const s = withSpectatorReferee({
            test,
            actors: pre,
            seats: [['b2', 'BluePlayer'], ['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        });
        const { lobbyId, a } = s;
        expect(a.b1.userId).toBeLessThan(a.b2.userId);
        expect(member(test, lobbyId, a.b2.userId).joinSeq).toBeLessThan(member(test, lobbyId, a.b1.userId).joinSeq);

        disconnect(test, s.host);
        refereeDropsFor20s(s);
        expectFlagMovedTo(s, a.b2.userId);
    });

    // T-S8f (A68(2)): the Leave marks the row away (leftAt); still never a candidate, whatever the presence rows say.
    it('host offline, Blue gone (one away after Leave, one offline) → the first Red player', () => {
        const s = withSpectatorReferee();
        const { test, lobbyId, a } = s;
        tx(test, a.b1, (ctx) => M.leave_lobby(ctx, { lobbyId }));
        expect(member(test, lobbyId, a.b1.userId).leftAt).toBeDefined();
        expect(test.db.UserPresence.identity.find(a.b1.identity)?.isOnline).toBe(true); // still on the site
        disconnect(test, a.b2);
        disconnect(test, s.host);
        refereeDropsFor20s(s);
        expectFlagMovedTo(s, a.r1.userId);
    });

    it('every player and the host offline → the next spectator; then → the coach', () => {
        const build = () =>
            withSpectatorReferee({
                beforeStart: (l) => {
                    const coach = guest(l.test, 'coach');
                    tx(l.test, coach, (ctx) => M.join_lobby(ctx, { lobbyId: l.lobbyId, joinCode: '', password: '' }));
                    tx(l.test, l.host, (ctx) =>
                        M.set_team_slot(ctx, { lobbyId: l.lobbyId, targetJoinSeq: seatOf(ctx, l.lobbyId, coach.userId), lobbySlot: { tag: 'BlueCoach' } as any }),
                    );
                    l.a.coach = coach;
                },
            });

        const s1 = build();
        joinAsSpectator(s1, 'spec2');
        for (const n of ['host', 'b1', 'b2', 'r1', 'r2']) disconnect(s1.test, s1.a[n]);
        refereeDropsFor20s(s1);
        expectFlagMovedTo(s1, s1.a.spec2.userId);

        const s2 = build();
        joinAsSpectator(s2, 'spec2');
        for (const n of ['host', 'b1', 'b2', 'r1', 'r2', 'spec2']) disconnect(s2.test, s2.a[n]);
        refereeDropsFor20s(s2);
        expectFlagMovedTo(s2, s2.a.coach.userId);
    });
});

describe('F5: spectators never pause; players auto-pause once', () => {
    it('a non-referee spectator refresh past 20 s: no Pause step, no flag change', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const spec = joinAsSpectator(s, 'spec');
        const before = steps(test, s.lobbyId).length;

        disconnect(test, spec);
        const row = pendingCheck(test, s.lobbyId, spec.userId);
        advance(test, 20_000);
        fireCheck(test, row);

        expect(pauseSteps(test, s.lobbyId)).toHaveLength(0);
        expect(steps(test, s.lobbyId)).toHaveLength(before);
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(false);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.host.userId);
    });

    it('Blue captain offline 20 s → one auto Pause (sequence = max + 1), paused, captain moves; a second check does not pause again', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const { lobbyId, a } = s;
        const blueCaptain = captainOf(test, lobbyId, 'BluePlayer')!;
        const captainActor = Object.values(a).find((x) => x.userId === blueCaptain.userId)!;
        const otherBlue = [a.b1, a.b2].find((x) => x.userId !== blueCaptain.userId)!;

        // One pick first so the Pause must land after an existing sequence.
        tx(test, captainActor, (ctx) => (priceCharacters(ctx, lobbyId, ['Acheron']), M.pick_character(ctx, { lobbyId, characterName: 'Acheron', eidolon: 0 })));
        const maxSeq = Math.max(...steps(test, lobbyId).map((x) => x.sequence));

        disconnect(test, captainActor);
        const row = pendingCheck(test, lobbyId, captainActor.userId);
        advance(test, 20_000);
        fireCheck(test, row);

        const pauses = pauseSteps(test, lobbyId);
        expect(pauses).toHaveLength(1);
        expect(pauses[0].payload).toMatchObject({ tag: 'Pause', value: { isAutoPause: true } });
        expect(pauses[0].sequence).toBe(maxSeq + 1);
        expect(pauses[0].actorUserId).toBe(SYSTEM_USER_ID);
        expect(session(test, lobbyId).timerState.isPaused).toBe(true);
        // D.8.2: the captain moves with the same grace.
        expect(captainOf(test, lobbyId, 'BluePlayer')?.userId).toBe(otherBlue.userId);

        // Already paused: a Red player's check does not add a second Pause step.
        disconnect(test, a.r2);
        const row2 = pendingCheck(test, lobbyId, a.r2.userId);
        advance(test, 20_000);
        fireCheck(test, row2);
        expect(pauseSteps(test, lobbyId)).toHaveLength(1);
        const seqs = steps(test, lobbyId).map((x) => x.sequence);
        expect(new Set(seqs).size).toBe(seqs.length);
    });

    it('NoAction: offline, disconnectedAt untouched, check scheduled, never a pause', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { disconnectPolicy: { tag: 'NoAction' } } });
        const { lobbyId, a } = s;

        disconnect(test, a.b2);
        const m = member(test, lobbyId, a.b2.userId);
        expect(m.isOnline).toBe(false);
        expect(m.disconnectedAt).toBeUndefined();
        const row = pendingCheck(test, lobbyId, a.b2.userId);
        advance(test, 20_000);
        fireCheck(test, row);

        expect(pauseSteps(test, lobbyId)).toHaveLength(0);
        expect(session(test, lobbyId).timerState.isPaused).toBe(false);
    });
});

describe('A48: multi-device presence', () => {
    it('one device of two drops: still online, nothing scheduled; the last device drops: offline + check', () => {
        const test = newHarness();
        // b1 on device 1, upgraded to a Discord user; device 2 logs in as a guest and links the same Discord id,
        // which re-points device 2's identity (and its UserPresence row) to b1's user.
        const dev1 = guest(test, 'b1');
        linkDiscord(test, dev1, 'discord-b1', 'B1');
        const dev2 = guest(test, 'b1-phone');
        const orphanGuestId = dev2.userId;
        linkDiscord(test, dev2, 'discord-b1', 'B1');
        expect(dev2.userId).toBe(dev1.userId);
        expect(orphanGuestId).not.toBe(dev1.userId);
        const presence = [...test.db.UserPresence.user_id.filter(dev1.userId)];
        expect(presence).toHaveLength(2);
        expect(presence.every((p) => p.isOnline)).toBe(true);

        const s = setupLobby(test, { actors: { b1: dev1 } });
        const { lobbyId } = s;

        disconnect(test, dev1);
        expect(test.db.UserPresence.identity.find(dev1.identity)?.isOnline).toBe(false);
        expect(test.db.UserPresence.identity.find(dev2.identity)?.isOnline).toBe(true);
        expect(member(test, lobbyId, dev1.userId).isOnline).toBe(true);
        expect(member(test, lobbyId, dev1.userId).disconnectedAt).toBeUndefined();
        expect(checksFor(test, lobbyId, dev1.userId)).toHaveLength(0);

        disconnect(test, dev2);
        expect(member(test, lobbyId, dev1.userId).isOnline).toBe(false);
        expect(member(test, lobbyId, dev1.userId).disconnectedAt?.microsSinceUnixEpoch).toBe(now(test));
        expect(checksFor(test, lobbyId, dev1.userId)).toHaveLength(1);

        // Either device coming back restores the membership and cancels the check.
        advance(test, 5_000);
        connect(test, dev2);
        expect(member(test, lobbyId, dev1.userId).isOnline).toBe(true);
        expect(checksFor(test, lobbyId, dev1.userId)).toHaveLength(0);
    });
});

const NOT_ELIGIBLE = /Opposing team is not eligible for forfeit/;
const rejoin = (s: Lobby, who: Actor) =>
    tx(s.test, who, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));

describe('F1 / A22(2): reconnect', () => {
    it('join_lobby by a disconnected member in Drafting: accepted, online, disconnectedAt cleared, pool charged', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const b1 = s.a.b1;
        disconnect(test, b1);
        expect(member(test, s.lobbyId, b1.userId).disconnectedAt).toBeDefined();
        advance(test, 5_000);

        rejoin(s, b1);
        const m = member(test, s.lobbyId, b1.userId);
        expect(m.isOnline).toBe(true);
        expect(m.disconnectedAt).toBeUndefined();
        expect(m.disconnectPoolRemainingMs).toBe(300_000 - 5_000);
    });

    it('join_lobby by a disconnected member in Waiting: accepted, online', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        disconnect(test, s.a.b1);
        expect(member(test, s.lobbyId, s.a.b1.userId).isOnline).toBe(false);

        rejoin(s, s.a.b1);
        const m = member(test, s.lobbyId, s.a.b1.userId);
        expect(m.isOnline).toBe(true);
        expect(m.disconnectedAt).toBeUndefined();
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
    });

    it('client_connected alone restores the membership (Drafting and Waiting)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        disconnect(test, s.a.b2);
        advance(test, 3_000);
        connect(test, s.a.b2);
        const m = member(test, s.lobbyId, s.a.b2.userId);
        expect(m.isOnline).toBe(true);
        expect(m.disconnectedAt).toBeUndefined();
        expect(m.disconnectPoolRemainingMs).toBe(300_000 - 3_000);

        const test2 = newHarness();
        const w = setupLobby(test2, { noStart: true });
        disconnect(test2, w.a.r1);
        connect(test2, w.a.r1);
        expect(member(test2, w.lobbyId, w.a.r1.userId).isOnline).toBe(true);
    });

    it('claim_forfeit against a team whose player reconnected is rejected', () => {
        const test = newHarness();
        // Host plays Red, so there is no exclusive spectator referee and players may claim (D-81).
        const s = setupLobby(test, {
            hostSlot: 'RedPlayer',
            seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer']],
        });
        disconnect(test, s.a.b1);
        disconnect(test, s.a.b2);
        advance(test, 61_000); // past disconnectForfeitSeconds (60)

        // Blue is eligible at this point (the F7 test proves the success path with the same timing);
        // one Blue player reconnecting must close it.
        rejoin(s, s.a.b1);
        expectReject(test, s.a.r1, (ctx) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 0 }), NOT_ELIGIBLE);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
    });
});

describe('F6: host leaves mid-draft', () => {
    it('the host flag goes to the new host and is not written back to the leaver', () => {
        const test = newHarness();
        const s = setupLobby(test, {
            hostSlot: 'BluePlayer',
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        });
        tx(test, s.host, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));

        // T-S8f (A68(1)(7)): a player's Leave in a live stage is a disconnect: the row is kept (away, leftAt) and the
        // flags move only through the 15 s check (D-35's immediate lowest-userId transfer is retired).
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.host.userId);
        expect(member(test, s.lobbyId, s.host.userId).leftAt).toBeDefined();
        advance(test, 15_000);
        fireCheck(test, pendingCheck(test, s.lobbyId, s.host.userId));

        const lobby = lobbyRow(test, s.lobbyId);
        expect(lobby.hostUserId).not.toBe(s.host.userId);
        // A22(5): the leaver held the host tier, so the first online Blue player by joinSeq (b1) takes host and referee.
        expect(lobby.hostUserId).toBe(s.a.b1.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b1.userId]);
        expect(lobby.stage.tag).toBe('Drafting');
        expect(member(test, s.lobbyId, s.host.userId).isReferee).toBe(false);
        expect(member(test, s.lobbyId, s.host.userId).leftAt).toBeDefined();
    });
});

describe('F7: claim_forfeit forfeitingTeamSide', () => {
    it('exclusive referee: 0 and 3 rejected; 1 reaches the eligibility gate, then succeeds once Blue is gone 60 s', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const claim = (side: number) => (ctx: any) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: side });

        expectReject(test, s.host, claim(0), 'Referee must specify forfeitingTeamSide');
        expectReject(test, s.host, claim(3), /forfeitingTeamSide must be 0/);
        expectReject(test, s.host, claim(1), NOT_ELIGIBLE);
        expectReject(test, s.host, claim(2), NOT_ELIGIBLE);

        disconnect(test, s.a.b1);
        disconnect(test, s.a.b2);
        advance(test, 61_000);
        tx(test, s.host, claim(1));

        // A casual non-tournament concede finalizes inline: runFinalization hard-deletes the lobby.
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeNull();
    });
});
