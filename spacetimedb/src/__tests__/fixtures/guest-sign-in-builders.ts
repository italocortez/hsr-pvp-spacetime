// Shared helpers: existing users, guest sign-in, second identities and live solo entries.
// From S10q (s10q-gap-coverage.test.ts); not a test file.
import { guest, linkDiscord, type Actor, type Harness } from './harness';
import {
    AUDIT,
    advanceStage,
    bracketRows,
    insertHsrAccount,
    membership,
    openTournament,
    register,
    seedAndGenerate,
} from './tournament-builders';
import { freshAuth } from './achievement-auth-cost-builders';

// ─── Shared helpers ──────────────────────────────────────────────────────────

export const byId = (x: number, y: number) => x - y;

/** A verified user with a known provider id (the account a guest signs in to) and `accounts` HSR accounts. */
export function existingUser(test: Harness, sub: string, accounts = 1): { a: Actor; providerId: string; accountIds: number[] } {
    const a = guest(test, sub);
    const providerId = `pid-${sub}`;
    linkDiscord(test, a, providerId, sub);
    const accountIds = Array.from({ length: accounts }, (_, i) => insertHsrAccount(test, a.userId, `${sub}-acc-${i}`)).sort(byId);
    return { a, providerId, accountIds };
}

/** server_link_provider (as the owner) for `g` to the account owning `providerId`; returns the guest's former user id. */
export function signIn(test: Harness, g: Actor, providerId: string): number {
    const guestId = g.userId;
    linkDiscord(test, g, providerId, 'ignored');
    return guestId;
}

/** A second client identity mapped to `userId` (written directly, as s10-identity-gc / s10h do). */
export function addSecondIdentity(test: Harness, userId: number, sub: string) {
    const extra = freshAuth(test, sub);
    test.db.UserIdentity.insert({ identity: extra.identity, userId, lastSeenAt: test.clock.now(), ...AUDIT(test) } as any);
    return extra;
}

export const mappedUser = (test: Harness, a: Actor) => test.db.UserIdentity.identity.find(a.identity)!.userId;

/** A solo (teamSize 1) tournament in InProgress with `players` registered; the bracket match holding `who`. */
export function soloLive(test: Harness, org: Actor, players: Actor[], who: Actor) {
    const id = openTournament(test, org, { teamSize: 1, maxParticipants: Math.max(4, players.length) });
    for (const p of players) register(test, p, id);
    advanceStage(test, org, id, 'Seeding');
    seedAndGenerate(test, org, id);
    advanceStage(test, org, id, 'InProgress');
    const teamId = membership(test, id, who.userId)!.teamId;
    const match = bracketRows(test, id).find((m) => m.team1Id === teamId || m.team2Id === teamId)!;
    return { id, teamId, match };
}
