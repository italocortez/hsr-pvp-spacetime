// ─── Identity Views ───────────────────────────────────────────────────────────
// Views exposing user identity / profile data plus public roster account rows.
//
// 1. view_my_identity          — per-user, own UserIdentity mapping (identity + userId)
// 2. view_my_profile           — per-user, the caller's User row for the profile page (D-04; S9b row; A77 shape kept)
// 3. view_public_hsr_accounts  — anonymous, HsrAccount rows where isRosterPublic=true (D-22; S9b: is_roster_public index)
// 4. view_admin_user_private   — Moderator+, the provider link of every linked user (D-05; A77: read from User)
// 5. view_user_by_username     — anonymous arg view (username): exact lookup on the unique User.username (S9b, D7)
// 6. view_user_achievements    — anonymous arg view (userId): a user's UserAchievement rows (S9b, A43, A40)
// 7. view_admin_users          — Moderator+, every User row without the provider columns (A77(1), S11a)
//
// `User` is private since S11a (A77): these views and the denormalized names / avatars of the other views are the only
// way user data reaches a client. No full scan in any view a non-staff client can read (S9b). The Moderator+ listings
// read the whole table after the role check (A37 exemption for admin views: small tables, tab-gated).

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { Role } from '@module/types/enums';
import { staffCaller } from '@module/helpers/identity/viewAnonymity';
import { DISCORD_LOGIN_METHOD } from '@module/helpers/lobby/banHelper';

/** A77(2) (S11a): `hasDiscordLinked` is no longer stored; a user is Discord-linked when its login method is Discord. */
const hasDiscordLinked = (user: any): boolean => user.loginMethod === DISCORD_LOGIN_METHOD;

// ---------------------------------------------------------------------------
// 1. My Identity (per-user view) — the caller's own identity mapping. Uses ctx.sender directly on the PK.
//    S9b: identity + userId only (no audit columns, no lastSeenAt: a connect no longer rewrites the client row).
// ---------------------------------------------------------------------------
const MyIdentityRow = t.object('MyIdentityRow', {
    identity: t.identity(),
    userId: t.u32(),
});

// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_identity = spacetimedb.view(
    { name: 'view_my_identity', public: true },
    t.option(MyIdentityRow),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return undefined;
        return { identity: mapping.identity, userId: mapping.userId };
    }
);

// ---------------------------------------------------------------------------
// 2. My Profile (per-user view, layer 0) — the caller's User row (D-04), the profile page's row
//    (PAGE-MAP profile): id, username ("IPC Battleground UID"), displayName, avatarCharacterName,
//    displayedAchievementId, hasDiscordLinked, isGuest, role, and the provider fields (A46) when linked.
//    S9b (S3 hand-off): no presence (UserPresence, A48), no email / discordId / discordUsername (gone in S3),
//    no deletedAt, no audit columns. One row, PK `id` (updates in place: display name, avatar, title).
//    A77 (S11a): same row shape; the provider fields come from the User row (UserPrivate merged) and
//    `hasDiscordLinked` is derived (loginMethod 'discord'). linkedAt is not sent.
// ---------------------------------------------------------------------------
const MyProfileRow = t.row('MyProfileRow', {
    id: t.u32().primaryKey(),
    username: t.string(),
    displayName: t.string(),
    avatarCharacterName: t.string(),
    displayedAchievementId: t.u32().optional(),
    hasDiscordLinked: t.bool(),
    isGuest: t.bool(),
    role: Role,
    // Provider fields (only visible to the user themselves; A46 provider generalization; on User since A77)
    loginMethod: t.string().optional(),
    providerId: t.string().optional(),
    providerUsername: t.string().optional(),
});

// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_profile = spacetimedb.view(
    { name: 'view_my_profile', public: true },
    t.array(MyProfileRow),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const user = ctx.db.User.id.find(mapping.userId);
        if (!user) return [];
        return [{
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            avatarCharacterName: user.avatarCharacterName,
            displayedAchievementId: user.displayedAchievementId,
            hasDiscordLinked: hasDiscordLinked(user),
            isGuest: user.isGuest,
            role: user.role,
            loginMethod: user.loginMethod,
            providerId: user.providerId,
            providerUsername: user.providerUsername,
        }];
    }
);

// ---------------------------------------------------------------------------
// 3. view_public_hsr_accounts — anonymous view over HsrAccount rows the owner made public (isRosterPublic),
//    through the S9b `is_roster_public` btree index (no scan). Characters included; the rating only when the
//    owner also set isRatingPublic. Flat rows (one per character); an account with no characters emits one row
//    with characterName / eidolonLevel undefined. The owner's `userId` is present: a public roster is
//    identified by the owner's choice (not an anonymous context, A37); the residual risk that a public roster
//    fingerprints an anonymized seat under OpenRoster is the one A40 accepts for ratings.
// ---------------------------------------------------------------------------
const PublicHsrAccountRow = t.object('PublicHsrAccountRow', {
    accountId: t.u32(),
    userId: t.u32(),
    uid: t.string(),
    region: t.string(),
    displayLabel: t.string(),
    accountRating: t.u32().optional(),
    characterName: t.string().optional(),
    eidolonLevel: t.u8().optional(),
});

// Phase 15 D-01/D-02: moved from anonymousViews.ts
// Phase 15.5 D-04: renamed from view_public_accounts — underlying table is HsrAccount; name now names the source.
export const view_public_hsr_accounts = spacetimedb.anonymousView(
    { name: 'view_public_hsr_accounts', public: true },
    t.array(PublicHsrAccountRow),
    (ctx) => {
        const results: any[] = [];
        for (const account of ctx.db.HsrAccount.is_roster_public.filter(true)) {
            const base = {
                accountId: account.id,
                userId: account.userId,
                uid: account.uid,
                region: account.region,
                displayLabel: account.displayLabel,
                accountRating: account.isRatingPublic ? account.accountRating : undefined,
            };
            const characters = [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(account.id)];
            if (characters.length === 0) {
                results.push({ ...base, characterName: undefined, eidolonLevel: undefined });
            } else {
                for (const char of characters) {
                    results.push({ ...base, characterName: char.characterName, eidolonLevel: char.eidolonLevel });
                }
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 4. Admin User Private (Moderator+) — the provider link of every linked user, so staff can look up the provider
//    name / id for moderation and the ban form (D-05). `[]` for anyone below Moderator. S9b: a staff-only full read
//    after the role check, no audit columns. PK `userId` (a relink updates the row in place).
//    A77 (S11a): same row shape, read from User (UserPrivate merged): one row per user with a provider linked
//    (loginMethod and providerId set); guests and never-linked users give no row, as they had no UserPrivate row.
// ---------------------------------------------------------------------------
const AdminUserPrivateRow = t.row('AdminUserPrivateRow', {
    userId: t.u32().primaryKey(),
    loginMethod: t.string(),
    providerId: t.string(),
    providerUsername: t.string(),
});

// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_admin_user_private = spacetimedb.view(
    { name: 'view_admin_user_private', public: true },
    t.array(AdminUserPrivateRow),
    (ctx) => {
        if (!staffCaller(ctx)) return [];
        const rows: any[] = [];
        // staff-only full read (A37 exemption for admin views: small tables, tab-gated)
        for (const u of ctx.db.User.iter()) {
            if (u.loginMethod === undefined || u.providerId === undefined) continue;
            rows.push({
                userId: u.id,
                loginMethod: u.loginMethod,
                providerId: u.providerId,
                providerUsername: u.providerUsername ?? '',
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 7. view_admin_users (Moderator+) — A77(1) (S11a): the admin panel's Users tab, which subscribed the public `User`
//    table before A77 (PAGE-MAP D6). Every User row with the columns the tab read then: id (PK), username, displayName,
//    isGuest, role, hasDiscordLinked (derived, A77(2)), avatarCharacterName, displayedAchievementId?, deletedAt? and the
//    four audit columns (the mockup's hidden-by-default columns). The provider columns stay in
//    view_admin_user_private (row shape kept, A77(2)); linkedAt is not sent. `[]` for anyone below Moderator
//    (staffCaller); a staff-only full read after the role check (A37 exemption for admin views: tab-gated).
// ---------------------------------------------------------------------------
const AdminUserRow = t.row('AdminUserRow', {
    id: t.u32().primaryKey(),
    username: t.string(),
    displayName: t.string(),
    isGuest: t.bool(),
    role: Role,
    hasDiscordLinked: t.bool(),
    avatarCharacterName: t.string(),
    displayedAchievementId: t.u32().optional(),
    deletedAt: t.timestamp().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
});

export const view_admin_users = spacetimedb.view(
    { name: 'view_admin_users', public: true },
    t.array(AdminUserRow),
    (ctx) => {
        if (!staffCaller(ctx)) return [];
        const rows: any[] = [];
        // staff-only full read (A37 exemption for admin views: small tables, tab-gated)
        for (const u of ctx.db.User.iter()) {
            rows.push({
                id: u.id,
                username: u.username,
                displayName: u.displayName,
                isGuest: u.isGuest,
                role: u.role,
                hasDiscordLinked: hasDiscordLinked(u),
                avatarCharacterName: u.avatarCharacterName,
                displayedAchievementId: u.displayedAchievementId,
                deletedAt: u.deletedAt,
                createdById: u.createdById,
                createdDate: u.createdDate,
                lastModifiedById: u.lastModifiedById,
                lastModifiedDate: u.lastModifiedDate,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 5. view_user_by_username(username) — S9b (A44(1), PAGE-MAP D7): the calendar's "Add calendar" / "Invite players"
//    search. Exact match on the unique `User.username` index (the UI asks for the exact IPC UID); no prefix
//    search (it would need a scan). At most one row; an unknown or soft-deleted user returns []. Shared per
//    argument (anonymousView). Since A77 (S11a) `User` is private and this view stays the exact-match search (A77(1)):
//    for a username the caller already knows it discloses the id, display name, avatar and title, nothing else (no
//    role, guest flag, provider or deletion state).
// ---------------------------------------------------------------------------
const UserByUsernameRow = t.row('UserByUsernameRow', {
    userId: t.u32(),
    username: t.string(),
    displayName: t.string(),
    avatarCharacterName: t.string(),
    displayedAchievementId: t.u32().optional(),
});

export const view_user_by_username = spacetimedb.anonymousView(
    { name: 'view_user_by_username', public: true },
    { username: t.string() },
    t.array(UserByUsernameRow),
    (ctx, { username }) => {
        const user = ctx.db.User.username.find(username);
        if (!user || user.deletedAt !== undefined) return [];
        return [{
            userId: user.id,
            username: user.username,
            displayName: user.displayName,
            avatarCharacterName: user.avatarCharacterName,
            displayedAchievementId: user.displayedAchievementId,
        }];
    }
);

// ---------------------------------------------------------------------------
// 6. view_user_achievements(userId) — S9b (A43: UserAchievement stays public; A37 aggregates; §A.4 P3): a user's
//    titles for the profile's achievements view. `achievementId` + `awardedAt` (the row's createdDate); no
//    `awardedById` and no audit columns (the A40 residual risk is the award timing, not the awarder).
// ---------------------------------------------------------------------------
const UserAchievementViewRow = t.row('UserAchievementViewRow', {
    achievementId: t.u32(),
    awardedAt: t.timestamp(),
});

export const view_user_achievements = spacetimedb.anonymousView(
    { name: 'view_user_achievements', public: true },
    { userId: t.u32() },
    t.array(UserAchievementViewRow),
    (ctx, { userId }) => {
        const rows: any[] = [];
        for (const ua of ctx.db.UserAchievement.by_user.filter(userId)) {
            rows.push({ achievementId: ua.achievementId, awardedAt: ua.createdDate });
        }
        return rows;
    }
);
