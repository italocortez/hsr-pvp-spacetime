import { table, t } from 'spacetimedb/server';
import { Role } from '@module/types/enums';

// S3 (A48, D-A1): presence (isOnline, lastLoginAt) moved to the private UserPresence table.
// S11a (A77): private (public: false). No client subscribes it; pages read users through views (names and avatars
// denormalized, PAGE-MAP D2; staff through view_admin_users and view_admin_user_private). The former UserPrivate
// columns live here: loginMethod, providerId, providerUsername (A46: the SpacetimeAuth claim shape; Discord-only
// policy at launch) and linkedAt, all unset for a guest; `hasDiscordLinked` is gone (derived from loginMethod in the
// views that expose it).
export const userColumns = {
    id: t.u32().primaryKey().autoInc(),
    username: t.string().unique(),
    displayName: t.string(),
    isGuest: t.bool(),
    role: Role,
    avatarCharacterName: t.string(), // FK reference to HsrCharacter name
    displayedAchievementId: t.u32().optional(), // FK to Achievement.id — shown on profile
    deletedAt: t.timestamp().optional(), // Set by an admin deletion or a ban; the scheduled job deletes after 5s (delete_my_account and server_delete_user delete at once)
    // A77(2) (S11a): the auth-provider link, merged from UserPrivate (A46). Unset until a provider is linked.
    loginMethod: t.string().optional(),      // 'discord' today; mirrors the token's login_method claim
    providerId: t.string().optional(),       // the provider's user id (Discord snowflake)
    providerUsername: t.string().optional(), // the provider name at the last link
    linkedAt: t.timestamp().optional(),      // when the current provider account was linked (UserPrivate's createdDate before A77)
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const User = table({
    name: 'user',
    public: false, // A77 (S11a)
    indexes: [
        { accessor: 'provider_id', algorithm: 'btree', columns: ['providerId'] },
        { accessor: 'by_method_and_provider', algorithm: 'btree', columns: ['loginMethod', 'providerId'] },
    ],
}, userColumns);
