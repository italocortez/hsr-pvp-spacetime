// Identity: bans, unbans, ban on reconnect, provider linking and user deletion.
// Decisions: D-07, D-08, D-09, D-10
// Contracts: docs/auth/contract.md
// From S10 (s10-identity.test.ts).
//
// T-S10 (batch C1): bans, provider linking and user deletion in memory, ported from the live
// test/backend/auth/{ban-admin, server-link-provider, auth-security (SEC-03a only), user-deletion (the in-memory part)}
// tests. Spec: docs/auth/contract.md (admin_ban_user, admin_unban_user, server_link_provider, clientConnected, the D-08
// three-point ban enforcement, D-09 cascade branching, D-12 resolveUserLabel) and docs/admin/contract.md
// (admin_delete_row, run_user_deletion). Server reducers run as the owner identity ('internal', registered by init);
// admin reducers run as a verified user promoted on the row. Scheduled UserDeletionJob rows are fired by hand
// (fireDeletionJob); the live residue keeps one real scheduler firing. Where the contract's error text differs from
// the code, the test follows the contract (CLAUDE.md §6: a failure is diagnostic), except an it tagged "(text per A76)":
// there the user adopted the code's wording (A76, T-S10 align) and the test asserts the code's exact text, state first.
// Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { ScheduleAt } from 'spacetimedb';
import { resolveUserLabel } from '@module/helpers/identity/userLabel';
import {
    M,
    advance,
    connect,
    expectReject,
    guest,
    linkDiscord,
    newHarness,
    now,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    AUDIT,
    rejection,
} from '../fixtures/harness';
import {
    moderator,
    verified,
    fireDeletionJob,
    freshAuth,
    identitiesOf,
    jobsFor,
    providerOf,
    admin,
    ADMIN_ONLY,
} from '../fixtures/identity';
import { createAchievement } from '../fixtures/achievements';

const DELETED = 'Unauthorized: This account has been deleted.';
const FIVE_SECONDS = 5_000_000n;

const userRow = (test: Harness, a: Actor) => test.db.User.id.find(a.userId);
// T-S11a (A77): the provider link is on the User row (UserPrivate merged); "no link" = the four columns unset.
const NO_LINK = { loginMethod: undefined, providerId: undefined, providerUsername: undefined, linkedAt: undefined };
const bans = (test: Harness) => [...test.db.BanRecord.iter()];
const ban = (test: Harness, who: Actor | 'internal', providerId: string, reason = 'abuse', banTypeTag = 'DiscordId') =>
    tx(test, who, (ctx) => M.admin_ban_user(ctx, { banTypeTag, providerId, reason }));
const link = (test: Harness, args: Partial<{ callerIdentityHex: string; provider: string; providerId: string; providerName: string }>) =>
    tx(test, 'internal', (ctx) => M.server_link_provider(ctx, {
        callerIdentityHex: args.callerIdentityHex ?? '',
        provider: args.provider ?? 'discord',
        providerId: args.providerId ?? '',
        providerName: args.providerName ?? '',
    }));
const deleteUserRow = (test: Harness, who: Actor | 'internal', userId: number | string) =>
    tx(test, who, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(userId) }));

// ════════════════════════════════════════════════════════════════════════════
// admin_ban_user / admin_unban_user (auth contract; D-07, D-08 point 3, D-10)
// ════════════════════════════════════════════════════════════════════════════

describe('admin_ban_user (auth contract § admin_ban_user; D-08 point 3, D-10)', () => {
    it('inserts the BanRecord, soft-deletes the linked user and schedules its UserDeletionJob 5 s out (scenario "Ban Enforcement at Ban-Time")', () => {
        const test = newHarness();
        const boss = admin(test);
        const target = verified(test, 'target');
        const pid = providerOf(test, target)!;
        ban(test, boss, pid, 'cheating');

        expect(bans(test)).toEqual([expect.objectContaining({ loginMethod: 'discord', providerId: pid, reason: 'cheating', bannedByUserId: boss.userId })]);
        expect(userRow(test, target)!.deletedAt?.microsSinceUnixEpoch).toBe(now(test));
        const jobs = jobsFor(test, target.userId);
        expect(jobs).toHaveLength(1);
        expect(jobs[0].scheduledAt).toEqual(ScheduleAt.time(now(test) + FIVE_SECONDS));
        expect(jobs[0].createdById).toBe(boss.userId);
        // the soft-deleted user is locked out of every authenticated reducer (scenario "Soft-Deleted User Reconnect")
        expectReject(test, target, (ctx) => M.set_displayed_achievement(ctx, { targetUserId: undefined, achievementId: undefined }), DELETED);
    });

    it('a provider id no user holds is banned without touching any user or scheduling a job', () => {
        const test = newHarness();
        const boss = admin(test);
        ban(test, boss, 'pid-nobody');
        expect(bans(test).map((b) => b.providerId)).toEqual(['pid-nobody']);
        expect([...test.db.UserDeletionJob.iter()]).toHaveLength(0);
        expect(userRow(test, boss)!.deletedAt).toBeUndefined();
    });

    it.each([
        ['an unknown banType', { banTypeTag: 'Email' }, 'Invalid banType "Email". Must be one of: DiscordId'],
        ['an empty providerId', { providerId: '' }, 'providerId is required'],
        ['a providerId over 32 characters', { providerId: 'x'.repeat(33) }, 'providerId must be 32 characters or fewer'],
        ['an empty reason', { reason: '' }, 'reason is required'],
        ['a reason over 500 characters', { reason: 'r'.repeat(501) }, 'reason must be 500 characters or fewer'],
    ])('input validation: %s is rejected and nothing is written', (_label, over, msg) => {
        const test = newHarness();
        const boss = admin(test);
        const args = { banTypeTag: 'DiscordId', providerId: 'pid-1', reason: 'abuse', ...over };
        expectReject(test, boss, (ctx) => M.admin_ban_user(ctx, args), msg);
        expect(bans(test)).toHaveLength(0);
    });

    it('a second ban of the same provider id is rejected (contract error "Duplicate ban exists") (text per A76)', () => {
        const test = newHarness();
        const boss = admin(test);
        ban(test, boss, 'pid-dup');
        const msg = rejection(test, boss, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId: 'pid-dup', reason: 'again' }));
        expect(bans(test)).toHaveLength(1);
        expect(msg).toBe('Provider DiscordId:pid-dup is already banned.');
    });

    it('a guest, a verified User and a Moderator are rejected: Admin only (contract error "Caller is not Admin")', () => {
        const test = newHarness();
        const g = guest(test, 'g');
        const user = verified(test, 'plain');
        const mod = moderator(test);
        for (const who of [g, user, mod]) {
            expectReject(test, who, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId: 'pid-x', reason: 'abuse' }), ADMIN_ONLY);
        }
        expect(bans(test)).toHaveLength(0);
    });
});

describe('admin_unban_user (auth contract § admin_unban_user; D-07 permanent bans lifted by hand)', () => {
    it('deletes the BanRecord, after which the provider id links again (D-08 point 1 no longer fires)', () => {
        const test = newHarness();
        const boss = admin(test);
        ban(test, boss, 'pid-lifted');
        const id = bans(test)[0].id;
        tx(test, boss, (ctx) => M.admin_unban_user(ctx, { banRecordId: id }));
        expect(bans(test)).toHaveLength(0);
        const back = guest(test, 'back');
        linkDiscord(test, back, 'pid-lifted', 'Back');
        expect(userRow(test, back)).toMatchObject({ isGuest: false, loginMethod: 'discord' });
    });

    it('an unknown BanRecord id is rejected; a non-Admin is rejected and the record stays', () => {
        const test = newHarness();
        const boss = admin(test);
        const mod = moderator(test);
        ban(test, boss, 'pid-stays');
        const id = bans(test)[0].id;
        expectReject(test, boss, (ctx) => M.admin_unban_user(ctx, { banRecordId: 4040 }), /BanRecord #?4040 not found/);
        expectReject(test, mod, (ctx) => M.admin_unban_user(ctx, { banRecordId: id }), ADMIN_ONLY);
        expect(bans(test)).toHaveLength(1);
    });
});

describe('ban on reconnect (auth contract § clientConnected; D-08 point 2, D-10)', () => {
    it('a user whose provider id is banned is soft-deleted on connect and gets a UserDeletionJob (actor: the user); reducers then reject them', () => {
        const test = newHarness();
        const target = verified(test, 'target');
        const pid = providerOf(test, target)!;
        // A ban recorded without the ban-time soft delete (e.g. a restored BanRecord): only the reconnect check can catch it.
        test.db.BanRecord.insert({ id: 0, loginMethod: 'discord', providerId: pid, reason: 'restored', bannedByUserId: 0, ...AUDIT(test) });
        expect(userRow(test, target)!.deletedAt).toBeUndefined();

        connect(test, target);

        expect(userRow(test, target)!.deletedAt?.microsSinceUnixEpoch).toBe(now(test));
        const jobs = jobsFor(test, target.userId);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ scheduledAt: ScheduleAt.time(now(test) + FIVE_SECONDS), createdById: target.userId });
        expectReject(test, target, (ctx) => M.set_displayed_achievement(ctx, { targetUserId: undefined, achievementId: undefined }), DELETED);

        // reconnecting again neither schedules a second job nor restores the account; login_as_guest creates no new user
        connect(test, target);
        const usersBefore = [...test.db.User.iter()].length;
        tx(test, target, (ctx) => M.login_as_guest(ctx, {}));
        expect(jobsFor(test, target.userId)).toHaveLength(1);
        expect([...test.db.User.iter()]).toHaveLength(usersBefore);
        expect(userRow(test, target)!.deletedAt).toBeDefined();
    });

    it('a banned user who comes back on a new device stays a guest: the link of the banned provider id is refused (D-08 point 1; s9c live todo)', () => {
        const test = newHarness();
        const boss = admin(test);
        const target = verified(test, 'target');
        const pid = providerOf(test, target)!;
        ban(test, boss, pid);
        const newDevice = guest(test, 'new-device');
        expect(() => linkDiscord(test, newDevice, pid, 'Target again')).toThrow(/banned/);
        expect(userRow(test, newDevice)).toMatchObject({ isGuest: true, ...NO_LINK });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// server_link_provider (auth contract § server_link_provider; admin contract § server_link_discord)
// ════════════════════════════════════════════════════════════════════════════

describe('server_link_provider as the owner server identity', () => {
    it('Case 1a: a guest is upgraded (isGuest false, username / displayName = providerName) and its User row gets the provider link with linkedAt (A77; scenario "Provider Linking (Discord)")', () => {
        const test = newHarness();
        const g = guest(test, 'fresh');
        link(test, { callerIdentityHex: g.identity.toHexString(), providerId: 'pid-fresh', providerName: 'FreshName' });
        expect(userRow(test, g)).toMatchObject({ isGuest: false, username: 'FreshName', displayName: 'FreshName',
            loginMethod: 'discord', providerId: 'pid-fresh', providerUsername: 'FreshName' });
        expect(userRow(test, g)!.linkedAt?.microsSinceUnixEpoch).toBe(now(test));
    });

    it('Case 1c: re-linking the same identity is idempotent: one User row, still verified, the username kept, the provider username refreshed, linkedAt kept (A77; edge case "already-verified user")', () => {
        const test = newHarness();
        const g = guest(test, 'twice');
        const hex = g.identity.toHexString();
        link(test, { callerIdentityHex: hex, providerId: 'pid-twice', providerName: 'First' });
        const linkedAt = userRow(test, g)!.linkedAt;
        advance(test, 60_000);
        link(test, { callerIdentityHex: hex, providerId: 'pid-twice', providerName: 'Renamed' });
        expect([...test.db.User.provider_id.filter('pid-twice')].map((u) => u.id)).toEqual([g.userId]);
        expect(userRow(test, g)).toMatchObject({ isGuest: false, username: 'First', providerUsername: 'Renamed', linkedAt });
        expect(identitiesOf(test, g.userId)).toHaveLength(1);
    });

    it.each([
        ['an empty providerId', { providerId: '' }, 'providerId is required'],
        ['an empty providerName', { providerName: '' }, 'providerName is required'],
        ['an empty callerIdentityHex', { callerIdentityHex: '' }, 'callerIdentityHex is required'],
        ['a callerIdentityHex that is not an identity', { callerIdentityHex: 'not-hex' }, 'callerIdentityHex is not a valid identity'],
        ['an unknown provider', { provider: 'facebook' }, 'Invalid provider "facebook". Must be one of: discord'],
    ])('input validation: %s is rejected; the guest is unchanged', (_label, over, msg) => {
        const test = newHarness();
        const g = guest(test, 'val');
        const args = { callerIdentityHex: g.identity.toHexString(), provider: 'discord', providerId: 'pid-val', providerName: 'Val', ...over };
        expect(() => link(test, args)).toThrow(msg);
        expect(userRow(test, g)).toMatchObject({ isGuest: true, ...NO_LINK });
    });

    it('an identity with no UserIdentity row is told to log in as a guest first (contract error "Identity not registered")', () => {
        const test = newHarness();
        const { identity } = freshAuth(test, 'never-logged-in');
        expect(() => link(test, { callerIdentityHex: identity.toHexString(), providerId: 'pid-new', providerName: 'New' }))
            .toThrow('Identity not registered. Call login_as_guest first.');
        expect([...test.db.User.iter()].filter((u) => u.providerId !== undefined)).toHaveLength(0); // T-S11a (A77)
    });

    it('a caller that is not a registered server identity is rejected, even an Admin', () => {
        const test = newHarness();
        const boss = admin(test);
        const g = guest(test, 'victim');
        expectReject(test, boss, (ctx) => M.server_link_provider(ctx, {
            callerIdentityHex: g.identity.toHexString(), provider: 'discord', providerId: 'pid-steal', providerName: 'Steal',
        }), 'Forbidden: caller is not a registered server identity.');
        expect(userRow(test, g)!.isGuest).toBe(true);
    });

    it('SEC-03a: a banned provider id cannot be linked; no provider link is written and the user is unchanged (scenario "Ban Enforcement at Link-Time") (text per A76)', () => {
        const test = newHarness();
        const boss = admin(test);
        ban(test, boss, 'pid-banned');
        const g = guest(test, 'wannabe');
        const msg = rejection(test, 'internal', (ctx) => M.server_link_provider(ctx, {
            callerIdentityHex: g.identity.toHexString(), provider: 'discord', providerId: 'pid-banned', providerName: 'Wannabe',
        }));
        expect(userRow(test, g)).toMatchObject({ isGuest: true, ...NO_LINK });
        expect(msg).toBe('This discord account is banned and cannot be linked.');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// User deletion (admin contract § admin_delete_row, § run_user_deletion; auth contract D-09, D-12)
// ════════════════════════════════════════════════════════════════════════════

describe('admin_delete_row(\'User\') and run_user_deletion (D-09 cascade branching)', () => {
    it('soft-deletes the user (deletedAt) and schedules one UserDeletionJob 5 s out; a second call is "already pending" (scenario "User Deletion (Already Pending)")', () => {
        const test = newHarness();
        const boss = admin(test);
        const target = verified(test, 'target');
        deleteUserRow(test, boss, target.userId);
        expect(userRow(test, target)!.deletedAt?.microsSinceUnixEpoch).toBe(now(test));
        const jobs = jobsFor(test, target.userId);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ scheduledAt: ScheduleAt.time(now(test) + FIVE_SECONDS), createdById: boss.userId });

        expect(() => deleteUserRow(test, boss, target.userId)).toThrow(`User #${target.userId} is already pending deletion.`);
        expect(jobsFor(test, target.userId)).toHaveLength(1);
    });

    it('an unknown id is "Row not found", a malformed key is rejected, and a non-Admin is rejected', () => {
        const test = newHarness();
        const boss = admin(test);
        const mod = moderator(test);
        const target = verified(test, 'target');
        expect(() => deleteUserRow(test, boss, 999_999)).toThrow('Row not found');
        expect(() => deleteUserRow(test, boss, 'abc')).toThrow(/Invalid primary key for User/);
        expect(() => deleteUserRow(test, mod, target.userId)).toThrow(ADMIN_ONLY);
        expect(userRow(test, target)!.deletedAt).toBeUndefined();
    });

    it('is refused while the user hosts a lobby (admin contract edge case "Delete user who owns active lobby")', () => {
        const test = newHarness();
        const boss = admin(test);
        const s = setupLobby(test, { noStart: true });
        expect(() => deleteUserRow(test, boss, s.host.userId)).toThrow(new RegExp(`Cannot delete user #${s.host.userId}: they are hosting lobby`));
        expect(userRow(test, s.host)!.deletedAt).toBeUndefined();
        expect(jobsFor(test, s.host.userId)).toHaveLength(0);
    });

    it('the job, fired by hand, archives a verified user: User row gone, DeletedUser { displayName, isGuest false, deletedAt }, identities gone, the provider link with the User row (D-09 case 3; A77)', () => {
        const test = newHarness();
        const boss = admin(test);
        const target = verified(test, 'archived');
        deleteUserRow(test, boss, target.userId);
        const deletedAt = userRow(test, target)!.deletedAt;
        fireDeletionJob(test, target.userId);

        expect(userRow(test, target)).toBeFalsy();
        expect(test.db.DeletedUser.id.find(target.userId)).toEqual({ id: target.userId, displayName: 'archived', isGuest: false, deletedAt });
        expect(identitiesOf(test, target.userId)).toHaveLength(0);
        expect(jobsFor(test, target.userId)).toHaveLength(0);
    });

    it('a guest with no history is hard-deleted with no archive row (D-09 case 1; scenario "User Deletion (Guest with No History)")', () => {
        const test = newHarness();
        const boss = admin(test);
        const g = guest(test, 'clean-guest');
        deleteUserRow(test, boss, g.userId);
        fireDeletionJob(test, g.userId);
        expect(userRow(test, g)).toBeFalsy();
        expect(test.db.DeletedUser.id.find(g.userId)).toBeFalsy();
        expect(identitiesOf(test, g.userId)).toHaveLength(0);
    });

    it('a guest with history (an earned achievement) is archived, not hard-deleted (D-09 case 2)', () => {
        const test = newHarness();
        const boss = admin(test);
        const g = guest(test, 'storied-guest');
        const ach = createAchievement(test, boss, 'Guest badge', true);
        tx(test, boss, (ctx) => M.manual_award_achievement(ctx, { achievementId: ach, targetUserId: g.userId }));
        const displayName = userRow(test, g)!.displayName;
        deleteUserRow(test, boss, g.userId);
        fireDeletionJob(test, g.userId);
        expect(userRow(test, g)).toBeFalsy();
        expect(test.db.DeletedUser.id.find(g.userId)).toMatchObject({ displayName, isGuest: true });
    });

    it('resolveUserLabel: live user → its name; archived user → the archived name, isDeleted; unknown id → "User #N" (D-12)', () => {
        const test = newHarness();
        const boss = admin(test);
        const live = verified(test, 'LiveName');
        const gone = verified(test, 'GoneName');
        deleteUserRow(test, boss, gone.userId);
        fireDeletionJob(test, gone.userId);
        const labels = tx(test, 'internal', (ctx) => [live.userId, gone.userId, 424_242].map((id) => resolveUserLabel(ctx, id)));
        expect(labels).toEqual([
            { displayName: 'LiveName', isDeleted: false },
            { displayName: 'GoneName', isDeleted: true },
            { displayName: 'User #424242', isDeleted: true },
        ]);
    });
});
