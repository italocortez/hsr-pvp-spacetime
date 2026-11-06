/**
 * Unit tests for spacetimedb/src/helpers/ownershipValidation.ts
 *
 * Tests validateCharacterOwnership pure function with mocked ctx.db lookups.
 * D-14: Only checks characters from LobbyMemberAccount entries (not all TPA).
 * D-12: Union of characters across all selected accounts.
 *
 * Contract: docs/roster/contract.md — Ownership Validation scenarios
 */

import { describe, it, expect } from 'vitest';

import { validateCharacterOwnership } from '../../../spacetimedb/src/helpers/ownershipValidation';

// ─── Mock ctx builder ─────────────────────────────────────────────────────────

function mockCtx(opts: {
    lobby?: { requireOwnership: boolean } | null;
    lmaRows?: { hsrAccountId: number }[];
    characters?: Map<string, boolean>; // key: "accountId:charName" → exists
}) {
    return {
        db: {
            Lobby: {
                id: {
                    find: (_id: number) => opts.lobby === undefined ? null : opts.lobby,
                },
            },
            LobbyMemberAccount: {
                by_lobby_and_user: {
                    filter: (_args: number[]) => (opts.lmaRows ?? [])[Symbol.iterator](),
                },
            },
            HsrAccountCharacter: {
                by_account_and_character: {
                    filter: (args: [number, string]) => {
                        const key = `${args[0]}:${args[1]}`;
                        const found = opts.characters?.get(key);
                        return found ? [{ characterName: args[1] }][Symbol.iterator]() : [][Symbol.iterator]();
                    },
                },
            },
        },
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('validateCharacterOwnership', () => {
    it('returns valid:true when requireOwnership is false (bypass)', () => {
        const ctx = mockCtx({ lobby: { requireOwnership: false } });
        const result = validateCharacterOwnership(ctx, 1, 'kafka', 100);
        expect(result).toEqual({ valid: true });
    });

    it('returns valid:true when lobby is not found (bypass)', () => {
        const ctx = mockCtx({ lobby: null });
        const result = validateCharacterOwnership(ctx, 1, 'kafka', 999);
        expect(result).toEqual({ valid: true });
    });

    it('returns valid:false with "No account selected" when LMA is empty', () => {
        const ctx = mockCtx({
            lobby: { requireOwnership: true },
            lmaRows: [],
        });
        const result = validateCharacterOwnership(ctx, 1, 'kafka', 100);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('No account selected for this match.');
    });

    it('returns valid:true when character found on first selected account', () => {
        const ctx = mockCtx({
            lobby: { requireOwnership: true },
            lmaRows: [{ hsrAccountId: 10 }],
            characters: new Map([['10:march7th', true]]),
        });
        const result = validateCharacterOwnership(ctx, 1, 'march7th', 100);
        expect(result).toEqual({ valid: true });
    });

    it('returns valid:true when character found on second of multiple accounts (D-12 union)', () => {
        const ctx = mockCtx({
            lobby: { requireOwnership: true },
            lmaRows: [{ hsrAccountId: 10 }, { hsrAccountId: 20 }],
            characters: new Map([['20:kafka', true]]), // only on second account
        });
        const result = validateCharacterOwnership(ctx, 1, 'kafka', 100);
        expect(result).toEqual({ valid: true });
    });

    it('returns valid:false when character not on any selected account', () => {
        const ctx = mockCtx({
            lobby: { requireOwnership: true },
            lmaRows: [{ hsrAccountId: 10 }, { hsrAccountId: 20 }],
            characters: new Map(), // character exists nowhere
        });
        const result = validateCharacterOwnership(ctx, 1, 'blade', 100);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('You do not own this character on any selected account.');
    });
});
