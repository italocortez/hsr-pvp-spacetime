import { describe, it, expect, afterAll } from 'vitest';
import {
  createTestHarness,
  createVerifiedTestHarness,
  hasServerToken,
  expectReducerError,
  queryPrivateTable,
  getTestDiscordId,
  TestHarness,
} from '../../shared/connection';
import { promoteToRole } from '../../shared/helpers/promoteUser';

describe('Ban Admin Reducers', () => {
  const harnesses: TestHarness[] = [];

  // Shared admin harness — created once, reused across input validation tests
  let adminHarness: TestHarness | null = null;

  async function getAdmin(): Promise<TestHarness> {
    if (adminHarness) return adminHarness;
    const h = await createVerifiedTestHarness();
    harnesses.push(h);
    await h.sync(2000);
    await promoteToRole(h, 'Admin');
    await h.sync(2000); // Wait for role update to propagate to server
    adminHarness = h;
    return h;
  }

  afterAll(async () => {
    for (const h of harnesses) {
      await h.disconnect().catch(() => {});
    }
  });

  describe('Input validation', () => {
    it.skipIf(!hasServerToken())('rejects providerId longer than 32 chars', async () => {
      const admin = await getAdmin();
      const longProviderId = 'a'.repeat(33);

      const err = await expectReducerError(
        admin.call.adminBanUser({
          banTypeTag: 'DiscordId',
          providerId: longProviderId,
          reason: 'Test ban',
        })
      );
      expect(err).toContain('32 characters');
    });

    it.skipIf(!hasServerToken())('rejects reason longer than 500 chars', async () => {
      const admin = await getAdmin();
      const longReason = 'x'.repeat(501);

      const err = await expectReducerError(
        admin.call.adminBanUser({
          banTypeTag: 'DiscordId',
          providerId: 'valid_provider_id',
          reason: longReason,
        })
      );
      expect(err).toContain('500 characters');
    });

    it.skipIf(!hasServerToken())('rejects empty providerId', async () => {
      const admin = await getAdmin();

      const err = await expectReducerError(
        admin.call.adminBanUser({
          banTypeTag: 'DiscordId',
          providerId: '',
          reason: 'Test ban',
        })
      );
      expect(err).toContain('providerId is required');
    });

    it.skipIf(!hasServerToken())('rejects empty reason', async () => {
      const admin = await getAdmin();

      const err = await expectReducerError(
        admin.call.adminBanUser({
          banTypeTag: 'DiscordId',
          providerId: 'some_provider_id',
          reason: '',
        })
      );
      expect(err).toContain('reason is required');
    });

    it.skipIf(!hasServerToken())('rejects invalid banTypeTag', async () => {
      const admin = await getAdmin();

      const err = await expectReducerError(
        admin.call.adminBanUser({
          banTypeTag: 'InvalidType',
          providerId: 'some_provider_id',
          reason: 'Test ban',
        })
      );
      expect(err).toContain('Invalid banType');
    });
  });

  describe('Duplicate ban rejection', () => {
    it.skipIf(!hasServerToken())('rejects banning the same provider ID twice', async () => {
      const admin = await getAdmin();

      // Create a verified target user to get a real Discord ID
      const target = await createVerifiedTestHarness();
      harnesses.push(target);
      await target.sync(2000);

      const targetDiscordId = await getTestDiscordId(target.userId);
      expect(targetDiscordId).toBeTruthy();

      // First ban should succeed
      await admin.call.adminBanUser({
        banTypeTag: 'DiscordId',
        providerId: targetDiscordId,
        reason: 'First ban - duplicate test',
      });
      await admin.sync(2000);

      // Verify ban record was created
      const banRecords = await queryPrivateTable(
        `SELECT * FROM ban_record WHERE provider_id = '${targetDiscordId}'`
      );
      expect(banRecords.length).toBe(1);

      // Second ban on same provider ID should fail
      const err = await expectReducerError(
        admin.call.adminBanUser({
          banTypeTag: 'DiscordId',
          providerId: targetDiscordId,
          reason: 'Second ban - should fail',
        })
      );
      expect(err).toContain('already banned');
    });
  });

  describe('Unban removes BanRecord', () => {
    it.skipIf(!hasServerToken())('admin_unban_user deletes the ban record', async () => {
      const admin = await getAdmin();

      // Create a verified target user
      const target = await createVerifiedTestHarness();
      harnesses.push(target);
      await target.sync(2000);

      const targetDiscordId = await getTestDiscordId(target.userId);
      expect(targetDiscordId).toBeTruthy();

      // Ban the target
      await admin.call.adminBanUser({
        banTypeTag: 'DiscordId',
        providerId: targetDiscordId,
        reason: 'Ban for unban test',
      });
      await admin.sync(2000);

      // Verify BanRecord exists and get its ID
      const banRecords = await queryPrivateTable(
        `SELECT * FROM ban_record WHERE provider_id = '${targetDiscordId}'`
      );
      expect(banRecords.length).toBe(1);
      const banRecordId = parseInt(banRecords[0].id, 10);
      expect(banRecordId).toBeGreaterThan(0);

      // Unban using the record ID
      admin.call.adminUnbanUser({ banRecordId });
      await admin.sync(2000);

      // Verify BanRecord was removed
      const afterUnban = await queryPrivateTable(
        `SELECT * FROM ban_record WHERE provider_id = '${targetDiscordId}'`
      );
      expect(afterUnban.length).toBe(0);
    });
  });

  describe('D-19: admin_ban_user schedules UserDeletionJob (R1 fix)', () => {
    it.skipIf(!hasServerToken())(
      'admin_ban_user inserts a user_deletion_job row for the banned user',
      async () => {
        const admin = await getAdmin();

        // Create a verified target user — they have a Discord ID we can ban on.
        const target = await createVerifiedTestHarness();
        harnesses.push(target);
        await target.sync(2000);

        const targetDiscordId = await getTestDiscordId(target.userId);
        expect(targetDiscordId).toBeTruthy();

        // Ban the target — this should:
        //   1. Insert BanRecord
        //   2. Soft-delete the User (set deletedAt)
        //   3. Insert UserDeletionJob scheduled 5s out (Phase 15.2 D-10 R1 fix)
        await admin.call.adminBanUser({
          banTypeTag: 'DiscordId',
          providerId: targetDiscordId,
          reason: 'D-19 regression test — UserDeletionJob insert verification',
        });
        await admin.sync(2000);

        // Verify BanRecord was created (pre-existing assertion, confirms ban path ran).
        const banRecords = await queryPrivateTable(
          `SELECT * FROM ban_record WHERE provider_id = '${targetDiscordId}'`
        );
        expect(banRecords.length).toBe(1);

        // D-19 core assertion: a UserDeletionJob row must exist for the banned user.
        // Phase 15.2 D-10 adds UserDeletionJob.insert to admin_ban_user (banAdmin.ts),
        // fixing the R1 latent bug where bans never triggered the scheduled cascade.
        const jobs = await queryPrivateTable(
          `SELECT * FROM user_deletion_job WHERE user_id = ${target.userId}`
        );
        expect(jobs.length).toBe(1);
      }
    );

    // clientConnected ban-on-reconnect (index.ts) gains the same UserDeletionJob.insert
    // call as admin_ban_user in Phase 15.2 D-10. The full integration path requires
    // racing a fresh WebSocket connect against a BanRecord insert in a way that
    // exercises the clientConnected handler — this is a timing-sensitive race that
    // the current harness cannot reliably drive without a dedicated reconnect harness.
    //
    // Structural coverage rationale:
    //   - The insert pattern at index.ts:clientConnected matches admin.ts:183-188 and
    //     banAdmin.ts verbatim (same ScheduleAt.time(now+5s), same auditInsert shape).
    //   - Plan 02 acceptance criteria verified the source diff (grep) that the insert
    //     is present in clientConnected.
    //   - The admin_ban_user D-19 integration test above exercises the identical
    //     UserDeletionJob.insert code path end-to-end.
    //
    // Deferred: a dedicated reconnect-race test would require a test harness that can
    // disconnect, insert a BanRecord, then reconnect within the 5s cascade window.
    // Tracked in deferred-items for Phase 16+ test infrastructure improvements.
    it.todo(
      'D-19 clientConnected ban-on-reconnect: insert pattern matches admin_ban_user (structural coverage)'
    );
  });

  describe('Permission guards', () => {
    it('guest user cannot call admin_ban_user', async () => {
      const guest = await createTestHarness();
      harnesses.push(guest);
      await guest.sync(2000);

      const err = await expectReducerError(
        guest.call.adminBanUser({
          banTypeTag: 'DiscordId',
          providerId: 'some_id',
          reason: 'Should be rejected',
        })
      );
      // ensureAdmin throws a permission error for non-admin users
      expect(err.toLowerCase()).toMatch(/admin|permission|unauthorized|not allowed/);
    });

    it.skipIf(!hasServerToken())('verified non-admin user cannot call admin_ban_user', async () => {
      const user = await createVerifiedTestHarness();
      harnesses.push(user);
      await user.sync(2000);

      // User has role 'User' (not Admin) by default after verification
      const err = await expectReducerError(
        user.call.adminBanUser({
          banTypeTag: 'DiscordId',
          providerId: 'some_id',
          reason: 'Should be rejected',
        })
      );
      expect(err.toLowerCase()).toMatch(/admin|permission|unauthorized|not allowed/);
    });
  });
});
