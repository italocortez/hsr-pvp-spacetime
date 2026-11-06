import { table, t } from 'spacetimedb/server';

export const calendarEventColumns = {
    id: t.u32().primaryKey().autoInc(),
    organizerId: t.u32(),
    title: t.string(),
    startAt: t.timestamp(),
    endAt: t.timestamp(),
    bracketMatchId: t.u32().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
    description: t.string().optional(),  // D-26: event notes (appended at end for safe migration)
};

export const CalendarEvent = table({
    name: 'calendar_event',
    public: true,
    indexes: [
        { accessor: 'organizer_id', algorithm: 'btree', columns: ['organizerId'] },
        { accessor: 'start_at', algorithm: 'btree', columns: ['startAt'] },
        { accessor: 'bracket_match_id', algorithm: 'btree', columns: ['bracketMatchId'] },
    ],
}, calendarEventColumns);
