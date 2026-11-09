/**
 * Live residue (T-S10, ACCESS-SECURITY-OPS §D.5, F14): scheduler timers actually firing. The in-memory suites
 * consume scheduled rows by hand; here nothing is ticked manually.
 *
 *   (a) D-17: admin_delete_row('User') soft-deletes and schedules run_user_deletion 5 s out; the job fires on its own,
 *       evicts the verified user to the DeletedUser archive and severs every identity. Observed through
 *       view_admin_deleted_users (the admin's subscription), view_user_by_username (anonymous arg view, A44(1)) and
 *       the victim's own view_my_identity. admin_delete_row is Admin-only (`ensureAdmin`), so the actor is an Admin
 *       (the brief's "Moderator" cannot call it).
 *   (b) The GC chains are armed: exactly one IdentityGcJob and one LobbyGcJob row (seeded by bootstrap; each run
 *       re-arms its own row). No view exposes the job tables, so the count goes through `spacetime sql`.
 *   (c) run_tournament_finalize firing on its own: todo (see the reason on the line).
 *
 * Estimated runtime: ~25 s ((a) two verified users + a ≤ 20 s wait for the 5 s job; (b) two CLI queries).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { hasServerToken, queryPrivateTable } from '../shared/connection';
import { type LiveUser, closeAll, connectVerified, setRole, subscribe, waitFor } from './_helpers';

describe('Scheduler chains fire without a manual tick (§D.5, F14)', () => {
    const open: LiveUser[] = [];

    afterAll(() => closeAll(open));

    it.skipIf(!hasServerToken())(
        '(a) D-17: admin_delete_row(User) → run_user_deletion fires by itself (~5 s) → the user is archived and unreachable',
        async () => {
            const admin = await connectVerified();
            const victim = await connectVerified();
            open.push(admin, victim);

            await setRole(admin.username, 'Admin');
            await subscribe(admin.conn, [
                'SELECT * FROM view_admin_deleted_users',
                `SELECT * FROM view_user_by_username('${victim.username}')`,
            ]);
            await waitFor(
                () => [...admin.conn.db.viewUserByUsername.iter()].find((u) => u.userId === victim.userId),
                'victim found by username before the deletion',
            );
            expect([...admin.conn.db.viewAdminDeletedUsers.iter()].some((d) => d.id === victim.userId)).toBe(false);

            // Awaited: a rejection fails the test (no swallowed .catch).
            await admin.conn.reducers.adminDeleteRow({ tableName: 'User', primaryKeyJson: String(victim.userId) });

            const archived = await waitFor(
                () => [...admin.conn.db.viewAdminDeletedUsers.iter()].find((d) => d.id === victim.userId),
                'run_user_deletion archives the victim (view_admin_deleted_users)',
                20_000,
            );
            expect(archived.isGuest).toBe(false);
            expect([...admin.conn.db.viewUserByUsername.iter()].some((u) => u.userId === victim.userId)).toBe(false);
            // The cascade deleted every UserIdentity row of the victim: its own session's identity view is empty.
            await waitFor(() => victim.conn.db.viewMyIdentity.count() === 0n, 'victim view_my_identity emptied', 10_000);
        },
        90_000,
    );

    it('(b) the GC chains are armed: exactly one identity_gc_job and one lobby_gc_job row', async () => {
        const identityJobs = await queryPrivateTable('SELECT COUNT(*) AS n FROM identity_gc_job');
        const lobbyJobs = await queryPrivateTable('SELECT COUNT(*) AS n FROM lobby_gc_job');
        expect(Number(identityJobs[0]?.n)).toBe(1);
        expect(Number(lobbyJobs[0]?.n)).toBe(1);
    }, 40_000);

    it.todo(
        '(c) A24(7): a two-player Casual tournament resolved to Completed gets finalizedAt from run_tournament_finalize ' +
            'without a manual tick. Not built: reaching Completed live needs registration, bracket generation and a ' +
            'played or resolved match (minutes of maincloud calls); s8d-finalization covers the reducer in memory. ' +
            'Revisit if the residue budget allows (≤ 15 min).',
    );
});
