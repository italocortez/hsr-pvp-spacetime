// Views: the admin views.
// Contracts: docs/views/contract.md
// From S9b (s9b-views.test.ts).
import { describe, expect, it } from 'vitest';
import type {
    AdminAbuseConfigRow,
    AdminBanRecordRow,
    AdminDeletedUserRow,
    AdminLobbyBanRow,
    AdminPresenceRow,
    AdminUserIdentityRow,
    AdminUserPrivateRow,
} from '@bindings/types';
import { M, connect, disconnect, guest, newHarness, seatOf, setupLobby, tx } from '../fixtures/harness';
import { moderator, verified, displayName, linked } from '../fixtures/identity';
import { setRole } from '../fixtures/draft-and-scoring';
import { ANON, profileGhost as ghost, keysOf, seatsOf, sorted, view } from '../fixtures/views';

// ════════════════════════════════════════════════════════════════════════════
// Admin views (S9b-AD1..AD3, S9b-V9; §A.4 P4, PAGE-MAP D6, A42, A48)
// ════════════════════════════════════════════════════════════════════════════

describe('admin views (S9b-AD1..AD3, S9b-V9)', () => {
    function world() {
        const test = newHarness();
        const mod = moderator(test, 'amod');
        const admin = verified(test, 'aadmin');
        setRole(test, admin.userId, 'Admin');
        const player = verified(test, 'aplayer');
        // a provider ban (soft-deletes the banned user)
        const bannee = linked(test, 'bannee-dev', 'pid-bannee', 'Bannee');
        tx(test, admin, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId: 'pid-bannee', reason: 'cheating' }));
        // a verified user who deletes their account → DeletedUser archive
        const leaver = verified(test, 'aleaver');
        tx(test, leaver, (ctx) => M.delete_my_account(ctx, {}));
        // one user on two devices (A48): connect both, close one
        const d1 = linked(test, 'dev-1', 'pid-dev', 'Dev');
        const d2 = linked(test, 'dev-2', 'pid-dev', 'Dev');
        expect(d2.userId).toBe(d1.userId);
        connect(test, d1);
        connect(test, d2);
        disconnect(test, d2);
        // a lobby ban in an anonymous lobby
        const l = setupLobby(test, { lobby: ANON, seats: seatsOf('L'), actors: { host: guest(test, 'Lhost') }, noStart: true });
        const lb = guest(test, 'Lbanned');
        tx(test, lb, (ctx) => M.join_lobby(ctx, { lobbyId: l.lobbyId, joinCode: '', password: '' }));
        tx(test, l.host, (ctx) => M.ban_member(ctx, { lobbyId: l.lobbyId, targetJoinSeq: seatOf(ctx, l.lobbyId, lb.userId) }));
        return { test, mod, admin, player, bannee, leaver, d1, d2, l, lb, outsider: guest(test, 'aout') };
    }
    const ALL = ['view_admin_user_identities', 'view_admin_ban_records', 'view_admin_deleted_users', 'view_admin_presence',
        'view_admin_lobby_bans', 'view_admin_abuse_config', 'view_admin_user_private'];

    it('S9b-AD1: a Moderator and an Admin read rows from every admin view; a User, a guest and an unmapped identity read []', () => {
        const w = world();
        for (const name of ALL) {
            expect(view(w.test, name, w.mod).length, `${name}: Moderator`).toBeGreaterThan(0);
            expect(view(w.test, name, w.admin), `${name}: Admin`).toEqual(view(w.test, name, w.mod));
            expect(view(w.test, name, w.player), `${name}: User`).toEqual([]);
            expect(view(w.test, name, w.outsider), `${name}: guest`).toEqual([]);
            expect(view(w.test, name, ghost()), `${name}: unmapped`).toEqual([]);
        }
    });

    it('view_admin_user_identities: every identity mapping (both devices of one user), no kind column', () => {
        const w = world();
        const rows = view<AdminUserIdentityRow>(w.test, 'view_admin_user_identities', w.mod);
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('adminIdentity'));
        const devs = rows.filter((r) => r.userId === w.d1.userId).map((r) => r.identity.toHexString()).sort();
        expect(devs).toEqual([w.d1.identity.toHexString(), w.d2.identity.toHexString()].sort());
        expect(rows).toHaveLength(Number(w.test.db.UserIdentity.count()));
    });

    it('view_admin_ban_records: the provider ban with the banning admin\'s id and label', () => {
        const w = world();
        const rows = view<AdminBanRecordRow>(w.test, 'view_admin_ban_records', w.mod);
        expect(rows).toHaveLength(1);
        expect(keysOf(rows[0])).toEqual(sorted('adminBan'));
        expect(rows[0]).toMatchObject({ loginMethod: 'discord', providerId: 'pid-bannee', reason: 'cheating', bannedByUserId: w.admin.userId, bannedByLabel: displayName(w.test, w.admin) });
    });

    it('view_admin_deleted_users: the archived user', () => {
        const w = world();
        const rows = view<AdminDeletedUserRow>(w.test, 'view_admin_deleted_users', w.mod);
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('adminDeleted'));
        expect(rows.find((r) => r.id === w.leaver.userId)).toMatchObject({ displayName: 'aleaver', isGuest: false });
    });

    it('S9b-AD2: view_admin_presence has one row per device; closing one device leaves the user online on the other (A48)', () => {
        const w = world();
        const rows = view<AdminPresenceRow>(w.test, 'view_admin_presence', w.mod);
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('adminPresence'));
        const dev = rows.filter((r) => r.userId === w.d1.userId);
        expect(dev).toHaveLength(2);
        expect(dev.find((r) => r.identity.toHexString() === w.d1.identity.toHexString())!.isOnline).toBe(true);
        expect(dev.find((r) => r.identity.toHexString() === w.d2.identity.toHexString())!.isOnline).toBe(false);
        expect(dev.some((r) => r.isOnline)).toBe(true); // the panel counts the user online
        disconnect(w.test, w.d1);
        expect(view<AdminPresenceRow>(w.test, 'view_admin_presence', w.mod).filter((r) => r.userId === w.d1.userId).some((r) => r.isOnline)).toBe(false);
    });

    it('view_admin_lobby_bans: staff read the real ids and names in an anonymous lobby', () => {
        const w = world();
        const rows = view<AdminLobbyBanRow>(w.test, 'view_admin_lobby_bans', w.mod);
        expect(rows).toHaveLength(1);
        expect(keysOf(rows[0])).toEqual(sorted('adminLobbyBan'));
        expect(rows[0]).toMatchObject({
            lobbyId: w.l.lobbyId, bannedUserId: w.lb.userId, bannedUserLabel: displayName(w.test, w.lb),
            bannedByUserId: w.l.host.userId, bannedByLabel: displayName(w.test, w.l.host),
        });
    });

    it('S9b-AD3: an Admin turns the guest kill switch off; the row updates in place without audit columns; a Moderator sees it but cannot change it', () => {
        const w = world();
        const [before] = view<AdminAbuseConfigRow>(w.test, 'view_admin_abuse_config', w.mod);
        expect(keysOf(before)).toEqual(sorted('adminAbuse'));
        expect(before).toMatchObject({ id: 1, guestLobbyCreationEnabled: true });
        expect(() => tx(w.test, w.mod, (ctx) => M.admin_set_guest_lobby_creation(ctx, { enabled: false }))).toThrow();
        expect(view<AdminAbuseConfigRow>(w.test, 'view_admin_abuse_config', w.mod)[0].guestLobbyCreationEnabled).toBe(true);
        tx(w.test, w.admin, (ctx) => M.admin_set_guest_lobby_creation(ctx, { enabled: false }));
        const after = view<AdminAbuseConfigRow>(w.test, 'view_admin_abuse_config', w.mod);
        expect(after).toHaveLength(1);
        expect(after[0]).toEqual({ ...before, guestLobbyCreationEnabled: false });
    });

    it('view_admin_user_private (unchanged behaviour): every provider link, the documented columns, Moderator+ only', () => {
        const w = world();
        const rows = view<AdminUserPrivateRow>(w.test, 'view_admin_user_private', w.mod);
        for (const r of rows) expect(keysOf(r)).toEqual(sorted('adminUserPrivate'));
        expect(rows.find((r) => r.providerId === 'pid-dev')).toMatchObject({ userId: w.d1.userId, loginMethod: 'discord', providerUsername: 'Dev' });
        expect(rows.find((r) => r.providerId === 'pid-bannee')).toMatchObject({ userId: w.bannee.userId });
        expect(rows).toHaveLength(Number(w.test.db.UserPrivate.count()));
    });
});
