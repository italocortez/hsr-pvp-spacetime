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
    public: false, // S3 (A37 calendar contexts): private, read through view_my_calendar_* / view_saved_calendar_availability (S9)
    primaryKey: ['userId', 'targetUserId'],
    indexes: [
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_user_and_target', algorithm: 'btree', columns: ['userId', 'targetUserId'] },
    ],
}, savedCalendarColumns);
