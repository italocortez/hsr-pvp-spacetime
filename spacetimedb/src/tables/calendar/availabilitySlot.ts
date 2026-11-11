import { table, t } from 'spacetimedb/server';
import { SlotKind } from '@module/types/enums';

// S10ac (A157(1), A157(3)): one dated interval per slot (recurrence, recurrenceRule and expiresAt removed: a slot ends
// at endAt), with a kind, Available or Blocked.
export const availabilitySlotColumns = {
    id: t.u32().primaryKey().autoInc(),
    userId: t.u32(),
    startAt: t.timestamp(),
    endAt: t.timestamp(),
    kind: SlotKind,
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const AvailabilitySlot = table({
    name: 'availability_slot',
    public: false, // S3 (A37 calendar contexts): private, read through view_my_calendar_* / view_saved_calendar_availability (S9)
    indexes: [
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
    ],
}, availabilitySlotColumns);
