import { SenderError } from 'spacetimedb/server';
import { ABUSE_CONFIG_ID } from '@module/helpers/lobby/abuseControls';

const ROLE_LEVEL: Record<string, number> = {
    Admin: 100,
    Moderator: 75,
    TournamentHost: 50,
    User: 25,
};
// Guest (no role / isGuest) = 0

/**
 * Returns the numeric level for a role value.
 * role.tag maps to ROLE_LEVEL. Unknown/guest roles return 0.
 */
export function getRoleLevel(role: any): number {
    return ROLE_LEVEL[role?.tag] ?? 0;
}

/**
 * Returns true if the given userRole meets or exceeds the requiredRole threshold.
 */
export function isRoleAtLeast(userRole: any, requiredRole: string): boolean {
    return getRoleLevel(userRole) >= (ROLE_LEVEL[requiredRole] ?? 0);
}

/**
 * Resolves ctx.sender (identity) → UserIdentity → User.
 * Returns both the mapping row and the User row.
 * Throws if the identity is not linked to any user.
 */
export function getAuthenticatedUser(ctx: any) {
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    if (!mapping) {
        throw new SenderError("Unauthorized: No user linked to this identity.");
    }
    const user = ctx.db.User.id.find(mapping.userId);
    if (!user) {
        throw new SenderError("Unauthorized: User record not found.");
    }
    if (user.deletedAt) {
        throw new SenderError("Unauthorized: This account has been deleted.");
    }
    ensureNotInMaintenance(ctx, user);
    return user;
}

/** A163(3) (S11a): the refusal of a state-changing reducer while maintenance mode is on. */
export const MAINTENANCE_TEXT = 'The site is in maintenance. Please try again later.';

/** A163(3): true while AbuseConfig.maintenanceMode is on (one primary-key read of the singleton; absent row = off). */
export function isMaintenanceOn(ctx: any): boolean {
    return ctx.db.AbuseConfig.id.find(ABUSE_CONFIG_ID)?.maintenanceMode === true;
}

/**
 * A163(3) (S11a): while maintenance mode is on, only an Admin acts. Called by getAuthenticatedUser (so by every
 * ensure* helper and ensureTournamentPermission), and by the few client reducers that resolve the caller themselves
 * (profile.ts resolveUser, login_as_guest). `user` undefined (an identity with no user) is refused too. The server
 * identities map to the SYSTEM user (Admin) and pass; scheduled reducers and the lifecycle hooks never call it.
 */
export function ensureNotInMaintenance(ctx: any, user: any | undefined): void {
    if (!isMaintenanceOn(ctx)) return;
    if (user && isRoleAtLeast(user.role, 'Admin')) return;
    throw new SenderError(MAINTENANCE_TEXT);
}

/**
 * Ensures the sender is an Admin.
 */
export function ensureAdmin(ctx: any) {
    const user = getAuthenticatedUser(ctx);
    if (!isRoleAtLeast(user.role, 'Admin')) {
        throw new SenderError("Forbidden: Requires Admin privileges.");
    }
    return user;
}

/**
 * Ensures the sender is a Moderator OR an Admin.
 */
export function ensureModerator(ctx: any) {
    const user = getAuthenticatedUser(ctx);
    if (!isRoleAtLeast(user.role, 'Moderator')) {
        throw new SenderError("Forbidden: Requires Moderator or Admin privileges.");
    }
    return user;
}

/**
 * Ensures the sender is a TournamentHost, Moderator, or Admin.
 */
export function ensureTournamentHost(ctx: any) {
    const user = getAuthenticatedUser(ctx);
    if (!isRoleAtLeast(user.role, 'TournamentHost')) {
        throw new SenderError("Forbidden: Requires Tournament Host, Moderator, or Admin privileges.");
    }
    return user;
}

/**
 * Ensures the sender is a verified (non-guest) user.
 * Guests can browse public data but cannot modify roster.
 */
export function ensureVerifiedUser(ctx: any) {
    const user = getAuthenticatedUser(ctx);
    if (user.isGuest) {
        throw new SenderError("Roster management requires a verified account. Link your Discord first.");
    }
    return user;
}
