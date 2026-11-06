/**
 * Test data factories for roster management tests.
 *
 * These generate valid test data with sensible defaults.
 * Override any field by spreading: { ...validAccount(), uid: 'custom' }
 */

/** Valid UIDs by region */
export const UIDS = {
  america: '600000001',
  europe: '700000001',
  asia: '800000001',
  twHkMo: '900000001',
} as const;

/** Invalid UIDs for negative tests */
export const INVALID_UIDS = {
  tooShort: '80012345',        // 8 digits
  tooLong: '8001234567',       // 10 digits
  letters: '80012abc6',        // non-numeric
  badRegion: '100000001',      // starts with 1
  zeroRegion: '000000001',     // starts with 0
} as const;

/** Generate unique UIDs for tests that need multiple distinct accounts */
let uidCounter = 0;
export function nextUid(region: '6' | '7' | '8' | '9' = '8'): string {
  uidCounter++;
  return `${region}${String(uidCounter).padStart(8, '0')}`;
}

/** Reset UID counter between test suites */
export function resetUidCounter(): void {
  uidCounter = 0;
}

/** Default args for create_hsr_account */
export function createAccountArgs(overrides: Partial<{ uid: string; displayLabel: string }> = {}) {
  return {
    uid: overrides.uid ?? nextUid(),
    displayLabel: overrides.displayLabel ?? 'Test Account',
  };
}

/** Character upsert payload */
export function characterBatch(
  chars: Array<{ characterName: string; eidolonLevel?: number }>
): string {
  return JSON.stringify(
    chars.map((c) => ({
      characterName: c.characterName,
      eidolonLevel: c.eidolonLevel ?? 0,
    }))
  );
}

/** Archetype names for testing */
export const ARCHETYPES = {
  dps: { name: 'DPS', description: 'Damage-focused characters' },
  support: { name: 'Support', description: 'Buff/heal-focused characters' },
  tank: { name: 'Tank', description: 'High survivability characters' },
} as const;

/**
 * Known valid character names from the HsrCharacter table.
 * Sourced from test/data/characters_table.json.
 * These must match what's seeded in the published module.
 */
export const KNOWN_CHARACTERS = [
  'acheron',
  'aglaea',
  'anaxa',
  'archer',
  'argenti',
  'arlan',
] as const;
