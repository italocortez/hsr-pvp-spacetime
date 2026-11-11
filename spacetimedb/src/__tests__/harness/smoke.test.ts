// The in-memory module test harness runs the real module (smoke).
// Contracts: docs/smoke/contract.md
// From S4(c) (harness.smoke.test.ts).
//
// T-S4(c): in-memory module test harness smoke test (plan D.7(2) spike).
// Proves spacetimedbModuleTestPlugin + createModuleTestHarness run the real module on this toolchain.
// No network: the harness is an in-memory datastore (WASM), nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { ConnectionId, ScheduleAt, TimeDuration, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth, TestClock } from 'spacetimedb/server/test-utils';
import spacetimedb from '@module/schema';
import * as moduleExports from '@module/index';

const START = Timestamp.fromDate(new Date('2026-01-01T00:00:00Z'));
const SEVEN_DAYS_MICROS = 7n * 86_400_000_000n;

function freshHarness() {
    return createModuleTestHarness(spacetimedb, moduleExports, { clock: new TestClock(START) });
}

// A client caller: the harness derives the sender Identity from the JWT payload (iss + sub).
function client(sub: string, connectionId: bigint) {
    return TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(connectionId));
}

describe('module test harness (smoke)', () => {
    it('(a) gives every test a fresh, empty database', () => {
        const first = freshHarness();
        first.withReducerTx(client('alice', 1n), (ctx) => moduleExports.login_as_guest(ctx, {}));
        expect(first.db.User.count()).toBe(1n);

        const second = freshHarness();
        expect(second.db.User.count()).toBe(0n);
        expect(second.db.UserIdentity.count()).toBe(0n);
    });

    it('(b) runs init as the owner (internal auth = the module identity) and creates SYSTEM', () => {
        const test = freshHarness();
        test.withReducerTx(TestAuth.internal(), (ctx) => {
            expect(ctx.sender.isEqual(test.moduleIdentity)).toBe(true);
            moduleExports.init(ctx, {});
        });

        const owners = [...test.db.ServerIdentity.iter()];
        expect(owners).toHaveLength(1);
        expect(owners[0].kind.tag).toBe('Owner');
        expect(owners[0].identity.isEqual(test.moduleIdentity)).toBe(true);
        expect(test.db.User.username.find('SYSTEM')?.role.tag).toBe('Admin');
        expect(test.db.UserIdentity.identity.find(test.moduleIdentity)).toBeDefined();
    });

    it('(b2) runs init with a client JWT sender (the publisher), which becomes the owner', () => {
        const test = freshHarness();
        const publisher = client('publisher', 9n);
        let publisherIdentity!: ReturnType<typeof test.viewContext>['sender'];
        test.withReducerTx(publisher, (ctx) => {
            publisherIdentity = ctx.sender;
            moduleExports.init(ctx, {});
        });
        expect([...test.db.ServerIdentity.iter()][0].identity.isEqual(publisherIdentity)).toBe(true);
    });

    it('(c) login_as_guest creates User + UserIdentity, readable from private tables', () => {
        const test = freshHarness();
        const alice = client('alice', 1n);
        const sender = test.viewContext(alice).sender;

        test.withReducerTx(alice, (ctx) => moduleExports.login_as_guest(ctx, {}));

        const mapping = test.db.UserIdentity.identity.find(sender);
        expect(mapping).toBeDefined();
        const user = test.db.User.id.find(mapping!.userId);
        expect(user?.isGuest).toBe(true);
        // S10h: "Guest_" + the last 8 hex characters (the first 8 are a fixed tag and a short checksum)
        expect(user?.username).toBe(`Guest_${sender.toHexString().slice(-8)}`);
        expect(mapping!.lastSeenAt.microsSinceUnixEpoch).toBe(START.microsSinceUnixEpoch);
    });

    it('(d) client_connected / client_disconnected can be called explicitly and write UserPresence', () => {
        const test = freshHarness();
        const alice = client('alice', 1n);
        const sender = test.viewContext(alice).sender;
        test.withReducerTx(alice, (ctx) => moduleExports.login_as_guest(ctx, {}));

        test.withReducerTx(alice, (ctx) => moduleExports.client_connected(ctx, {}));
        expect(test.db.UserPresence.identity.find(sender)?.isOnline).toBe(true);

        test.clock.advance(TimeDuration.fromMillis(5_000));
        test.withReducerTx(alice, (ctx) => moduleExports.client_disconnected(ctx, {}));
        const presence = test.db.UserPresence.identity.find(sender);
        expect(presence?.isOnline).toBe(false);
        expect(presence?.lastSeenAt.microsSinceUnixEpoch).toBe(START.microsSinceUnixEpoch + 5_000_000n);
    });

    it('(e) advances the clock and calls scheduled reducers by hand with a row', () => {
        const test = freshHarness();
        test.clock.advance(TimeDuration.fromMillis(20_000));
        const now = START.microsSinceUnixEpoch + 20_000_000n;
        expect(test.clock.now().microsSinceUnixEpoch).toBe(now);

        test.withReducerTx(TestAuth.internal(), (ctx) =>
            moduleExports.run_identity_gc(ctx, { arg: { scheduledId: 1n, scheduledAt: ScheduleAt.time(now) } }),
        );
        // run_identity_gc self-requeues 7 days after ctx.timestamp (the advanced clock).
        const jobs = [...test.db.IdentityGcJob.iter()];
        expect(jobs).toHaveLength(1);
        expect(jobs[0].scheduledAt).toEqual(ScheduleAt.time(now + SEVEN_DAYS_MICROS));

        // The onSchedule-bound reducer (S3 stub) is callable the same way.
        test.withReducerTx(TestAuth.internal(), (ctx) =>
            moduleExports.run_referee_transfer_check(ctx, {
                arg: { scheduledId: 1n, scheduledAt: ScheduleAt.time(now), lobbyId: 1, userId: 1 },
            }),
        );
    });

    // (f) Finding: the 2.14.1 harness has no option to set the module env. ctx.env reads go through the
    // `env_get` host syscall, which the plugin's stub throws on, so requireTestDatabase (server_* reducers)
    // cannot pass in-memory. This test pins the current behaviour; it fails once the SDK supports env.
    it('(f) module env (STDB_TARGET) is not settable: ctx.env throws in the harness', () => {
        const test = freshHarness();
        expect(() =>
            test.withReducerTx(TestAuth.internal(), (ctx) => ctx.env.STDB_TARGET),
        ).toThrow(/env_get/);
    });

    it.skip('(f2) server_* reducers pass requireTestDatabase (needs module env support in test-utils)', () => {});
});
