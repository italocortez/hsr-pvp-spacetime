// ─── Admin Views ──────────────────────────────────────────────────────────────
// S9b (ACCESS-SECURITY-OPS §A.4 P4, PAGE-MAP D6 / adminpanel, A42, A48): staff listings for the admin panel. Each view
// is per-sender and returns [] unless the caller's role is Moderator or above (`staffCaller`); staff are never an
// anonymous context, so ids and names are real. Each listing reads its whole table (a full scan) after the role
// check (A37 exemption for admin views: small tables, tab-gated), so a non-staff caller returns [] without touching
// the table; the panel gates every subscription by its tab. No full scan in any view a non-staff client can read.
//
// 1. view_admin_user_identities — UserIdentity rows (identity → user mapping, last seen)
// 2. view_admin_ban_records     — BanRecord rows (provider bans) with the banning admin's label
// 3. view_admin_deleted_users   — DeletedUser archive rows
// 4. view_admin_presence        — UserPresence rows (replaces User.isOnline / lastLoginAt, A48)
// 5. view_admin_lobby_bans      — LobbyBan rows of every lobby with labels (the In-Cell `lobby_ban` grid)
// 6. view_admin_abuse_config    — the AbuseConfig singleton incl. the guest kill switch (A42)
//
// Not built (PAGE-MAP's adminpanel section does not list them): view_admin_lobbies, view_admin_match_results,
// view_admin_match_history. view_admin_user_private stays in identityViews.ts; view_admin_stuck_games in
// matchResultViews.ts.

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { abuseConfigColumns } from '@module/tables/admin/abuseConfig';
import { resolveUserLabel } from '@module/helpers/identity/userLabel';
import { staffCaller } from '@module/helpers/identity/viewAnonymity';

// ---------------------------------------------------------------------------
// 1. view_admin_user_identities — every identity mapping: identity (PK; a re-point updates the row), userId,
//    lastSeenAt. UserIdentity has no kind column; the server identities (Owner, Delegates) are mapped to the
//    SYSTEM user by `init` and `server_register_delegate`, so they appear here under SYSTEM's userId.
//    Full read (staff-only).
// ---------------------------------------------------------------------------
const AdminUserIdentityRow = t.row('AdminUserIdentityRow', {
    identity: t.identity().primaryKey(),
    userId: t.u32(),
    lastSeenAt: t.timestamp(),
});

export const view_admin_user_identities = spacetimedb.view(
    { name: 'view_admin_user_identities', public: true },
    t.array(AdminUserIdentityRow),
    (ctx) => {
        if (!staffCaller(ctx)) return [];
        const rows: any[] = [];
        // staff-only full read (A37 exemption for admin views: small tables, tab-gated)
        for (const m of ctx.db.UserIdentity.iter()) {
            rows.push({ identity: m.identity, userId: m.userId, lastSeenAt: m.lastSeenAt });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 2. view_admin_ban_records — every provider ban (A46: loginMethod + providerId): id (PK), loginMethod,
//    providerId, reason, bannedByUserId, bannedByLabel, createdDate (admin_unban_user takes the id).
//    Full read (staff-only).
// ---------------------------------------------------------------------------
const AdminBanRecordRow = t.row('AdminBanRecordRow', {
    id: t.u32().primaryKey(),
    loginMethod: t.string(),
    providerId: t.string(),
    reason: t.string(),
    bannedByUserId: t.u32(),
    bannedByLabel: t.string(),
    createdDate: t.timestamp(),
});

export const view_admin_ban_records = spacetimedb.view(
    { name: 'view_admin_ban_records', public: true },
    t.array(AdminBanRecordRow),
    (ctx) => {
        if (!staffCaller(ctx)) return [];
        const rows: any[] = [];
        // staff-only full read (A37 exemption for admin views: small tables, tab-gated)
        for (const b of ctx.db.BanRecord.iter()) {
            rows.push({
                id: b.id,
                loginMethod: b.loginMethod,
                providerId: b.providerId,
                reason: b.reason,
                bannedByUserId: b.bannedByUserId,
                bannedByLabel: resolveUserLabel(ctx, b.bannedByUserId).displayName,
                createdDate: b.createdDate,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 3. view_admin_deleted_users — the DeletedUser archive (write-once): id (PK), displayName, isGuest, deletedAt.
//    Full read (staff-only).
// ---------------------------------------------------------------------------
const AdminDeletedUserRow = t.row('AdminDeletedUserRow', {
    id: t.u32().primaryKey(),
    displayName: t.string(),
    isGuest: t.bool(),
    deletedAt: t.timestamp(),
});

export const view_admin_deleted_users = spacetimedb.view(
    { name: 'view_admin_deleted_users', public: true },
    t.array(AdminDeletedUserRow),
    (ctx) => {
        if (!staffCaller(ctx)) return [];
        const rows: any[] = [];
        // staff-only full read (A37 exemption for admin views: small tables, tab-gated)
        for (const d of ctx.db.DeletedUser.iter()) {
            rows.push({ id: d.id, displayName: d.displayName, isGuest: d.isGuest, deletedAt: d.deletedAt });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 4. view_admin_presence — per-identity presence (A48, D-A1): identity (PK; connect / disconnect update the row),
//    userId, isOnline, lastLoginAt, lastSeenAt. "User online" = any row of the user with isOnline; the panel's
//    Online count comes from here. Full read (staff-only).
// ---------------------------------------------------------------------------
const AdminPresenceRow = t.row('AdminPresenceRow', {
    identity: t.identity().primaryKey(),
    userId: t.u32(),
    isOnline: t.bool(),
    lastLoginAt: t.timestamp(),
    lastSeenAt: t.timestamp(),
});

export const view_admin_presence = spacetimedb.view(
    { name: 'view_admin_presence', public: true },
    t.array(AdminPresenceRow),
    (ctx) => {
        if (!staffCaller(ctx)) return [];
        const rows: any[] = [];
        // staff-only full read (A37 exemption for admin views: small tables, tab-gated)
        for (const p of ctx.db.UserPresence.iter()) {
            rows.push({
                identity: p.identity,
                userId: p.userId,
                isOnline: p.isOnline,
                lastLoginAt: p.lastLoginAt,
                lastSeenAt: p.lastSeenAt,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 5. view_admin_lobby_bans — every LobbyBan row (PAGE-MAP D6: the In-Cell `lobby_ban` grid; unban_member is exposed
//    to staff): lobbyId, bannedUserId, bannedUserLabel, bannedByUserId, bannedByLabel, createdDate. Staff read real
//    ids in anonymous lobbies too. No PK (LobbyBan's key is (lobbyId, bannedUserId); rows are inserted / deleted).
//    Full read (staff-only).
// ---------------------------------------------------------------------------
const AdminLobbyBanRow = t.row('AdminLobbyBanRow', {
    lobbyId: t.u32(),
    bannedUserId: t.u32(),
    bannedUserLabel: t.string(),
    bannedByUserId: t.u32(),
    bannedByLabel: t.string(),
    createdDate: t.timestamp(),
});

export const view_admin_lobby_bans = spacetimedb.view(
    { name: 'view_admin_lobby_bans', public: true },
    t.array(AdminLobbyBanRow),
    (ctx) => {
        if (!staffCaller(ctx)) return [];
        const rows: any[] = [];
        // staff-only full read (A37 exemption for admin views: small tables, tab-gated)
        for (const ban of ctx.db.LobbyBan.iter()) {
            rows.push({
                lobbyId: ban.lobbyId,
                bannedUserId: ban.bannedUserId,
                bannedUserLabel: resolveUserLabel(ctx, ban.bannedUserId).displayName,
                bannedByUserId: ban.bannedByUserId,
                bannedByLabel: resolveUserLabel(ctx, ban.bannedByUserId).displayName,
                createdDate: ban.createdDate,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 6. view_admin_abuse_config — the AbuseConfig singleton (id 1): every tunable, maintenanceMode and the A42 guest
//    kill switch (guestLobbyCreationEnabled) for the Server Settings "Controls" card; no audit columns. Moderator+
//    may read it (the panel's route guard); only an Admin may change it (admin_update_abuse_config,
//    admin_set_guest_lobby_creation). PK `id` (edits update the row in place). Index: AbuseConfig.id.
// ---------------------------------------------------------------------------
const {
    createdById: _abuseCreatedById,
    createdDate: _abuseCreatedDate,
    lastModifiedById: _abuseLastModifiedById,
    lastModifiedDate: _abuseLastModifiedDate,
    ...abuseConfigViewColumns
} = abuseConfigColumns;

const AdminAbuseConfigRow = t.row('AdminAbuseConfigRow', {
    ...abuseConfigViewColumns,
    id: t.u32().primaryKey(),
});

export const view_admin_abuse_config = spacetimedb.view(
    { name: 'view_admin_abuse_config', public: true },
    t.array(AdminAbuseConfigRow),
    (ctx) => {
        if (!staffCaller(ctx)) return [];
        const config = ctx.db.AbuseConfig.id.find(1);
        if (!config) return [];
        const { createdById, createdDate, lastModifiedById, lastModifiedDate, ...rest } = config;
        return [rest];
    }
);
