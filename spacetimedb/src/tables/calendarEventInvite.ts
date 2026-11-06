import { table, t } from 'spacetimedb/server';
import { InviteStatus } from '../types/enums';

export const calendarEventInviteColumns = {
    eventId: t.u32(),
    inviteeUserId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
    inviteStatus: InviteStatus,           // D-01: Pending|Accepted|Declined|Tentative
    respondedAt: t.timestamp().optional(), // D-02: when invitee responded
};

export const CalendarEventInvite = table({
    name: 'calendar_event_invite',
    public: false, // S3 (A37 calendar contexts): private, read through view_my_calendar_* / view_saved_calendar_availability (S9)
    primaryKey: ['eventId', 'inviteeUserId'],
    indexes: [
        { accessor: 'event_id', algorithm: 'btree', columns: ['eventId'] },
        { accessor: 'invitee_user_id', algorithm: 'btree', columns: ['inviteeUserId'] },
        { accessor: 'by_event_and_invitee', algorithm: 'btree', columns: ['eventId', 'inviteeUserId'] },
    ],
}, calendarEventInviteColumns);
