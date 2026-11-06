/**
 * Unit tests for spacetimedb/src/helpers/rosterHelpers.ts
 *
 * Tests pure validation/derivation functions that don't need SpacetimeDB context.
 * spacetimedb/server is aliased to test/shared/mocks/spacetimedb-server.ts via vitest config.
 */

import { describe, it, expect, vi } from 'vitest';
import { UIDS, INVALID_UIDS } from '../../shared/fixtures';

// Mock auditColumns (imported by rosterHelpers but unused by validateUid/deriveRegion)
vi.mock('../../../spacetimedb/src/helpers/auditColumns', () => ({
  auditUpdate: vi.fn(() => ({})),
}));

const { validateUid, deriveRegion } = await import(
  '../../../spacetimedb/src/helpers/rosterHelpers'
);

describe('validateUid', () => {
  it('accepts valid 9-digit UIDs starting with 6, 7, 8, or 9', () => {
    expect(() => validateUid(UIDS.america)).not.toThrow();
    expect(() => validateUid(UIDS.europe)).not.toThrow();
    expect(() => validateUid(UIDS.asia)).not.toThrow();
    expect(() => validateUid(UIDS.twHkMo)).not.toThrow();
  });

  it('rejects UIDs shorter than 9 digits', () => {
    expect(() => validateUid(INVALID_UIDS.tooShort)).toThrow('UID must be exactly 9 digits');
  });

  it('rejects UIDs longer than 9 digits', () => {
    expect(() => validateUid(INVALID_UIDS.tooLong)).toThrow('UID must be exactly 9 digits');
  });

  it('rejects UIDs containing letters', () => {
    expect(() => validateUid(INVALID_UIDS.letters)).toThrow('UID must be exactly 9 digits');
  });

  it('rejects UIDs starting with invalid region digit', () => {
    expect(() => validateUid(INVALID_UIDS.badRegion)).toThrow('first digit must be 6, 7, 8, or 9');
  });

  it('rejects UIDs starting with 0', () => {
    expect(() => validateUid(INVALID_UIDS.zeroRegion)).toThrow('first digit must be 6, 7, 8, or 9');
  });

  it('rejects empty string', () => {
    expect(() => validateUid('')).toThrow('UID must be exactly 9 digits');
  });

  it('rejects strings with spaces', () => {
    expect(() => validateUid('800 12345')).toThrow('UID must be exactly 9 digits');
  });
});

describe('deriveRegion', () => {
  it('maps 6xx to America', () => {
    expect(deriveRegion(UIDS.america)).toBe('America');
  });

  it('maps 7xx to Europe', () => {
    expect(deriveRegion(UIDS.europe)).toBe('Europe');
  });

  it('maps 8xx to Asia', () => {
    expect(deriveRegion(UIDS.asia)).toBe('Asia');
  });

  it('maps 9xx to TW_HK_MO', () => {
    expect(deriveRegion(UIDS.twHkMo)).toBe('TW_HK_MO');
  });

  it('throws for invalid first digit', () => {
    expect(() => deriveRegion('100000001')).toThrow('does not map to a known region');
  });
});
