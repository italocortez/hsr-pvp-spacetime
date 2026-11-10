// T-S4 done-check (ACCESS-SECURITY-OPS §D.3 row S4, §D.8.2; DECISIONS A22, A22a, A48; BACKEND-BUGS F5):
// the 15-second referee-transfer check, the player auto-pause and multi-device presence, in memory.
// The scheduler is not simulated: the test advances the TestClock and calls run_referee_transfer_check by hand
// with the row client_disconnected inserted.
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
    refereeIds,
    session,
    setupLobby,
    steps,
    tx,
    type Harness,
    type SetupOpts,
    seatOf,
    priceCharacters,
} from './s4-fixtures';

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
