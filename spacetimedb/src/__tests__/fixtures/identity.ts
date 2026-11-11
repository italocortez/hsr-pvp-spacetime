// Fixtures: users and roles, client identities, User rows, the deletion job, and guests signing in to an existing
//   account.
// From S8 (s8-fixtures.ts: verified, roles), S10 (s10-c1-fixtures.ts: identities, deletion job), S10f
// (s10f-fixtures.ts: User rows), S10q (s10q-gap-coverage.test.ts: sign-in builders); gathered by T-REORG2.
//
// Not a test file. Roles and User rows are written straight into the in-memory datastore, outside any reducer;
// `test.db` is read only outside `tx` bodies (reading it inside `withReducerTx` crashes the in-memory datastore).
// Nothing reaches maincloud.
import { ConnectionId } from 'spacetimedb';
import { AUDIT, M, TestAuth, byId, guest, linkDiscord, tx, type Actor, type Harness } from './harness';
import { insertHsrAccount } from './roster';

// ─── Users and roles ─────────────────────────────────────────────────────────

export const ADMIN_ONLY = 'Forbidden: Requires Admin privileges.';

let nextProvider = 1;

/** A verified (Discord-linked) user. */
export function verified(test: Harness, name: string): Actor {
    const a = guest(test, name);
    linkDiscord(test, a, `discord-${name}-${nextProvider++}`, name);
    return a;
}

/** Sets a user's role directly on the row. */
export function setUserRole(test: Harness, userId: number, role: 'User' | 'TournamentHost' | 'Moderator' | 'Admin') {
    test.db.User.id.update({ ...test.db.User.id.find(userId)!, role: { tag: role } as any });
}

/** A verified Tournament Host (may call create_tournament). */
export function host(test: Harness, name = 'org'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'TournamentHost');
    return a;
}

/** A verified Moderator. */
export function moderator(test: Harness, name = 'mod'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Moderator');
    return a;
}

/** A verified Admin (role written on the row). */
export function admin(test: Harness, name = 'boss'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Admin');
    return a;
}

/** A guest that links a provider (verified) with an explicit provider id. */
export function linked(test: Harness, sub: string, providerId: string, name: string): Actor {
    const a = guest(test, sub);
    linkDiscord(test, a, providerId, name);
    return a;
}

export const displayName = (test: Harness, who: Actor | number) =>
    test.db.User.id.find(typeof who === 'number' ? who : who.userId)!.displayName;

/**
 * Results audit #9 (S10f): the leaderboard rebuild skips rating rows whose user has no live User row, so tests that
 * write MmrRating rows directly seed a plain User row for each id (written outside a transaction; no-op if present).
 */
export function seedUserRow(test: Harness, userId: number, o: { deletedAt?: any } = {}) {
    if (test.db.User.id.find(userId)) return;
    test.db.User.insert({
        id: userId, username: `user-${userId}`, displayName: `user-${userId}`, isGuest: false, role: { tag: 'User' },
        avatarCharacterName: '', displayedAchievementId: undefined, deletedAt: o.deletedAt,
        // T-S11a (A77): the provider columns of a linked user (formerly hasDiscordLinked: true)
        loginMethod: 'discord', providerId: `pid-user-${userId}`, providerUsername: `user-${userId}`, linkedAt: test.clock.now(),
        ...AUDIT(test),
    } as any);
}

// ─── Identities and the deletion job ─────────────────────────────────────────

let nextConn = 900_000n;

/** A client identity that has never called login_as_guest (no UserIdentity row). */
export function freshAuth(test: Harness, sub: string) {
    const auth = TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub }), new ConnectionId(nextConn++));
    return { auth, identity: test.viewContext(auth).sender };
}

export const providerOf = (test: Harness, a: Actor) => test.db.User.id.find(a.userId)?.providerId; // T-S11a: on User (A77)
export const jobsFor = (test: Harness, userId: number) => [...test.db.UserDeletionJob.iter()].filter((j) => j.userId === userId);
export const identitiesOf = (test: Harness, userId: number) => [...test.db.UserIdentity.user_id.filter(userId)];
export const mappedUser = (test: Harness, a: Actor) => test.db.UserIdentity.identity.find(a.identity)!.userId;

/** Fires the user's single pending UserDeletionJob by hand, as the scheduler would (the row is consumed first). */
export function fireDeletionJob(test: Harness, userId: number) {
    const jobs = jobsFor(test, userId);
    if (jobs.length !== 1) throw new Error(`fireDeletionJob: expected one job for user ${userId}, found ${jobs.length}`);
    test.db.UserDeletionJob.scheduledId.delete(jobs[0].scheduledId);
    tx(test, 'internal', (ctx) => M.run_user_deletion(ctx, { arg: jobs[0] }));
}

/** A second client identity mapped to `userId` (written directly, as s10-identity-gc / s10h do). */
export function addSecondIdentity(test: Harness, userId: number, sub: string) {
    const extra = freshAuth(test, sub);
    test.db.UserIdentity.insert({ identity: extra.identity, userId, lastSeenAt: test.clock.now(), ...AUDIT(test) } as any);
    return extra;
}

// ─── Guests signing in to an existing account (A112) ──────────────────────────

export interface ExistingUserOpts {
    /** The provider name linked (default: `sub`). */
    name?: string;
    /** How many HSR accounts, uids `${sub}-acc-<i>` (default 1). */
    accounts?: number;
    /** Explicit HSR account uids instead of `accounts` numbered ones. */
    uids?: string[];
}

/** A verified user with a known provider id (the account a guest signs in to) and its HSR accounts (ids ascending). */
export function existingUser(test: Harness, sub: string, o: ExistingUserOpts = {}): { a: Actor; providerId: string; accountIds: number[] } {
    const a = guest(test, sub);
    const providerId = `pid-${sub}`;
    linkDiscord(test, a, providerId, o.name ?? sub);
    const uids = o.uids ?? Array.from({ length: o.accounts ?? 1 }, (_, i) => `${sub}-acc-${i}`);
    const accountIds = uids.map((uid) => insertHsrAccount(test, a.userId, uid)).sort(byId);
    return { a, providerId, accountIds };
}

/** server_link_provider (as the owner) for `g` to the account owning `providerId`; returns the guest's former user id. */
export function signIn(test: Harness, g: Actor, providerId: string): number {
    const guestId = g.userId;
    linkDiscord(test, g, providerId, 'ignored');
    return guestId;
}
