// Admin: the guard of the scheduled reducers and the manual clean-up tools that restart a stopped chain.
// Decisions: none new (triage L11, L6; ROADMAP S11a)
// Contracts: docs/admin/contract.md, docs/smoke/contract.md (Identity Garbage Collection), docs/auth/contract.md
// From S11a.
//
// T-S11a (L11): every scheduled reducer (run_user_deletion, run_identity_gc, run_lobby_gc, run_referee_transfer_check,
// run_tournament_finalize) refuses a caller that is not the scheduler (ensureScheduler: ctx.senderAuth.isInternal) and
// changes nothing; the scheduler path, which the harness models as TestAuth.internal() (sender = the module identity),
// still runs; the manual tools admin_gc_identities / admin_gc_lobbies still work for a Moderator.
// The harness cannot tell the database owner from the module identity (both are 'internal' here): that the owner and a
// delegate are refused on maincloud is a live check (S11a log).
// T-S11a (L6): a manual GC run restarts a chain that has stopped (no job row) and leaves a running chain alone.
import { describe, expect, it } from 'vitest';
import { ScheduleAt } from 'spacetimedb';
import {
    M,
    advance,
    disconnect,
    expectReject,
    fireCheck,
    guest,
    newHarness,
    now,
    pendingCheck,
    setupLobby,
    snap,
    tx,
    type Actor,
    type Harness,
} from '../fixtures/harness';
import { admin, fireDeletionJob, jobsFor, moderator, verified } from '../fixtures/identity';
import { advanceStage, liveField, resolveMatch, BO1 } from '../fixtures/tournaments';
import { jobsOf, tick } from '../fixtures/tournament-matches';

const SEVEN_DAYS_MICROS = 7n * 86_400_000_000n;
const FIFTEEN_MINUTES_MICROS = 15n * 60_000_000n;
const refusal = (name: string) => `Forbidden: ${name} is a scheduled reducer and runs only from the scheduler.`;

/** Everything a scheduled reducer could write, as one comparable string. */
function world(test: Harness): string {
    return snap(
        [...test.db.User.iter()], [...test.db.UserIdentity.iter()], [...test.db.UserDeletionJob.iter()],
        [...test.db.IdentityGcJob.iter()], [...test.db.LobbyGcJob.iter()], [...test.db.GcResult.iter()],
        [...test.db.Lobby.iter()], [...test.db.LobbyMember.iter()], [...test.db.MatchSessionStep.iter()],
        [...test.db.RefereeTransferCheck.iter()], [...test.db.TournamentFinalizeJob.iter()], [...test.db.Tournament.iter()],
    );
}

/** A guest, a verified user and an Admin: none of them is the scheduler. */
const outsiders = (test: Harness): Actor[] => [guest(test, 'out-guest'), verified(test, 'out-user'), admin(test, 'out-admin')];

describe('L11: a scheduled reducer refuses every caller but the scheduler and changes nothing', () => {
    it('run_user_deletion: the soft-deleted user stays until the scheduler fires the job', () => {
        const test = newHarness();
        const victim = verified(test, 'victim');
        tx(test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(victim.userId) }));
        const [job] = jobsFor(test, victim.userId);
        expect(job).toBeDefined();
        const callers = outsiders(test);
        const before = world(test);
        for (const who of callers) {
            expectReject(test, who, (ctx) => M.run_user_deletion(ctx, { arg: job }), refusal('run_user_deletion'));
        }
        expect(world(test)).toBe(before);
        expect(test.db.User.id.find(victim.userId)).toBeTruthy();

        fireDeletionJob(test, victim.userId); // the scheduler path
        expect(test.db.User.id.find(victim.userId)).toBeFalsy();
    });

    it('run_identity_gc and run_lobby_gc: no run, no GcResult, no re-queued job; the scheduler path re-queues', () => {
        const test = newHarness();
        const callers = outsiders(test);
        const at = ScheduleAt.time(now(test));
        const before = world(test);
        for (const who of callers) {
            expectReject(test, who, (ctx) => M.run_identity_gc(ctx, { arg: { scheduledId: 1n, scheduledAt: at } }), refusal('run_identity_gc'));
            expectReject(test, who, (ctx) => M.run_lobby_gc(ctx, { arg: { scheduledId: 1n, scheduledAt: at } }), refusal('run_lobby_gc'));
        }
        expect(world(test)).toBe(before);

        tx(test, 'internal', (ctx) => M.run_identity_gc(ctx, { arg: { scheduledId: 1n, scheduledAt: at } }));
        tx(test, 'internal', (ctx) => M.run_lobby_gc(ctx, { arg: { scheduledId: 1n, scheduledAt: at } }));
        expect([...test.db.IdentityGcJob.iter()].map((j) => j.scheduledAt)).toEqual([ScheduleAt.time(now(test) + SEVEN_DAYS_MICROS)]);
        expect([...test.db.LobbyGcJob.iter()].map((j) => j.scheduledAt)).toEqual([ScheduleAt.time(now(test) + FIFTEEN_MINUTES_MICROS)]);
    });

    it('run_referee_transfer_check: the offline referee keeps the flag until the scheduler fires the check', () => {
        const test = newHarness();
        const s = setupLobby(test, { hostSlot: 'BluePlayer', seats: [['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] });
        disconnect(test, s.host);
        const row = pendingCheck(test, s.lobbyId, s.host.userId);
        advance(test, 16_000);
        const callers = [...outsiders(test), s.a.r1];
        const before = world(test);
        for (const who of callers) {
            expectReject(test, who, (ctx) => M.run_referee_transfer_check(ctx, { arg: row }), refusal('run_referee_transfer_check'));
        }
        expect(world(test)).toBe(before);

        fireCheck(test, row); // the scheduler path
        const refs = [...test.db.LobbyMember.lobby_id.filter(s.lobbyId)].filter((m) => m.isReferee).map((m) => m.userId);
        expect(refs).not.toContain(s.host.userId);
    });

    it('run_tournament_finalize: the organizer and an Admin are refused; the scheduler tick finalizes', () => {
        const f = liveField(4, BO1);
        for (let guard = 0; guard < 16; guard++) {
            const ready = [...f.test.db.BracketMatch.iter()].filter((m) => m.tournamentId === f.id && m.state.tag === 'Ready');
            if (ready.length === 0) break;
            resolveMatch(f.test, f.org, ready[0].id, ready[0].team1Id!);
        }
        advanceStage(f.test, f.org, f.id, 'Completed');
        const [row] = jobsOf(f.test, f.id);
        const callers = [f.org, ...outsiders(f.test)];
        const before = world(f.test);
        for (const who of callers) {
            expectReject(f.test, who, (ctx) => M.run_tournament_finalize(ctx, { arg: row }), refusal('run_tournament_finalize'));
        }
        expect(world(f.test)).toBe(before);

        tick(f.test, f.id);
        expect(f.test.db.Tournament.id.find(f.id)!.finalizedAt).toBeDefined();
    });
});

describe('L11: the manual tools still work through their own reducers', () => {
    it('a Moderator runs admin_gc_identities and admin_gc_lobbies (one GcResult each); a plain user is refused', () => {
        const test = newHarness();
        const mod = moderator(test);
        tx(test, mod, (ctx) => M.admin_gc_identities(ctx, {}));
        tx(test, mod, (ctx) => M.admin_gc_lobbies(ctx, {}));
        expect([...test.db.GcResult.iter()].map((r) => r.gcType).sort()).toEqual(['identity', 'lobby']);
        expectReject(test, verified(test, 'plain'), (ctx) => M.admin_gc_lobbies(ctx, {}), 'Forbidden: Requires Moderator or Admin privileges.');
    });
});

describe('L6: a manual GC run restarts a stopped chain and leaves a running one alone', () => {
    it('no job row (the chain stopped): admin_gc_identities queues IdentityGcJob 7 days out, admin_gc_lobbies LobbyGcJob 15 minutes out', () => {
        const test = newHarness();
        const mod = moderator(test);
        expect([...test.db.IdentityGcJob.iter()]).toHaveLength(0);
        expect([...test.db.LobbyGcJob.iter()]).toHaveLength(0);
        tx(test, mod, (ctx) => M.admin_gc_identities(ctx, {}));
        tx(test, mod, (ctx) => M.admin_gc_lobbies(ctx, {}));
        expect([...test.db.IdentityGcJob.iter()].map((j) => j.scheduledAt)).toEqual([ScheduleAt.time(now(test) + SEVEN_DAYS_MICROS)]);
        expect([...test.db.LobbyGcJob.iter()].map((j) => j.scheduledAt)).toEqual([ScheduleAt.time(now(test) + FIFTEEN_MINUTES_MICROS)]);
    });

    it('a running chain: the manual runs add no second row; the seed reducers stay idempotent', () => {
        const test = newHarness();
        const mod = moderator(test);
        tx(test, 'internal', (ctx) => M.seed_identity_gc_job(ctx, {}));
        tx(test, 'internal', (ctx) => M.seed_lobby_gc_job(ctx, {}));
        const identityJobs = snap([...test.db.IdentityGcJob.iter()]);
        const lobbyJobs = snap([...test.db.LobbyGcJob.iter()]);
        advance(test, 60_000);
        tx(test, mod, (ctx) => M.admin_gc_identities(ctx, {}));
        tx(test, mod, (ctx) => M.admin_gc_lobbies(ctx, {}));
        tx(test, 'internal', (ctx) => M.seed_identity_gc_job(ctx, {}));
        tx(test, 'internal', (ctx) => M.seed_lobby_gc_job(ctx, {}));
        expect(snap([...test.db.IdentityGcJob.iter()])).toBe(identityJobs);
        expect(snap([...test.db.LobbyGcJob.iter()])).toBe(lobbyJobs);
    });
});
