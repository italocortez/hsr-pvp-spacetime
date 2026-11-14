// Identity: identity and lobby garbage collection, its guards and its job.
// Decisions: D-06, D-07, D-08, D-11, D-12
// Contracts: docs/auth/contract.md
// From S10 (s10-identity-gc.test.ts).
//
// T-S10 (batch C1): identity garbage collection in memory, ported from the live
// test/backend/garbage-collector/identity-gc.test.ts. Spec: docs/smoke/contract.md § Identity Garbage Collection
// (D-06 skip guests, D-07 preserve newest, D-08 skip online, D-11 90-day TTL, D-12 orphans, GcResult audit, seed
// idempotency) and its edge-case rows. The live suite aged identities with server_set_datetime / server_set_online
// (test-database-only reducers that throw on ctx.env in memory); here the TestClock moves instead and presence goes
// offline through the client_disconnected hook (A48: presence is per identity). Every guard test gives the user TWO
// identities, so it is the guard, not D-07, that keeps the stale one (the live "skips guests / online" tests were
// vacuous with one identity). Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { ScheduleAt } from 'spacetimedb';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    connect,
    disconnect,
    expectReject,
    guest,
    linkDiscord,
    newHarness,
    now,
    tx,
    type Actor,
    type Harness,
    AUDIT,
} from '../fixtures/harness';
import { moderator, setUserRole, verified, freshAuth, identitiesOf } from '../fixtures/identity';
import { DAY_MS } from '../fixtures/calendar';

const SEVEN_DAYS_MICROS = 7n * 86_400_000_000n;
const MOD_ONLY = 'Forbidden: Requires Moderator or Admin privileges.';

const gcRows = (test: Harness, gcType: string) => [...test.db.GcResult.iter()].filter((r) => r.gcType === gcType);
const gcIdentities = (test: Harness, who: Actor | 'internal') => tx(test, who, (ctx) => M.admin_gc_identities(ctx, {}));
const hasIdentity = (test: Harness, a: Actor) => !!test.db.UserIdentity.identity.find(a.identity);

/**
 * A verified user on two devices: `first` links the provider id, `second` (a later guest) links the same id and is
 * re-pointed to the same user (Case 1b of the sign-in, confirm_link). `second` reconnects `gapDays` later, so it is the newest
 * identity. Both devices are offline at the end unless `keepOnline` names one.
 */
function twoDeviceUser(test: Harness, name: string, gapDays = 10, keepOnline?: 'first' | 'second') {
    const first = verified(test, name);
    const second = guest(test, `${name}-2`);
    linkDiscord(test, second, test.db.User.id.find(first.userId)!.providerId!, name);
    expect(second.userId).toBe(first.userId);
    advance(test, gapDays * DAY_MS);
    connect(test, second); // bumps the second identity's lastSeenAt (lastSeenAt bump on connect)
    if (keepOnline !== 'first') disconnect(test, first);
    if (keepOnline !== 'second') disconnect(test, second);
    return { first, second, userId: first.userId };
}

describe('admin_gc_identities / admin_gc_lobbies: role guard and GcResult audit (scenarios "Admin GC Auth Guard", "Admin GC Trigger")', () => {
    it('a guest and a verified User are rejected by both admin GC reducers; no GcResult is written', () => {
        const test = newHarness();
        const g = guest(test, 'g');
        const user = verified(test, 'plain');
        for (const who of [g, user]) {
            expectReject(test, who, (ctx) => M.admin_gc_identities(ctx, {}), MOD_ONLY);
            expectReject(test, who, (ctx) => M.admin_gc_lobbies(ctx, {}), MOD_ONLY);
        }
        expect([...test.db.GcResult.iter()]).toHaveLength(0);
    });

    it('a Moderator runs both: each writes one GcResult even when nothing was deleted (identity: triggeredBy admin; actor = the Moderator); S11a (L6): with no chain running, the identity run re-arms IdentityGcJob 7 days out and the lobby run LobbyGcJob 15 minutes out', () => {
        const test = newHarness();
        const mod = moderator(test);
        gcIdentities(test, mod);
        tx(test, mod, (ctx) => M.admin_gc_lobbies(ctx, {}));

        const [identity] = gcRows(test, 'identity');
        expect(identity).toMatchObject({ itemsDeleted: 0, createdById: mod.userId });
        expect(identity.ranAt.microsSinceUnixEpoch).toBe(now(test));
        expect(identity.itemsScanned).toBe([...test.db.UserIdentity.iter()].length);
        expect(JSON.parse(identity.details)).toEqual({ orphaned: 0, stale: 0, guests: 0, triggeredBy: 'admin' }); // T-S10h: + guests (A95(1))
        expect(gcRows(test, 'lobby')).toEqual([expect.objectContaining({ itemsDeleted: 0, createdById: mod.userId })]);
        expect(JSON.parse(gcRows(test, 'lobby')[0].details).triggeredBy).toBe('admin');
        expect([...test.db.IdentityGcJob.iter()].map((j) => j.scheduledAt)).toEqual([ScheduleAt.time(now(test) + SEVEN_DAYS_MICROS)]);
        expect([...test.db.LobbyGcJob.iter()].map((j) => j.scheduledAt)).toEqual([ScheduleAt.time(now(test) + 15n * 60_000_000n)]);
    });
});

describe('identity GC guards (D-06, D-07, D-08, D-11, D-12)', () => {
    it('D-07 / D-11: of a verified offline user\'s two identities past 90 days, the older is deleted with its presence row and the newest is kept', () => {
        const test = newHarness();
        const mod = moderator(test);
        const { first, second, userId } = twoDeviceUser(test, 'roamer');
        advance(test, 91 * DAY_MS); // both past the TTL; second is still 10 days newer
        gcIdentities(test, mod);

        expect(hasIdentity(test, first)).toBe(false);
        expect(test.db.UserPresence.identity.find(first.identity)).toBeFalsy();
        expect(identitiesOf(test, userId).map((r) => r.identity.toHexString())).toEqual([second.identity.toHexString()]);
        expect(JSON.parse(gcRows(test, 'identity')[0].details)).toMatchObject({ stale: 1, orphaned: 0 });
        expect(gcRows(test, 'identity')[0].itemsDeleted).toBe(1);
    });

    it('D-11: an older identity idle 89 days is kept; at 90 days idle (the TTL is inclusive) it is deleted', () => {
        const test = newHarness();
        const mod = moderator(test);
        const { first, second } = twoDeviceUser(test, 'recent'); // first last seen at START; the clock is START + 10 d
        advance(test, 79 * DAY_MS);
        gcIdentities(test, mod);
        expect(hasIdentity(test, first)).toBe(true);
        expect(hasIdentity(test, second)).toBe(true);

        advance(test, DAY_MS);
        gcIdentities(test, mod);
        expect(hasIdentity(test, first)).toBe(false);
        expect(hasIdentity(test, second)).toBe(true);
    });

    it('D-08: while one of the user\'s identities is online, no identity of that user is collected; once offline, the stale one goes', () => {
        const test = newHarness();
        const mod = moderator(test);
        const { first, second } = twoDeviceUser(test, 'online', 10, 'second');
        advance(test, 120 * DAY_MS);
        gcIdentities(test, mod);
        expect(hasIdentity(test, first)).toBe(true);
        expect(hasIdentity(test, second)).toBe(true);

        disconnect(test, second);
        gcIdentities(test, mod);
        expect(hasIdentity(test, first)).toBe(false);
        expect(hasIdentity(test, second)).toBe(true);
    });

    // T-S10h (A95(1)): D-06 now holds for a guest with match history or a live membership; an idle, history-free guest
    // is deleted whole (s10h-lobby-rulings.test.ts covers the rule in full).
    /** A guest on two devices (the second an older offline identity), offline, plus a verified control user. */
    function staleGuest(test: Harness) {
        const g = guest(test, 'guesty');
        const extra = freshAuth(test, 'guesty-old-device');
        test.db.UserIdentity.insert({ identity: extra.identity, userId: g.userId, lastSeenAt: test.clock.now(), ...AUDIT(test) });
        return { g, extra };
    }
    function expectGuestKept(test: Harness, g: Actor, extra: { identity: any }) {
        expect(identitiesOf(test, g.userId)).toHaveLength(2);
        expect(test.db.UserIdentity.identity.find(extra.identity)).toBeTruthy();
        expect(test.db.User.id.find(g.userId)!.isGuest).toBe(true);
    }

    it('D-06 / A95(1): a guest with match history keeps its stale second identity, while a verified user in the same state loses it', () => {
        const test = newHarness();
        const mod = moderator(test);
        const { g, extra } = staleGuest(test);
        test.db.MatchParticipantHistory.insert({
            userId: g.userId, matchHistoryId: 1, teamSide: { tag: 'Blue' } as any, displayName: 'guesty',
            isReferee: false, isCoach: false, isCaptain: false, ...AUDIT(test),
        });
        const control = twoDeviceUser(test, 'control');
        disconnect(test, g);
        advance(test, 120 * DAY_MS);
        gcIdentities(test, mod);

        expectGuestKept(test, g, extra);
        expect(hasIdentity(test, control.first)).toBe(false);
    });

    it('D-06 / A95(1): a guest holding a lobby membership keeps its stale second identity and its user row', () => {
        const test = newHarness();
        const mod = moderator(test);
        const { g, extra } = staleGuest(test);
        const h = verified(test, 'lobbyhost');
        tx(test, h, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any));
        const lobbyId = [...test.db.Lobby.iter()].find((l) => l.hostUserId === h.userId)!.id;
        tx(test, g, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password: '' }));
        disconnect(test, g);
        advance(test, 120 * DAY_MS);
        gcIdentities(test, mod);

        expectGuestKept(test, g, extra);
        expect([...test.db.LobbyMember.user_id.filter(g.userId)]).toHaveLength(1);
    });

    it('A95(1) (supersedes D-06 for this case): an idle guest with no match history and no membership is deleted, both identities with it', () => {
        const test = newHarness();
        const mod = moderator(test);
        const { g, extra } = staleGuest(test);
        disconnect(test, g);
        advance(test, 120 * DAY_MS);
        gcIdentities(test, mod);

        expect(test.db.User.id.find(g.userId)).toBeFalsy();
        expect(identitiesOf(test, g.userId)).toHaveLength(0);
        expect(test.db.UserIdentity.identity.find(extra.identity)).toBeFalsy();
        expect(JSON.parse(gcRows(test, 'identity')[0].details)).toMatchObject({ guests: 1 });
    });

    it('D-12: an identity whose user row is missing is deleted at once, whatever its age; the user\'s single identity past the TTL is kept (D-07)', () => {
        const test = newHarness();
        const mod = moderator(test);
        const orphan = freshAuth(test, 'orphan');
        test.db.UserIdentity.insert({ identity: orphan.identity, userId: 777_777, lastSeenAt: test.clock.now(), ...AUDIT(test) });
        const lonely = verified(test, 'lonely');
        disconnect(test, lonely);
        advance(test, 200 * DAY_MS);
        // the orphan is fresh relative to the clock: bump it so its age cannot be the reason
        test.db.UserIdentity.identity.update({ ...test.db.UserIdentity.identity.find(orphan.identity)!, lastSeenAt: test.clock.now() });
        gcIdentities(test, mod);

        expect(test.db.UserIdentity.identity.find(orphan.identity)).toBeFalsy();
        expect(hasIdentity(test, lonely)).toBe(true);
        const [row] = gcRows(test, 'identity');
        expect(JSON.parse(row.details)).toMatchObject({ orphaned: 1, stale: 0 });
    });

    it('the scheduled run writes a GcResult only when it deleted something, and requeues itself 7 days out either way ("Scheduled GC on empty database")', () => {
        const test = newHarness();
        const fire = () => {
            const jobs = [...test.db.IdentityGcJob.iter()];
            for (const j of jobs) test.db.IdentityGcJob.scheduledId.delete(j.scheduledId);
            const arg = jobs[0] ?? { scheduledId: 1n, scheduledAt: ScheduleAt.time(now(test)) };
            tx(test, 'internal', (ctx) => M.run_identity_gc(ctx, { arg }));
        };
        fire();
        expect(gcRows(test, 'identity')).toHaveLength(0);
        expect([...test.db.IdentityGcJob.iter()].map((j) => j.scheduledAt)).toEqual([ScheduleAt.time(now(test) + SEVEN_DAYS_MICROS)]);

        const orphan = freshAuth(test, 'sched-orphan');
        test.db.UserIdentity.insert({ identity: orphan.identity, userId: 888_888, lastSeenAt: test.clock.now(), ...AUDIT(test) });
        advance(test, 7 * DAY_MS);
        fire();
        const rows = gcRows(test, 'identity');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ itemsDeleted: 1, createdById: 0 });
        expect(JSON.parse(rows[0].details)).toEqual({ orphaned: 1, stale: 0, guests: 0 }); // T-S10h: + guests (A95(1))
        expect([...test.db.IdentityGcJob.iter()]).toHaveLength(1);
    });

    // S10h review F4: a scheduled run that reached the 500-guest cap requeues one hour out (the backlog drains in hourly
    // runs); a run under the cap keeps the weekly interval. Exactly one job is queued either way. The 501 idle guests are
    // inserted as rows (User + UserIdentity, no presence row = offline), as in s10h-lobby-rulings.test.ts.
    it('review F4: a scheduled run that hits the 500-guest cap requeues itself one hour out; the next run, under the cap, requeues 7 days out', () => {
        const test = newHarness();
        const ONE_HOUR_MICROS = 3_600_000_000n;
        const fire = () => {
            const jobs = [...test.db.IdentityGcJob.iter()];
            for (const j of jobs) test.db.IdentityGcJob.scheduledId.delete(j.scheduledId);
            const arg = jobs[0] ?? { scheduledId: 1n, scheduledAt: ScheduleAt.time(now(test)) };
            tx(test, 'internal', (ctx) => M.run_identity_gc(ctx, { arg }));
        };
        const ids: number[] = [];
        for (let i = 0; i < 501; i++) {
            const u = test.db.User.insert({
                id: 0, username: `cap_${i}`, displayName: `cap_${i}`, isGuest: true, role: { tag: 'User' } as any,
                avatarCharacterName: 'march7th', displayedAchievementId: undefined, deletedAt: undefined,
                ...AUDIT(test),
            } as any);
            test.db.UserIdentity.insert({ identity: freshAuth(test, `cap-${i}`).identity, userId: u.id, lastSeenAt: test.clock.now(), ...AUDIT(test) });
            ids.push(u.id);
        }
        const left = () => ids.filter((id) => test.db.User.id.find(id)).length;
        advance(test, 30 * DAY_MS);

        fire();
        expect(left()).toBe(1);
        expect(JSON.parse(gcRows(test, 'identity')[0].details)).toMatchObject({ guests: 500 });
        expect([...test.db.IdentityGcJob.iter()].map((j) => j.scheduledAt)).toEqual([ScheduleAt.time(now(test) + ONE_HOUR_MICROS)]);

        advance(test, 60 * 60 * 1000);
        fire();
        expect(left()).toBe(0);
        expect(JSON.parse(gcRows(test, 'identity')[1].details)).toMatchObject({ guests: 1 });
        expect([...test.db.IdentityGcJob.iter()].map((j) => j.scheduledAt)).toEqual([ScheduleAt.time(now(test) + SEVEN_DAYS_MICROS)]);
    }, 120_000);
});

describe('seed_identity_gc_job (scenario "Seed Identity GC Job Idempotency")', () => {
    it('init queues no IdentityGcJob; the first seed queues one 7 days out; a second seed is a no-op; a non-server caller (even an Admin) is rejected', () => {
        const test = newHarness();
        expect([...test.db.IdentityGcJob.iter()]).toHaveLength(0);

        tx(test, 'internal', (ctx) => M.seed_identity_gc_job(ctx, {}));
        const first = [...test.db.IdentityGcJob.iter()];
        expect(first).toHaveLength(1);
        expect(first[0].scheduledAt).toEqual(ScheduleAt.time(now(test) + SEVEN_DAYS_MICROS));

        advance(test, DAY_MS);
        tx(test, 'internal', (ctx) => M.seed_identity_gc_job(ctx, {}));
        expect([...test.db.IdentityGcJob.iter()]).toEqual(first);

        const boss = verified(test, 'boss');
        setUserRole(test, boss.userId, 'Admin');
        expectReject(test, boss, (ctx) => M.seed_identity_gc_job(ctx, {}), 'Forbidden: caller is not the registered server identity.');
        expect([...test.db.IdentityGcJob.iter()]).toHaveLength(1);
    });
});
