/**
 * Integration tests: Archetype CRUD & Admin Permission Guards
 *
 * UAT coverage: Tests 10-11
 *
 * These reducers require Admin role. The test harness logs in as guest,
 * so these tests verify the permission guard rejects non-admins.
 *
 * Requires: SpacetimeDB running with published module.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestHarness, expectReducerError, type TestHarness } from '../../shared/connection';
import { ARCHETYPES, KNOWN_CHARACTERS } from '../../shared/fixtures';

describe('Archetype CRUD (Admin)', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createTestHarness();
  });

  afterAll(async () => {
    await h?.disconnect();
  });

  // ── Permission Guards ───────────────────────────────────────────────────

  describe('permission enforcement', () => {
    it('rejects non-admin archetype creation', async () => {
      const msg = await expectReducerError(
        h.call.adminUpsertArchetype({
          name: ARCHETYPES.dps.name,
          description: ARCHETYPES.dps.description,
        })
      );
      expect(msg).toContain('Admin');
    });

    it('rejects non-admin archetype deletion', async () => {
      const msg = await expectReducerError(
        h.call.adminDeleteArchetype({ archetypeId: 1 })
      );
      expect(msg).toContain('Admin');
    });

    it('rejects non-admin character archetype assignment', async () => {
      const msg = await expectReducerError(
        h.call.adminAssignCharacterArchetypes({
          characterName: KNOWN_CHARACTERS[0],
          archetypeIdsJson: JSON.stringify([1]),
        })
      );
      expect(msg).toContain('Admin');
    });

    it('rejects non-admin character archetype removal', async () => {
      const msg = await expectReducerError(
        h.call.adminRemoveCharacterArchetypes({
          characterName: KNOWN_CHARACTERS[0],
          archetypeIdsJson: JSON.stringify([1]),
        })
      );
      expect(msg).toContain('Admin');
    });
  });

  // ── Admin Proxy Permission Guards ───────────────────────────────────────

  describe('admin proxy permission enforcement', () => {
    it('rejects non-admin account creation', async () => {
      const msg = await expectReducerError(
        h.call.adminCreateHsrAccount({
          targetUserId: 1,
          uid: '800000001',
          displayLabel: 'Hacked',
        })
      );
      expect(msg).toContain('Admin');
    });

    it('rejects non-admin account update', async () => {
      const msg = await expectReducerError(
        h.call.adminUpdateHsrAccount({
          hsrAccountId: 1,
          displayLabel: 'Hacked',
          isRosterPublic: true,
          isRatingPublic: true,
        })
      );
      expect(msg).toContain('Admin');
    });

    it('rejects non-admin account deletion', async () => {
      const msg = await expectReducerError(
        h.call.adminDeleteHsrAccount({ hsrAccountId: 1 })
      );
      expect(msg).toContain('Admin');
    });

    it('rejects non-admin batch character upsert', async () => {
      const msg = await expectReducerError(
        h.call.adminBatchUpsertCharacters({
          hsrAccountId: 1,
          charactersJson: JSON.stringify([{ characterName: KNOWN_CHARACTERS[0], eidolonLevel: 0 }]),
        })
      );
      expect(msg).toContain('Admin');
    });

    it('rejects non-admin batch character removal', async () => {
      const msg = await expectReducerError(
        h.call.adminBatchRemoveCharacters({
          hsrAccountId: 1,
          characterNamesJson: JSON.stringify([KNOWN_CHARACTERS[0]]),
        })
      );
      expect(msg).toContain('Admin');
    });
  });
});
