import type { Role } from '@bindings/types';

/** A role name: `'Admin' | 'Moderator' | 'TournamentHost' | 'User'` (the generated `Role` tags). */
export type RoleName = Role['tag'];

/**
 * Mirrors `ROLE_LEVEL` in `spacetimedb/src/helpers/identity/ensurePermissions.ts`; keep the two
 * in step. UX only: the module re-checks every action.
 */
const ROLE_LEVEL: Record<RoleName, number> = {
    Admin: 100,
    Moderator: 75,
    TournamentHost: 50,
    User: 25,
};

/** True when `role` meets or exceeds `min` (mirrors the module's `isRoleAtLeast`). */
export function isRoleAtLeast(role: Role, min: RoleName): boolean {
    return ROLE_LEVEL[role.tag] >= ROLE_LEVEL[min];
}
