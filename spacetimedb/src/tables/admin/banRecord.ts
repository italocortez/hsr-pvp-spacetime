import { table, t } from 'spacetimedb/server';

/**
 * Stores ban records keyed by auth provider identity.
 * Private (public: false) — never exposed to client subscriptions.
 * D-06, CR-01, WR-01
 *
 * S3 (A46): keyed by loginMethod + providerId like the provider columns of User (UserPrivate before A77). The former BanType enum (one variant,
 * DiscordId) became the string `loginMethod`: it mirrors the token claim, and adding a provider later is
 * a value, not an enum variant (an enum change would be a type change, hence a wipe).
 */
export const banRecordColumns = {
    id: t.u32().primaryKey().autoInc(),
    loginMethod: t.string(),             // 'discord' today
    providerId: t.string(),              // the banned provider user id
    reason: t.string(),
    bannedByUserId: t.u32(),             // FK to User.id (the admin who banned)
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const BanRecord = table({
    name: 'ban_record',
    public: false,      // CR-01: MUST be explicit
    indexes: [
        { accessor: 'provider_id', algorithm: 'btree', columns: ['providerId'] },
        { accessor: 'by_method_and_provider', algorithm: 'btree', columns: ['loginMethod', 'providerId'] },
    ],
}, banRecordColumns);
