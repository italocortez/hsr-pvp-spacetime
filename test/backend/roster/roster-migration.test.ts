/**
 * Integration tests: Roster Migration
 *
 * UAT coverage: Test 9
 * Requires: SpacetimeDB running with published module + seed data.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createVerifiedTestHarness, hasServerToken, expectReducerError, queryPrivateTable, type TestHarness } from '../../shared/connection';
import { nextUid, resetUidCounter, characterBatch, KNOWN_CHARACTERS } from '../../shared/fixtures';

describe.skipIf(!hasServerToken())('Roster Migration', () => {
  let h: TestHarness;
  let sourceAccountId: number;
  let targetAccountId: number;

  beforeAll(async () => {
    resetUidCounter();
    h = await createVerifiedTestHarness();

    // Create source account with characters
    const sourceUid = nextUid();
    await h.call.createHsrAccount({ uid: sourceUid, displayLabel: 'Source' });
    await h.sync(1000);

    const sourceRows = await queryPrivateTable(`SELECT * FROM hsr_account WHERE user_id = ${h.userId}`);
    const source = sourceRows.find(a => a.uid.replace(/"/g, '') === sourceUid);
    if (!source) throw new Error('Source account not created');
    sourceAccountId = Number(source.id);

    await h.call.batchUpsertCharacters({
      hsrAccountId: sourceAccountId,
      charactersJson: characterBatch([
        { characterName: KNOWN_CHARACTERS[0], eidolonLevel: 3 },
        { characterName: KNOWN_CHARACTERS[1], eidolonLevel: 1 },
      ]),
    });
    await h.sync();

    // Create target account
    const targetUid = nextUid();
    await h.call.createHsrAccount({ uid: targetUid, displayLabel: 'Target' });
    await h.sync();

    const targetRows = await queryPrivateTable(`SELECT * FROM hsr_account WHERE user_id = ${h.userId}`);
    const target = targetRows.find(a => a.uid.replace(/"/g, '') === targetUid);
    if (!target) throw new Error('Target account not created');
    targetAccountId = Number(target.id);
  });

  afterAll(async () => {
    await h?.disconnect();
  });

  it('copy mode: duplicates characters to target, preserves source', async () => {
    await h.call.migrateRoster({
      sourceAccountId,
      targetAccountId,
      mode: 'copy',
    });
    await h.sync();

    const sourceChars = await queryPrivateTable(`SELECT * FROM hsr_account_character WHERE hsr_account_id = ${sourceAccountId}`);
    expect(sourceChars.length).toBeGreaterThanOrEqual(2);

    const targetChars = await queryPrivateTable(`SELECT * FROM hsr_account_character WHERE hsr_account_id = ${targetAccountId}`);
    expect(targetChars.length).toBeGreaterThanOrEqual(2);

    const targetChar0 = targetChars.find((c) => c.character_name.replace(/"/g, '') === KNOWN_CHARACTERS[0]);
    expect(targetChar0 ? Number(targetChar0.eidolon_level) : undefined).toBe(3);
  });

  it('move mode: transfers characters, source is emptied', async () => {
    // Add a fresh character to source for the move test
    await h.call.batchUpsertCharacters({
      hsrAccountId: sourceAccountId,
      charactersJson: characterBatch([
        { characterName: KNOWN_CHARACTERS[2], eidolonLevel: 4 },
      ]),
    });
    await h.sync();

    await h.call.migrateRoster({
      sourceAccountId,
      targetAccountId,
      mode: 'move',
    });
    await h.sync();

    const sourceChars = await queryPrivateTable(`SELECT * FROM hsr_account_character WHERE hsr_account_id = ${sourceAccountId}`);
    expect(sourceChars).toHaveLength(0);

    const movedRows = await queryPrivateTable(`SELECT * FROM hsr_account_character WHERE hsr_account_id = ${targetAccountId}`);
    const moved = movedRows.find(
      (c) => c.character_name.replace(/"/g, '') === KNOWN_CHARACTERS[2]
    );
    expect(moved).toBeDefined();
    expect(moved ? Number(moved.eidolon_level) : undefined).toBe(4);
  });

  it('rejects invalid mode', async () => {
    const msg = await expectReducerError(
      h.call.migrateRoster({ sourceAccountId, targetAccountId, mode: 'invalid' })
    );
    expect(msg).toContain('copy');
  });

  it('rejects same source and target', async () => {
    const msg = await expectReducerError(
      h.call.migrateRoster({ sourceAccountId, targetAccountId: sourceAccountId, mode: 'copy' })
    );
    expect(msg).toContain('same account');
  });
});
