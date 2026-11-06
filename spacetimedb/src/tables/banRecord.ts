import { table, t } from 'spacetimedb/server';
import { BanType } from '../types/enums';

/**
 * Stores ban records keyed by auth provider ID.
 * Private (public: false) — never exposed to client subscriptions.
 * banType narrows which provider namespace the ban applies to.
 * D-06, CR-01, WR-01
 *
 * Note: Multi-column index (.filter() on composite key) causes PANIC in the
 * SpacetimeDB TypeScript SDK. Only a single-column provider_id index is used.
 * checkProviderBan performs in-memory banType filtering after the index lookup.
 */
export const banRecordColumns = {
    id: t.u32().primaryKey().autoInc(),
    banType: BanType,                    // enum: DiscordId
    providerId: t.string(),              // the banned Discord ID string
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
        { accessor: 'ban_record_provider_id', algorithm: 'btree', columns: ['providerId'] },
    ],
}, banRecordColumns);
