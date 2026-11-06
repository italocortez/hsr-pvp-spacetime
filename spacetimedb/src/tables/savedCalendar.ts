import { table, t } from 'spacetimedb/server';

export const savedCalendarColumns = {
    userId: t.u32(),
    targetUserId: t.u32(),
    isVisible: t.bool(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const SavedCalendar = table({
    name: 'saved_calendar',
    public: true,
    primaryKey: ['userId', 'targetUserId'],
    indexes: [
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_user_and_target', algorithm: 'btree', columns: ['userId', 'targetUserId'] },
    ],
}, savedCalendarColumns);
