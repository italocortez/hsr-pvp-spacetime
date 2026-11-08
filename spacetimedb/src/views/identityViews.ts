// ─── Identity Views ───────────────────────────────────────────────────────────
// Views exposing user identity / profile data plus public roster account rows.
//
// 1. view_my_identity          — per-user, own UserIdentity mapping (identity + userId)
// 2. view_my_profile           — per-user, User + UserPrivate merge for the profile page (D-04; S9b row)
// 3. view_public_hsr_accounts  — anonymous, HsrAccount rows where isRosterPublic=true (D-22; S9b: is_roster_public index)
// 4. view_admin_user_private   — Moderator+, UserPrivate rows (D-05; S9b: staff-only full read, no audit columns)
// 5. view_user_by_username     — anonymous arg view (username): exact lookup on the unique User.username (S9b, D7)
// 6. view_user_achievements    — anonymous arg view (userId): a user's UserAchievement rows (S9b, A43, A40)
//
// No full scan in any view a non-staff client can read (S9b). The Moderator+ listing reads the whole table after the
// role check (A37 exemption for admin views: small tables, tab-gated).

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { Role } from '@module/types/enums';
import { staffCaller } from '@module/helpers/identity/viewAnonymity';

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
// 2. My Profile (per-user view, layer 0) — User + UserPrivate for the caller (D-04), the profile page's row
//    (PAGE-MAP profile): id, username ("IPC Battleground UID"), displayName, avatarCharacterName,
//    displayedAchievementId, hasDiscordLinked, isGuest, role, and the provider fields (A46) when linked.
//    S9b (S3 hand-off): no presence (UserPresence, A48), no email / discordId / discordUsername (gone in S3),
//    no deletedAt, no audit columns. One row, PK `id` (updates in place: display name, avatar, title).
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
    // UserPrivate fields (only visible to the user themselves; A46 provider generalization)
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
        const priv = ctx.db.UserPrivate.userId.find(mapping.userId);
        return [{
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            avatarCharacterName: user.avatarCharacterName,
            displayedAchievementId: user.displayedAchievementId,
            hasDiscordLinked: user.hasDiscordLinked,
            isGuest: user.isGuest,
            role: user.role,
            loginMethod: priv?.loginMethod,
            providerId: priv?.providerId,
            providerUsername: priv?.providerUsername,
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
// 4. Admin User Private (Moderator+) — every UserPrivate row, so staff can look up the provider name / id for
//    moderation and the ban form (D-05). `[]` for anyone below Moderator. S9b: a staff-only full read after the role
//    check, no audit columns. PK `userId` (a relink updates the row in place).
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
        for (const p of ctx.db.UserPrivate.iter()) {
            rows.push({
                userId: p.userId,
                loginMethod: p.loginMethod,
                providerId: p.providerId,
                providerUsername: p.providerUsername,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 5. view_user_by_username(username) — S9b (A44(1), PAGE-MAP D7): the calendar's "Add calendar" / "Invite players"
//    search. Exact match on the unique `User.username` index (the UI asks for the exact IPC UID); no prefix
//    search (it would need a scan). At most one row; an unknown or soft-deleted user returns []. Shared per
//    argument (anonymousView): `User` is a public table, so the row discloses nothing new.
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
