import type { Role } from '@bindings/types';
import { describe, expect, it } from 'vitest';
import { isRoleAtLeast, type RoleName } from './roles';

/*
 * Role order mirrors the module's ROLE_LEVEL (spacetimedb/src/helpers/identity/ensurePermissions.ts).
 * The fifth "role" is the visitor: no user at all, so no role; the guards treat it separately
 * (routes.test.tsx). Here: the four named roles in order, and every boundary.
 */
const ORDER: RoleName[] = ['User', 'TournamentHost', 'Moderator', 'Admin'];
const role = (tag: RoleName) => ({ tag }) as Role;

describe('isRoleAtLeast', () => {
    for (const [i, actual] of ORDER.entries()) {
        for (const [j, min] of ORDER.entries()) {
            const expected = i >= j;
            it(`${actual} at least ${min} is ${expected}`, () => {
                expect(isRoleAtLeast(role(actual), min)).toBe(expected);
            });
        }
    }

    it('orders the roles User < TournamentHost < Moderator < Admin', () => {
        // Each role meets its own level and fails the next one up.
        for (let i = 0; i < ORDER.length - 1; i++) {
            const lower = ORDER[i] as RoleName;
            const higher = ORDER[i + 1] as RoleName;
            expect(isRoleAtLeast(role(lower), lower)).toBe(true);
            expect(isRoleAtLeast(role(lower), higher)).toBe(false);
            expect(isRoleAtLeast(role(higher), lower)).toBe(true);
        }
    });
});
