import { table, t } from 'spacetimedb/server';

export const hsrAccountColumns = {
    id: t.u32().primaryKey().autoInc(),
    userId: t.u32(),
    uid: t.string(),
    region: t.string(),
    displayLabel: t.string(),
    isActive: t.bool(),
    isRosterPublic: t.bool(),
    isRatingPublic: t.bool(),
    isDuplicateUid: t.bool(),
    accountRating: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const HsrAccount = table({
    name: 'hsr_account',
    // D-20: Intentionally NOT public — raw subscriptions replaced by server-side views
    indexes: [
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'uid', algorithm: 'btree', columns: ['uid'] },
    ],
}, hsrAccountColumns);
