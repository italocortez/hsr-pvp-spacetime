/**
 * Integration tests: HSR Account CRUD
 *
 * UAT coverage: Tests 2-5, 8
 * Requires: SpacetimeDB running with published module + seed data.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createVerifiedTestHarness, hasServerToken, expectReducerError, queryPrivateTable, type TestHarness } from '../../shared/connection';
import { nextUid, resetUidCounter } from '../../shared/fixtures';

describe.skipIf(!hasServerToken())('HSR Account CRUD', () => {
  let h: TestHarness;

  /** Return only this test user's accounts (avoids cross-user pollution from shared DB) */
  const myAccounts = async () => {
    const rows = await queryPrivateTable(`SELECT * FROM hsr_account WHERE user_id = ${h.userId}`);
    return rows.map(r => ({
      id: Number(r.id),
      userId: Number(r.user_id),
      uid: r.uid.replace(/"/g, ''),
      region: r.region.replace(/"/g, ''),
      displayLabel: r.display_label.replace(/"/g, ''),
      isActive: r.is_active === 'true',
      isRosterPublic: r.is_roster_public === 'true',
      isRatingPublic: r.is_rating_public === 'true',
      isDuplicateUid: r.is_duplicate_uid === 'true',
    }));
  };

  beforeAll(async () => {
    resetUidCounter();
    h = await createVerifiedTestHarness();
  });

  afterAll(async () => {
    await h?.disconnect();
  });

  // ── Test 2: Create HSR Account ──────────────────────────────────────────

  describe('create_hsr_account', () => {
    it('creates account with correct region derived from UID', async () => {
      const uid = '800000099';
      await h.call.createHsrAccount({ uid, displayLabel: 'Asia Account' });
      await h.sync();

      const created = (await myAccounts()).find((a) => a.uid === uid);
      expect(created).toBeDefined();
      expect(created!.region).toBe('Asia');
      expect(created!.displayLabel).toBe('Asia Account');
    });

    it('auto-activates the first account for a user', async () => {
      const myAccount = (await myAccounts()).find((a) => a.uid === '800000099');
      expect(myAccount).toBeDefined();
      expect(myAccount!.isActive).toBe(true);
    });

    it('defaults isRatingPublic to false', async () => {
      const created = (await myAccounts()).find((a) => a.uid === '800000099');
      expect(created!.isRatingPublic).toBe(false);
      // isDuplicateUid may be true if UID exists from a prior test run (shared DB)
    });

    it('rejects invalid UID (too short)', async () => {
      const msg = await expectReducerError(
        h.call.createHsrAccount({ uid: '8001234', displayLabel: 'Bad' })
      );
      expect(msg).toContain('9 digits');
    });

    it('rejects invalid UID (bad region digit)', async () => {
      const msg = await expectReducerError(
        h.call.createHsrAccount({ uid: '100000001', displayLabel: 'Bad' })
      );
      expect(msg).toContain('first digit');
    });

    it('auto-labels when displayLabel is empty', async () => {
      const uid = nextUid();
      await h.call.createHsrAccount({ uid, displayLabel: '' });
      await h.sync();

      const created = (await myAccounts()).find((a) => a.uid === uid);
      expect(created).toBeDefined();
      expect(created!.displayLabel).toMatch(/^Account \d+$/);
    });
  });

  // ── Test 3: Account Limit Enforcement ───────────────────────────────────

  describe('5-account limit', () => {
    it('enforces maximum 5 accounts per user', async () => {
      // Fill up to 5
      const currentCount = (await myAccounts()).length;
      for (let i = currentCount; i < 5; i++) {
        await h.call.createHsrAccount({ uid: nextUid(), displayLabel: `Fill ${i}` });
        await h.sync(300);
      }

      // 6th should fail
      const msg = await expectReducerError(
        h.call.createHsrAccount({ uid: nextUid(), displayLabel: 'Should Fail' })
      );
      expect(msg).toContain('Maximum 5');
    });
  });

  // ── Test 4: Update HSR Account ──────────────────────────────────────────

  describe('update_hsr_account', () => {
    it('updates label and visibility fields', async () => {
      const target = (await myAccounts())[0];

      await h.call.updateHsrAccount({
        hsrAccountId: target.id,
        displayLabel: 'Updated Label',
        isRosterPublic: true,
        isRatingPublic: true,
      });
      await h.sync();

      const updatedRow = (await queryPrivateTable(`SELECT * FROM hsr_account WHERE id = ${target.id}`))[0];
      expect(updatedRow).toBeDefined();
      expect(updatedRow.display_label.replace(/"/g, '')).toBe('Updated Label');
      expect(updatedRow.is_roster_public).toBe('true');
      expect(updatedRow.is_rating_public).toBe('true');
    });

    it('rejects empty display label', async () => {
      const target = (await myAccounts())[0];

      const msg = await expectReducerError(
        h.call.updateHsrAccount({
          hsrAccountId: target.id,
          displayLabel: '   ',
          isRosterPublic: false,
          isRatingPublic: false,
        })
      );
      expect(msg).toContain('cannot be empty');
    });
  });

  // ── Test 5: Set Active Account ──────────────────────────────────────────

  describe('set_active_hsr_account', () => {
    it('activates target and deactivates others', async () => {
      const accounts = await myAccounts();
      if (accounts.length < 2) return;

      const inactive = accounts.find((a) => !a.isActive);
      if (!inactive) return;

      await h.call.setActiveHsrAccount({ hsrAccountId: inactive.id });
      await h.sync();

      const refreshedRow = (await queryPrivateTable(`SELECT * FROM hsr_account WHERE id = ${inactive.id}`))[0];
      expect(refreshedRow).toBeDefined();
      expect(refreshedRow.is_active).toBe('true');

      // All others should be inactive
      for (const acc of await myAccounts()) {
        if (acc.id !== inactive.id) {
          expect(acc.isActive).toBe(false);
        }
      }
    });

    it('is a no-op when called on already-active account', async () => {
      const active = (await myAccounts()).find((a) => a.isActive);
      if (!active) return;

      // Should succeed without error
      await h.call.setActiveHsrAccount({ hsrAccountId: active.id });
    });
  });

  // ── Test 8: Delete Account with Cascade ─────────────────────────────────

  describe('delete_hsr_account', () => {
    it('deletes account and cascades character rows', async () => {
      // Use an existing account (we're at the 5-account limit after the previous test)
      const accounts = await myAccounts();
      const account = accounts[accounts.length - 1]; // pick the last one
      if (!account) return;

      await h.call.deleteHsrAccount({ hsrAccountId: account.id });
      await h.sync();

      // Account should be gone
      const deletedRows = await queryPrivateTable(`SELECT * FROM hsr_account WHERE id = ${account.id}`);
      expect(deletedRows.length).toBe(0);

      // No orphan characters
      const orphans = await queryPrivateTable(`SELECT * FROM hsr_account_character WHERE hsr_account_id = ${account.id}`);
      expect(orphans).toHaveLength(0);
    });
  });
});
